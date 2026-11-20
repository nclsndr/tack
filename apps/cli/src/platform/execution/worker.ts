// Coverage skip: this worker entrypoint runs only in the supervised child, invisible to parent coverage.
/* v8 ignore start -- @preserve */
import { createReadStream, createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { encodeRunOutcome, inspectScriptDefinition, runScript } from "@tackup/core";
import {
  CapabilitiesPayloadSchema,
  decodePayload,
  encodeFrame,
  FrameDecoder,
  ProtocolFailure,
  StartPayloadSchema,
  type Frame,
  type WorkerFailure,
} from "./protocol.ts";
import { makeLiveShell } from "./shell.ts";
import { publishedPackageName } from "../../domain/execution/published-name.ts";
import { declarationsOf, prepareScript } from "./script-api-adapter.ts";
import { installScriptApi, scriptApiUrl } from "./script-api-hooks.ts";

// A script imports the Tack that runs it under the published name; nothing is installed.
installScriptApi(publishedPackageName, scriptApiUrl);

// The executable needs this switch to start the sidecar as Bun. Scripts and their shells do not.
delete process.env["BUN_BE_BUN"];

const input = createReadStream("", { fd: 3, autoClose: true });
const output = createWriteStream("", { fd: 4, autoClose: true });
const decoder = new FrameDecoder();
const abort = new AbortController();
let runId: string | undefined;
let state: "starting" | "loading" | "requirements" | "running" | "terminal" = "starting";
let capabilities: ((frame: Frame) => void) | undefined;
const send = (kind: Frame["kind"], payload: Schema.Json) => {
  if (runId === undefined) throw new ProtocolFailure();
  output.write(encodeFrame({ version: 1, runId, kind, payload }));
};
const terminal = async (payload: Schema.Json) => {
  state = "terminal";
  send("terminal", payload);
  output.end();
  input.destroy();
};
const failure = (
  stage: WorkerFailure["stage"],
  code: WorkerFailure["code"],
  message: string,
  diagnostics?: Schema.Json,
) =>
  terminal({
    failure: { stage, code, message },
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
const diagnostic = (error: unknown): Schema.Json => ({
  message: error instanceof Error ? error.message.slice(0, 65536) : "Unknown worker failure.",
  ...(error instanceof Error && error.stack !== undefined
    ? { stack: error.stack.slice(0, 65536) }
    : {}),
});

const execute = async (frame: Frame) => {
  const start = decodePayload(StartPayloadSchema, frame.payload);
  state = "loading";
  send("stage", { stage: "load" });
  let imported: unknown;
  try {
    imported = await import(pathToFileURL(start.entrypoint).href);
  } catch (error) {
    if (error instanceof Error && error.name === "ScriptDefinitionError") {
      await failure("load", "invalid_definition", error.message);
      return;
    }
    const dependency =
      error instanceof Error &&
      /Cannot find (?:module|package)|ModuleNotFound|ResolveMessage/.test(error.message);
    await failure(
      "load",
      dependency === true ? "dependency_unavailable" : "module_load_failed",
      dependency === true
        ? "A source dependency is unavailable. Install the source dependencies before running it."
        : "The script module could not be loaded.",
      diagnostic(error),
    );
    return;
  }
  const exported =
    typeof imported === "object" && imported !== null && "default" in imported
      ? imported.default
      : undefined;
  if (start.describe === true) {
    const declared = declarationsOf(exported);
    if (declared.ok === false) await failure("preflight", declared.code, declared.message);
    else
      await terminal({
        described: Schema.decodeUnknownSync(Schema.Json)(declared.declarations),
      });
    return;
  }
  const prepared = prepareScript(exported, start.input, start.cwd, start.words);
  if (prepared.ok === false) {
    await failure("preflight", prepared.code, prepared.message);
    return;
  }
  const definition = inspectScriptDefinition(prepared.definition);
  if (definition.ok === false) {
    await failure("preflight", definition.code, definition.message);
    return;
  }
  state = "requirements";
  const received = new Promise<Frame>((resolve) => {
    capabilities = resolve;
  });
  send("requirements", {
    secrets: [...definition.definition.secrets],
    services: [...definition.definition.services],
  });
  const supplied = decodePayload(CapabilitiesPayloadSchema, (await received).payload);
  state = "running";
  send("stage", { stage: "execution" });
  const result = await runScript(definition.definition, {
    // The script received its validated arguments already.
    input: {},
    services: {
      secrets: supplied.secrets,
      Shell: makeLiveShell({
        cwd: start.cwd,
        environment: process.env,
        onOutput: (content) => send("log", { source: "shell", content }),
        onStart: (pid) => send("shell-start", { pid }),
        onEnd: (pid) => send("shell-end", { pid }),
      }),
    },
    signal: abort.signal,
    onLog: (log) => send("log", { source: "script", content: log.content }),
  });
  const encoded = encodeRunOutcome(result);
  const { logs: _logs, truncation: _truncation, ...core } = encoded;
  await terminal({
    core: Schema.decodeUnknownSync(Schema.Json)(core),
    coreTruncation: Schema.decodeUnknownSync(Schema.Json)(encoded.truncation),
  });
};

input.on("data", (chunk: Buffer | string) => {
  try {
    for (const frame of decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)) {
      if (runId !== undefined && frame.runId !== runId) throw new ProtocolFailure();
      if (frame.kind === "start" && state === "starting") {
        runId = frame.runId;
        state = "loading";
        void execute(frame)
          .catch(async (error: unknown) => {
            if (state !== "terminal")
              await failure(
                "worker",
                error instanceof ProtocolFailure ? "protocol_failure" : "worker_failure",
                "The worker could not complete the run.",
                diagnostic(error),
              );
          })
          .catch(() => {
            process.exitCode = 3;
            input.destroy();
            output.destroy();
          });
      } else if (
        frame.kind === "capabilities" &&
        state === "requirements" &&
        capabilities !== undefined
      ) {
        capabilities(frame);
        capabilities = undefined;
      } else if (frame.kind === "cancel" && state !== "starting" && state !== "terminal")
        abort.abort();
      else throw new ProtocolFailure();
    }
  } catch {
    process.exitCode = 3;
    input.destroy();
    output.destroy();
  }
});
input.on("end", () => {
  if (state !== "terminal") {
    abort.abort();
    process.exitCode = 3;
  }
});
/* v8 ignore stop -- @preserve */
