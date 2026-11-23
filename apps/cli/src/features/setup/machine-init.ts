import { Effect, FileSystem, Path } from "effect";
import type { HandMadeEntry } from "../../domain/agents/hand-made-entry.ts";
import { agentAdapterIds } from "../../domain/agents/agent-adapter.ts";
import type { AgentAdapterId } from "../../domain/links/agent-adapter-schema.ts";
import type { AgentDetection } from "../../domain/setup/machine-init-schema.ts";
import {
  initializeState,
  resolveStateDirectory,
  StateConfigurationError,
  type StateOptions,
} from "../../services/state-store.ts";
import { observeHandMadeEntries } from "../hand-made/hand-made-entries.ts";
import { enableAdaptersIn } from "../reconciliation/agent.ts";
import {
  applySyncPlan,
  planSync,
  type SyncApplication,
  type SyncPlan,
} from "../reconciliation/sync-command.ts";
import { makeCommandSnapshot, type CommandSnapshot } from "../snapshot/command-snapshot.ts";
import { withCommandWriter } from "../writer/recovered-writer.ts";

/**
 * The folders in the operator home that show an agent is used there, the first one the folder its
 * detection names when none exists. They are the folders Tack links into, whatever
 * `CLAUDE_CONFIG_DIR`, `CLINE_DIR`, `CODEX_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`,
 * `XDG_CONFIG_HOME` or `PI_CODING_AGENT_DIR` say, so detection reads the same ones. The Cline
 * extension keeps its workflows and rules under `Documents/Cline` and may never create `.cline`.
 */
export const agentHomes = {
  claude: [".claude"],
  cline: [".cline", "Documents/Cline"],
  codex: [".codex", ".agents"],
  copilot: [".copilot"],
  cursor: [".cursor"],
  gemini: [".gemini"],
  opencode: [".config/opencode"],
  pi: [".pi"],
} as const satisfies Record<AgentAdapterId, readonly [string, ...Array<string>]>;

/** Reports, for every adapter, whether its agent's home folder exists in `home`. */
const detectAgents = Effect.fnUntraced(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(agentAdapterIds, (adapter) =>
    Effect.gen(function* () {
      const candidates = agentHomes[adapter].map((folder) => path.join(home, folder));
      const found = yield* Effect.forEach(candidates, (candidate) =>
        fileSystem.exists(candidate).pipe(Effect.catch(() => Effect.succeed(false))),
      );
      const index = found.indexOf(true);
      return {
        adapter,
        home: candidates[Math.max(index, 0)] ?? path.join(home, agentHomes[adapter][0]),
        found: index !== -1,
      } satisfies AgentDetection;
    }),
  );
});

/** What one `tack init` asks for. */
export type MachineInitRequest = {
  /** The adapters `--adapter` named; they replace detection. Absent, detection decides. */
  readonly adapters?: ReadonlyArray<AgentAdapterId>;
  readonly cwd: string;
};

/** What setting up this machine would write; see `InitPlanSchema` for its public form. */
export type MachineInitPlan = {
  /** The operator home the agents were looked for in. */
  readonly home: string;
  readonly stateDirectory: string;
  readonly state: "create" | "exists";
  readonly adapters: {
    readonly enabled: ReadonlyArray<AgentAdapterId>;
    readonly toEnable: ReadonlyArray<AgentAdapterId>;
    readonly detection: ReadonlyArray<AgentDetection>;
    readonly source: "detected" | "requested";
  };
  /** The user sync of the state once the adapters are enabled. */
  readonly sync: SyncPlan;
  readonly handMade: ReadonlyArray<HandMadeEntry>;
};

/** What a run of {@link MachineInitPlan} wrote. */
type MachineInitApplication = {
  readonly state: "created" | "existed";
  readonly adaptersEnabled: ReadonlyArray<AgentAdapterId>;
  readonly sync: SyncApplication;
};

/** What one `tack init` planned, and what it then wrote. */
export type MachineInitExecution = {
  readonly plan: MachineInitPlan;
  readonly applied: MachineInitApplication;
};

/**
 * Plans the setup from `snapshot`: the adapters to enable, the user sync of the state once they are
 * enabled, and the hand-made entries in their user folders. It writes nothing.
 */
const planMachineInit = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  request: MachineInitRequest,
  snapshot: CommandSnapshot,
  state: MachineInitPlan["state"],
) {
  const path = yield* Path.Path;
  const home = stateOptions.homeDirectory;
  // Coverage skip: the host supplies a home to every route that needs one; this narrows it.
  /* v8 ignore next -- @preserve */
  if (home === undefined)
    return yield* new StateConfigurationError({
      message: "The operator home directory is unavailable.",
    });
  const user = { _tag: "user", canonicalPath: path.resolve(home) } as const;
  const detection = yield* detectAgents(user.canonicalPath);
  const enabled = snapshot.state.data.enabledAdapters;
  const wanted =
    request.adapters ??
    detection.flatMap(({ adapter, found }) => (found === true ? [adapter] : []));
  const enabling = yield* enableAdaptersIn(snapshot.state, wanted);
  const adapters = enabling.state.data.enabledAdapters;
  const sync = yield* planSync(
    stateOptions,
    {
      apply: true,
      cwd: request.cwd,
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "user" },
    },
    yield* makeCommandSnapshot(enabling.state, snapshot),
  );
  return {
    home: user.canonicalPath,
    stateDirectory: yield* resolveStateDirectory(stateOptions),
    state,
    adapters: {
      enabled,
      toEnable: adapters.filter((adapter) => enabled.includes(adapter) === false),
      detection,
      source: request.adapters === undefined ? "detected" : "requested",
    },
    sync,
    handMade: yield* observeHandMadeEntries(snapshot.state.data.links, user, adapters),
  } satisfies MachineInitPlan;
});

/**
 * Sets up this machine: the state, the agents found in the operator home (or the ones requested),
 * and their user links, which on a new machine are the built-in skills. It creates the state when
 * absent, then, under one writer session, plans from what it finds, enables the adapters and applies
 * the user sync. A rerun on a set-up machine writes nothing. Sources, projects and picks are never
 * touched, and hand-made entries are only reported.
 */
export const runMachineInit = Effect.fn("setup.runMachineInit")(function* (
  stateOptions: StateOptions,
  request: MachineInitRequest,
) {
  const initialization = yield* initializeState(stateOptions);
  return yield* withCommandWriter(stateOptions, (writer, snapshot) =>
    Effect.gen(function* () {
      const plan = yield* planMachineInit(
        stateOptions,
        request,
        snapshot,
        initialization.alreadyInitialized === true ? "exists" : "create",
      );
      if (plan.adapters.toEnable.length > 0)
        yield* writer.checkpoint((state) => enableAdaptersIn(state, plan.adapters.toEnable));
      const execution: MachineInitExecution = {
        plan,
        applied: {
          state: initialization.alreadyInitialized === true ? "existed" : "created",
          adaptersEnabled: plan.adapters.toEnable,
          sync: yield* applySyncPlan(writer, plan.sync),
        },
      };
      return execution;
    }),
  );
});
