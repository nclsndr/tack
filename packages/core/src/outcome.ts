import { type Cause, type LogLevel } from "effect";
import type { EncodedRunOutcome } from "./outcome-schema.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type RunStage = "preflight" | "input" | "construction" | "execution" | "output" | "cleanup";
export type FailureCode =
  | "invalid_definition"
  | "unsupported_contract"
  | "unknown_capability"
  | "missing_capability"
  | "invalid_input"
  | "input_too_large"
  | "schema_defect"
  | "construction_defect"
  | "invalid_program"
  | "expected_failure"
  | "capability_failure"
  | "executed_defect"
  | "interrupted"
  | "unexpected_failure"
  | "invalid_expected_failure"
  | "invalid_output"
  | "boundary_too_large"
  | "cleanup_failed";
export type CauseDiagnostic = {
  readonly kind: "Fail" | "Die" | "Interrupt";
  readonly message: string;
};
export type RunFailure = {
  readonly status: "failure";
  readonly stage: RunStage;
  readonly code: FailureCode;
  readonly message: string;
  readonly cause?: Cause.Cause<unknown>;
  readonly diagnostics?: readonly CauseDiagnostic[];
  readonly encoded?: JsonValue;
  readonly encodedFailures?: readonly JsonValue[];
};
export type RunSuccess<A = unknown> = {
  readonly status: "success";
  readonly stage: "output";
  readonly code: "success";
  readonly value: A;
  readonly encoded: JsonValue;
};
export type PrimaryOutcome<A = unknown> = RunSuccess<A> | RunFailure;
export type RunLog = {
  readonly source: "script";
  readonly sequence: number;
  readonly timestamp: string;
  readonly content: string;
  readonly level: LogLevel.LogLevel;
};
export type LogTruncation = {
  readonly reason: "event_bytes" | "total_bytes" | "event_count";
  readonly observed: number;
  readonly limit: number;
};
export type Finalization =
  | { readonly status: "not_started" | "complete" }
  | {
      readonly status: "failed";
      readonly cause: Cause.Cause<unknown>;
      readonly diagnostics: readonly CauseDiagnostic[];
    };
export type RunOutcome<A = unknown> = {
  readonly status: "success" | "failure";
  readonly stage: RunStage;
  readonly code: FailureCode | "success";
  readonly primary: PrimaryOutcome<A>;
  readonly finalization: Finalization;
  readonly logs: readonly RunLog[];
  readonly truncation: readonly LogTruncation[];
  readonly encodedInput?: JsonValue;
  readonly execution?:
    | { readonly status: "success"; readonly value: A }
    | { readonly status: "failure"; readonly cause: Cause.Cause<unknown> };
};

export const RunLimits = {
  inputBytes: 1024 * 1024,
  boundaryBytes: 1024 * 1024,
  logEventBytes: 64 * 1024,
  logBytes: 10 * 1024 * 1024,
  logEvents: 10_000,
} as const;

/** Copies JSON data without invoking user serialization hooks or object getters. */
export function copyJson(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const copy = (item: unknown): JsonValue => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || item === null || ancestors.has(item))
      throw new Error("Value is not JSON data.");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype)
          throw new Error("Value is not a plain JSON array.");
        const result: JsonValue[] = [];
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (descriptor === undefined || !("value" in descriptor))
            throw new Error("JSON arrays must contain plain values.");
          result.push(copy(descriptor.value));
        }
        return result;
      }
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("Value is not a JSON object.");
      const result: Record<string, JsonValue> = Object.create(null);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (descriptor.enumerable !== true) continue;
        if (!("value" in descriptor)) throw new Error("JSON data cannot contain accessors.");
        result[key] = copy(descriptor.value);
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };
  return copy(value);
}

/** Produces only boundary-encoded values and bounded diagnostic text for transport/history. */
export function encodeRunOutcome(outcome: RunOutcome): EncodedRunOutcome {
  const primary =
    outcome.primary.status === "success"
      ? {
          status: outcome.primary.status,
          stage: outcome.primary.stage,
          code: outcome.primary.code,
          encoded: outcome.primary.encoded,
        }
      : {
          status: outcome.primary.status,
          stage: outcome.primary.stage,
          code: outcome.primary.code,
          message: outcome.primary.message,
          ...(outcome.primary.encoded === undefined ? {} : { encoded: outcome.primary.encoded }),
          ...(outcome.primary.encodedFailures === undefined
            ? {}
            : { encodedFailures: outcome.primary.encodedFailures }),
          ...(outcome.primary.diagnostics === undefined
            ? {}
            : { diagnostics: outcome.primary.diagnostics }),
        };
  return {
    status: outcome.status,
    stage: outcome.stage,
    code: outcome.code,
    primary,
    finalization:
      outcome.finalization.status === "failed"
        ? { status: "failed", diagnostics: outcome.finalization.diagnostics }
        : outcome.finalization,
    logs: outcome.logs,
    truncation: outcome.truncation,
    ...(outcome.encodedInput === undefined ? {} : { encodedInput: outcome.encodedInput }),
  };
}

/**
 * An error a script-API script threw, already stripped of its secret values. Its message becomes the
 * run's message, so the author can read why the script stopped.
 */
export class ScriptError extends Error {
  override readonly name = "ScriptError";
}
