import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  defineScript,
  encodeRunOutcome,
  EncodedRunOutcomeSchema,
  NoExpectedFailure,
  runScript,
  RunLimits,
} from "../src/index.ts";

const success = {
  status: "success",
  stage: "output",
  code: "success",
  primary: { status: "success", stage: "output", code: "success", encoded: { value: 1 } },
  finalization: { status: "complete" },
  logs: [],
  truncation: [],
};
const decode = Schema.decodeUnknownSync(EncodedRunOutcomeSchema, { onExcessProperty: "error" });

describe("encoded run outcome", () => {
  it("accepts actual success, expected failure, defect, interruption and cleanup projections", async () => {
    const base = {
      contract: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      error: Schema.String,
      secrets: [],
      services: [],
    } as const;
    for (const program of [
      Effect.succeed("ok"),
      Effect.fail("domain"),
      Effect.die("defect"),
      Effect.interrupt,
    ]) {
      const script = defineScript({ ...base, run: () => program });
      const outcome = encodeRunOutcome(await runScript(script, { input: {}, services: {} }));
      expect(decode(outcome)).toEqual(outcome);
    }
    const script = defineScript({
      ...base,
      error: NoExpectedFailure,
      run: () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.die("cleanup"));
          yield* Effect.log("log");
          return "ok";
        }),
    });
    const outcome = encodeRunOutcome(await runScript(script, { input: {}, services: {} }));
    expect(decode(outcome)).toEqual(outcome);
    expect(
      decode(
        encodeRunOutcome(
          await runScript(
            defineScript({ ...base, input: Schema.String, run: () => Effect.succeed("ok") }),
            { input: 12, services: {} },
          ),
        ),
      ).code,
    ).toBe("invalid_input");
  });

  it.each([
    { status: "invented" },
    { stage: "invented" },
    { code: "invented" },
    { primary: {} },
    { finalization: {} },
    { primary: { ...success.primary, encoded: undefined } },
    { primary: { ...success.primary, stage: "execution" } },
    { primary: { ...success.primary, value: "raw runtime value" } },
    { execution: { status: "success", value: {} } },
    { status: "failure" },
    { code: "invalid_output" },
    { finalization: { status: "not_started" } },
    { finalization: { status: "failed", diagnostics: [] } },
    { status: "failure", stage: "cleanup", code: "cleanup_failed" },
  ])("rejects malformed or inconsistent transport fields %#", (change) => {
    expect(() => decode({ ...success, ...change })).toThrow();
  });

  it("requires encoded expected failures and rejects unrelated failure stages", () => {
    const primary = {
      status: "failure",
      stage: "execution",
      code: "expected_failure",
      message: "failed",
      encoded: null,
      encodedFailures: [null],
    };
    const expected = {
      ...success,
      status: "failure",
      stage: "execution",
      code: "expected_failure",
      primary,
    };
    expect(decode(expected)).toEqual(expected);
    expect(() => decode({ ...expected, primary: { ...primary, encodedFailures: [] } })).toThrow();
    expect(() => decode({ ...expected, primary: { ...primary, encoded: undefined } })).toThrow();
    expect(() =>
      decode({ ...expected, stage: "output", primary: { ...primary, stage: "output" } }),
    ).toThrow();
    expect(() => decode({ ...expected, primary: { ...primary, cause: {} } })).toThrow();
  });

  it("rejects non-JSON and oversized encoded data", () => {
    for (const encoded of [
      new Map(),
      new Date(),
      NaN,
      Infinity,
      { value: undefined },
      "x".repeat(RunLimits.boundaryBytes),
    ]) {
      expect(() => decode({ ...success, primary: { ...success.primary, encoded } })).toThrow();
    }
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => decode({ ...success, primary: { ...success.primary, encoded: cycle } })).toThrow();
  });

  it("checks log order, bytes, levels, timestamps and truncation evidence", () => {
    const log = {
      source: "script",
      sequence: 1,
      timestamp: "2026-10-21T00:00:00.000Z",
      content: "ok",
      level: "Info",
    };
    expect(decode({ ...success, logs: [log] }).logs).toEqual([log]);
    for (const change of [
      { sequence: 0 },
      { sequence: 2 },
      { sequence: 1.5 },
      { timestamp: "today" },
      { level: "custom" },
      { source: "shell" },
      { content: "x".repeat(RunLimits.logEventBytes + 1) },
    ]) {
      expect(() => decode({ ...success, logs: [{ ...log, ...change }] })).toThrow();
    }
    const truncation = { reason: "event_count", observed: 10_001, limit: 10_000 };
    expect(decode({ ...success, truncation: [truncation] }).truncation).toEqual([truncation]);
    expect(() => decode({ ...success, truncation: [{ ...truncation, observed: 1 }] })).toThrow();
    expect(() => decode({ ...success, truncation: [{ ...truncation, limit: 1 }] })).toThrow();
    expect(() => decode({ ...success, truncation: [truncation, truncation] })).toThrow();
  });
});

describe("encoded run outcome agreement", () => {
  const preflight = {
    status: "failure",
    stage: "preflight",
    code: "missing_capability",
    primary: {
      status: "failure",
      stage: "preflight",
      code: "missing_capability",
      message: "Missing declared secret TOKEN.",
    },
    finalization: { status: "not_started" },
    logs: [],
    truncation: [],
  };

  it("refuses a pre-execution failure whose finalization started", () => {
    expect(decode(preflight)).toEqual(preflight);
    expect(() => decode({ ...preflight, finalization: { status: "complete" } })).toThrow(
      "Pre-execution failures cannot have started finalization.",
    );
  });

  it("refuses captured logs whose total exceeds the byte limit", () => {
    const perLog = RunLimits.logEventBytes;
    const count = Math.floor(RunLimits.logBytes / perLog) + 1;
    const logs = Array.from({ length: count }, (_, index) => ({
      source: "script",
      sequence: index + 1,
      timestamp: "2026-10-21T00:00:00.000Z",
      content: "x".repeat(perLog),
      level: "Info",
    }));

    expect(() => decode({ ...success, logs })).toThrow(
      "Captured logs exceed their total byte limit.",
    );
  });

  it("accepts total-bytes truncation evidence only against the total log limit", () => {
    const truncation = {
      reason: "total_bytes",
      observed: RunLimits.logBytes + 1,
      limit: RunLimits.logBytes,
    };

    expect(decode({ ...success, truncation: [truncation] }).truncation).toEqual([truncation]);
    expect(() =>
      decode({ ...success, truncation: [{ ...truncation, limit: RunLimits.logEventBytes }] }),
    ).toThrow();
  });
});
