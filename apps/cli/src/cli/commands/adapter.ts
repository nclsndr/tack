import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  AgentAdapterIdSchema,
  type AgentAdapterId,
} from "../../domain/agents/agent-adapter-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { listAlias } from "./list-alias.ts";
import { InvocationIssue } from "./model.ts";
import { cleanupDetailsFlag } from "./flag-utils.ts";
import { handle, receive } from "./invocation-receiver.ts";
import { applyFlag } from "./operation-contract.ts";

/** Decodes, deduplicates, and canonically orders adapter arguments. */
export const decodeAdapters = (adapters: ReadonlyArray<AgentAdapterId>) =>
  Schema.decodeUnknownEffect(
    Schema.Array(AgentAdapterIdSchema).check(
      Schema.makeFilter((values) =>
        new Set(values).size === values.length ? [] : ["Adapter IDs must be unique."],
      ),
    ),
  )(adapters).pipe(
    Effect.map((decoded) => [...decoded].sort(compareCodeUnits)),
    Effect.mapError(
      () =>
        new InvocationIssue({
          code: "invalid-flag",
          message: `Adapters must be unique IDs from: ${AgentAdapterIdSchema.literals.join(", ")}.`,
        }),
    ),
  );

const adapterArgument = Argument.Literals("adapter", AgentAdapterIdSchema.literals).pipe(
  Argument.withDescription(`Adapter ID: ${AgentAdapterIdSchema.literals.join(", ")}`),
);
const adapterEnableCommand = Command.make(
  "enable",
  { adapters: adapterArgument.pipe(Argument.variadic()) },
  handle(
    "adapter-enable",
    Effect.fnUntraced(function* ({ adapters }) {
      return { _tag: "adapter-enable", adapters: yield* decodeAdapters(adapters) };
    }),
  ),
).pipe(
  Command.withDescription(
    "Enable these adapters in addition to the enabled ones; removing one requires adapter disable",
  ),
  Command.withExamples([{ command: "tack adapter enable claude codex cursor" }]),
);
const adapterDisableCommand = Command.make(
  "disable",
  { adapter: adapterArgument, apply: applyFlag, details: cleanupDetailsFlag },
  ({ adapter, apply, details }) => receive({ _tag: "adapter-disable", adapter, apply, details }),
).pipe(
  Command.withDescription(
    "Preview removing an adapter's managed links and disabling it; --apply cleans up, then disables",
  ),
  Command.withExamples([
    { command: "tack adapter disable cursor" },
    { command: "tack adapter disable cursor --apply" },
  ]),
);
/** The `adapter` group: list, enable and disable the coding-agent adapters. */
export const adapterCommand = Command.make("adapter", {}, () =>
  receive({ _tag: "adapter-list" }),
).pipe(
  Command.withSubcommands([
    adapterEnableCommand,
    adapterDisableCommand,
    listAlias({}, () => receive({ _tag: "adapter-list" })),
  ]),
  Command.withDescription(
    "Enable and disable the coding-agent adapters that receive links; bare `adapter` lists the enabled ones",
  ),
  Command.withExamples([{ command: "tack adapter" }]),
);

/** A repeatable `--adapter ID` flag, documented as optional, that yields the IDs it was given. */
export const repeatableAdapterFlag = (description: string) =>
  // `Flag.optional` keeps the repeatable flag documented as optional.
  Flag.optional(Flag.Literals("adapter", AgentAdapterIdSchema.literals).pipe(Flag.atLeast(0))).pipe(
    // Coverage skip: Flag.atLeast(0) always yields a list, so the empty fallback never runs.
    /* v8 ignore next -- @preserve */
    Flag.map((values) => Option.getOrElse(values, () => [])),
    Flag.withDescription(description),
  );
