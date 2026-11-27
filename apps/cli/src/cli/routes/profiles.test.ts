import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { bundleFixture } from "../../../test/support/bundle-fixture.ts";
import { profileFixture } from "../../../test/support/profile-fixture.ts";
import { mutateStateFixture } from "../../../test/support/state-fixture.ts";
import { readState } from "../../services/state-store.ts";
import type { Invocation } from "../commands/index.ts";
import { profileRoutes } from "./profiles.ts";
import { outcomeOf } from "./route.test-support.ts";
import type { Route } from "./route.ts";

type InvocationOf<Tag extends Invocation["_tag"]> = Extract<Invocation, { readonly _tag: Tag }>;

const applyInvocation = (
  world: Effect.Success<typeof profileFixture>,
  overrides: Partial<InvocationOf<"profile-apply">> = {},
): InvocationOf<"profile-apply"> => ({
  _tag: "profile-apply",
  reference: world.request.reference,
  namespace: world.request.namespace,
  targetRoots: world.request.targetRoots,
  force: false,
  apply: false,
  ...overrides,
});

const homeNeed = <I extends Invocation>(route: Route<I>, invocation: I) =>
  typeof route.needsHome === "function" ? route.needsHome(invocation) : route.needsHome;

it.layer(LiveTestLayer)("profile routes", (test) => {
  test("reads the operator home only for a user namespace", () => {
    const user = { _tag: "user" } as const;
    const project = { _tag: "project", projectName: "ci" } as const;
    const target = { targetRoots: [], force: false, apply: false } as const;
    const apply = { _tag: "profile-apply", reference: "tools:ci", ...target } as const;
    const adopt = { _tag: "profile-adopt", reference: "tools:ci", apply: false } as const;
    const bundle = { _tag: "profile-apply-bundle", file: "ci.tar.gz", ...target } as const;
    expect([
      homeNeed(profileRoutes["profile-apply"], { ...apply, namespace: user }),
      homeNeed(profileRoutes["profile-apply"], { ...apply, namespace: project }),
      homeNeed(profileRoutes["profile-adopt"], { ...adopt, namespace: user }),
      homeNeed(profileRoutes["profile-adopt"], { ...adopt, namespace: project }),
      homeNeed(profileRoutes["profile-apply-bundle"], { ...bundle, namespace: user }),
      homeNeed(profileRoutes["profile-apply-bundle"], { ...bundle, namespace: project }),
    ]).toEqual([true, false, true, false, true, false]);
  });

  test.effect("previews a profile apply as success and reports the applied sync once applied", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      const route = profileRoutes["profile-apply"];
      const preview = yield* world.run(outcomeOf(route.run(applyInvocation(world), world.options)));
      expect(preview).toMatchObject({ classification: "success", diagnostics: [] });
      expect(preview).not.toHaveProperty("applied");
      expect((yield* readState(world.options)).data.profileApplications ?? []).toEqual([]);

      const applied = yield* world.run(
        outcomeOf(route.run(applyInvocation(world, { apply: true }), world.options)),
      );
      expect(applied).toMatchObject({ classification: "success", applied: expect.anything() });
      expect(
        yield* world.fs.readLink(world.path.join(world.project, ".agents/skills/review")),
      ).toContain("review");
    }),
  );

  test.effect("classifies a refused profile apply as a domain outcome", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-apply"].run(
            applyInvocation(world, { reference: "tools:missing", apply: true }),
            world.options,
          ),
        ),
      );
      expect(outcome).toMatchObject({
        classification: "domain",
        plan: { refused: true, findings: [{ code: "profile-unpublished" }] },
      });
      expect(outcome).not.toHaveProperty("applied");
    }),
  );

  test.effect("classifies a profile apply that leaves a foreign destination as partial", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      yield* world.write("project/.agents/skills/review/SKILL.md", "foreign\n");
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-apply"].run(
            applyInvocation(world, { apply: true }),
            world.options,
          ),
        ),
      );
      expect(outcome.classification).toBe("partial");
      expect(
        yield* world.fs.readFileString(
          world.path.join(world.project, ".agents/skills/review/SKILL.md"),
        ),
      ).toBe("foreign\n");
    }),
  );

  test.effect("applies a member an enabled agent cannot take as skipped, not partial", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      yield* world.write(
        "source/tack.yaml",
        "version: 2\nname: tools\nskills: [{path: skills}]\ncommands: [{path: commands}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
      );
      yield* world.write("source/commands/ship.md", "---\ndescription: Ship it\n---\nShip.\n");
      yield* world.write("source/ci.yaml", "version: 1\nname: ci\nmembers: [notes, ship]\n");
      yield* mutateStateFixture(world.options, (state) => ({
        ...state,
        data: { ...state.data, enabledAdapters: ["claude"] },
      }));
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-apply"].run(
            applyInvocation(world, { apply: true }),
            world.options,
          ),
        ),
      );
      expect(outcome).toMatchObject({
        classification: "success",
        plan: {
          delivery: {
            incomplete: false,
            skipped: [
              {
                member: `command ${world.sourceId}:ship`,
                adapter: "claude",
                reason: "Tack does not link commands for claude",
              },
            ],
          },
        },
      });
      expect(
        yield* world.fs.readLink(world.path.join(world.project, ".claude/skills/notes")),
      ).toContain("notes");
    }),
  );

  test.effect("checks every applied docs action before calling a profile apply complete", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      yield* world.write(
        "source/tack.yaml",
        "version: 2\nname: tools\nskills: [{path: skills}]\ndocs: [{name: handbook, path: docs}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
      );
      yield* world.write("source/docs/index.md", "# Guide");
      yield* world.write("source/ci.yaml", "version: 1\nname: ci\nmembers: [review, handbook]\n");
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-apply"].run(
            applyInvocation(world, { apply: true }),
            world.options,
          ),
        ),
      );
      expect(outcome).toMatchObject({
        classification: "success",
        applied: { docs: [{ actions: [{ _tag: "applied" }] }] },
      });
      expect(yield* world.fs.exists(world.path.join(world.project, ".tack/docs"))).toBe(true);
    }),
  );

  test.effect("passes an explicit target home to a user profile apply", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      const targetHome = world.path.join(world.root, "isolated-home");
      yield* world.fs.makeDirectory(targetHome);
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-apply"].run(
            applyInvocation(world, {
              namespace: { _tag: "user" },
              targetRoots: [],
              targetHome,
            }),
            world.options,
          ),
        ),
      );
      expect(JSON.stringify(outcome.plan)).toContain(targetHome);
    }),
  );

  test.effect("exports a profile bundle only on apply and refuses an unknown profile", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      const route = profileRoutes["profile-export"];
      const output = world.path.join(world.root, "ci.tar.gz");
      const invocation = {
        _tag: "profile-export",
        reference: "tools:ci",
        output,
        apply: false,
      } as const;
      const preview = yield* world.run(outcomeOf(route.run(invocation, world.options)));
      expect(preview).toMatchObject({ classification: "success" });
      expect(preview).not.toHaveProperty("applied");
      expect(yield* world.fs.exists(output)).toBe(false);

      expect(
        yield* world.run(outcomeOf(route.run({ ...invocation, apply: true }, world.options))),
      ).toMatchObject({
        classification: "success",
        applied: { exported: true, output },
      });
      expect(yield* world.fs.exists(output)).toBe(true);

      // Export never overwrites, so an occupied output path refuses the export.
      const refused = yield* world.run(
        outcomeOf(route.run({ ...invocation, apply: true }, world.options)),
      );
      expect(refused).toMatchObject({
        classification: "domain",
        plan: { refused: true, findings: [{ code: "profile-bundle-identity" }] },
      });
      expect(refused).not.toHaveProperty("applied");

      const unknown = yield* world.run(
        outcomeOf(
          route.run(
            { ...invocation, reference: "tools:missing", output: `${output}.missing` },
            world.options,
          ),
        ),
      );
      expect(unknown).toMatchObject({
        classification: "domain",
        plan: { refused: true, files: [], findings: [{ code: "profile-unpublished" }] },
      });
      expect(unknown.plan).not.toHaveProperty("manifest");
    }),
  );

  test.effect("inspects a bundle file as its manifest without reading state", () =>
    Effect.gen(function* () {
      const world = yield* bundleFixture;
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-inspect-bundle"].run(
            { _tag: "profile-inspect-bundle", file: world.file },
            {},
          ),
        ),
      );
      expect(outcome).toMatchObject({
        classification: "success",
        result: {
          kind: "profile-bundle-inspection",
          file: world.file,
          manifest: { profile: { name: "ci" } },
        },
      });
    }),
  );

  test.effect("applies a bundle through the same outcome as a profile apply", () =>
    Effect.gen(function* () {
      const world = yield* bundleFixture;
      const invocation = {
        _tag: "profile-apply-bundle",
        file: world.file,
        namespace: world.request.namespace,
        targetRoots: world.request.targetRoots,
        force: false,
        apply: true,
      } as const;
      const outcome = yield* world.run(
        outcomeOf(profileRoutes["profile-apply-bundle"].run(invocation, world.options)),
      );
      expect(outcome).toMatchObject({ classification: "success", applied: expect.anything() });
      expect((yield* readState(world.options)).data.profileApplications).toHaveLength(1);
    }),
  );

  test.effect("saves the effective user picks into a profile and refuses an invalid save", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      yield* mutateStateFixture(world.options, (state) => ({
        ...state,
        data: {
          ...state.data,
          userChoices: [
            {
              address: { kind: "skill", name: "notes", sourceRegistrationId: world.sourceId },
              decision: "include",
            },
          ],
        },
      }));
      const route = profileRoutes["profile-save"];
      const invocation = {
        _tag: "profile-save",
        sourcePath: world.source,
        name: "toolbox",
        input: "user",
        edit: false,
        apply: true,
      } as const;
      const saved = yield* world.run(outcomeOf(route.run(invocation, world.options)));
      expect(saved).toMatchObject({ classification: "success", applied: { saved: true } });
      expect(
        yield* world.fs.readFileString(world.path.join(world.source, "profiles/toolbox.yaml")),
      ).toContain("notes");

      const refused = yield* world.run(outcomeOf(route.run(invocation, world.options)));
      expect(refused).toMatchObject({ classification: "domain" });
      expect(refused).not.toHaveProperty("applied");
    }),
  );

  test.effect("saves the user plus a named project without reading the working directory", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-save"].run(
            {
              _tag: "profile-save",
              sourcePath: world.source,
              name: "both",
              input: "user+project",
              projectName: "ci",
              edit: false,
              apply: false,
            },
            world.options,
          ),
        ),
      );
      expect(outcome).toMatchObject({ classification: "success" });
      expect(outcome).not.toHaveProperty("applied");
    }),
  );

  test.effect("saves the project that contains the working directory when none is named", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      // The route reads the process working directory; register it as a root of the fixture project.
      const cwd = yield* world.fs.realPath(world.path.resolve("."));
      yield* mutateStateFixture(world.options, (state) => ({
        ...state,
        data: {
          ...state.data,
          projects: state.data.projects.map((project) => ({
            ...project,
            roots: [...project.roots, cwd].toSorted(),
            choices: [
              {
                address: { kind: "skill", name: "notes", sourceRegistrationId: world.sourceId },
                decision: "include",
              },
            ],
          })),
        },
      }));
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-save"].run(
            {
              _tag: "profile-save",
              sourcePath: world.source,
              name: "outside",
              input: "project",
              edit: false,
              apply: false,
            },
            world.options,
          ),
        ),
      );
      expect(outcome).toMatchObject({ classification: "success" });
      expect(JSON.stringify(outcome.plan)).toContain("notes");
    }),
  );

  test.effect("adopts a profile into picks, partial with blockers and domain with findings", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      const route = profileRoutes["profile-adopt"];
      const invocation = {
        _tag: "profile-adopt",
        reference: "tools:ci",
        namespace: { _tag: "project", projectName: "ci" },
        apply: true,
      } as const;
      const adopted = yield* world.run(outcomeOf(route.run(invocation, world.options)));
      expect(adopted).toMatchObject({ classification: "success", applied: { adopted: true } });
      expect((yield* readState(world.options)).data.projects[0]?.choices).toBeDefined();

      const refused = yield* world.run(
        outcomeOf(route.run({ ...invocation, reference: "tools:missing" }, world.options)),
      );
      expect(refused).toMatchObject({ classification: "domain" });
      expect(refused).not.toHaveProperty("applied");
    }),
  );

  test.effect("previews an adopt into a project with a missing root as partial", () =>
    Effect.gen(function* () {
      const world = yield* profileFixture;
      yield* world.fs.remove(world.project, { recursive: true });
      const outcome = yield* world.run(
        outcomeOf(
          profileRoutes["profile-adopt"].run(
            {
              _tag: "profile-adopt",
              reference: "tools:ci",
              namespace: { _tag: "project", projectName: "ci" },
              apply: false,
            },
            world.options,
          ),
        ),
      );
      expect(outcome).toMatchObject({ classification: "partial", plan: { findings: [] } });
      expect(outcome).not.toHaveProperty("applied");
    }),
  );
});
