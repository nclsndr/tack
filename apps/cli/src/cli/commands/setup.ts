import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { handle } from "./invocation-receiver.ts";
import { operationContract } from "./operation-contract.ts";
import { decodeAdapters, repeatableAdapterFlag } from "./reconciliation.ts";

/** One repeatable machine setup, written at once: state, agents and their user links. */
export const initCommand = Command.make(
  "init",
  {
    adapters: repeatableAdapterFlag(
      "Enable this agent instead of the detected ones; repeatable. It never disables an enabled one",
    ),
  },
  handle(
    "machine-init",
    Effect.fnUntraced(function* ({ adapters }) {
      return {
        _tag: "machine-init",
        ...(adapters.length === 0 ? {} : { adapters: yield* decodeAdapters(adapters) }),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Set up this machine and say what was written: the state, the agents found in your home (~/.claude, ~/.codex or ~/.agents, ~/.cursor) and their user links, which are the built-in skills on a new machine. Hand-made entries are listed and left alone. Safe to repeat, and the one step after an upgrade",
  ),
  Command.withExamples([
    { command: "tack init" },
    { command: "tack init --adapter claude --adapter cursor" },
  ]),
  // It writes at once and reports what it planned beside what it applied.
  operationContract({ mutation: "immediate", slots: ["plan", "applied"] }),
);
