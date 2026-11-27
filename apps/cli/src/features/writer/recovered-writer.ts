import { Effect } from "effect";

import type { PreviewOrApplied } from "../../domain/plan-and-apply.ts";
import { recoverLinkJournal } from "../links/link-settlement.ts";
import {
  withStateCheckpointWriter,
  type StateCheckpointWriter,
  type StateOptions,
} from "../../services/state-store.ts";
import {
  readInvocationSnapshot,
  writerInvocationSnapshot,
  type CommandSnapshot,
} from "../snapshot/command-snapshot.ts";

/**
 * Holds the state writer lock and settles the prepared journal, whichever kind of link its
 * entries hold, before `use` observes state. Every mutating workflow plans after this recovery so
 * its plan already reflects the recovered ownership evidence.
 */
export const withRecoveredWriter = <A, E, R>(
  stateOptions: StateOptions,
  use: (writer: StateCheckpointWriter) => Effect.Effect<A, E, R>,
  autoInitialize = false,
) =>
  withStateCheckpointWriter(
    stateOptions,
    (writer) =>
      Effect.gen(function* () {
        yield* recoverLinkJournal(writer);
        return yield* use(writer);
      }),
    autoInitialize,
  );

/**
 * Runs one mutating command under the writer lock, from the one document it reads there after
 * recovery. `use` plans from the snapshot of that document and writes through the writer. When it
 * ends, the invocation's snapshot is the document the writer left behind.
 */
export const withCommandWriter = <A, E, R>(
  stateOptions: StateOptions,
  use: (writer: StateCheckpointWriter, snapshot: CommandSnapshot) => Effect.Effect<A, E, R>,
  autoInitialize = false,
) =>
  withRecoveredWriter(
    stateOptions,
    (writer) =>
      Effect.gen(function* () {
        const result = yield* use(writer, yield* writerInvocationSnapshot(writer.current()));
        yield* writerInvocationSnapshot(writer.current());
        return result;
      }),
    autoInitialize,
  );

/**
 * Plans from one read-only snapshot by default. With `apply`, plans once from the recovered
 * document under the writer lock and applies that same typed plan in the same locked session.
 */
export const previewOrApply = Effect.fnUntraced(function* <
  Plan,
  Applied,
  PlanError,
  PlanServices,
  ApplyError,
  ApplyServices,
>(
  stateOptions: StateOptions,
  options: {
    readonly apply: boolean;
    readonly plan: (snapshot: CommandSnapshot) => Effect.Effect<Plan, PlanError, PlanServices>;
    readonly applyPlan: (
      writer: StateCheckpointWriter,
      plan: Plan,
    ) => Effect.Effect<Applied, ApplyError, ApplyServices>;
  },
) {
  if (options.apply === false) {
    const preview: PreviewOrApplied<Plan, Applied> = {
      plan: yield* options.plan(yield* readInvocationSnapshot(stateOptions)),
    };
    return preview;
  }
  return yield* withCommandWriter(stateOptions, (writer, snapshot) =>
    Effect.gen(function* () {
      const plan = yield* options.plan(snapshot);
      const applied = yield* options.applyPlan(writer, plan);
      const execution: PreviewOrApplied<Plan, Applied> = { applied, plan };
      return execution;
    }),
  );
});
