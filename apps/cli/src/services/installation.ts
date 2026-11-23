import { Context, Effect } from "effect";
import type { InstallKind } from "../domain/self/upgrade-guide.ts";

/** The variable that selects an import step to crash at; source runs in tests only. */
export const crashAtVariable = "TACK_IMPORT_CRASH_AT";

/** What a built-ins prune needs: the operator home, its environment and the agent link folders. */
export type BuiltInsPruneRequest = {
  readonly home: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly folders: ReadonlyArray<string>;
};

/**
 * How the running Tack was installed, and the chores only an installed copy has. A host without a
 * real install, such as the in-memory browser build, provides its own facts.
 */
export class Installation extends Context.Service<
  Installation,
  {
    readonly kind: InstallKind;
    /**
     * After a package run applies a sync, removes the built-ins copies that neither this version
     * nor a link in the folders needs. Absent when this run keeps no built-ins copies.
     */
    readonly pruneBuiltIns?: (request: BuiltInsPruneRequest) => Effect.Effect<void>;
    /** Ends the process at a named import step when a crash-recovery test asks for it. */
    readonly crashPoint: (step: string) => Effect.Effect<void>;
  }
>()("tack/cli/services/installation/Installation") {}
