import { describe, expect, it } from "vitest";
import { definitionFailureCodes } from "@tackup/core";
import { Schema } from "effect";
import {
  admitFrame,
  encodeFrame,
  maximumFrameBytes,
  ProtocolFailure,
  TerminalPayloadSchema,
  workerFailureCodes,
  type Frame,
  type WorkerState,
} from "./protocol.ts";

const frame = (kind: Frame["kind"], payload: Frame["payload"]): Frame => ({
  version: 1,
  runId: "run",
  kind,
  payload,
});
const states: ReadonlyArray<WorkerState> = [
  "starting",
  "loading",
  "requirements",
  "prepared",
  "running",
  "terminal",
];
const core = { status: "success" };
const failure = (stage: string, code = "module_load_failed") => ({
  failure: { stage, code, message: "Failed." },
});
/** The states in which each frame is admitted; every other state rejects it. */
const lifecycle: ReadonlyArray<readonly [string, Frame, ReadonlyArray<WorkerState>]> = [
  ["load stage", frame("stage", { stage: "load" }), ["starting"]],
  ["execution stage", frame("stage", { stage: "execution" }), ["prepared"]],
  ["requirements", frame("requirements", { secrets: [], services: ["Shell"] }), ["loading"]],
  ["log", frame("log", { source: "effect", content: "x" }), ["running"]],
  ["shell start", frame("shell-start", { pid: 7 }), ["running"]],
  ["shell end", frame("shell-end", { pid: 7 }), ["running"]],
  ["core terminal", frame("terminal", { core, coreTruncation: [] }), ["running"]],
  ["load failure terminal", frame("terminal", failure("load")), ["loading"]],
  [
    "described terminal",
    frame("terminal", { described: { args: { name: { type: "string" } }, secrets: [] } }),
    ["loading"],
  ],
  [
    "preflight failure terminal",
    frame("terminal", failure("preflight", "invalid_definition")),
    ["loading", "requirements"],
  ],
  [
    "worker failure terminal",
    frame("terminal", failure("worker", "worker_failure")),
    ["loading", "requirements", "prepared", "running"],
  ],
  ["start", frame("start", { entrypoint: "x", cwd: "/", input: null }), []],
  ["capabilities", frame("capabilities", { secrets: {} }), []],
  ["cancel", frame("cancel", {}), []],
];

describe("worker frame admission", () => {
  it.each(lifecycle)(
    "admits the %s frame only in its lifecycle states",
    (_name, input, allowed) => {
      for (const state of states) {
        if (allowed.includes(state)) expect(() => admitFrame(state, input)).not.toThrow();
        else expect(() => admitFrame(state, input), state).toThrow(ProtocolFailure);
      }
    },
  );

  it("returns the transition and decoded payload for the caller to apply", () => {
    expect(admitFrame("starting", frame("stage", { stage: "load" }))).toEqual({
      kind: "stage",
      next: "loading",
      lastStage: "load",
    });
    expect(admitFrame("prepared", frame("stage", { stage: "execution" }))).toEqual({
      kind: "stage",
      next: "running",
      lastStage: "execution",
    });
    expect(
      admitFrame("loading", frame("requirements", { secrets: ["TOKEN"], services: [] })),
    ).toEqual({
      kind: "requirements",
      next: "requirements",
      lastStage: "preflight",
      requirements: { secrets: ["TOKEN"], services: [] },
    });
    expect(admitFrame("running", frame("shell-end", { pid: 7 }))).toEqual({
      kind: "shell-end",
      pid: 7,
    });
    expect(admitFrame("running", frame("terminal", { core, coreTruncation: [] }))).toEqual({
      kind: "terminal",
      next: "terminal",
      terminal: { core, coreTruncation: [] },
    });
  });

  it.each([
    [
      "requirements with an unknown service",
      "loading",
      frame("requirements", { secrets: [], services: ["Network"] }),
    ],
    [
      "requirements with an excess field",
      "loading",
      frame("requirements", { secrets: [], services: [], extra: 1 }),
    ],
    ["an unknown stage", "starting", frame("stage", { stage: "output" })],
    ["a log from an unknown source", "running", frame("log", { source: "stdout", content: "x" })],
    ["a non-positive process group", "running", frame("shell-start", { pid: 0 })],
    [
      "a terminal with both core and failure",
      "running",
      frame("terminal", { core, ...failure("worker", "worker_failure") }),
    ],
    ["a terminal with neither core nor failure", "running", frame("terminal", {})],
    [
      "a terminal with both a description and a failure",
      "loading",
      frame("terminal", { described: { args: {}, secrets: [] }, ...failure("load") }),
    ],
    [
      "a terminal with an unknown failure code",
      "loading",
      frame("terminal", failure("load", "nonsense")),
    ],
  ] as const)("rejects %s as a protocol failure", (_name, state, input) => {
    expect(() => admitFrame(state, input)).toThrow(ProtocolFailure);
  });
});

describe("worker terminal vocabulary", () => {
  it("accepts every core definition failure code as a preflight failure", () => {
    expect(workerFailureCodes).toEqual(expect.arrayContaining([...definitionFailureCodes]));
    for (const code of definitionFailureCodes)
      expect(
        Schema.decodeUnknownSync(TerminalPayloadSchema)(failure("preflight", code)),
      ).toMatchObject({ failure: { code } });
  });
});

describe("worker frame encoding", () => {
  it("refuses to encode a frame larger than the frame limit", () => {
    const content = "x".repeat(maximumFrameBytes);
    expect(() => encodeFrame(frame("log", { source: "effect", content }))).toThrow(ProtocolFailure);
    expect(encodeFrame(frame("log", { source: "effect", content: "x" })).readUInt32BE()).toBe(
      JSON.stringify(frame("log", { source: "effect", content: "x" })).length,
    );
  });
});
