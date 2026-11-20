import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  classifyRunFailure,
  HistoryRecordSchema,
  runFailure,
  type RunFailure,
} from "./execution-schema.ts";

type Pin = readonly [RunFailure["stage"], string, RunFailure["classification"]];

// Every stage and code an operator run produces, with the classification its producer assigned
// before classification moved into one function.
const pins: ReadonlyArray<Pin> = [
  // Core outcomes, projected by the supervisor.
  ["output", "success", "success"],
  ["execution", "interrupted", "interruption"],
  ["execution", "expected_failure", "domain"],
  ["execution", "capability_failure", "domain"],
  ["execution", "invalid_expected_failure", "domain"],
  ["execution", "boundary_too_large", "domain"],
  ["output", "invalid_output", "domain"],
  ["output", "boundary_too_large", "domain"],
  ["cleanup", "cleanup_failed", "domain"],
  ["preflight", "invalid_definition", "invalid-configuration"],
  ["preflight", "unsupported_contract", "invalid-configuration"],
  ["preflight", "unknown_capability", "invalid-configuration"],
  ["preflight", "missing_capability", "invalid-configuration"],
  ["input", "invalid_input", "invalid-configuration"],
  ["input", "input_too_large", "invalid-configuration"],
  ["input", "schema_defect", "invalid-configuration"],
  ["construction", "construction_defect", "internal"],
  ["construction", "invalid_program", "internal"],
  ["execution", "executed_defect", "internal"],
  ["execution", "unexpected_failure", "internal"],
  ["execution", "schema_defect", "internal"],
  ["output", "schema_defect", "internal"],
  // Worker terminal failures, classified by the supervisor.
  ["load", "dependency_unavailable", "invalid-configuration"],
  ["load", "module_load_failed", "invalid-configuration"],
  ["load", "protocol_failure", "invalid-configuration"],
  ["preflight", "worker_failure", "invalid-configuration"],
  ["worker", "protocol_failure", "internal"],
  ["worker", "worker_failure", "internal"],
  // Supervisor observations.
  ["execution", "timeout", "domain"],
  ["worker", "unexpected_worker_exit", "internal"],
  ["worker", "worker_spawn_failed", "internal"],
  ["preflight", "secret_missing", "invalid-configuration"],
  ["preflight", "secret_configuration_failed", "invalid-configuration"],
  // Source readiness, from the platform adapter.
  ["preflight", "package_manifest_unavailable", "invalid-configuration"],
  ["preflight", "package_manifest_invalid", "invalid-configuration"],
  ["preflight", "entrypoint_unavailable", "invalid-configuration"],
  ["preflight", "entrypoint_unsupported", "invalid-configuration"],
  ["preflight", "dependency_unavailable", "invalid-configuration"],
  // Invocation, from the feature and the input transport.
  ["invocation", "run_targets_conflict", "invalid-invocation"],
  ["invocation", "timeout_invalid", "invalid-invocation"],
  ["invocation", "input_sources_conflict", "invalid-invocation"],
  ["invocation", "input_file_read_failed", "invalid-invocation"],
  ["invocation", "input_too_large", "invalid-invocation"],
  ["invocation", "input_json_invalid", "invalid-invocation"],
  ["invocation", "input_stdin_read_failed", "invalid-invocation"],
  // Resolution, from the feature.
  ["resolution", "state_storage_failed", "persistence"],
  ["resolution", "state_busy", "domain"],
  ["resolution", "run_resolution_failed", "invalid-configuration"],
  ["resolution", "run_root_not_registered", "invalid-configuration"],
  ["resolution", "run_target_not_unique", "invalid-configuration"],
  ["resolution", "run_target_unavailable", "invalid-configuration"],
  ["resolution", "script_address_ambiguous", "invalid-configuration"],
  ["resolution", "script_not_found", "invalid-configuration"],
  // History persistence, from the platform adapter.
  ["history", "history_create_failed", "persistence"],
  ["history", "history_finish_failed", "persistence"],
  ["history", "history_read_failed", "persistence"],
  ["history", "history_clear_failed", "persistence"],
  // Host validation of the returned run result.
  ["worker", "run_result_invalid", "internal"],
];

describe("run failure classification", () => {
  it.each(pins)("classifies %s %s as %s", (stage, code, classification) => {
    expect(classifyRunFailure(stage, code)).toBe(classification);
  });

  it("builds failures with their derived classification and optional details", () => {
    expect(runFailure("resolution", "script_not_found", "Missing.")).toEqual({
      stage: "resolution",
      code: "script_not_found",
      message: "Missing.",
      classification: "invalid-configuration",
    });
    expect(
      runFailure("worker", "unexpected_worker_exit", "Exited.", { lastStage: "load" }),
    ).toEqual({
      stage: "worker",
      code: "unexpected_worker_exit",
      message: "Exited.",
      classification: "internal",
      details: { lastStage: "load" },
    });
  });
});

describe("run history records", () => {
  const pending = {
    version: 1,
    runId: "run-1",
    status: "pending",
    startedAt: "2026-11-16T00:00:00.000Z",
    address: {
      kind: "script",
      name: "deploy",
      sourceRegistrationId: "21380456-fa78-4ed4-95ae-110da2a6d41c",
    },
  };

  it("accepts a pending record without terminal fields", () => {
    expect(Schema.decodeUnknownSync(HistoryRecordSchema)(pending)).toEqual(pending);
  });

  it("refuses a pending record that already has a finish time", () => {
    expect(() =>
      Schema.decodeUnknownSync(HistoryRecordSchema)({
        ...pending,
        finishedAt: "2026-11-16T00:00:01.000Z",
      }),
    ).toThrow("Pending history cannot contain terminal fields.");
  });
});
