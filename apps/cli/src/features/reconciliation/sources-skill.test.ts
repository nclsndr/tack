import { bareSkillText, writeUnder } from "../../../test/support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { mutateStateFixture, stateOptionsAt } from "../../../test/support/state-fixture.ts";
import {
  generatedSkillRegistrationId,
  projectSourcesSkillName,
  userSourcesSkillName,
} from "../../domain/generated/sources-skill.ts";
import { initializeState, type StateOptions } from "../../services/state-store.ts";
import { attachDocs } from "../docs/docs.ts";
import { registerSource } from "../sources/source.ts";
import { runStatus, statusPartialCauses } from "../status/status.ts";
import { enableAdapters } from "./agent.ts";
import { runSyncCommand } from "./sync-command.ts";

const handbookYaml = (body: string) =>
  [
    "version: 1",
    "name: team-handbook",
    "description: The team handbook - deploy skills and runbooks.",
    "maintainers: [platform-team]",
    "rules:",
    "  description: Before you edit any skill or runbook of this source.",
    `  body: ${JSON.stringify(body)}`,
    "skills: [{ path: skills }]",
    "docs: [{ name: runbooks, path: runbooks }]",
    "",
  ].join("\n");

/** A home, a project `shop` and the sources it can link: a handbook, a kit and a docs-only wiki. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-sources-" }));
  const home = path.join(root, "home");
  const project = path.join(root, "shop");
  const handbook = path.join(root, "handbook");
  const kit = path.join(root, "kit");
  const wiki = path.join(root, "wiki");
  for (const folder of [home, project, path.join(root, "git"), path.join(root, "blog-git")])
    yield* fs.makeDirectory(folder);
  const writeHandbook = writeUnder(handbook);
  yield* writeHandbook("tack.yaml", handbookYaml("Branch first."));
  yield* writeHandbook(
    "skills/deploy/SKILL.md",
    bareSkillText("deploy", { tack: ["user-activation: default"] }),
  );
  yield* writeHandbook("runbooks/deploy.md", "# Deploy\n");
  yield* writeUnder(kit)("tack.yaml", "version: 1\nname: kit\nskills: [{ path: skills }]\n");
  yield* writeUnder(kit)("skills/lint/SKILL.md", bareSkillText("lint"));
  yield* writeUnder(wiki)("tack.yaml", "version: 1\nname: wiki\ndocs: [{ name: wiki, path: . }]\n");
  yield* writeUnder(wiki)("start.md", "# Start\n");
  const options: StateOptions = stateOptionsAt(path.join(root, "state"), home);
  yield* initializeState(options);
  yield* mutateStateFixture(options, (state) => ({
    ...state,
    data: {
      ...state.data,
      projects: [
        { name: "shop", gitCommonDirectory: path.join(root, "git"), roots: [project] },
        { name: "blog", gitCommonDirectory: path.join(root, "blog-git"), roots: [home] },
      ],
    },
  }));
  for (const sourcePath of [handbook, kit, wiki]) yield* registerSource(options, { sourcePath });
  yield* enableAdapters(options, ["claude"]);
  const shop = { _tag: "project", projectName: "shop" } as const;
  const sync = (apply: boolean) =>
    runSyncCommand(options, {
      apply,
      cwd: project,
      includeOptional: false,
      noDocs: false,
      selector: shop,
    });
  const status = () => runStatus(options, { cwd: project, selector: shop });
  const skillFile = path.join(
    root,
    "state",
    "generated",
    "projects",
    "shop",
    projectSourcesSkillName,
    "SKILL.md",
  );
  return { fs, path, root, home, project, handbook, kit, wiki, options, sync, status, skillFile };
});

it.layer(LiveTestLayer)("the sources skill", (test) => {
  test.effect("previews, writes and links one skill that lists the project's linked sources", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // The kit's only skill is excluded and the wiki is attached as docs, so the wiki is listed and
      // the kit is not.
      yield* f.fs.writeFileString(
        f.path.join(f.kit, "skills/lint/SKILL.md"),
        bareSkillText("lint", { tack: ["activation: opt-in"] }),
      );
      yield* attachDocs(f.options, { projectName: "shop" }, { reference: "wiki" });

      const preview = yield* f.sync(false);
      expect(preview.plan.sourcesSkills).toEqual([
        {
          namespace: { _tag: "project", projectName: "shop" },
          path: f.skillFile,
          inputs: expect.stringMatching(/^[0-9a-f]{16}$/),
          state: "missing",
        },
      ]);
      const creates = preview.plan.resources?.plan.units.flatMap((unit) =>
        unit.actions.flatMap((action) =>
          action._tag === "link-create" ? [action.evidence.address] : [],
        ),
      );
      expect(creates).toContainEqual({
        kind: "skill",
        name: projectSourcesSkillName,
        sourceRegistrationId: generatedSkillRegistrationId,
      });
      expect(yield* f.fs.exists(f.skillFile)).toBe(false);

      yield* f.sync(true);
      const text = yield* f.fs.readFileString(f.skillFile);
      expect(text).toContain(`name: ${projectSourcesSkillName}`);
      expect(text).toContain("### team-handbook");
      expect(text).toContain(`- Path: \`${f.handbook}\``);
      expect(text).toContain("> Branch first.");
      expect(text).toContain("### wiki");
      expect(text).not.toContain("### kit");
      const link = f.path.join(f.project, ".claude", "skills", projectSourcesSkillName);
      expect(yield* f.fs.realPath(link)).toBe(f.path.dirname(f.skillFile));

      const report = yield* f.status();
      expect(report.sourcesSkills).toMatchObject([{ path: f.skillFile, state: "current" }]);
      expect(
        report.destinations.filter((destination) => destination.destinationPath === link),
      ).toMatchObject([{ _tag: "matching" }]);
      expect(statusPartialCauses(report)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  test.effect("names a source of a reserved label by its ID, and leaves out an unhealthy one", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const impostor = f.path.join(f.root, "impostor");
      yield* writeUnder(impostor)(
        "tack.yaml",
        "version: 1\nname: tack\nskills: [{ path: skills }]\n",
      );
      yield* writeUnder(impostor)("skills/format/SKILL.md", bareSkillText("format"));
      const registered = yield* registerSource(f.options, { sourcePath: impostor });
      yield* attachDocs(f.options, { projectName: "shop" }, { reference: "wiki" });
      yield* f.fs.writeFileString(
        f.path.join(f.wiki, "tack.yaml"),
        "version: 1\nname: wiki\nkind: docs\n",
      );

      yield* f.sync(true);
      // A second apply finds the copy current and leaves it.
      yield* f.sync(true);
      const text = yield* f.fs.readFileString(f.skillFile);
      expect(text).toContain(`### ${registered.registration.id}`);
      expect(text).not.toContain("### wiki");
      expect((yield* f.status()).sourcesSkills).toMatchObject([{ state: "current" }]);
    }).pipe(Effect.scoped),
  );

  test.effect("reports a changed rule as stale until a sync rewrites the skill", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.sync(true);
      const before = yield* f.fs.readFileString(f.skillFile);
      yield* f.fs.writeFileString(f.path.join(f.handbook, "tack.yaml"), handbookYaml("Rebase."));

      const stale = yield* f.status();
      expect(stale.sourcesSkills).toMatchObject([{ state: "stale" }]);
      expect(statusPartialCauses(stale)).toEqual([
        {
          code: "sources-skill-stale",
          subject: { namespace: { _tag: "project", projectName: "shop" }, path: f.skillFile },
        },
      ]);
      expect((yield* f.sync(false)).plan.sourcesSkills).toMatchObject([{ state: "stale" }]);
      expect(yield* f.fs.readFileString(f.skillFile)).toBe(before);

      yield* f.sync(true);
      expect(yield* f.fs.readFileString(f.skillFile)).toContain("> Rebase.");
      expect((yield* f.status()).sourcesSkills).toMatchObject([{ state: "current" }]);
    }).pipe(Effect.scoped),
  );

  test.effect("writes the user's skill under its own name", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const applied = yield* runSyncCommand(f.options, {
        apply: true,
        cwd: f.home,
        includeOptional: false,
        noDocs: true,
        selector: { _tag: "user" },
      });
      expect(applied.plan.sourcesSkills).toMatchObject([
        { namespace: { _tag: "user" }, state: "missing" },
      ]);
      const link = f.path.join(f.home, ".claude", "skills", userSourcesSkillName);
      expect(yield* f.fs.readFileString(f.path.join(link, "SKILL.md"))).toContain(
        "# Tack sources linked for the user",
      );
    }).pipe(Effect.scoped),
  );

  test.effect(
    "writes no sources skill for a project that links no source, or through no adapter",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const skill of ["skills/deploy/SKILL.md", "skills/lint/SKILL.md"])
          yield* f.fs.writeFileString(
            f.path.join(skill.includes("deploy") ? f.handbook : f.kit, skill),
            bareSkillText(skill.includes("deploy") ? "deploy" : "lint", {
              tack: ["activation: opt-in"],
            }),
          );
        const preview = yield* f.sync(false);
        expect(preview.plan.sourcesSkills).toEqual([]);
        yield* f.fs.writeFileString(
          f.path.join(f.handbook, "skills/deploy/SKILL.md"),
          bareSkillText("deploy"),
        );
        // An adapter that links skills must be enabled for a namespace to get its sources skill.
        yield* mutateStateFixture(f.options, (state) => ({
          ...state,
          data: { ...state.data, enabledAdapters: [] },
        }));
        expect((yield* f.sync(false)).plan.sourcesSkills).toEqual([]);
        expect((yield* f.status()).sourcesSkills).toBeUndefined();
        expect(
          (yield* runSyncCommand(f.options, {
            adapterOverride: [],
            apply: false,
            cwd: f.project,
            includeOptional: false,
            noDocs: false,
            selector: { _tag: "project", projectName: "shop" },
          })).plan.sourcesSkills,
        ).toEqual([]);
      }).pipe(Effect.scoped),
  );

  test.effect("removes the generated folder of a project the state no longer holds", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const gone = f.path.join(f.root, "state", "generated", "projects", "gone");
      const blog = f.path.join(f.root, "state", "generated", "projects", "blog");
      yield* f.fs.makeDirectory(f.path.join(gone, projectSourcesSkillName), { recursive: true });
      yield* f.fs.makeDirectory(blog, { recursive: true });
      yield* f.sync(true);
      expect(yield* f.fs.exists(gone)).toBe(false);
      expect(yield* f.fs.exists(blog)).toBe(true);
      expect(yield* f.fs.exists(f.skillFile)).toBe(true);
    }).pipe(Effect.scoped),
  );

  test.effect("fails as a state storage error when the skill cannot be written", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const projects = f.path.join(f.root, "state", "generated", "projects");
      yield* f.fs.makeDirectory(projects, { recursive: true });
      yield* f.fs.chmod(projects, 0o500);
      const failure = yield* f
        .sync(true)
        .pipe(Effect.flip, Effect.ensuring(f.fs.chmod(projects, 0o755).pipe(Effect.orDie)));
      expect(failure).toMatchObject({
        _tag: "StateStorageError",
        operation: "write the sources skill",
      });
      expect(
        yield* f.fs.exists(f.path.join(f.project, ".claude", "skills", projectSourcesSkillName)),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );
});
