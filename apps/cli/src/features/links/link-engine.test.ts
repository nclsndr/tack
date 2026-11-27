import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import {
  initializeState,
  readState,
  withStateCheckpointWriter,
  type StateOptions,
} from "../../services/state-store.ts";
import {
  agentLink,
  managedLinksOf,
  type LinkEvidence,
} from "../../domain/links/link-record-schema.ts";
import { docsLink, managedDocsLinksOf } from "../../domain/docs/docs-schema.ts";
import { observeDestination } from "../../services/destination.ts";
import { deliveryKindOf } from "./link-delivery.ts";
import { DestinationObservationSchema } from "../../domain/reconciliation/destination-observation-schema.ts";
import { docsChangeFailures } from "../docs/docs-links.ts";
import { reconciliationLinkFailureCodes } from "../reconciliation/reconciliation-application.ts";
import {
  adoptLink,
  createLink,
  describeAdopt,
  describeCreate,
  describeRemove,
  makeLinkLedger,
  preparedBatchOf,
  refuseSource,
  removeLink,
} from "./link-engine.ts";
import { recoverLinkJournal } from "./link-settlement.ts";

/*
 * Agent links and docs mounts go through one engine. Given the same observed destination they get
 * the same outcome; the delivery-kind parameters (parent policy and proofs) are the only
 * differences, and each is exercised for both kinds below.
 */

const registrationId = "00000000-0000-4000-8000-000000000001";
const kinds = ["agent", "docs"] as const;
type Kind = (typeof kinds)[number];

type World = {
  readonly root: string;
  readonly source: string;
  readonly other: string;
  readonly options: StateOptions;
  readonly link: (kind: Kind) => LinkEvidence;
  /** The text Tack derives for the link, and the directory that holds it. */
  readonly textOf: (link: LinkEvidence) => string;
};

/** A temporary project with a source directory, and the link evidence of each kind for it. */
const withWorld = <A, E, R>(use: (world: World) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-link-engine-" }),
    );
    const root = path.join(base, "project");
    const source = path.join(base, "source", "guide");
    const other = path.join(base, "other");
    yield* Effect.forEach([root, source, other], (directory) =>
      fileSystem.makeDirectory(directory, { recursive: true }),
    );
    const options = stateOptionsAt(path.join(base, "state"), base);
    yield* initializeState(options);
    const link = (kind: Kind): LinkEvidence =>
      kind === "agent"
        ? agentLink({
            adapter: "cursor",
            address: { kind: "skill", name: "guide", sourceRegistrationId: registrationId },
            sourceDirectoryPath: source,
            sourceRegistrationId: registrationId,
            target: { _tag: "project-root", projectName: "demo", canonicalPath: root },
          })
        : docsLink({
            projectName: "demo",
            root,
            resource: { sourceRegistrationId: registrationId, name: "guide" },
            destinationPath: path.join(root, ".tack", "docs", registrationId, "guide"),
            sourceDirectoryPath: source,
          });
    const textOf = (evidence: LinkEvidence) =>
      path.relative(path.dirname(evidence.destinationPath), evidence.sourceDirectoryPath);
    return yield* use({ root, source, other, options, link, textOf });
  });

type Setup = (
  world: World,
  link: LinkEvidence,
) => Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path>;

/** One way a destination can look, and what creating and removing a link ends as there. */
type Scenario = {
  readonly name: string;
  readonly setup: Setup;
  readonly create: string;
  readonly remove: string;
  readonly adopt: string;
};

const symlinkTo =
  (target: (world: World, link: LinkEvidence, path: Path.Path) => string): Setup =>
  (world, link) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fileSystem.symlink(target(world, link, path), link.destinationPath);
    });

/** Every way a destination can look, built the same way for both kinds. */
const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "absent",
    setup: () => Effect.void,
    create: "created",
    remove: "removed",
    adopt: "changed",
  },
  {
    name: "an owned link",
    setup: symlinkTo((world, link) => world.textOf(link)),
    create: "occupied",
    remove: "removed",
    adopt: "adopted",
  },
  {
    name: "a foreign link",
    setup: symlinkTo((world, link, path) =>
      path.relative(path.dirname(link.destinationPath), world.other),
    ),
    create: "occupied",
    remove: "not-owned",
    adopt: "changed",
  },
  {
    name: "a file",
    setup: (_, link) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(link.destinationPath, "mine");
      }),
    create: "occupied",
    remove: "not-owned",
    adopt: "changed",
  },
  {
    name: "a directory",
    setup: (_, link) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(link.destinationPath);
      }),
    create: "occupied",
    remove: "not-owned",
    adopt: "changed",
  },
  {
    name: "a dangling link with another text",
    setup: symlinkTo(() => "../nowhere"),
    create: "occupied",
    remove: "not-owned",
    adopt: "changed",
  },
];

/** The directory above a destination exists, as the planner's directory step leaves it. */
const withParent = (link: LinkEvidence) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(link.destinationPath), { recursive: true });
  });

it.layer(LiveTestLayer)("one link engine for both delivery kinds", (engine) => {
  for (const kind of kinds) {
    for (const { name, setup, create, remove, adopt } of scenarios) {
      engine.effect(`${kind}: adopting over ${name} ends as ${adopt}`, () =>
        withWorld((world) =>
          Effect.gen(function* () {
            const link = world.link(kind);
            yield* withParent(link);
            yield* setup(world, link);
            const before = yield* observeDestination(link.destinationPath);
            const ledger = makeLinkLedger();
            const result = yield* adoptLink(ledger, link, world.textOf(link));
            expect(result._tag).toBe(adopt);
            // An adoption is learned as recorded, a refusal as unchanged, and neither touches disk.
            expect(ledger.learned.get(link.destinationPath)).toBe(
              result._tag === "adopted" ? "record" : "keep",
            );
            expect(yield* observeDestination(link.destinationPath)).toStrictEqual(before);
          }),
        ),
      );
      engine.effect(`${kind}: creating over ${name} ends as ${create}`, () =>
        withWorld((world) =>
          Effect.gen(function* () {
            const link = world.link(kind);
            yield* withParent(link);
            yield* setup(world, link);
            const ledger = makeLinkLedger();
            const result = yield* createLink(ledger, link, world.textOf(link));
            expect(result._tag).toBe(create);
            // A creation is learned as recorded, and a refusal as unchanged.
            expect(ledger.learned.get(link.destinationPath)).toBe(
              result._tag === "created" ? "record" : "keep",
            );
            expect(ledger.inFlight.size).toBe(0);
          }),
        ),
      );
      engine.effect(`${kind}: removing over ${name} ends as ${remove}`, () =>
        withWorld((world) =>
          Effect.gen(function* () {
            const link = world.link(kind);
            yield* withParent(link);
            yield* setup(world, link);
            const result = yield* removeLink(makeLinkLedger(), link);
            expect(result._tag).toBe(remove);
            // Only a proven-owned link is unlinked; everything else is left as it was.
            expect((yield* observeDestination(link.destinationPath))._tag === "absent").toBe(
              result._tag === "removed",
            );
          }),
        ),
      );
    }

    engine.effect(`${kind}: removes a dangling link whose text is the text Tack derives`, () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const link = world.link(kind);
          yield* withParent(link);
          yield* fileSystem.symlink(world.textOf(link), link.destinationPath);
          yield* fileSystem.remove(world.source, { recursive: true });
          expect((yield* removeLink(makeLinkLedger(), link))._tag).toBe("removed");
        }),
      ),
    );

    engine.effect(`${kind}: refuses a source that is missing, a file or no longer canonical`, () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const link = world.link(kind);
          yield* withParent(link);
          const refusal = () =>
            createLink(makeLinkLedger(), link, world.textOf(link)).pipe(
              Effect.map((result) =>
                result._tag === "source-refused" ? result.refusal._tag : result._tag,
              ),
            );
          yield* fileSystem.remove(world.source, { recursive: true });
          expect(yield* refusal()).toBe("unreadable");
          yield* fileSystem.writeFileString(world.source, "not a directory");
          expect(yield* refusal()).toBe("wrong-type");
          yield* fileSystem.remove(world.source);
          yield* fileSystem.makeDirectory(world.other, { recursive: true }).pipe(Effect.ignore);
          yield* fileSystem.makeDirectory(path.dirname(world.source), { recursive: true });
          yield* fileSystem.symlink(world.other, world.source);
          expect(yield* refusal()).toBe("not-canonical");
        }),
      ),
    );
  }

  // Parent policy, a parameter of the delivery kind (the table in the phase says they differ).
  engine.effect(
    "docs: a parent that is a link blocks creating and removing, but not a missing link",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const link = world.link("docs");
          yield* fileSystem.makeDirectory(path.join(world.other, "docs", registrationId), {
            recursive: true,
          });
          yield* fileSystem.symlink(world.other, path.join(world.root, ".tack"));
          const created = yield* createLink(makeLinkLedger(), link, world.textOf(link));
          expect(created).toMatchObject({
            _tag: "parents-unsafe",
            verdict: { code: "docs-parent-not-directory" },
          });
          // Nothing was created through the redirection.
          expect(
            yield* fileSystem.exists(path.join(world.other, "docs", registrationId, "guide")),
          ).toBe(false);
          // A link that is already gone needs no parent: removing it settles.
          expect((yield* removeLink(makeLinkLedger(), link))._tag).toBe("removed");
          // A link that is there is not unlinked through an unsafe parent.
          yield* fileSystem.symlink(
            path.relative(path.join(world.other, "docs", registrationId), world.source),
            path.join(world.other, "docs", registrationId, "guide"),
          );
          expect(yield* removeLink(makeLinkLedger(), link)).toMatchObject({
            _tag: "parents-unsafe",
          });
        }),
      ),
  );

  engine.effect("agent: a directory alias is resolved, not refused", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const link = world.link("agent");
        yield* fileSystem.makeDirectory(path.join(world.other, "skills"), { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(path.dirname(link.destinationPath)), {
          recursive: true,
        });
        yield* fileSystem.symlink(
          path.join(world.other, "skills"),
          path.dirname(link.destinationPath),
        );
        const text = path.relative(path.join(world.other, "skills"), world.source);
        expect((yield* createLink(makeLinkLedger(), link, text))._tag).toBe("created");
        expect(yield* fileSystem.exists(path.join(world.other, "skills", "guide"))).toBe(true);
        expect((yield* removeLink(makeLinkLedger(), link))._tag).toBe("removed");
      }),
    ),
  );

  // Recovery: one journal, one rule; the parent policy decides who can be blocked.
  for (const kind of kinds) {
    for (const { name, setup } of scenarios) {
      engine.effect(`${kind}: recovers a prepared create over ${name} by observation`, () =>
        withWorld((world) =>
          Effect.gen(function* () {
            const link = world.link(kind);
            yield* withParent(link);
            yield* setup(world, link);
            yield* mutateStateFixture(world.options, (state) => ({
              ...state,
              data: { ...state.data, journal: preparedBatchOf([{ _tag: "create", link }]) },
            }));
            yield* withStateCheckpointWriter(world.options, recoverLinkJournal);
            const state = yield* readState(world.options);
            expect(state.data.journal).toBeUndefined();
            // Only a link showing the text Tack writes is recorded.
            expect(state.data.links).toHaveLength(name === "an owned link" ? 1 : 0);
          }),
        ),
      );
    }
  }

  engine.effect(
    "docs: a prepared entry under a redirected parent stays prepared and blocks only itself",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const docs = world.link("docs");
          const agent = world.link("agent");
          yield* withParent(agent);
          yield* fileSystem.symlink(world.textOf(agent), agent.destinationPath);
          yield* fileSystem.makeDirectory(path.join(world.other, "docs", registrationId), {
            recursive: true,
          });
          yield* fileSystem.symlink(world.other, path.join(world.root, ".tack"));
          yield* mutateStateFixture(world.options, (state) => ({
            ...state,
            data: {
              ...state.data,
              journal: preparedBatchOf([
                { _tag: "create", link: docs },
                { _tag: "create", link: agent },
              ]),
            },
          }));
          yield* withStateCheckpointWriter(world.options, recoverLinkJournal);
          const state = yield* readState(world.options);
          // The agent entry settled; the blocked docs entry is the only one left.
          expect(state.data.journal?.map((entry) => entry.link.delivery._tag)).toEqual(["docs"]);
          expect(managedLinksOf(state.data.links)).toHaveLength(1);
          expect(managedDocsLinksOf(state.data.links)).toEqual([]);

          // Repairing the parent lets the next writer settle it.
          yield* fileSystem.remove(path.join(world.root, ".tack"));
          yield* withStateCheckpointWriter(world.options, recoverLinkJournal);
          expect((yield* readState(world.options)).data.journal).toBeUndefined();
        }),
      ),
  );

  engine.effect(
    "docs: a prepared removal settles when its destination is gone, whatever its parent",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const docs = world.link("docs");
          yield* fileSystem.symlink(world.other, path.join(world.root, ".tack"));
          yield* mutateStateFixture(world.options, (state) => ({
            ...state,
            data: {
              ...state.data,
              links: [docs],
              journal: preparedBatchOf([{ _tag: "remove", link: docs }]),
            },
          }));
          yield* withStateCheckpointWriter(world.options, recoverLinkJournal);
          const state = yield* readState(world.options);
          expect(state.data.journal).toBeUndefined();
          expect(state.data.links).toEqual([]);
        }),
      ),
  );

  engine.effect("docs: names why a root or a parent cannot be acted through", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const docs = world.link("docs");
        const verdictOf = (link: LinkEvidence, create: boolean) =>
          deliveryKindOf(link)
            .parents(link, create)
            .pipe(Effect.map((verdict) => (verdict._tag === "unsafe" ? verdict.code : "safe")));

        // A destination outside its root is refused before anything is observed.
        expect(
          yield* verdictOf(
            { ...docs, destinationPath: path.join(world.other, "elsewhere") },
            false,
          ),
        ).toBe("docs-destination-escape");

        // A parent that cannot be inspected is reported as unreadable, not as unsafe for a reason.
        const unreadable = Effect.provideService(verdictOf(docs, true), FileSystem.FileSystem, {
          ...fileSystem,
          makeDirectory: () =>
            Effect.fail(PlatformError.badArgument({ module: "test", method: "makeDirectory" })),
        } as FileSystem.FileSystem);
        expect(yield* unreadable).toBe("docs-parent-unreadable");

        // The registered root has moved: it is now reached through a link.
        yield* fileSystem.rename(world.root, path.join(world.other, "moved"));
        yield* fileSystem.symlink(path.join(world.other, "moved"), world.root);
        expect(yield* verdictOf(docs, false)).toBe("docs-root-moved");
      }),
    ),
  );

  engine.effect(
    "adopts only through safe parents, from a usable source, with Tack's exact text",
    () =>
      withWorld((world) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const docs = world.link("docs");
          yield* withParent(docs);
          yield* fileSystem.symlink(world.textOf(docs), docs.destinationPath);
          const adopt = (link: LinkEvidence, text = world.textOf(link)) =>
            adoptLink(makeLinkLedger(), link, text).pipe(Effect.map((result) => result._tag));

          // The link resolves to the source, but its text is not the text the plan names.
          expect(yield* adopt(docs, `./${world.textOf(docs)}`)).toBe("changed");
          expect(
            yield* adopt({ ...docs, destinationPath: path.join(world.other, "elsewhere") }),
          ).toBe("parents-unsafe");
          yield* fileSystem.remove(world.source, { recursive: true });
          expect(yield* adopt(docs)).toBe("source-refused");
        }),
      ),
  );

  engine.effect("reports a source it can stat but not resolve as unreadable", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const refusal = yield* refuseSource(world.link("agent")).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            realPath: () =>
              Effect.fail(PlatformError.badArgument({ module: "test", method: "realPath" })),
          }),
        );
        expect(refusal?._tag).toBe("unreadable");
        expect(yield* refuseSource(world.link("agent"))).toBeUndefined();
      }),
    ),
  );

  engine.effect("never mounts docs for a user target and never owns an agent docs link", () =>
    withWorld((world) =>
      Effect.gen(function* () {
        const docs = world.link("docs");
        const userDocs: LinkEvidence = {
          ...docs,
          target: { _tag: "user", canonicalPath: world.root },
        };
        expect(yield* deliveryKindOf(userDocs).parents(userDocs, false)).toMatchObject({
          _tag: "unsafe",
          code: "docs-destination-escape",
        });
        // An agent delivery can only hold a skill or a command; anything else is never Tack's.
        const agentDocs: LinkEvidence = { ...docs, delivery: { _tag: "agent", adapter: "cursor" } };
        const observation = yield* observeDestination(agentDocs.destinationPath);
        expect(yield* deliveryKindOf(agentDocs).owns(observation, agentDocs)).toBe(false);
      }),
    ),
  );
});

it("describes every way a create or remove ends, once for every caller", () => {
  const observation = Schema.decodeUnknownSync(DestinationObservationSchema)({
    _tag: "entry",
    destinationPath: "/project/.claude/skills/x",
    entryType: "directory",
  });
  const error = PlatformError.badArgument({ module: "test", method: "symlink" });
  const verdict = {
    _tag: "unsafe",
    code: "docs-parent-redirected",
    message: "Docs parent /p has been redirected.",
  } as const;
  const atDestination = {
    message: "The destination is an existing directory.",
    conclusion: "blocked",
    observation,
  } as const;
  const parentsUnsafe = {
    code: "parents-unsafe",
    message: verdict.message,
    conclusion: "blocked",
    reason: "docs-parent-redirected",
  } as const;
  const filesystemFailure = {
    code: "filesystem-failure",
    message: error.message,
    conclusion: "filesystem-failure",
  } as const;

  expect(describeCreate({ _tag: "created" })).toBeUndefined();
  expect(describeCreate({ _tag: "parents-unsafe", verdict })).toStrictEqual(parentsUnsafe);
  expect(
    describeCreate({ _tag: "source-refused", refusal: { _tag: "unreadable", error } }),
  ).toStrictEqual(filesystemFailure);
  expect(
    describeCreate({
      _tag: "source-refused",
      refusal: { _tag: "wrong-type", kind: "command", expected: "file" },
    }),
  ).toStrictEqual({
    code: "source-changed",
    message: "The recorded command source must be a file.",
    conclusion: "blocked",
  });
  expect(
    describeCreate({ _tag: "source-refused", refusal: { _tag: "not-canonical" } }),
  ).toStrictEqual({
    code: "source-changed",
    message: "The recorded source path is no longer canonical.",
    conclusion: "blocked",
  });
  expect(describeCreate({ _tag: "occupied", observation })).toStrictEqual({
    code: "destination-occupied",
    ...atDestination,
  });
  expect(describeCreate({ _tag: "unverified", observation })).toStrictEqual({
    code: "unverified",
    ...atDestination,
  });
  expect(describeCreate({ _tag: "filesystem-failure", error })).toStrictEqual(filesystemFailure);

  expect(describeAdopt({ _tag: "adopted" })).toBeUndefined();
  expect(describeAdopt({ _tag: "changed", observation })).toStrictEqual({
    code: "destination-not-owned",
    ...atDestination,
  });
  expect(describeAdopt({ _tag: "parents-unsafe", verdict })).toStrictEqual(parentsUnsafe);

  expect(describeRemove({ _tag: "removed" })).toBeUndefined();
  expect(describeRemove({ _tag: "parents-unsafe", verdict })).toStrictEqual(parentsUnsafe);
  expect(describeRemove({ _tag: "not-owned", observation })).toStrictEqual({
    code: "destination-not-owned",
    ...atDestination,
  });
  expect(describeRemove({ _tag: "still-present", observation })).toStrictEqual({
    code: "unverified",
    ...atDestination,
  });
  expect(describeRemove({ _tag: "filesystem-failure", error, observation })).toStrictEqual(
    filesystemFailure,
  );

  // Each caller publishes its own code for the engine's; these tables are the public contract.
  expect(reconciliationLinkFailureCodes).toStrictEqual({
    "parents-unsafe": "destination-conflict",
    "source-changed": "destination-conflict",
    "destination-occupied": "destination-conflict",
    "destination-not-owned": "destination-conflict",
    unverified: "destination-conflict",
    "filesystem-failure": "filesystem-failure",
  });
  const destinationChanged = {
    code: "docs-destination-changed",
    message: "The destination changed after planning; retry reconciliation.",
  };
  expect(docsChangeFailures).toStrictEqual({
    "source-changed": {
      code: "docs-source-changed",
      message: "The docs directory changed after planning.",
    },
    "destination-occupied": destinationChanged,
    "destination-not-owned": destinationChanged,
    unverified: {
      code: "docs-verification-failed",
      message: "The docs mutation could not be verified; retry to recover.",
    },
  });
});
