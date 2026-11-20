import { Schema } from "effect";
import { definitionFailureCodes } from "@tackup/core";
import { ScriptDeclarationsSchema } from "../../domain/execution/execution-schema.ts";

/** Maximum bytes in one private worker frame. */
export const maximumFrameBytes = 16 * 1024 * 1024;
/** Common private protocol header; payload validation belongs to each lifecycle transition. */
const FrameSchema = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  kind: Schema.Literals([
    "start",
    "stage",
    "requirements",
    "capabilities",
    "cancel",
    "log",
    "shell-start",
    "shell-end",
    "terminal",
  ]),
  payload: Schema.Json,
});
export type Frame = typeof FrameSchema.Type;

/** Supervisor to worker: the one run the worker executes. */
export const StartPayloadSchema = Schema.Struct({
  entrypoint: Schema.String,
  cwd: Schema.String,
  input: Schema.Json,
  words: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Load the script and report what it declares instead of running it. */
  describe: Schema.optionalKey(Schema.Literal(true)),
});
/** Supervisor to worker: values for the declared secrets. */
export const CapabilitiesPayloadSchema = Schema.Struct({
  secrets: Schema.Record(Schema.String, Schema.String),
});
/** Worker to supervisor: the lifecycle stage the worker entered. */
const StagePayloadSchema = Schema.Struct({ stage: Schema.Literals(["load", "execution"]) });
/** Worker to supervisor: the recognized definition's declared capabilities. */
const RequirementsPayloadSchema = Schema.Struct({
  secrets: Schema.Array(Schema.String),
  services: Schema.Array(Schema.Literal("Shell")),
});
/** Worker to supervisor: one captured Effect log or Shell output chunk. */
const LogPayloadSchema = Schema.Struct({
  source: Schema.Literals(["script", "shell"]),
  content: Schema.String,
});
/** Worker to supervisor: one Shell process group the worker started or settled. */
const ShellGroupPayloadSchema = Schema.Struct({
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
/** Codes the worker reports before a core outcome exists, including every core recognition code. */
export const workerFailureCodes = [
  "dependency_unavailable",
  "module_load_failed",
  "invalid_args",
  ...definitionFailureCodes,
  "protocol_failure",
  "worker_failure",
] as const;
/** Worker to supervisor: exactly one encoded core outcome or one worker failure. */
export const TerminalPayloadSchema = Schema.Struct({
  core: Schema.optionalKey(Schema.Json),
  coreTruncation: Schema.optionalKey(Schema.Array(Schema.Json)),
  failure: Schema.optionalKey(
    Schema.Struct({
      stage: Schema.Literals(["load", "preflight", "worker"]),
      code: Schema.Literals(workerFailureCodes),
      message: Schema.String,
    }),
  ),
  diagnostics: Schema.optionalKey(Schema.Json),
  /** What the script declares, in place of a run, when the start asked to describe it. */
  described: Schema.optionalKey(ScriptDeclarationsSchema),
});
export type TerminalPayload = typeof TerminalPayloadSchema.Type;
export type WorkerFailure = NonNullable<TerminalPayload["failure"]>;

/** Reports malformed private traffic without echoing potentially secret payloads. */
export class ProtocolFailure extends Error {
  constructor() {
    super("The worker sent invalid private protocol traffic.");
  }
}

/** Decodes one frame payload strictly, rejecting excess fields. */
export const decodePayload = <A>(schema: Schema.Codec<A, unknown>, payload: unknown): A =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(payload);

/** The supervisor's view of one worker's lifecycle. */
export type WorkerState =
  | "starting"
  | "loading"
  | "requirements"
  | "prepared"
  | "running"
  | "terminal";
/** One worker frame admitted in the current lifecycle state, with its decoded payload. */
export type FrameAdmission =
  | {
      readonly kind: "stage";
      readonly next: "loading" | "running";
      readonly lastStage: "load" | "execution";
    }
  | {
      readonly kind: "requirements";
      readonly next: "requirements";
      readonly lastStage: "preflight";
      readonly requirements: typeof RequirementsPayloadSchema.Type;
    }
  | { readonly kind: "log"; readonly log: typeof LogPayloadSchema.Type }
  | { readonly kind: "shell-start" | "shell-end"; readonly pid: number }
  | { readonly kind: "terminal"; readonly next: "terminal"; readonly terminal: TerminalPayload };

/** Whether a terminal report carries exactly one kind of evidence matching the stage reached. */
const terminalMatchesState = (state: WorkerState, terminal: TerminalPayload) =>
  state !== "starting" &&
  [terminal.core, terminal.failure, terminal.described].filter((item) => item !== undefined)
    .length === 1 &&
  (terminal.core === undefined || state === "running") &&
  (terminal.described === undefined || state === "loading") &&
  (terminal.failure?.stage !== "load" || state === "loading") &&
  (terminal.failure?.stage !== "preflight" || state === "loading" || state === "requirements");

const admit = (state: WorkerState, frame: Frame): FrameAdmission => {
  if (state === "terminal") throw new ProtocolFailure();
  if (frame.kind === "stage") {
    const { stage } = decodePayload(StagePayloadSchema, frame.payload);
    if (stage === "load" && state === "starting")
      return { kind: "stage", next: "loading", lastStage: "load" };
    if (stage === "execution" && state === "prepared")
      return { kind: "stage", next: "running", lastStage: "execution" };
    throw new ProtocolFailure();
  }
  if (frame.kind === "requirements" && state === "loading")
    return {
      kind: "requirements",
      next: "requirements",
      lastStage: "preflight",
      requirements: decodePayload(RequirementsPayloadSchema, frame.payload),
    };
  if (frame.kind === "log" && state === "running")
    return { kind: "log", log: decodePayload(LogPayloadSchema, frame.payload) };
  if ((frame.kind === "shell-start" || frame.kind === "shell-end") && state === "running")
    return { kind: frame.kind, pid: decodePayload(ShellGroupPayloadSchema, frame.payload).pid };
  if (frame.kind === "terminal") {
    const terminal = decodePayload(TerminalPayloadSchema, frame.payload);
    if (terminalMatchesState(state, terminal) === true)
      return { kind: "terminal", next: "terminal", terminal };
  }
  throw new ProtocolFailure();
};

/**
 * Admits one worker frame in the supervisor's lifecycle order: load, requirements, prepared
 * capabilities, execution, then exactly one terminal report. Admission is pure: the caller
 * applies the returned transition only after the frame and its payload are accepted. Every other
 * frame, including a malformed payload, is a protocol failure.
 */
export const admitFrame = (state: WorkerState, frame: Frame): FrameAdmission => {
  try {
    return admit(state, frame);
  } catch {
    throw new ProtocolFailure();
  }
};

/** Encodes a validated JSON frame independently of worker stdout and stderr. */
export const encodeFrame = (frame: Frame): Buffer => {
  const body = Buffer.from(JSON.stringify(frame));
  if (body.length > maximumFrameBytes) throw new ProtocolFailure();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};

/** Incrementally decodes bounded length-prefixed frames, rejecting truncated endings. */
export class FrameDecoder {
  private buffered = Buffer.alloc(0);
  push(chunk: Uint8Array): ReadonlyArray<Frame> {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: Frame[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE();
      if (length === 0 || length > maximumFrameBytes) throw new ProtocolFailure();
      if (this.buffered.length < length + 4) break;
      try {
        frames.push(
          Schema.decodeUnknownSync(FrameSchema, { onExcessProperty: "error" })(
            JSON.parse(this.buffered.subarray(4, length + 4).toString("utf8")),
          ),
        );
      } catch {
        throw new ProtocolFailure();
      }
      this.buffered = this.buffered.subarray(length + 4);
    }
    return frames;
  }
  end(): void {
    if (this.buffered.length !== 0) throw new ProtocolFailure();
  }
}
