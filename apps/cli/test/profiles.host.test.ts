import { skillText } from "./support/source-tree.ts";
import { writeUnder, seedSource, bareSkillText } from "./support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { checkPaths } from "../src/features/check/check-paths.ts";
import { checkSource } from "../src/features/sources/source-check.ts";
import { initializeState, readState } from "../src/services/state-store.ts";
import { registerSource } from "../src/features/sources/source.ts";
import { saveProfile } from "../src/features/profiles/profile-save.ts";
import { profilePublications } from "../src/features/sources/profile-publications.ts";
import { profileContext } from "../src/features/profiles/profile-check.ts";
import { resolveProfile } from "../src/domain/profiles/profile-resolution.ts";
import { provideTestFileSystem } from "./support/live-test-layer.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-profiles-" }));
  const options = {
    homeDirectory: root,
    environment: { TACK_STATE_DIR: path.join(root, "state") },
  };
  const write = writeUnder(root);
  // The profile lives under `profiles/`, so this source does not start from the standard tree.
  yield* seedSource(path.join(root, "owner"), {
    "tack.yaml":
      "version: 2\nname: owner\nskills:\n  - path: skills\ncommands:\n  - path: commands\nprofiles:\n  - name: ci\n    path: profiles/ci.yaml\n",
    "skills/review/SKILL.md": bareSkillText("review", {
      description: "Review",
      tack: [
        "activation: opt-in",
        "projects: [other]",
        "dependencies:",
        "  - kind: command",
        "    name: lint",
        "  - kind: command",
        "    name: optional",
        "    optional: true",
      ],
    }),
    "commands/lint.md": "Lint",
    "commands/optional.md": "Optional",
    "profiles/ci.yaml": "version: 1\nname: ci\nmembers: [review]\n",
  });
  const check = () =>
    Effect.gen(function* () {
      const folders = yield* Effect.filter(yield* fs.readDirectory(root), (directory) =>
        fs
          .stat(path.join(root, directory))
          .pipe(
            Effect.flatMap((info) =>
              info.type === "Directory"
                ? fs.exists(path.join(root, directory, "tack.yaml"))
                : Effect.succeed(false),
            ),
          ),
      );
      return yield* checkPaths(folders.map((directory) => path.join(root, directory)));
    });
  return { fs, path, root, options, write, check };
});

it.layer(LiveTestLayer)("fixed profile authoring", (test) => {
  test.effect("checks the built-in skill's actual declaration and manifest examples", () =>
    Effect.gen(function* () {
      const { root, path, options, write, fs, check } = yield* fixture;
      const guidance = yield* fs.readFileString(
        new URL("../src/builtins/skills/author-tack-profiles/SKILL.md", import.meta.url).pathname,
      );
      const examples = [...guidance.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
        (match) => match[1] ?? "",
      );
      expect(examples).toHaveLength(2);
      yield* write("owner/tack.yaml", examples[0] ?? "");
      yield* write("owner/profiles/ci.yaml", examples[1] ?? "");
      yield* write(
        "owner/skills/review/SKILL.md",
        skillText("review", { description: "Review", body: "" }),
      );
      yield* write("team/tack.yaml", "version: 1\nname: team\ncommands: [{path: audit.md}]\n");
      yield* write("team/audit.md", "Audit");
      yield* initializeState(options);
      yield* registerSource(options, { sourcePath: path.join(root, "team") });
      const before = yield* readState(options);
      expect((yield* checkSource(path.join(root, "owner"))).findings).toEqual([]);
      const report = yield* check();
      expect(report.summary.errors).toBe(0);
      expect(report.checks.flatMap((item) => item.details).join("\n")).toMatch(
        /Direct members \(2\)[\s\S]*review[\s\S]*audit/,
      );
      expect(yield* readState(options)).toEqual(before);
    }),
  );
  test.effect("refuses unpublished, broken and escaped profile saves", () =>
    Effect.gen(function* () {
      const { root, path, options, write, check, fs } = yield* fixture;
      yield* write("owner/profiles/absent.yaml", "version: 1\nname: absent\nmembers: []\n");
      expect(
        (yield* checkPaths([path.join(root, "owner/profiles/absent.yaml")])).findings,
      ).toContainEqual(expect.objectContaining({ code: "profile-unpublished" }));
      yield* write("owner/profiles/ci.yaml", "version: 1\nname: ci\nmembers: [42]\n");
      expect(
        (yield* saveProfile(options, {
          sourcePath: path.join(root, "owner"),
          profile: { version: 1, name: "ci", members: [] },
        })).saved,
      ).toBe(false);
      yield* fs.rename(path.join(root, "owner/profiles"), path.join(root, "escaped-profiles"));
      yield* fs.symlink(path.join(root, "escaped-profiles"), path.join(root, "owner/profiles"));
      expect(
        (yield* saveProfile(options, {
          sourcePath: path.join(root, "owner"),
          profile: { version: 1, name: "escaped", members: [] },
        })).saved,
      ).toBe(false);
      expect(yield* fs.exists(path.join(root, "escaped-profiles/escaped.yaml"))).toBe(false);
      expect((yield* check()).summary.errors).toBeGreaterThan(0);
      yield* write("owner/tack.yaml", "version: 2\nskills: []\ncommands: []\nprofiles: [42]\n");
      expect(
        (yield* saveProfile(options, {
          sourcePath: path.join(root, "owner"),
          profile: { version: 1, name: "ci", members: [] },
        })).saved,
      ).toBe(false);
      yield* write("owner/tack.yaml", "{version: 1, commands: []}\n");
      expect(
        (yield* saveProfile(options, {
          sourcePath: path.join(root, "owner"),
          profile: { version: 1, name: "flow", members: [] },
        })).report.findings,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "profile-publication-layout" })]),
      );
    }),
  );
  test.effect(
    "serializes saves through the final rename and refuses a concurrent publication",
    () =>
      Effect.gen(function* () {
        const { root, path, options, fs } = yield* fixture;
        const sourcePath = path.join(root, "owner");
        const file = path.join(sourcePath, "profiles/ci.yaml");
        const original = yield* fs.readFileString(file);
        const services = yield* Effect.context<Effect.Services<ReturnType<typeof saveProfile>>>();
        let competitor: Effect.Success<ReturnType<typeof saveProfile>> | undefined;
        let triggered = false;
        const raced = {
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (to === file && triggered === false) {
                triggered = true;
                competitor = yield* saveProfile(options, {
                  sourcePath,
                  profile: { version: 1, name: "other", members: [] },
                }).pipe(Effect.provideContext(services), Effect.orDie);
              }
              yield* fs.rename(from, to);
            }),
        } satisfies FileSystem.FileSystem;
        const first = yield* provideTestFileSystem(
          saveProfile(options, {
            sourcePath,
            expectedContent: original,
            profile: { version: 1, name: "ci", members: [] },
          }),
          raced,
        );
        expect(first.saved).toBe(true);
        expect(competitor).toMatchObject({
          saved: false,
          report: {
            findings: expect.arrayContaining([
              expect.objectContaining({
                code: "profile-save-conflict",
                message: expect.stringContaining("another save"),
              }),
            ]),
          },
        });
        expect(yield* fs.exists(path.join(sourcePath, "profiles/other.yaml"))).toBe(false);
        expect(yield* fs.readFileString(path.join(sourcePath, "tack.yaml"))).not.toContain("other");
        expect(yield* fs.exists(path.join(sourcePath, ".tack-profile-save.lock"))).toBe(false);
        expect(
          (yield* saveProfile(options, {
            sourcePath,
            profile: { version: 1, name: "other", members: [] },
          })).saved,
        ).toBe(true);
      }),
  );
  test.effect(
    "refuses an intervening profile edit after staging and removes its scratch files",
    () =>
      Effect.gen(function* () {
        const { root, path, options, fs } = yield* fixture;
        const sourcePath = path.join(root, "owner");
        const file = path.join(sourcePath, "profiles/ci.yaml");
        const original = yield* fs.readFileString(file);
        const intervening = `${original}# edited while save was staging\n`;
        let changed = false;
        const raced = {
          ...fs,
          makeTempFileScoped: (settings) =>
            Effect.gen(function* () {
              const temporary = yield* fs.makeTempFileScoped(settings);
              if (settings?.prefix === ".profile-" && changed === false) {
                changed = true;
                yield* fs.writeFileString(file, intervening);
              }
              return temporary;
            }),
        } satisfies FileSystem.FileSystem;
        const result = yield* provideTestFileSystem(
          saveProfile(options, {
            sourcePath,
            expectedContent: original,
            profile: { version: 1, name: "ci", members: [] },
          }),
          raced,
        );
        expect(result.saved).toBe(false);
        expect(result.report.findings).toContainEqual(
          expect.objectContaining({ code: "profile-save-conflict" }),
        );
        expect(yield* fs.readFileString(file)).toBe(intervening);
        expect(
          (yield* fs.readDirectory(path.dirname(file))).filter((name) =>
            name.startsWith(".profile-"),
          ),
        ).toEqual([]);
        expect(yield* fs.exists(path.join(sourcePath, ".tack-profile-save.lock"))).toBe(false);
      }),
  );
  test.effect("refuses source changes both after validation and before the final rename", () =>
    Effect.gen(function* () {
      const { root, path, options, fs } = yield* fixture;
      const declaration = path.join(root, "owner/tack.yaml");
      const before = yield* fs.readFileString(declaration);
      for (const raceRead of [2, 3]) {
        let reads = 0;
        const raced = {
          ...fs,
          readFileString: (file, encoding) =>
            Effect.suspend(() => {
              if (file === declaration) reads += 1;
              return file === declaration && reads === raceRead
                ? Effect.succeed(`${before}maintainers: [changed]\n`)
                : fs.readFileString(file, encoding);
            }),
        } satisfies FileSystem.FileSystem;
        const result = yield* provideTestFileSystem(
          saveProfile(options, {
            sourcePath: path.join(root, "owner"),
            profile: { version: 1, name: "ci", members: [] },
          }),
          raced,
        );
        expect(result.saved).toBe(false);
        expect(result.report.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "profile-save-conflict" })]),
        );
        expect(yield* fs.readFileString(declaration)).toBe(before);
      }
    }),
  );
  test.effect(
    "reports independent schema, path and publication problems while healthy resources stay available",
    () =>
      Effect.gen(function* () {
        const { root, path, write, fs, check } = yield* fixture;
        const declarations = [
          ["profiles: wrong", "profile-publication-invalid"],
          [
            "profiles: [{name: ci, path: profiles/ci.yaml, typo: true}]",
            "profile-publication-invalid",
          ],
          [
            "profiles: [{name: ci, path: profiles/ci.yaml}, {name: ci, path: another.yaml}]",
            "profile-publication-duplicate",
          ],
          ["profiles: [{name: ci, path: ../outside.yaml}]", "profile-path-invalid"],
          ["profiles: [{name: ci, path: tack.yaml}]", "profile-path-invalid"],
          ["profiles: [{name: ci, path: absent.yaml}]", "profile-declaration-path-missing"],
          ["profiles: [{name: ci, path: profiles}]", "profile-path-wrong-type"],
        ];
        for (const [section, code] of declarations) {
          yield* write(
            "owner/tack.yaml",
            `version: 2\nname: owner\nskills: [{path: skills}]\n${section}\n`,
          );
          const report = yield* checkSource(path.join(root, "owner"));
          expect(report.counts.skill).toBe(1);
          expect(report.findings).toEqual(
            expect.arrayContaining([expect.objectContaining({ code })]),
          );
        }
        yield* write(
          "owner/tack.yaml",
          "version: 2\nname: owner\nskills: [{path: skills}]\nprofiles: [{name: ci, path: profiles/ci.yaml}]\n",
        );
        for (const content of [
          "version: [",
          "version: 1\nname: ci\nmembers: [42]\n",
          "version: 1\nname: ci\nmembers: []\nunknown: true\n",
        ]) {
          yield* write("owner/profiles/ci.yaml", content);
          expect((yield* check()).findings).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: "profile-schema-invalid" })]),
          );
        }
        yield* write("outside.yaml", "version: 1\nname: ci\nmembers: []\n");
        yield* fs.rename(
          path.join(root, "owner/profiles/ci.yaml"),
          path.join(root, "original.yaml"),
        );
        yield* fs.symlink(
          path.join(root, "outside.yaml"),
          path.join(root, "owner/profiles/ci.yaml"),
        );
        expect((yield* check()).findings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "profile-declaration-path-outside-source" }),
          ]),
        );
      }),
  );
  test.effect(
    "keeps exact inventory under registration permutations and reports undeclared, quarantined and missing members",
    () =>
      Effect.gen(function* () {
        const { root, path, write, options, check } = yield* fixture;
        const current = yield* profileContext(options, path.join(root, "owner"));
        const profile = { version: 1, name: "ci", members: ["review"] } as const;
        expect(
          resolveProfile(
            profile,
            current.registration.id,
            {
              ...current.catalog,
              entries: [...current.catalog.entries].reverse(),
              sources: [...(current.catalog.sources ?? [])].reverse(),
            },
            "ci.yaml",
          ),
        ).toEqual(resolveProfile(profile, current.registration.id, current.catalog, "ci.yaml"));
        yield* write(
          "owner/profiles/ci.yaml",
          "version: 1\nname: ci\nmembers: [{name: review, source: team}]\n",
        );
        expect((yield* check()).findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "profile-source-undeclared" })]),
        );
        yield* write("owner/profiles/ci.yaml", "version: 1\nname: ci\nmembers: [review]\n");
        yield* write("owner/skills/review/SKILL.md", "---\nname: review\n---\n");
        expect((yield* check()).findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "profile-member-quarantined" })]),
        );
      }),
  );
  test.effect(
    "checks scripts and docs as data without invoking code and does not admit new defaults",
    () =>
      Effect.gen(function* () {
        const { root, path, write, check, fs } = yield* fixture;
        yield* write("owner/commands/new-default.md", "Default");
        yield* write(
          "owner/tack.yaml",
          "version: 2\nname: owner\ncommands: [{path: commands}]\nscripts: [{name: danger, path: danger.ts, description: Never execute}]\ndocs: [{name: guide, path: docs}]\nprofiles: [{name: ci, path: profiles/ci.yaml}]\n",
        );
        yield* write("owner/danger.ts", "throw new Error('profile check executed supplied code');");
        yield* write("owner/docs/index.md", "# Guide\n");
        yield* write("owner/profiles/ci.yaml", "version: 1\nname: ci\nmembers: [danger, guide]\n");
        const before = yield* fs.readFileString(path.join(root, "owner/danger.ts"));
        const result = yield* check();
        expect(result.summary.errors).toBe(0);
        expect(result.checks.flatMap((item) => item.details)).toEqual(
          expect.arrayContaining([
            "Direct members (2)",
            "docs owner:guide",
            "script owner:danger",
            "Required dependencies (0)",
          ]),
        );
        expect(yield* fs.readFileString(path.join(root, "owner/danger.ts"))).toBe(before);
      }),
  );
  test.effect("refuses stale and occupied saves and retains the original published bytes", () =>
    Effect.gen(function* () {
      const { root, path, options, write, fs } = yield* fixture;
      const original = yield* fs.readFileString(path.join(root, "owner/profiles/ci.yaml"));
      const stale = yield* saveProfile(options, {
        sourcePath: path.join(root, "owner"),
        profile: { version: 1, name: "ci", members: [] },
        expectedContent: "old content",
      });
      expect(stale.saved).toBe(false);
      expect(yield* fs.readFileString(path.join(root, "owner/profiles/ci.yaml"))).toBe(original);
      const existing = yield* saveProfile(options, {
        sourcePath: path.join(root, "owner"),
        profile: { version: 1, name: "ci", members: ["review"] },
        expectedContent: original,
      });
      expect(existing.saved).toBe(true);
      yield* write("owner/profiles/occupied.yaml", "foreign");
      expect(
        (yield* saveProfile(options, {
          sourcePath: path.join(root, "owner"),
          profile: { version: 1, name: "occupied", members: [] },
        })).saved,
      ).toBe(false);
    }),
  );
  test.effect(
    "saves a new publication and portable external members without changing daily selection",
    () =>
      Effect.gen(function* () {
        const { root, path, options, write, check, fs } = yield* fixture;
        yield* initializeState(options);
        yield* write("team/tack.yaml", "version: 1\nname: team\ncommands:\n  - path: commands\n");
        yield* write("team/commands/audit.md", "Audit");
        yield* registerSource(options, { sourcePath: path.join(root, "team") });
        const before = yield* readState(options);
        const saved = yield* saveProfile(options, {
          sourcePath: path.join(root, "owner"),
          profile: {
            version: 1,
            name: "second",
            "depends-on": ["team"],
            members: [{ name: "audit", kind: "command", source: "team" }],
          },
        });
        expect(saved.saved).toBe(true);
        expect(yield* fs.readFileString(path.join(root, "owner/profiles/second.yaml"))).toContain(
          "source: team",
        );
        expect(yield* readState(options)).toEqual(before);
        expect((yield* check()).summary.errors).toBe(0);
      }),
  );
  test.effect("refuses incomplete saves before writing either profile or publication", () =>
    Effect.gen(function* () {
      const { root, path, options, fs } = yield* fixture;
      const declaration = yield* fs.readFileString(path.join(root, "owner/tack.yaml"));
      const saved = yield* saveProfile(options, {
        sourcePath: path.join(root, "owner"),
        profile: {
          version: 1,
          name: "missing",
          "depends-on": ["team"],
          members: [{ name: "audit", source: "team" }],
        },
      });
      expect(saved.saved).toBe(false);
      expect(yield* fs.exists(path.join(root, "owner/profiles/missing.yaml"))).toBe(false);
      expect(yield* fs.readFileString(path.join(root, "owner/tack.yaml"))).toBe(declaration);
    }),
  );
  test.effect(
    "checks an unregistered publication without state and resolves only direct and required members",
    () =>
      Effect.gen(function* () {
        const { check, fs, options } = yield* fixture;
        const report = yield* check();
        expect(report.summary.errors).toBe(0);
        expect(report.checks.flatMap((item) => item.details)).toEqual(
          expect.arrayContaining([
            "Direct members (1)",
            "skill owner:review",
            "Required dependencies (1)",
            "command owner:lint",
          ]),
        );
        expect(yield* fs.exists(options.environment.TACK_STATE_DIR)).toBe(false);
      }),
  );
  test.effect("keeps bare members owner-scoped under registration order and owner removal", () =>
    Effect.gen(function* () {
      const { root, path, write, options, check, fs } = yield* fixture;
      yield* write("team/tack.yaml", "version: 1\nname: team\nskills:\n  - path: skills\n");
      yield* write("team/skills/review/SKILL.md", "---\nname: review\ndescription: Other\n---\n");
      yield* initializeState(options);
      yield* registerSource(options, { sourcePath: path.join(root, "team") });
      yield* registerSource(options, { sourcePath: path.join(root, "owner") });
      const before = yield* readState(options);
      expect((yield* check()).checks.flatMap((item) => item.details)).toContain(
        "skill owner:review",
      );
      yield* fs.rename(
        path.join(root, "owner/skills/review/SKILL.md"),
        path.join(root, "removed.md"),
      );
      const report = yield* check();
      expect(report.summary.errors).toBeGreaterThan(0);
      expect(report.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "profile-member-missing" })]),
      );
      expect(yield* readState(options)).toEqual(before);
    }),
  );
  test.effect("distinguishes schema, publication and incomplete external linkage", () =>
    Effect.gen(function* () {
      const { root, path, write, check } = yield* fixture;
      yield* write(
        "owner/profiles/ci.yaml",
        "version: 1\nname: ci\ndepends-on: [team]\nmembers:\n  - name: review\n    source: team\n",
      );
      const missing = yield* check();
      expect(missing.checks.flatMap((item) => item.details)).toContain(
        "Structure: valid · Source linkage: incomplete",
      );
      expect(missing.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "profile-source-unregistered",
            remedy: expect.stringContaining("companion"),
          }),
        ]),
      );
      yield* write("owner/profiles/ci.yaml", "version: 99\nname: ci\nmembers: []\n");
      expect((yield* check()).findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "profile-version-unsupported" })]),
      );
      yield* write("owner/profiles/ci.yaml", "version: 1\nname: other\nmembers: [review]\n");
      expect((yield* check()).findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "profile-publication-mismatch" })]),
      );
      expect((yield* checkSource(path.join(root, "owner"))).counts.skill).toBe(1);
    }),
  );
  test.effect("reports kind candidates and refuses duplicate portable source names", () =>
    Effect.gen(function* () {
      const { root, path, write, check, options } = yield* fixture;
      yield* write("owner/commands/review.md", "Review");
      const ambiguous = yield* check();
      expect(ambiguous.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "profile-member-ambiguous",
            candidates: expect.arrayContaining([
              expect.objectContaining({ kind: "command" }),
              expect.objectContaining({ kind: "skill" }),
            ]),
          }),
        ]),
      );
      yield* write(
        "owner/profiles/ci.yaml",
        "version: 1\nname: ci\ndepends-on: [team]\nmembers:\n  - name: review\n    kind: skill\n    source: team\n",
      );
      yield* initializeState(options);
      for (const dir of ["one", "two"]) {
        yield* write(`${dir}/tack.yaml`, "version: 1\nname: team\ncommands: []\n");
        yield* registerSource(options, { sourcePath: path.join(root, dir) });
      }
      expect((yield* check()).findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "profile-source-ambiguous",
            remedy: expect.stringContaining("distinct"),
          }),
        ]),
      );
    }),
  );
  test.effect("preserves resource dependency rules and reports blocked chains", () =>
    Effect.gen(function* () {
      const { root, path, fs, check } = yield* fixture;
      yield* fs.rename(path.join(root, "owner/commands/lint.md"), path.join(root, "lint.md"));
      expect((yield* check()).findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "profile-required-missing",
            remedy: expect.stringContaining("lint"),
          }),
        ]),
      );
    }),
  );
  test.effect(
    "saves non-canonical YAML publications safely and refuses unsupported alias edits before any writes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const sourcePath = f.path.join(f.root, "owner");
        const declarationFile = f.path.join(sourcePath, "tack.yaml");
        for (const [index, key] of ["profiles", '"profiles"'].entries()) {
          yield* f.write(
            "owner/tack.yaml",
            `"version": 2\nname: owner\n# keep resource bytes\nskills: [{path: skills}]\ncommands: [{path: commands}]\n${key}:\n- name: ci\n# keep publication note\n  path: profiles/ci.yaml\n`,
          );
          const ci = yield* f.fs.readFileString(f.path.join(sourcePath, "profiles/ci.yaml"));
          const saved = yield* saveProfile(f.options, {
            sourcePath,
            profile: { version: 1, name: `safe-${index}`, members: ["review"] },
          });
          expect(saved.saved, JSON.stringify(saved.report.findings)).toBe(true);
          expect((yield* checkPaths([sourcePath])).summary.errors).toBe(0);
          expect(yield* f.fs.readFileString(f.path.join(sourcePath, "profiles/ci.yaml"))).toBe(ci);
          expect(yield* f.fs.readFileString(declarationFile)).toContain("# keep publication note");
        }
        const alias =
          "version: 2\nname: owner\nskills: []\ncommands: []\nimports: &publications []\nprofiles: *publications\n";
        yield* f.write("owner/tack.yaml", alias);
        const refused = yield* saveProfile(f.options, {
          sourcePath,
          profile: { version: 1, name: "alias-copy", members: [] },
        });
        expect(refused.saved).toBe(false);
        expect(refused.report.findings).toContainEqual(
          expect.objectContaining({ code: "profile-publication-layout" }),
        );
        expect(yield* f.fs.readFileString(declarationFile)).toBe(alias);
        expect(yield* f.fs.exists(f.path.join(sourcePath, "profiles/alias-copy.yaml"))).toBe(false);
      }),
  );
});

it("decodes profile publications separately from resources", () => {
  expect(profilePublications("/source", { version: 1 }).publications).toEqual([]);
  expect(
    profilePublications("/source", { version: 2, profiles: [{ name: "ci", path: "ci.yaml" }, 42] }),
  ).toMatchObject({ publications: [{ name: "ci" }], findings: [{ field: "profiles[1]" }] });
});
