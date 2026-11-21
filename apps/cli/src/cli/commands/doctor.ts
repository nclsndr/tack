import { Command } from "effect/cli";
import { receive } from "./invocation-receiver.ts";
import { readOnly } from "./operation-contract.ts";

/** The single read-only health report; it has no selector, no prompt and no repair mode. */
export const doctorCommand = Command.make("doctor", {}, () => receive({ _tag: "doctor" })).pipe(
  Command.withDescription(
    "Read-only, machine-wide health report: release, state, built-in skill, adapters, sources, published profile definitions, retained profile inventories, projects, links and docs. Each problem names its exact next command; any failed check exits 1",
  ),
  Command.withExamples([{ command: "tack doctor" }, { command: "tack --json doctor" }]),
  readOnly,
);
