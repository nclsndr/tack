import { Cause, Context, Effect, Exit, Logger, Redacted, Schema, Scope } from "effect";
import { isCapabilityFailure, Secret, Shell, type ShellService } from "./capabilities.ts";
import {
  inspectScriptDefinition,
  parseScriptBoundary,
  NoExpectedFailure,
  type BoundarySchema,
  type ErrorBoundary,
  type RecognizedScript,
  type ScriptDefinition,
  type ScriptServices,
  type ServiceName,
} from "./definition.ts";
import {
  copyJson,
  RunLimits,
  type CauseDiagnostic,
  type Finalization,
  type JsonValue,
  type LogTruncation,
  type PrimaryOutcome,
  type RunFailure,
  type RunLog,
  type RunOutcome,
  type RunStage,
  ScriptError,
} from "./outcome.ts";

type SuppliedServices = {
  readonly secrets?: Readonly<Record<string, string>>;
  readonly Shell?: ShellService;
};
export type RunOptions = {
  readonly input: unknown;
  readonly services: SuppliedServices;
  readonly signal?: AbortSignal;
  readonly onLog?: (event: RunLog) => void;
};
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function describe(value: unknown): string {
  try {
    if (Redacted.isRedacted(value)) return "<redacted>";
    if (typeof value === "string") return value.slice(0, 4096);
    if (value instanceof Error) return value.message.slice(0, 4096);
    if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null ||
      value === undefined
    )
      return String(value);
    return "<runtime value>";
  } catch {
    return "<unavailable diagnostic>";
  }
}
function diagnostics(cause: Cause.Cause<unknown>): readonly CauseDiagnostic[] {
  return cause.reasons.slice(0, 100).map((reason) => ({
    kind: Cause.isDieReason(reason) ? "Die" : Cause.isFailReason(reason) ? "Fail" : "Interrupt",
    message: Cause.isDieReason(reason)
      ? describe(reason.defect)
      : Cause.isFailReason(reason)
        ? describe(reason.error)
        : "Execution interrupted.",
  }));
}
function failure(
  stage: RunStage,
  code: RunFailure["code"],
  message: string,
  cause?: Cause.Cause<unknown>,
): RunFailure {
  return {
    status: "failure",
    stage,
    code,
    message,
    ...(cause === undefined ? {} : { cause, diagnostics: diagnostics(cause) }),
  };
}
function schemaBoundary(
  definition: RecognizedScript,
  schema: BoundarySchema,
  value: unknown,
  direction: "decode" | "encode",
  stage: "input" | "output" | "execution",
) {
  try {
    const result = parseScriptBoundary(
      definition,
      schema,
      value,
      direction === "encode" && stage === "input" ? "encodeInput" : direction,
    );
    if (Exit.isSuccess(result)) return { ok: true as const, value: result.value };
    const ordinary =
      result.cause.reasons.length > 0 &&
      result.cause.reasons.every(
        (reason) => Cause.isFailReason(reason) && Schema.isSchemaError(reason.error),
      );
    return {
      ok: false as const,
      failure: failure(
        stage,
        ordinary
          ? stage === "input"
            ? "invalid_input"
            : stage === "output"
              ? "invalid_output"
              : "invalid_expected_failure"
          : "schema_defect",
        ordinary
          ? "Value does not satisfy its boundary schema."
          : "Boundary schema failed outside validation.",
        result.cause,
      ),
    };
  } catch (error) {
    return {
      ok: false as const,
      failure: failure(
        stage,
        "schema_defect",
        "Boundary schema threw during validation.",
        Cause.die(error),
      ),
    };
  }
}
function encodedBoundary(
  definition: RecognizedScript,
  schema: BoundarySchema,
  value: unknown,
  stage: "input" | "output" | "execution",
) {
  const encoded = schemaBoundary(definition, schema, value, "encode", stage);
  if (!encoded.ok) return encoded;
  try {
    const json = copyJson(encoded.value);
    if (bytes(JSON.stringify(json)) > RunLimits.boundaryBytes)
      return {
        ok: false as const,
        failure: failure(stage, "boundary_too_large", "Encoded boundary exceeds its byte limit."),
      };
    return { ok: true as const, value: json };
  } catch {
    return {
      ok: false as const,
      failure: failure(
        stage,
        stage === "output"
          ? "invalid_output"
          : stage === "execution"
            ? "invalid_expected_failure"
            : "invalid_input",
        "Encoded boundary is not JSON data.",
      ),
    };
  }
}
function classify(definition: RecognizedScript, exit: Exit.Exit<unknown, unknown>): PrimaryOutcome {
  if (Exit.isSuccess(exit)) {
    const encoded = encodedBoundary(definition, definition.output, exit.value, "output");
    return encoded.ok
      ? {
          status: "success",
          stage: "output",
          code: "success",
          value: exit.value,
          encoded: encoded.value,
        }
      : encoded.failure;
  }
  const cause = exit.cause;
  const defect = cause.reasons.find((reason) => Cause.isDieReason(reason));
  if (defect !== undefined)
    return failure(
      "execution",
      "executed_defect",
      defect.defect instanceof ScriptError ? defect.defect.message : "Program execution defect.",
      cause,
    );
  if (cause.reasons.some((reason) => Cause.isInterruptReason(reason)))
    return failure("execution", "interrupted", "Program execution interrupted.", cause);
  if (
    cause.reasons.some((reason) => Cause.isFailReason(reason) && isCapabilityFailure(reason.error))
  )
    return failure("execution", "capability_failure", "A Tack capability failed.", cause);
  if (definition.error === NoExpectedFailure)
    return failure(
      "execution",
      "unexpected_failure",
      "Program failed despite declaring no expected failure.",
      cause,
    );
  const encodedFailures: JsonValue[] = [];
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const encoded = encodedBoundary(definition, definition.error, reason.error, "execution");
    if (!encoded.ok)
      return {
        ...encoded.failure,
        cause,
        diagnostics: [...diagnostics(cause), ...(encoded.failure.diagnostics ?? [])],
      };
    encodedFailures.push(encoded.value);
    if (bytes(JSON.stringify(encodedFailures)) > RunLimits.boundaryBytes)
      return failure(
        "execution",
        "boundary_too_large",
        "Encoded failures exceed their aggregate byte limit.",
        cause,
      );
  }
  if (encodedFailures.length === 0)
    return failure(
      "execution",
      "unexpected_failure",
      "Program failed without a declared domain failure.",
      cause,
    );
  return {
    ...failure("execution", "expected_failure", "Program reported an expected failure.", cause),
    encoded: encodedFailures[0]!,
    encodedFailures,
  };
}

/** Executes one definition with explicit capabilities, awaiting cleanup before settling. */
export function runScript<
  I extends BoundarySchema,
  O extends BoundarySchema,
  E extends ErrorBoundary,
  Names extends readonly string[],
  Services extends readonly ServiceName[],
>(
  definition: ScriptDefinition<I, O, E, Names, Services>,
  options: Omit<RunOptions, "services"> & { readonly services: ScriptServices<Names, Services> },
): Promise<RunOutcome<O["Type"]>>;
/** Runs a recognized module definition at a host boundary after runtime preflight. */
export function runScript(definition: RecognizedScript, options: RunOptions): Promise<RunOutcome>;
export async function runScript(definition: unknown, options: RunOptions): Promise<RunOutcome> {
  const logs: RunLog[] = [];
  const truncation: LogTruncation[] = [];
  let observedEvents = 0;
  let observedBytes = 0;
  const truncate = (reason: LogTruncation["reason"], observed: number, limit: number) => {
    const index = truncation.findIndex((entry) => entry.reason === reason);
    const entry = { reason, observed, limit };
    if (index === -1) truncation.push(entry);
    else truncation[index] = entry;
  };
  const logger = Logger.make<unknown, void>(({ message, logLevel, date }) => {
    observedEvents += 1;
    const content = Array.isArray(message)
      ? message.map((part: unknown) => (typeof part === "string" ? part : describe(part))).join(" ")
      : describe(message);
    const length = bytes(content);
    observedBytes += length;
    if (observedEvents > RunLimits.logEvents) {
      truncate("event_count", observedEvents, RunLimits.logEvents);
      return;
    }
    if (observedBytes > RunLimits.logBytes) {
      truncate("total_bytes", observedBytes, RunLimits.logBytes);
      return;
    }
    const bounded =
      length > RunLimits.logEventBytes
        ? new TextDecoder()
            .decode(new TextEncoder().encode(content).slice(0, RunLimits.logEventBytes))
            .replace(/\uFFFD$/, "")
        : content;
    if (length > RunLimits.logEventBytes) truncate("event_bytes", length, RunLimits.logEventBytes);
    const event: RunLog = {
      source: "script",
      sequence: logs.length + 1,
      timestamp: date.toISOString(),
      content: bounded,
      level: logLevel,
    };
    logs.push(event);
    options.onLog?.(event);
  });
  const finish = (
    primary: PrimaryOutcome,
    finalization: Finalization = { status: "not_started" },
    encodedInput?: JsonValue,
    execution?: RunOutcome["execution"],
  ): RunOutcome => ({
    status: finalization.status === "failed" ? "failure" : primary.status,
    stage: finalization.status === "failed" ? "cleanup" : primary.stage,
    code: finalization.status === "failed" ? "cleanup_failed" : primary.code,
    primary,
    finalization,
    logs,
    truncation,
    ...(encodedInput === undefined ? {} : { encodedInput }),
    ...(execution === undefined ? {} : { execution }),
  });
  const inspected = inspectScriptDefinition(definition);
  if (!inspected.ok) return finish(failure("preflight", inspected.code, inspected.message));
  const script = inspected.definition;
  let context = Context.empty();
  for (const name of script.secrets) {
    const value = options.services.secrets?.[name];
    if (typeof value !== "string")
      return finish(failure("preflight", "missing_capability", `Missing declared secret ${name}.`));
    context = Context.add(context, Secret(name), Redacted.make(value));
  }
  if (script.services.includes("Shell")) {
    if (
      options.services.Shell === undefined ||
      typeof options.services.Shell.execute !== "function"
    )
      return finish(
        failure("preflight", "missing_capability", "Missing declared Shell implementation."),
      );
    context = Context.add(context, Shell, options.services.Shell);
  }
  try {
    const input = copyJson(options.input);
    if (bytes(JSON.stringify(input)) > RunLimits.inputBytes)
      return finish(failure("input", "input_too_large", "Input exceeds its byte limit."));
  } catch {
    return finish(failure("input", "invalid_input", "Input must be JSON data."));
  }
  const input = schemaBoundary(script, script.input, options.input, "decode", "input");
  if (!input.ok) return finish(input.failure);
  const encodedInputResult = encodedBoundary(script, script.input, input.value, "input");
  if (!encodedInputResult.ok && encodedInputResult.failure.code === "schema_defect")
    return finish(encodedInputResult.failure);
  const encodedInput = encodedInputResult.ok ? encodedInputResult.value : undefined;
  if (options.signal?.aborted === true)
    return finish(
      failure(
        "execution",
        "interrupted",
        "Program execution interrupted before construction.",
        Cause.interrupt(),
      ),
      undefined,
      encodedInput,
    );
  let program: unknown;
  try {
    program = script.run(input.value);
  } catch (error) {
    return finish(
      failure(
        "construction",
        "construction_defect",
        "Program construction threw.",
        Cause.die(error),
      ),
      undefined,
      encodedInput,
    );
  }
  if (!Effect.isEffect(program))
    return finish(
      failure("construction", "invalid_program", "Program constructor must return an Effect."),
      undefined,
      encodedInput,
    );
  const scope = Scope.makeUnsafe();
  const provided = Effect.provideContext(
    Scope.provide(program, scope),
    Context.makeUnsafe<unknown>(context.mapUnsafe),
  );
  const exit = await Effect.runPromiseExit(
    Effect.provide(provided, Logger.layer([logger])),
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  const primary = classify(script, exit);
  const cleanup = await Effect.runPromiseExit(
    Effect.provide(Scope.close(scope, exit), Logger.layer([logger])),
  );
  const finalization: Finalization = Exit.isSuccess(cleanup)
    ? { status: "complete" }
    : { status: "failed", cause: cleanup.cause, diagnostics: diagnostics(cleanup.cause) };
  return finish(
    primary,
    finalization,
    encodedInput,
    Exit.isSuccess(exit)
      ? { status: "success", value: exit.value }
      : { status: "failure", cause: exit.cause },
  );
}
