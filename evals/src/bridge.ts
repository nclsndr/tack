import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { posix } from "node:path";
import type { CommandEvidence, CommandRequest, CommandResult } from "./contract.ts";
import { record } from "./plan.ts";

/** Validate untrusted MCP arguments before touching Docker; argv never enters a host shell. */
export function commandRequest(value: unknown): CommandRequest {
  const input = record(value);
  const argv = input["argv"];
  const cwd = input["cwd"];
  if (
    Object.keys(input).some((key) => key !== "argv" && key !== "cwd") ||
    Array.isArray(argv) === false ||
    argv.length === 0 ||
    argv.length > 128 ||
    argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    typeof cwd !== "string" ||
    cwd.includes("\0") ||
    (posix.normalize(cwd) !== "/world" && posix.normalize(cwd).startsWith("/world/") === false)
  )
    throw new Error("Expected argv and contained /world cwd");
  return {
    argv: argv.filter((arg): arg is string => typeof arg === "string"),
    cwd: posix.normalize(cwd),
  };
}
/** Expose only an authenticated bounded command endpoint; the closure fixes its task container. */
export async function startBridge(options: {
  exec: (request: CommandRequest) => Promise<CommandResult>;
  toolCalls: number;
  outputBytes: number;
  onCommand?: (command: CommandEvidence) => Promise<void>;
}): Promise<{
  url: string;
  token: string;
  commands: CommandEvidence[];
  denials: { toolCalls: number; outputBytes: number; busy: number };
  close: () => Promise<void>;
}> {
  const token = randomBytes(32).toString("hex");
  const commands: CommandEvidence[] = [];
  const denials = { toolCalls: 0, outputBytes: 0, busy: 0 };
  let calls = 0;
  let bytes = 0;
  let busy = false;
  const server = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== `Bearer ${token}`) {
      reply(401, { error: "Unauthorized" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/") {
      reply(404, { error: "Unknown endpoint" });
      return;
    }
    const reasons = [
      ...(busy === true ? ["command-busy"] : []),
      ...(calls >= options.toolCalls ? ["tool-call-limit"] : []),
      ...(bytes >= options.outputBytes ? ["output-budget-limit"] : []),
    ];
    if (reasons.length > 0) {
      if (busy === true) denials.busy += 1;
      if (calls >= options.toolCalls) denials.toolCalls += 1;
      if (bytes >= options.outputBytes) denials.outputBytes += 1;
      reply(429, { code: reasons[0], reasons, error: `Trial denied: ${reasons.join(", ")}` });
      return;
    }
    busy = true;
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 16384) throw new Error("Command request too large");
      }
      const command = commandRequest(JSON.parse(body));
      calls += 1;
      const result = await options.exec(command);
      const evidence = { ...command, ...result };
      commands.push(evidence);
      bytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      await options.onCommand?.(evidence);
      reply(200, { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    } catch (error) {
      reply(400, { error: String(error) });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  // Coverage skip: a listening TCP server always reports an address object, never a pipe name.
  /* v8 ignore next -- @preserve */
  if (address === null || typeof address === "string") throw new Error("Bridge did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    token,
    commands,
    denials,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
    },
  };
}
