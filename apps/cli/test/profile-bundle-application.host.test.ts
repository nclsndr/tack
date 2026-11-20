import { saveProfile } from "../src/features/profiles/profile-save.ts";
import { relocateSource } from "../src/features/sources/source.ts";
import { expect, it } from "@effect/vitest";
import { Effect, PlatformError } from "effect";
import { LiveTestLayer, provideTestFileSystem } from "./support/live-test-layer.ts";
import { bundleFixture } from "./support/bundle-fixture.ts";
import { mutateState } from "./support/state-fixture.ts";
import { runBundleApply } from "../src/features/profiles/bundle-apply.ts";
import { runBundleExport } from "../src/features/profiles/bundle-export.ts";
import { readState } from "../src/services/state-store.ts";
import { runSyncCommand } from "../src/features/reconciliation/sync-command.ts";
import { collectProfileInput, runProfileAdopt } from "../src/features/profiles/profile-copy.ts";
import { readInvocationSnapshot } from "../src/features/snapshot/command-snapshot.ts";

it.layer(LiveTestLayer)("bundle application parity and retention", (test) => {
  test.effect("retains empty application intent and still requires replacement authorization", () =>
    Effect.gen(function* () {
      const { fs, path, root, options, request, run, write } = yield* bundleFixture;
      yield* write("source/ci.yaml", "version: 1\nname: ci\nmembers: []\n");
      const file = path.join(root, "empty.tar.gz");
      const exported = yield* runBundleExport(options, {
        reference: "tools:ci",
        output: file,
        apply: true,
      });
      expect(exported.exported, JSON.stringify(exported.plan.findings)).toBe(true);
      const first = yield* run(runBundleApply(options, { ...request, file }));
      expect(first.plan.refused).toBe(false);
      const state = yield* readState(options);
      expect(state.data.profileApplications?.[0]?.inventory).toEqual([]);
      expect(state.data.links).toEqual([]);
      expect(
        (yield* run(runBundleApply(options, { ...request, file }))).plan.findings[0]?.code,
      ).toBe("profile-existing-selection");
      expect(
        (yield* run(runBundleApply(options, { ...request, file, force: true }))).plan.refused,
      ).toBe(false);
      expect((yield* readState(options)).data.sources).toEqual(state.data.sources);
      expect(yield* fs.exists(path.join(root, "project/.agents/skills"))).toBe(false);
    }),
  );
  test.effect(
    "refuses editing or rebinding retained artifact projections before changing their bytes",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run, file } = yield* bundleFixture;
        yield* run(runBundleApply(options, { ...request, file }));
        const state = yield* readState(options);
        const source = state.data.sources.find((registration) => registration.bundle !== undefined);
        if (source === undefined) throw new Error("Missing bundle source");
        const before = yield* fs.readFileString(path.join(source.canonicalPath, "ci.yaml"));
        const saved = yield* saveProfile(options, {
          sourcePath: source.canonicalPath,
          profile: { version: 1, name: "ci", members: [] },
        });
        expect(saved.saved).toBe(false);
        expect(saved.report.findings.map((finding) => finding.code)).toContain(
          "profile-bundle-immutable",
        );
        expect(yield* fs.readFileString(path.join(source.canonicalPath, "ci.yaml"))).toBe(before);
        expect(
          (yield* Effect.result(
            relocateSource(options, {
              registrationId: source.id,
              sourcePath: path.join(root, "source"),
            }),
          ))["_tag"],
        ).toBe("Failure");
        expect(yield* readState(options)).toEqual(state);
        yield* mutateState(options, (current) => ({
          ...current,
          data: {
            ...current.data,
            sources: current.data.sources.map((registration) =>
              registration.id !== source.id || registration.bundle === undefined
                ? registration
                : {
                    ...registration,
                    bundle: {
                      ...registration.bundle,
                      bindings: {
                        ...registration.bundle.bindings,
                        team:
                          current.data.sources.find((candidate) => candidate.bundle === undefined)
                            ?.id ?? source.id,
                      },
                    },
                  },
            ),
          },
        }));
        const changed = yield* readState(options);
        expect(
          (yield* run(runBundleApply(options, { ...request, file, force: true }))).plan.findings[0]
            ?.code,
        ).toBe("profile-bundle-identity");
        expect(yield* readState(options)).toEqual(changed);
      }),
  );
  test.effect(
    "keeps an isolated user target fixed and refuses a shared context or redirected parents",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, home, options, request, run, file } = yield* bundleFixture;
        const ordinary = path.join(root, "ordinary-home");
        yield* fs.makeDirectory(path.join(ordinary, ".agents/skills"), { recursive: true });
        const sentinel = path.join(ordinary, ".agents/skills/sentinel");
        yield* fs.writeFileString(sentinel, "ordinary bytes");
        yield* fs.symlink(path.join(ordinary, ".agents"), path.join(home, ".agents"));
        const user = {
          ...request,
          file,
          namespace: { _tag: "user" as const },
          targetRoots: [],
          targetHome: home,
        };
        const before = yield* readState(options);
        expect(
          (yield* run(runBundleApply(options, { ...user, force: true }))).plan.findings[0]?.code,
        ).toBe("profile-target-boundary");
        expect(yield* readState(options)).toEqual(before);
        expect(yield* fs.exists(path.join(options.environment.TACK_STATE_DIR, "bundles"))).toBe(
          false,
        );
        yield* fs.rename(path.join(home, ".agents"), path.join(home, "redirected-agents"));
        const applied = yield* run(runBundleApply(options, user));
        expect(applied.plan.refused, JSON.stringify(applied.plan.findings)).toBe(false);
        expect(yield* fs.exists(path.join(home, ".agents/skills/review"))).toBe(true);
        const other = {
          homeDirectory: ordinary,
          environment: { HOME: ordinary, TACK_STATE_DIR: options.environment.TACK_STATE_DIR },
        };
        const sync = yield* run(
          runSyncCommand(other, {
            apply: true,
            cwd: root,
            includeOptional: true,
            noDocs: false,
            selector: { _tag: "user" },
          }),
        );
        expect(sync.plan.resources?.causes.map((cause) => cause.code)).toContain(
          "profile-inventory-unresolved",
        );
        expect(
          (yield* run(runBundleApply(other, { ...user, targetHome: ordinary, force: true }))).plan
            .refused,
        ).toBe(true);
        expect(yield* fs.readFileString(sentinel)).toBe("ordinary bytes");
        expect(yield* fs.exists(path.join(ordinary, ".agents/skills/review"))).toBe(false);
      }),
  );
  test.effect(
    "retains registrations, bytes and exact intent after zero successful links, then retries without defaults",
    () =>
      Effect.gen(function* () {
        const { fs, path, project, options, request, run, file } = yield* bundleFixture;
        const failed = {
          ...fs,
          symlink: () =>
            Effect.fail(PlatformError.badArgument({ module: "bundle-test", method: "symlink" })),
        };
        const result = yield* run(
          provideTestFileSystem(runBundleApply(options, { ...request, file }), failed),
        );
        expect(
          result.applied?.resources?.units
            .flatMap((unit) => unit.actions)
            .filter((action) => action["_tag"] === "failed"),
        ).toHaveLength(2);
        const state = yield* readState(options);
        expect(state.data.links).toEqual([]);
        expect(state.data.sources.filter((source) => source.bundle !== undefined)).toHaveLength(1);
        expect(state.data.profileApplications).toHaveLength(1);
        expect((yield* run(runBundleApply(options, { ...request, file }))).plan.refused).toBe(true);
        const payload = state.data.sources.find(
          (source) => source.bundle !== undefined,
        )?.canonicalPath;
        if (payload === undefined) throw new Error("Missing retained payload");
        expect(yield* fs.exists(payload)).toBe(true);
        yield* run(
          runSyncCommand(options, {
            apply: true,
            cwd: project,
            includeOptional: true,
            noDocs: false,
            selector: request.namespace,
          }),
        );
        expect((yield* fs.readDirectory(path.join(project, ".agents/skills"))).sort()).toEqual([
          "review",
          "style",
        ]);
        expect((yield* readState(options)).data.sources).toEqual(state.data.sources);
      }),
  );
  test.effect(
    "keeps foreign-only occupancy separate from selection and retains an incomplete application",
    () =>
      Effect.gen(function* () {
        const { fs, path, project, options, request, run, file } = yield* bundleFixture;
        yield* fs.makeDirectory(path.join(project, ".agents/skills"), { recursive: true });
        for (const name of ["review", "style"])
          yield* fs.writeFileString(path.join(project, ".agents/skills", name), "foreign");
        const applied = yield* run(runBundleApply(options, { ...request, file }));
        expect(applied.plan.existing).toEqual([]);
        expect(applied.plan.refused).toBe(false);
        expect(
          applied.plan.sync?.resources?.plan.units.reduce(
            (sum, unit) => sum + unit.summary.conflict,
            0,
          ),
        ).toBeGreaterThan(0);
        expect((yield* readState(options)).data.links).toEqual([]);
        const forced = yield* run(runBundleApply(options, { ...request, file, force: true }));
        expect(forced.plan.refused).toBe(false);
        for (const name of ["review", "style"])
          expect(yield* fs.readFileString(path.join(project, ".agents/skills", name))).toBe(
            "foreign",
          );
      }),
  );
  test.effect(
    "keeps revisions distinct and leaves earlier payloads retained for ownership and recovery",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run, file } = yield* bundleFixture;
        yield* run(runBundleApply(options, { ...request, file }));
        const oldState = yield* readState(options);
        const oldProjection = oldState.data.sources.find((source) => source.bundle !== undefined);
        if (oldProjection === undefined) throw new Error("Missing old projection");
        const skill = path.join(root, "source/skills/review/SKILL.md");
        yield* fs.writeFileString(skill, (yield* fs.readFileString(skill)) + "\nRevision two\n");
        const second = path.join(root, "revision-two.tar.gz");
        expect(
          (yield* runBundleExport(options, { reference: "tools:ci", output: second, apply: true }))
            .exported,
        ).toBe(true);
        const newer = yield* run(
          runBundleApply(options, { ...request, file: second, force: true }),
        );
        expect(newer.plan.refused).toBe(false);
        expect(newer.plan.bundle?.identity).not.toBe(oldProjection.bundle?.identity);
        expect(yield* fs.exists(oldProjection.canonicalPath)).toBe(true);
        expect(
          yield* fs.readFileString(
            path.join(oldProjection.canonicalPath, "skills/review/SKILL.md"),
          ),
        ).not.toContain("Revision two");
        expect(
          yield* fs.readFileString(
            path.join(request.targetRoots[0], ".agents/skills/review/SKILL.md"),
          ),
        ).toContain("Revision two");
        expect(
          (yield* readState(options)).data.sources.filter((source) => source.bundle !== undefined),
        ).toHaveLength(2);
      }),
  );
  test.effect(
    "keeps projected defaults out of unrelated daily contexts while explicit adoption remains organic",
    () =>
      Effect.gen(function* () {
        const { root, options, request, run, file } = yield* bundleFixture;
        const applied = yield* run(runBundleApply(options, { ...request, file }));
        yield* mutateState(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            projects: [
              ...state.data.projects,
              { name: "daily", gitCommonDirectory: root + "/daily-git", roots: [root + "/daily"] },
            ],
          },
        }));
        const daily = { _tag: "project" as const, projectName: "daily" };
        const before = yield* collectProfileInput(yield* readInvocationSnapshot(options), {
          user: false,
          projectName: "daily",
        });
        const ids = (yield* readState(options)).data.sources
          .filter((source) => source.bundle !== undefined)
          .map((source) => source.id);
        expect(
          before.members.some((member) => ids.includes(member.address.sourceRegistrationId)),
        ).toBe(false);
        expect(
          (yield* run(
            runProfileAdopt(options, {
              reference: applied.plan.reference,
              namespace: daily,
              apply: true,
              cwd: root,
            }),
          )).adopted,
        ).toBe(true);
        const after = yield* collectProfileInput(yield* readInvocationSnapshot(options), {
          user: false,
          projectName: "daily",
        });
        expect(
          after.members.some((member) => ids.includes(member.address.sourceRegistrationId)),
        ).toBe(true);
        expect(after.members.map((member) => member.address.name)).toContain("notes");
      }),
  );
});
