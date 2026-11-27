import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import {
  AgentCapabilitySchema,
  type AgentAdapterId,
} from "../../domain/agents/agent-adapter-schema.ts";
import { decodeAdapters, repeatableAdapterFlag } from "./adapter.ts";
import type { ReconcilePlanningRequest } from "./model.ts";
import { booleanFlag, optionalFlag } from "./flag-utils.ts";
import { handle, invalid } from "./invocation-receiver.ts";
import { applyFlag } from "./operation-contract.ts";
import { allFlag, cwdFlag, projectFlag, selectorFrom, userFlag } from "./target-selector.ts";

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

/** `sync`: preview, then apply, the selected links and docs mounts. */
export const syncCommand = Command.make(
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
);
