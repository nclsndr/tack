import {
  listSkillChoices,
  removeSkillChoice,
  setSkillChoice,
} from "../../../test/support/snapshot-helpers.ts";
import {
  mutateStateFixture,
  withStateFixture,
  type StateFixture,
} from "../../../test/support/state-fixture.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { faultyFileSystem, platformTestError } from "../../../test/support/faults.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import {
  catalogAddressCandidates,
  ChoiceProjectNotFoundError,
  ChoiceProjectRemovingError,
} from "./choice.ts";
import { type Namespace, type SkillChoice } from "../../domain/choices/choice-schema.ts";

it("suggests catalog addresses near a chosen address the catalog lacks", () => {
  const entry = (kind: "command" | "skill", name: string, owner: "private" | "shared") => ({
    address: {
      kind,
      name,
      sourceRegistrationId:
        owner === "shared"
          ? "00000000-0000-4000-8000-000000000001"
          : "00000000-0000-4000-8000-000000000002",
    },
  });
  const catalog = {
    entries: [
      entry("skill", "review", "shared"),
      entry("skill", "reviews", "private"),
      entry("command", "review", "shared"),
      entry("skill", "deploy", "shared"),
    ],
  };

  expect(
    catalogAddressCandidates(catalog, entry("skill", "review", "shared").address),
  ).toBeUndefined();
  const unlisted = "00000000-0000-4000-8000-000000000003";
  expect(
    catalogAddressCandidates(catalog, {
      kind: "skill",
      name: "review",
      sourceRegistrationId: unlisted,
    }),
  ).toEqual([
    entry("command", "review", "shared").address,
    entry("skill", "review", "shared").address,
    entry("skill", "reviews", "private").address,
  ]);
  expect(
    catalogAddressCandidates(catalog, {
      kind: "skill",
      name: "reveiw",
      sourceRegistrationId: unlisted,
    }),
  ).toEqual([entry("skill", "review", "shared").address]);
  expect(
    catalogAddressCandidates(catalog, {
      kind: "skill",
      name: "unrelated",
      sourceRegistrationId: unlisted,
    }),
  ).toEqual([]);
});

const projectNamespace = (projectName: string) =>
  ({ _tag: "project", projectName }) satisfies Namespace;

const userNamespace = { _tag: "user" } satisfies Namespace;

const address = (owner: "shared" | "private", name: string) =>
  ({
    kind: "skill",
    name,
    sourceRegistrationId:
      owner === "shared"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
  }) satisfies SkillChoice["address"];

const choice = (
  namespace: Namespace,
  owner: "shared" | "private",
  name: string,
  decision: SkillChoice["decision"],
) => ({ address: address(owner, name), decision, namespace }) satisfies SkillChoice;

/** A state fixture with the registered projects `project-a` and `project-b`. */
const withFixture = <A, E, R>(use: (fixture: StateFixture) => Effect.Effect<A, E, R>) =>
  withStateFixture((fixture) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { options, root } = fixture;
      yield* mutateStateFixture(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: [
            {
              gitCommonDirectory: path.join(root, "git-a"),
              name: "project-a",
              roots: [path.join(root, "project-a")],
            },
            {
              gitCommonDirectory: path.join(root, "git-b"),
              name: "project-b",
              roots: [path.join(root, "project-b")],
            },
          ],
        },
      }));
      return yield* use(fixture);
    }),
  );

it.layer(LiveTestLayer)("namespace choices", (choiceIt) => {
  choiceIt.effect("persists, replaces, filters, and removes exact choices", () =>
    withFixture(({ options }) =>
      Effect.gen(function* () {
        const projectA = projectNamespace("project-a");
        const projectB = projectNamespace("project-b");
        const first = yield* setSkillChoice(
          options,
          choice(userNamespace, "shared", "zeta", "include"),
        );
        yield* setSkillChoice(options, choice(projectA, "shared", "alpha", "include"));
        yield* setSkillChoice(options, choice(projectB, "shared", "alpha", "exclude"));
        const replaced = yield* setSkillChoice(
          options,
          choice(projectA, "shared", "alpha", "exclude"),
        );

        const all = yield* listSkillChoices(options);
        const onlyProjectA = yield* listSkillChoices(options, projectA);
        const removed = yield* removeSkillChoice(options, {
          address: address("shared", "alpha"),
          namespace: projectA,
        });
        const repeatedRemoval = yield* removeSkillChoice(options, {
          address: address("shared", "alpha"),
          namespace: projectA,
        });

        expect(first.changed).toBe(true);
        expect(replaced).toMatchObject({ changed: true, choice: { decision: "exclude" } });
        expect(all).toEqual([
          choice(projectA, "shared", "alpha", "exclude"),
          choice(projectB, "shared", "alpha", "exclude"),
          choice(userNamespace, "shared", "zeta", "include"),
        ]);
        expect(onlyProjectA).toEqual([choice(projectA, "shared", "alpha", "exclude")]);
        expect(removed.removed).toBe(true);
        expect(repeatedRemoval.removed).toBe(false);
        expect(yield* listSkillChoices(options, projectA)).toEqual([]);
      }),
    ),
  );

  choiceIt.effect("keeps picks of the same kind and name from different sources apart", () =>
    withFixture(({ options }) =>
      Effect.gen(function* () {
        const projectA = projectNamespace("project-a");
        const command = (namespace: Namespace, owner: "shared" | "private") =>
          ({
            address: { ...address(owner, "alpha"), kind: "command" as const },
            decision: "include",
            namespace,
          }) satisfies SkillChoice;
        yield* setSkillChoice(options, choice(userNamespace, "shared", "alpha", "include"));
        yield* setSkillChoice(options, choice(userNamespace, "private", "alpha", "exclude"));
        yield* setSkillChoice(options, command(userNamespace, "shared"));
        yield* setSkillChoice(options, choice(projectA, "shared", "alpha", "include"));

        // Setting one exact pick never replaces a pick of another source, kind or namespace.
        const replaced = yield* setSkillChoice(
          options,
          choice(userNamespace, "shared", "alpha", "exclude"),
        );

        expect(replaced).toMatchObject({ changed: true, choice: { decision: "exclude" } });
        expect(yield* listSkillChoices(options)).toEqual([
          choice(projectA, "shared", "alpha", "include"),
          command(userNamespace, "shared"),
          choice(userNamespace, "shared", "alpha", "exclude"),
          choice(userNamespace, "private", "alpha", "exclude"),
        ]);
      }),
    ),
  );

  choiceIt.effect("keeps choices for addresses absent from the live catalog", () =>
    withFixture(({ options }) =>
      Effect.gen(function* () {
        const missing = choice(userNamespace, "private", "missing-skill", "include");

        yield* setSkillChoice(options, missing);

        expect(yield* listSkillChoices(options)).toEqual([missing]);
      }),
    ),
  );

  choiceIt.effect("orders persisted choices independently of mutation order", () =>
    withFixture(({ options, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const values = [
          choice(userNamespace, "shared", "zeta", "include"),
          choice(projectNamespace("project-b"), "private", "beta", "exclude"),
          choice(projectNamespace("project-a"), "shared", "alpha", "include"),
        ];
        yield* Effect.forEach(values, (value) => setSkillChoice(options, value));
        const forward = yield* fileSystem.readFileString(statePath);
        yield* Effect.forEach(values, (value) =>
          removeSkillChoice(options, { address: value.address, namespace: value.namespace }),
        );
        yield* Effect.forEach([...values].reverse(), (value) => setSkillChoice(options, value));

        expect(yield* fileSystem.readFileString(statePath)).toBe(forward);
      }),
    ),
  );

  choiceIt.effect("returns the same state without writing for repeated no-op mutations", () =>
    withFixture(({ options, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const existing = choice(userNamespace, "shared", "alpha", "include");
        yield* setSkillChoice(options, existing);
        const before = yield* fileSystem.readFileString(statePath);

        const results = yield* provideTestFileSystem(
          Effect.all(
            [
              setSkillChoice(options, existing),
              removeSkillChoice(options, {
                address: address("shared", "absent"),
                namespace: userNamespace,
              }),
            ],
            { concurrency: 1 },
          ),
          yield* faultyFileSystem({ rename: () => platformTestError("rename") }),
        );

        expect(results[0].changed).toBe(false);
        expect(results[1].removed).toBe(false);
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );

  choiceIt.effect("rejects an unknown project namespace without changing state", () =>
    withFixture(({ options, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const before = yield* fileSystem.readFileString(statePath);

        const error = yield* Effect.flip(
          setSkillChoice(
            options,
            choice(projectNamespace("missing-project"), "shared", "alpha", "include"),
          ),
        );
        const removeError = yield* Effect.flip(
          removeSkillChoice(options, {
            address: address("shared", "alpha"),
            namespace: projectNamespace("missing-project"),
          }),
        );

        expect(error).toBeInstanceOf(ChoiceProjectNotFoundError);
        expect(error).toMatchObject({
          code: "choice-project-not-found",
          projectName: "missing-project",
        });
        expect(removeError).toBeInstanceOf(ChoiceProjectNotFoundError);
        expect(removeError).toMatchObject({
          code: "choice-project-not-found",
          projectName: "missing-project",
        });
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );

  choiceIt.effect("rejects mutations for a project retained only for removal cleanup", () =>
    withFixture(({ options, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: (state.data.projects ?? []).map((project) =>
              project.name === "project-a"
                ? {
                    ...project,
                    removingRoots: project.roots,
                    roots: [],
                  }
                : project,
            ),
          },
        }));
        const before = yield* fileSystem.readFileString(statePath);
        const namespace = projectNamespace("project-a");
        const setError = yield* Effect.flip(
          setSkillChoice(options, choice(namespace, "shared", "alpha", "include")),
        );
        const removeError = yield* Effect.flip(
          removeSkillChoice(options, {
            address: address("shared", "alpha"),
            namespace,
          }),
        );

        expect(setError).toBeInstanceOf(ChoiceProjectRemovingError);
        expect(setError).toMatchObject({
          code: "choice-project-removing",
          projectName: "project-a",
        });
        expect(removeError).toBeInstanceOf(ChoiceProjectRemovingError);
        expect(removeError).toMatchObject({
          code: "choice-project-removing",
          projectName: "project-a",
        });
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );
});
