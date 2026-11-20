import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  AgentAdapterIdSchema,
  AgentCapabilitySchema,
  type AgentAdapterId,
} from "../../domain/links/agent-adapter-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { listAlias } from "./list-alias.ts";
import { InvocationIssue, type ReconcilePlanningRequest } from "./model.ts";
import { booleanFlag, optionalFlag } from "./flag-utils.ts";
import { handle, invalid, receive } from "./invocation-receiver.ts";
import { applyFlag, immediate, previewApply, readOnly } from "./operation-contract.ts";
import { allFlag, cwdFlag, projectFlag, selectorFrom, userFlag } from "./target-selector.ts";

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
const adapterSetCommand = Command.make(
  "enable",
  { adapters: adapterArgument.pipe(Argument.variadic()) },
  handle(
    "adapter-set",
    Effect.fnUntraced(function* ({ adapters }) {
      return { _tag: "adapter-set", adapters: yield* decodeAdapters(adapters) };
    }),
  ),
).pipe(
  Command.withDescription(
    "Enable these adapters in addition to the enabled ones; removing one requires adapter disable",
  ),
  Command.withExamples([{ command: "tack adapter enable claude codex cursor" }]),
  immediate,
);
const adapterDisableCommand = Command.make(
  "disable",
  { adapter: adapterArgument, apply: applyFlag },
  ({ adapter, apply }) => receive({ _tag: "adapter-disable", adapter, apply }),
).pipe(
  Command.withDescription(
    "Preview removing an adapter's managed links and disabling it; --apply cleans up, then disables",
  ),
  Command.withExamples([
    { command: "tack adapter disable cursor" },
    { command: "tack adapter disable cursor --apply" },
  ]),
  previewApply,
);
const adapterCommand = Command.make("adapter", {}, () => receive({ _tag: "adapter-list" })).pipe(
  Command.withSubcommands([
    adapterSetCommand,
    adapterDisableCommand,
    listAlias(receive({ _tag: "adapter-list" })),
  ]),
  Command.withDescription(
    "Enable and disable the coding-agent adapters that receive links; bare `adapter` lists the enabled ones",
  ),
  Command.withExamples([{ command: "tack adapter" }]),
  readOnly,
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

/** Flags for one combined resource and docs sync. */
const planningFlags = {
  adapters: repeatableAdapterFlag("Limit planning to this enabled adapter; repeatable"),
  requiredCapability: optionalFlag(
    Flag.Literals("require-capability", AgentCapabilitySchema.literals),
    "Block the plan when a selected adapter lacks this capability",
  ),
  cwd: cwdFlag,
  all: allFlag,
  includeOptional: booleanFlag("include-optional", "Include optional skill dependencies"),
  noAdapters: booleanFlag("no-adapters", "Plan without any adapter; cannot combine with --adapter"),
  noDocs: booleanFlag("no-docs", "Omit project docs mounts"),
  projectName: projectFlag,
  user: userFlag,
} as const;

const planningRequest = Effect.fnUntraced(function* ({
  adapters,
  requiredCapability,
  cwd,
  all,
  includeOptional,
  noAdapters,
  noDocs,
  projectName,
  user,
}: Command.Command.Config.Infer<typeof planningFlags>) {
  if (noAdapters === true && adapters.length > 0)
    return yield* invalid("invalid-flag", "--no-adapters cannot be combined with --adapter.");
  if (noAdapters && noDocs)
    return yield* invalid("invalid-flag", "--no-adapters cannot be combined with --no-docs.");
  const adapterOverride =
    noAdapters === true
      ? ([] satisfies ReadonlyArray<AgentAdapterId>)
      : adapters.length === 0
        ? undefined
        : yield* decodeAdapters(adapters);
  const selector = yield* selectorFrom({ projectName, user, all, cwd });
  if (noAdapters && selector._tag === "user")
    return yield* invalid("invalid-flag", "--no-adapters has no docs mounts for --user.");
  return {
    ...(adapterOverride === undefined ? {} : { adapterOverride }),
    ...(cwd === undefined ? {} : { cwd }),
    includeOptional,
    noDocs,
    ...(requiredCapability === undefined ? {} : { requiredCapability }),
    selector,
  } satisfies ReconcilePlanningRequest;
});

const syncCommand = Command.make(
  "sync",
  { ...planningFlags, apply: applyFlag },
  handle(
    "sync",
    Effect.fnUntraced(function* ({ apply, ...flags }) {
      return { _tag: "sync", apply, ...(yield* planningRequest(flags)) };
    }),
  ),
).pipe(
  Command.withDescription(
    "Preview selected resource links and attached project docs mounts; --apply replans and writes them. Bare selects the containing project; --all selects every project and the user target.",
  ),
  Command.withExamples([
    { command: "tack sync --project demo" },
    { command: "tack sync --project demo --no-adapters --apply" },
    { command: "tack sync --user --apply" },
  ]),
  previewApply,
);

/** Commands owned by adapter selection and reconciliation. */
export const reconciliationCommands = [adapterCommand, syncCommand] as const;
