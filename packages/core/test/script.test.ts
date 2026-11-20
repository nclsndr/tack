import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Logger, Redacted, Schema, SchemaGetter } from "effect";
import {
  copyJson,
  defineScript,
  definitionFailureCodes,
  encodeRunOutcome,
  inspectScriptDefinition,
  NoExpectedFailure,
  runScript,
  Secret,
  Shell,
  ShellFailure,
  RunLimits,
  type RunLog,
} from "../src/index.ts";

const base = {
  contract: 1,
  input: Schema.Struct({}),
  output: Schema.String,
  error: NoExpectedFailure,
  secrets: [],
  services: [],
} as const;
const successful = defineScript({ ...base, run: () => Effect.succeed("ok") });
// Models malformed JavaScript callers at the contract's runtime boundary.
const unchecked = (changes: Record<string, unknown>) =>
  ({ ...successful, ...changes }) as typeof successful;
const direct = (definition: typeof successful) =>
  runScript(definition, { input: {}, services: {} });

describe("Tack script contract", () => {
  it("recognizes opaque definitions, versions, schemas and capability identities", () => {
    expect(inspectScriptDefinition(successful).ok).toBe(true);
    expect(inspectScriptDefinition({ ...base, run: () => Effect.succeed("x") })).toMatchObject({
      ok: false,
      code: "invalid_definition",
    });
    expect(inspectScriptDefinition(unchecked({ contract: 2 }))).toMatchObject({
      code: "unsupported_contract",
    });
    expect(inspectScriptDefinition(unchecked({ services: ["Network"] }))).toMatchObject({
      code: "unknown_capability",
    });
    expect(inspectScriptDefinition(unchecked({ secrets: ["TACK_TOKEN"] }))).toMatchObject({
      code: "unknown_capability",
    });
    expect(inspectScriptDefinition(unchecked({ input: {} }))).toMatchObject({
      code: "invalid_definition",
    });
  });

  it("publishes exactly the recognition failure codes that inspection reports", () => {
    const codes = [
      { ...base, run: () => Effect.succeed("x") },
      unchecked({ contract: 2 }),
      unchecked({ services: ["Network"] }),
      unchecked({ secrets: ["TACK_TOKEN"] }),
      unchecked({ input: {} }),
    ].flatMap((value) => {
      const inspection = inspectScriptDefinition(value);
      return inspection.ok === true ? [] : [inspection.code];
    });
    expect(new Set(codes)).toEqual(new Set(definitionFailureCodes));
  });

  it("keeps definition and program construction lazy", async () => {
    let executions = 0;
    const script = defineScript({
      ...base,
      run: () =>
        Effect.sync(() => {
          executions += 1;
          return "ok";
        }),
    });
    script.run({});
    expect(executions).toBe(0);
    const result = await direct(script);
    expect(executions).toBe(1);
    expect(result).toMatchObject({
      status: "success",
      primary: { value: "ok", encoded: "ok" },
      encodedInput: {},
      finalization: { status: "complete" },
    });
  });

  it("rejects nested and top-level excess input before construction", async () => {
    let constructed = false;
    const script = defineScript({
      ...base,
      input: Schema.Struct({ nested: Schema.Struct({ value: Schema.String }) }),
      run: () => {
        constructed = true;
        return Effect.succeed("ok");
      },
    });
    for (const input of [
      { nested: { value: "yes", extra: true } },
      { nested: { value: "yes" }, extra: true },
    ]) {
      expect((await runScript(script, { input, services: {} })).code).toBe("invalid_input");
    }
    expect(constructed).toBe(false);
  });

  it("decodes input and encodes success through their transformations", async () => {
    const script = defineScript({
      ...base,
      input: Schema.NumberFromString,
      output: Schema.NumberFromString,
      run: (input) => Effect.succeed(input + 1),
    });
    expect(await runScript(script, { input: "12", services: {} })).toMatchObject({
      encodedInput: "12",
      primary: { value: 13, encoded: "13" },
    });
  });

  it("classifies synchronous schema throws and asynchronous schemas as defects", async () => {
    const throwing = Schema.String.check(
      Schema.makeFilter(() => {
        throw new Error("schema exploded");
      }),
    );
    expect(
      (
        await runScript(
          defineScript({ ...base, input: throwing, run: () => Effect.succeed("ok") }),
          { input: "x", services: {} },
        )
      ).code,
    ).toBe("schema_defect");
    const asynchronous = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transformEffect((value) => Effect.promise(async () => value)),
        encode: SchemaGetter.transform((value: string) => value),
      }),
    );
    expect(
      (
        await runScript(
          defineScript({ ...base, input: asynchronous, run: () => Effect.succeed("ok") }),
          { input: "x", services: {} },
        )
      ).code,
    ).toBe("schema_defect");
  });

  it("distinguishes construction throws and non-Effect programs", async () => {
    expect(
      (
        await direct(
          unchecked({
            run: () => {
              throw new Error("boom");
            },
          }),
        )
      ).code,
    ).toBe("construction_defect");
    for (const value of ["value", Promise.resolve("value"), () => "value"]) {
      const result = await direct(unchecked({ run: () => value }));
      expect(result.code).toBe("invalid_program");
      expect(result.finalization.status).toBe("not_started");
    }
  });

  it("encodes declared failures and rejects absent or invalid error contracts", async () => {
    const script = defineScript({
      ...base,
      error: Schema.Struct({ reason: Schema.String }),
      run: () => Effect.fail({ reason: "declined" }),
    });
    expect(await runScript(script, { input: {}, services: {} })).toMatchObject({
      code: "expected_failure",
      primary: { encoded: { reason: "declined" } },
    });
    expect((await direct(unchecked({ run: () => Effect.fail("unexpected") }))).code).toBe(
      "unexpected_failure",
    );
    expect(
      (await direct(unchecked({ error: Schema.String, run: () => Effect.fail(3) }))).code,
    ).toBe("invalid_expected_failure");
  });

  it("rejects invalid, non-JSON and oversized encoded output while retaining execution", async () => {
    expect(await direct(unchecked({ run: () => Effect.succeed(42) }))).toMatchObject({
      code: "invalid_output",
      execution: { status: "success", value: 42 },
    });
    expect(
      (await direct(unchecked({ output: Schema.Unknown, run: () => Effect.succeed(new Map()) })))
        .code,
    ).toBe("invalid_output");
    expect(
      (await direct(unchecked({ run: () => Effect.succeed("x".repeat(RunLimits.boundaryBytes)) })))
        .code,
    ).toBe("boundary_too_large");
    expect(
      (await runScript(successful, { input: "x".repeat(RunLimits.inputBytes), services: {} })).code,
    ).toBe("input_too_large");
  });

  it("requires explicit named secret fakes and does not supply extra capabilities", async () => {
    const script = defineScript({
      ...base,
      secrets: ["TOKEN"],
      run: () => Effect.map(Secret("TOKEN"), (secret) => Redacted.value(secret)),
    });
    expect(
      await runScript(script, { input: {}, services: { secrets: { TOKEN: "fake-token" } } }),
    ).toMatchObject({ primary: { value: "fake-token" } });
    const recognized = inspectScriptDefinition(script);
    if (!recognized.ok) throw new Error("Expected recognized definition");
    expect((await runScript(recognized.definition, { input: {}, services: {} })).code).toBe(
      "missing_capability",
    );
    const hidden = unchecked({ run: () => Secret("UNDECLARED") });
    expect(
      (await runScript(hidden, { input: {}, services: { secrets: { UNDECLARED: "extra" } } })).code,
    ).toBe("executed_defect");
  });

  it("keeps non-zero Shell exits as data and capability failures out of the domain schema", async () => {
    const calls: string[] = [];
    const script = defineScript({
      ...base,
      services: ["Shell"],
      output: Schema.Number,
      run: () =>
        Effect.flatMap(Shell, (shell) =>
          Effect.map(
            shell.execute({ executable: "fake", args: ["a"] }),
            (result) => result.exitCode,
          ),
        ),
    });
    const result = await runScript(script, {
      input: {},
      services: {
        Shell: {
          execute: (command) =>
            Effect.sync(() => {
              calls.push(command.executable);
              return { stdout: "out", stderr: "err", exitCode: 7 };
            }),
        },
      },
    });
    expect(result).toMatchObject({ status: "success", primary: { value: 7 } });
    expect(calls).toEqual(["fake"]);
    for (const operation of ["spawn", "io", "termination"] as const) {
      expect(
        (
          await runScript(script, {
            input: {},
            services: {
              Shell: {
                execute: () => Effect.fail(new ShellFailure({ operation, message: "failed" })),
              },
            },
          })
        ).code,
      ).toBe("capability_failure");
    }
    expect(
      (
        await runScript(script, {
          input: {},
          services: { Shell: { execute: () => Effect.interrupt } },
        })
      ).code,
    ).toBe("interrupted");
  });

  it("classifies complete mixed causes without dropping contributing reasons", async () => {
    const cases = [
      { cause: Cause.combine(Cause.fail("domain"), Cause.die("defect")), code: "executed_defect" },
      { cause: Cause.combine(Cause.fail("domain"), Cause.interrupt()), code: "interrupted" },
      {
        cause: Cause.combine(
          Cause.fail<unknown>("domain"),
          Cause.fail(new ShellFailure({ operation: "spawn", message: "failed" })),
        ),
        code: "capability_failure",
      },
      { cause: Cause.combine(Cause.fail("one"), Cause.fail("two")), code: "expected_failure" },
    ];
    for (const { cause, code } of cases) {
      const result = await direct(
        unchecked({ error: Schema.String, run: () => Effect.failCause(cause) }),
      );
      expect(result.code).toBe(code);
      if (result.primary.status !== "failure") throw new Error("Expected failure");
      expect(result.primary.cause?.reasons).toHaveLength(2);
    }
  });

  it("awaits finalizers for success, expected failure, defect and interruption", async () => {
    for (const terminal of [
      Effect.succeed("ok"),
      Effect.fail("domain"),
      Effect.die("defect"),
      Effect.interrupt,
    ]) {
      const events: string[] = [];
      const script = unchecked({
        error: Schema.String,
        run: () =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                events.push("acquired");
              }),
              () =>
                Effect.sync(() => {
                  events.push("released");
                }),
            );
            return yield* terminal;
          }),
      });
      const result = await direct(script);
      expect(events).toEqual(["acquired", "released"]);
      expect(result.finalization.status).toBe("complete");
    }
  });

  it("preserves primary success and every cleanup failure", async () => {
    const script = defineScript({
      ...base,
      run: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.die("cleanup one"));
          yield* Effect.addFinalizer(() => Effect.die("cleanup two"));
          return "ok";
        }),
    });
    const result = await direct(script);
    expect(result).toMatchObject({
      code: "cleanup_failed",
      primary: { status: "success", value: "ok" },
      finalization: { status: "failed" },
    });
    if (result.finalization.status !== "failed") throw new Error("Expected failed cleanup");
    expect(result.finalization.cause.reasons).toHaveLength(2);
  });

  it("does not construct an already-aborted program", async () => {
    let constructed = false;
    const controller = new AbortController();
    controller.abort();
    const script = defineScript({
      ...base,
      run: () => {
        constructed = true;
        return Effect.succeed("ok");
      },
    });
    expect(
      (await runScript(script, { input: {}, services: {}, signal: controller.signal })).code,
    ).toBe("interrupted");
    expect(constructed).toBe(false);
  });

  it("finalizes after invalid output and output schema defects", async () => {
    for (const output of [
      Schema.Number,
      Schema.String.check(
        Schema.makeFilter(() => {
          throw new Error("schema defect");
        }),
      ),
    ]) {
      let released = false;
      const result = await direct(
        unchecked({
          output,
          run: () =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true;
                }),
              );
              return "invalid";
            }),
        }),
      );
      expect(["invalid_output", "schema_defect"]).toContain(result.code);
      expect(result.finalization.status).toBe("complete");
      expect(released).toBe(true);
    }
  });

  it("retains failed primary causes when cleanup also fails", async () => {
    const primary = Cause.combine(Cause.fail("domain"), Cause.interrupt());
    const result = await direct(
      unchecked({
        error: Schema.String,
        run: () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.die("cleanup"));
            return yield* Effect.failCause(primary);
          }),
      }),
    );
    expect(result.code).toBe("cleanup_failed");
    expect(result.primary.code).toBe("interrupted");
    if (result.primary.status !== "failure") throw new Error("Expected failure");
    expect(result.primary.cause?.reasons).toHaveLength(2);
  });

  it("propagates host abort and waits for interrupted program cleanup", async () => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    let released = false;
    const script = defineScript({
      ...base,
      run: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              released = true;
            }),
          );
          yield* Effect.sync(() => entered.resolve());
          return yield* Effect.never;
        }),
    });
    const running = runScript(script, { input: {}, services: {}, signal: controller.signal });
    await entered.promise;
    controller.abort();
    expect((await running).code).toBe("interrupted");
    expect(released).toBe(true);
  });

  it("captures ordered bounded Effect logs including cleanup logs", async () => {
    const observed: RunLog[] = [];
    const script = defineScript({
      ...base,
      run: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.log("cleanup"));
          yield* Effect.log("first");
          yield* Effect.log("x".repeat(RunLimits.logEventBytes + 10));
          return "ok";
        }),
    });
    const result = await runScript(script, {
      input: {},
      services: {},
      onLog: (event) => {
        observed.push(event);
      },
    });
    expect(result.logs.map((log) => log.sequence)).toEqual([1, 2, 3]);
    expect(observed).toEqual(result.logs);
    expect(result.logs[2]?.content).toBe("cleanup");
    expect(result.truncation).toEqual([
      {
        reason: "event_bytes",
        observed: RunLimits.logEventBytes + 10,
        limit: RunLimits.logEventBytes,
      },
    ]);
  });

  it("rejects JSON accessors, cycles and serialization hooks without executing them", () => {
    let touched = false;
    const array = [1];
    Object.defineProperty(array, "0", {
      get: () => {
        touched = true;
        return 1;
      },
    });
    expect(() => copyJson(array)).toThrow();
    expect(() =>
      copyJson({
        get value() {
          touched = true;
          return 1;
        },
      }),
    ).toThrow();
    expect(() =>
      copyJson({
        toJSON() {
          touched = true;
          return "hidden";
        },
      }),
    ).toThrow();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => copyJson(cycle)).toThrow();
    expect(touched).toBe(false);
  });

  it("bounds the complete encoded collection of mixed domain failures", async () => {
    const large = "x".repeat(600_000);
    const result = await direct(
      unchecked({
        error: Schema.String,
        run: () => Effect.failCause(Cause.combine(Cause.fail(large), Cause.fail(`${large}b`))),
      }),
    );
    expect(result.code).toBe("boundary_too_large");
    if (result.primary.status !== "failure") throw new Error("Expected failure");
    expect(result.primary.cause?.reasons).toHaveLength(2);
  });

  it("transports encoded values without serializing raw program values or causes", async () => {
    const result = await direct(successful);
    expect(encodeRunOutcome(result)).not.toHaveProperty("execution");
    expect(encodeRunOutcome(result).primary).not.toHaveProperty("value");
    const failure = await direct(unchecked({ run: () => Effect.die(new Error("detail")) }));
    expect(encodeRunOutcome(failure).primary).not.toHaveProperty("cause");
    expect(JSON.stringify(encodeRunOutcome(failure))).not.toContain("stack");
  });
});

describe("runScript diagnostics and limits", () => {
  const dieWith = async (defect: unknown) => {
    const result = await direct(unchecked({ run: () => Effect.die(defect) }));
    if (result.primary.status !== "failure") throw new Error("Expected failure");
    return result.primary.diagnostics;
  };

  it("describes redacted, primitive and opaque defects without exposing their values", async () => {
    expect(await dieWith(Redacted.make("secret-token"))).toEqual([
      { kind: "Die", message: "<redacted>" },
    ]);
    expect(await dieWith(42)).toEqual([{ kind: "Die", message: "42" }]);
    expect(await dieWith({ token: "secret-token" })).toEqual([
      { kind: "Die", message: "<runtime value>" },
    ]);
  });

  it("falls back to a placeholder when a defect's message cannot be read", async () => {
    const hostile = new Error("unused");
    Object.defineProperty(hostile, "message", {
      get: () => {
        throw new Error("message getter exploded");
      },
    });

    expect(await dieWith(hostile)).toEqual([{ kind: "Die", message: "<unavailable diagnostic>" }]);
  });

  it("refuses an unrecognized definition during preflight", async () => {
    const result = await direct(unchecked({ contract: 2 }));

    expect(result).toMatchObject({
      status: "failure",
      stage: "preflight",
      code: "unsupported_contract",
      finalization: { status: "not_started" },
    });
  });

  it("refuses a script that declares Shell when no Shell implementation is supplied", async () => {
    const script = defineScript({
      ...base,
      services: ["Shell"],
      run: () => Effect.map(Shell, () => "ok"),
    });
    const recognized = inspectScriptDefinition(script);
    if (!recognized.ok) throw new Error("Expected recognized definition");

    expect(await runScript(recognized.definition, { input: {}, services: {} })).toMatchObject({
      stage: "preflight",
      code: "missing_capability",
      primary: { message: "Missing declared Shell implementation." },
    });
  });

  it("refuses input that is not JSON data before decoding it", async () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);

    expect(await runScript(successful, { input: cycle, services: {} })).toMatchObject({
      stage: "input",
      code: "invalid_input",
      primary: { message: "Input must be JSON data." },
    });
  });

  it("stops before construction when re-encoding the decoded input throws", async () => {
    let constructed = false;
    const input = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value: string) => value),
        encode: SchemaGetter.transform((): string => {
          throw new Error("encode exploded");
        }),
      }),
    );
    const result = await runScript(
      unchecked({
        input,
        run: () => {
          constructed = true;
          return Effect.succeed("ok");
        },
      }),
      { input: "value", services: {} },
    );

    expect(result).toMatchObject({ stage: "input", code: "schema_defect" });
    expect(constructed).toBe(false);
  });

  it("runs without an encoded input when the decoded input re-encodes to non-JSON data", async () => {
    const input = Schema.Unknown.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value: unknown) => String(value)),
        encode: SchemaGetter.transform((): unknown => new Map()),
      }),
    );
    const result = await runScript(unchecked({ input, run: () => Effect.succeed("ok") }), {
      input: "value",
      services: {},
    });

    expect(result).toMatchObject({ status: "success", primary: { value: "ok" } });
    expect(result).not.toHaveProperty("encodedInput");
  });

  it("rejects a declared failure that encodes to non-JSON data", async () => {
    const result = await direct(
      unchecked({ error: Schema.Unknown, run: () => Effect.fail(new Map()) }),
    );

    expect(result).toMatchObject({
      stage: "execution",
      code: "invalid_expected_failure",
      primary: { message: "Encoded boundary is not JSON data." },
    });
  });

  it("treats a failure cause without reasons as an undeclared failure", async () => {
    const result = await direct(
      unchecked({ error: Schema.String, run: () => Effect.failCause(Cause.empty) }),
    );

    expect(result).toMatchObject({
      code: "unexpected_failure",
      primary: { message: "Program failed without a declared domain failure." },
    });
  });

  it("describes non-string log parts and log messages handed directly to the logger", async () => {
    const script = defineScript({
      ...base,
      run: () =>
        Effect.gen(function* () {
          yield* Effect.log("count", 3, Redacted.make("hidden"));
          const loggers = yield* Logger.CurrentLoggers;
          yield* Effect.withFiber((fiber) =>
            Effect.sync(() => {
              for (const logger of loggers) {
                logger.log({
                  message: "direct",
                  logLevel: "Info",
                  cause: Cause.empty,
                  fiber,
                  date: new Date(0),
                });
              }
            }),
          );
          return "ok";
        }),
    });

    const result = await direct(script);

    expect(result.logs.map((log) => log.content)).toEqual(["count 3 <redacted>", "direct"]);
  });

  it("stops recording logs past the event count and keeps the latest observed count", async () => {
    const script = defineScript({
      ...base,
      run: () =>
        Effect.gen(function* () {
          for (let index = 0; index < RunLimits.logEvents + 2; index += 1) yield* Effect.log("x");
          return "ok";
        }),
    });

    const result = await direct(script);

    expect(result.logs).toHaveLength(RunLimits.logEvents);
    expect(result.truncation).toEqual([
      { reason: "event_count", observed: RunLimits.logEvents + 2, limit: RunLimits.logEvents },
    ]);
  });

  it("stops recording logs once their total bytes exceed the limit", async () => {
    const half = Math.ceil(RunLimits.logBytes / 2) + 1;
    const script = defineScript({
      ...base,
      run: () =>
        Effect.gen(function* () {
          yield* Effect.log("a".repeat(half));
          yield* Effect.log("b".repeat(half));
          return "ok";
        }),
    });

    const result = await direct(script);

    expect(result.logs).toHaveLength(1);
    expect(result.truncation).toEqual([
      { reason: "event_bytes", observed: half, limit: RunLimits.logEventBytes },
      { reason: "total_bytes", observed: half * 2, limit: RunLimits.logBytes },
    ]);
  });
});

describe("JSON copies and transport", () => {
  it("refuses arrays that are not plain arrays", () => {
    class Tagged extends Array<number> {}

    expect(() => copyJson(Tagged.from([1]))).toThrow("Value is not a plain JSON array.");
  });

  it("copies only enumerable own properties", () => {
    const value = { shown: 1 };
    Object.defineProperty(value, "hidden", { value: 2, enumerable: false });

    expect(JSON.stringify(copyJson(value))).toBe('{"shown":1}');
  });

  it("transports a failure without diagnostics when it has no cause", async () => {
    const recognized = inspectScriptDefinition(
      defineScript({
        ...base,
        secrets: ["TOKEN"],
        run: () => Effect.map(Secret("TOKEN"), () => "ok"),
      }),
    );
    if (!recognized.ok) throw new Error("Expected recognized definition");

    const encoded = encodeRunOutcome(
      await runScript(recognized.definition, { input: {}, services: {} }),
    );

    expect(encoded.primary).toEqual({
      status: "failure",
      stage: "preflight",
      code: "missing_capability",
      message: "Missing declared secret TOKEN.",
    });
  });
});
