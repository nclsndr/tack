import { write } from "../../../../test/support/source-tree.ts";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import {
  expectViewContract,
  flat,
  lines as linesOf,
  renderView,
  styleOf,
} from "./human.test-support.ts";
import { inspectionViews } from "./inspection-views.ts";
import { createPublicEnvelope, type PublicEnvelope } from "../public-outcome.ts";
import { docsListOutcome, projectsOutcome, resultOutcome, sourcesOutcome } from "../outcomes.ts";
import { type GitService } from "../../../services/git.ts";
import { runHost } from "../../../../test/support/host-runner.ts";
import { LiveTestLayer } from "../../../../test/support/live-test-layer.ts";
import { hintsIn, parseHintsIn } from "../../../../test/support/hints.ts";
import { decodeEnvelope } from "../../../../test/support/tack-process.ts";

const testGit = (anchor: string, root: string) =>
  ({
    listWorktrees: () => Effect.succeed([{ bare: false, detached: false, path: root }]),
    resolveCommonDirectory: () => Effect.succeed(anchor),
  }) satisfies GitService;

type Captured = {
  readonly envelopes: Readonly<Record<string, PublicEnvelope>>;
  readonly root: string;
};

/** Drives real operations against a temporary state and keeps the envelopes they print. */
const capture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-human-inspections-" });
  const canonicalRoot = yield* fileSystem.realPath(root);
  const directory = (...parts: ReadonlyArray<string>) => path.join(canonicalRoot, ...parts);
  const docsSource = (name: string) =>
    Effect.gen(function* () {
      const source = directory(name);
      yield* write(
        path.join(source, "tack.yaml"),
        `version: 1\nskills:\n  - path: skills\ndocs:\n  - name: ${name}\n    path: notes\n`,
      );
      yield* write(path.join(source, "notes", "index.md"), "# Notes\n");
      yield* write(
        path.join(source, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review\n---\n",
      );
      return source;
    });
  const handbook = yield* docsSource("handbook");
  const guide = yield* docsSource("guide");
  const broken = yield* docsSource("broken");
  yield* write(directory("anchor", "keep"), "");
  yield* write(directory("project", "keep"), "");
  const git = testGit(directory("anchor"), directory("project"));
  const state = directory("state");
  const invoke = (...arguments_: ReadonlyArray<string>) =>
    runHost({ args: ["--state-dir", state, ...arguments_, "--json"], git }).pipe(
      Effect.map(({ stdout }) => decodeEnvelope(stdout)),
    );
  const out: Record<string, PublicEnvelope> = {};
  const record = (name: string, ...arguments_: ReadonlyArray<string>) =>
    invoke(...arguments_).pipe(
      Effect.tap((envelope) =>
        Effect.sync(() => {
          out[name] = envelope;
        }),
      ),
    );

  yield* invoke("state", "init");
  yield* record("sourceInspectEmpty", "source");
  yield* record("choiceListEmpty", "pick");
  yield* record("adapterListEmpty", "adapter");
  yield* record("projectInspectEmpty", "project");
  yield* record("docsListNoProject", "docs", "--project", "nope");
  yield* invoke("source", "add", handbook);
  yield* invoke("source", "add", guide);
  yield* invoke("source", "add", broken);
  yield* invoke("project", "add", "workspace", "--repository-cwd", directory("project"));
  yield* record("projectInspect", "project");
  yield* invoke("pick", "include", "handbook:review", "--project", "workspace");
  yield* invoke("pick", "exclude", "guide:review", "--user");
  yield* record("choiceListAll", "pick");
  yield* record("choiceListProject", "pick", "--project", "workspace");
  yield* invoke("adapter", "enable", "cursor", "codex");
  yield* record("adapterList", "adapter");
  yield* record("docsListNone", "docs", "--project", "workspace");
  yield* record("docsTargetNone", "docs", "target", "--project", "workspace");
  yield* invoke("docs", "attach", "handbook", "--project", "workspace");
  yield* record("docsListOne", "docs", "--project", "workspace");
  yield* record("docsTargetUnmounted", "docs", "target", "--project", "workspace");
  yield* invoke("docs", "attach", "guide", "--project", "workspace");
  yield* record("docsListNoDefault", "docs", "--project", "workspace");
  yield* record("docsTargetNoDefault", "docs", "target", "--project", "workspace");
  yield* invoke("docs", "configure", "--project", "workspace", "--default", "handbook");
  yield* invoke("sync", "--no-adapters", "--project", "workspace", "--apply");
  yield* record("docsList", "docs", "--project", "workspace");
  yield* record("docsTarget", "docs", "target", "--project", "workspace");
  yield* fileSystem.remove(directory("guide", "notes"), { recursive: true });
  yield* record("docsListPartial", "docs", "--project", "workspace");
  yield* fileSystem.remove(path.join(broken, "tack.yaml"));
  yield* record("sourceInspect", "source");
  yield* fileSystem.remove(directory("project"), { recursive: true });
  yield* record("projectInspectPartial", "project");
  return { envelopes: out, root: canonicalRoot } satisfies Captured;
});

let captured: Captured;
beforeAll(async () => {
  captured = await Effect.runPromise(capture.pipe(Effect.scoped, Effect.provide(LiveTestLayer)));
});

const envelopeOf = (name: string): PublicEnvelope => {
  const envelope = captured.envelopes[name];
  if (envelope === undefined) throw new Error(`No captured envelope ${name}`);
  return envelope;
};

const render = (envelope: PublicEnvelope, width = 80) => renderView(envelope, { width });

/** The output with each line break and the indentation after it removed, so wrapped paths rejoin. */
const joined = (output: string) => output.replace(/\n */g, "");

/** The widest terminal the views lay out for: the temporary paths of these tests fit on one line. */
const wide = 160;

const capturedNames = [
  "sourceInspectEmpty",
  "choiceListEmpty",
  "adapterListEmpty",
  "projectInspectEmpty",
  "docsListNoProject",
  "projectInspect",
  "choiceListAll",
  "choiceListProject",
  "adapterList",
  "docsListNone",
  "docsTargetNone",
  "docsListOne",
  "docsTargetUnmounted",
  "docsListNoDefault",
  "docsTargetNoDefault",
  "docsList",
  "docsTarget",
  "docsListPartial",
  "sourceInspect",
  "projectInspectPartial",
] as const;

describe("captured envelopes", () => {
  it("come from the real host with the statuses the views must show", () => {
    expect(envelopeOf("sourceInspect").status).toBe("partial");
    expect(envelopeOf("projectInspectPartial").status).toBe("partial");
    expect(envelopeOf("docsListPartial").status).toBe("partial");
    expect(envelopeOf("docsTargetUnmounted").status).toBe("failure");
  });

  it("render through a dedicated view that keeps the view contract", () => {
    for (const name of capturedNames) {
      const envelope = envelopeOf(name);
      expect(render(envelope).startsWith(`tack ${envelope.command}`), name).toBe(true);
      expectViewContract(envelope);
    }
  });

  it.effect("only suggest commands the real grammar parses as the operation they name", () =>
    Effect.gen(function* () {
      let total = 0;
      for (const name of capturedNames) {
        const output = render(envelopeOf(name));
        const operations = yield* parseHintsIn(output);
        total += operations.length;
        expect(operations.length, name).toBe(hintsIn(output).length);
      }
      expect(total).toBeGreaterThan(10);
    }),
  );
});

describe("source", () => {
  it("shows an empty registry without hints", () => {
    const output = render(envelopeOf("sourceInspectEmpty"));
    expect(linesOf(output)[0]).toBe("tack source · 0 sources · ✓ success");
    expect(output).toContain("No sources are registered.");
    expect(hintsIn(output)).toEqual([]);
  });

  it("shows health per source and the diagnostic for each unhealthy one", () => {
    const envelope = envelopeOf("sourceInspect");
    const output = render(envelope, wide);
    const lines = linesOf(output);
    expect(lines[0]).toBe("tack source · 3 sources · ! partial");
    expect(output).toContain("2 healthy · 1 unhealthy");
    expect(lines.filter((line) => line.includes("✓ healthy")).length).toBe(2);
    const broken = lines.find((line) => line.includes("✗ unhealthy"));
    expect(broken).toContain(`${captured.root}/broken`);
    expect(output).toContain("declaration-missing");
    expect(output).toMatch(/id +[0-9a-f-]{36}/);
    expect(output).toContain("Warnings");
    expect(output).toContain("source-unhealthy");
    expect(hintsIn(output)).toEqual(["tack catalog"]);
  });

  it("marks a source whose every declaration loads nothing as broken and points to its check", () => {
    const healthy = { canonicalPath: "/srv/tools", id: "00000000-0000-4000-8000-000000000001" };
    const broken = { canonicalPath: "/srv/notes", id: "00000000-0000-4000-8000-000000000002" };
    const declaration = { kind: "skill", path: "skills" } as const;
    const problem = { code: "declaration-path-missing", message: "The folder is missing." };
    const envelope = createPublicEnvelope(
      "source",
      sourcesOutcome([
        {
          declarations: [{ ...declaration, resources: 2, problems: [problem] }],
          registration: healthy,
          status: "healthy",
        },
        {
          declarations: [{ ...declaration, resources: 0, problems: [problem] }],
          registration: broken,
          status: "healthy",
        },
      ]),
    );
    const output = render(envelope, wide);
    const lines = linesOf(output);
    expect(lines[0]).toBe("tack source · 2 sources · ! partial");
    expect(output).toContain("1 healthy · 1 broken");
    expect(lines.find((line) => line.includes("✓ healthy"))).toContain(healthy.canonicalPath);
    expect(lines.find((line) => line.includes("✗ broken"))).toContain(broken.canonicalPath);
    expect(envelope.diagnostics).toMatchObject([
      { code: "source-loads-nothing", details: { sourceRegistrationId: broken.id } },
    ]);
    expect(hintsIn(output)).toEqual([`tack check ${broken.canonicalPath}`, "tack catalog"]);
    expectViewContract(envelope);
  });

  it("abbreviates paths under the home directory", () => {
    const output = renderView(envelopeOf("sourceInspect"), {
      width: 120,
      homeDirectory: captured.root,
    });
    expect(output).toContain("~/broken");
  });

  it("keeps wide characters and long paths readable", () => {
    const registration = {
      canonicalPath: "/srv/スキル/日本語のソースディレクトリ/とても長いパス名",
      id: "00000000-0000-4000-8000-000000000001",
    };
    const envelope = createPublicEnvelope(
      "source",
      sourcesOutcome([
        { declarations: [], registration, status: "healthy" },
        {
          issue: {
            code: "declaration-malformed",
            message: "宣言ファイルを読み取れません。構文を確認してください。再度お試しください。",
          },
          registration: { ...registration, id: "00000000-0000-4000-8000-000000000002" },
          status: "unhealthy",
        },
      ]),
    );
    expectViewContract(envelope);
    for (const width of [40, 80, 120])
      expect(joined(render(envelope, width))).toContain(registration.canonicalPath);
  });

  it("renders a failure as header and diagnostics", () => {
    const failure = createPublicEnvelope("source", {
      classification: "persistence",
      diagnostics: [
        {
          code: "state-unreadable",
          message: "Tack could not safely access persisted data.",
          severity: "error",
        },
      ],
    });
    const output = render(failure);
    expect(linesOf(output)[0]).toBe("tack source · ✗ persistence");
    expect(output).toContain("state-unreadable");
    expect(hintsIn(output)).toEqual([]);
  });
});

describe("project", () => {
  it("shows the anchor and each root of a healthy project", () => {
    const output = render(envelopeOf("projectInspect"));
    const lines = linesOf(output);
    expect(lines[0]).toBe("tack project · 1 project · ✓ success");
    expect(output).toContain("all healthy");
    expect(lines.find((line) => line.includes("workspace"))).toContain("✓ active");
    expect(lines.some((line) => line.includes("anchor") && line.includes("✓ healthy"))).toBe(true);
    expect(lines.some((line) => line.includes("root") && line.includes("✓ active"))).toBe(true);
    expect(hintsIn(output)).toEqual(["tack status"]);
  });

  it("shows a missing root with its issue and the diagnostic, and offers a refresh preview", () => {
    const output = render(envelopeOf("projectInspectPartial"), wide);
    const lines = linesOf(output);
    expect(lines[0]).toBe("tack project · 1 project · ! partial");
    expect(output).toContain("0 healthy · 1 needs attention");
    expect(
      lines.some((line) => line.includes("! missing") && line.includes(`${captured.root}/project`)),
    ).toBe(true);
    expect(output).toContain("root-missing: The registered project path is missing.");
    expect(output).toContain("Warnings");
    expect(hintsIn(output)).toEqual(["tack project refresh --project workspace"]);
  });

  it("shows removing projects, handoff roots and removal intent", () => {
    const envelope = createPublicEnvelope(
      "project",
      projectsOutcome([
        {
          anchor: { path: "/repo/.git", status: "healthy" },
          project: {
            gitCommonDirectory: "/repo/.git",
            name: "demo",
            removalIntent: "project",
            removingRoots: ["/repo/old-worktree"],
            roots: [],
          },
          roots: [],
        },
        {
          anchor: {
            issue: { code: "anchor-missing", message: "The registered project path is missing." },
            path: "/other/.git",
            status: "unhealthy",
          },
          project: { gitCommonDirectory: "/other/.git", name: "other", roots: ["/other"] },
          roots: [
            {
              issue: { code: "root-access-failed", message: "Permission denied." },
              root: "/other",
              status: "unhealthy",
            },
          ],
        },
      ]),
    );
    const output = render(envelope);
    expect(output).toContain("! removing");
    expect(output).toContain("removal requested");
    expect(output).toContain("/repo/old-worktree");
    expect(output).toContain("anchor-missing: The registered project path is missing.");
    expect(output).toContain("root-access-failed: Permission denied.");
    expect(output).toContain("0 healthy · 2 need attention");
    expect(hintsIn(output)).toEqual(["tack project refresh --project demo"]);
  });

  it("shows no projects without hints", () => {
    const output = render(envelopeOf("projectInspectEmpty"));
    expect(output).toContain("No projects are registered.");
    expect(hintsIn(output)).toEqual([]);
  });
});

describe("pick", () => {
  it("groups choices by namespace with their decision and address", () => {
    const output = render(envelopeOf("choiceListAll"));
    const lines = linesOf(output);
    expect(lines[0]).toBe("tack pick · 2 choices · ✓ success");
    expect(output).toContain("Project workspace 1 choice");
    expect(output).toContain("User 1 choice");
    expect(lines.some((line) => /\+ include\s+skill [0-9a-f-]{36}:review/.test(line))).toBe(true);
    expect(lines.some((line) => /− exclude\s+skill [0-9a-f-]{36}:review/.test(line))).toBe(true);
    expect(hintsIn(output)).toEqual(["tack sync --project workspace"]);
  });

  it("suggests the user plan when only user choices exist", () => {
    const envelope = createPublicEnvelope(
      "pick",
      resultOutcome({
        kind: "choices",
        choices: [
          {
            address: {
              kind: "context",
              name: "style",
              sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
            },
            decision: "include",
            namespace: { _tag: "user" },
          },
        ],
      }),
    );
    const output = render(envelope);
    expect(output).toContain("context 00000000-0000-4000-8000-000000000001:style");
    expect(hintsIn(output)).toEqual(["tack sync --user"]);
  });

  it("shows an empty list and points at the catalog", () => {
    const output = render(envelopeOf("choiceListEmpty"));
    expect(output).toContain("No choices are stored.");
    expect(hintsIn(output)).toEqual(["tack catalog"]);
  });

  it("renders a failed project lookup as header and diagnostics", () => {
    const output = render(
      createPublicEnvelope("pick", {
        classification: "invalid-configuration",
        diagnostics: [
          {
            code: "project-not-found",
            message:
              'Project "nope" is not registered. Run `tack project` to list registered projects and roots.',
            severity: "error",
          },
        ],
        next: [["tack", "project"]],
      }),
    );
    expect(linesOf(output)[0]).toBe("tack pick · ✗ invalid-configuration");
    expect(hintsIn(output)).toEqual(["tack project"]);
  });
});

describe("adapter", () => {
  it("shows enabled and not enabled adapters", () => {
    const output = render(envelopeOf("adapterList"));
    expect(linesOf(output)[0]).toBe("tack adapter · 2 of 8 enabled · ✓ success");
    expect(output).toMatch(/Enabled\s+codex, cursor/);
    expect(output).toMatch(/Not enabled\s+claude, cline, copilot, gemini, opencode, pi\n/);
    expect(hintsIn(output)).toEqual(["tack status"]);
  });

  it("states that nothing is delivered when no adapter is enabled", () => {
    const output = render(envelopeOf("adapterListEmpty"));
    expect(output).toContain("No adapters are enabled, so no skills are delivered.");
    expect(output).toMatch(
      /Not enabled\s+claude, cline, codex, copilot, cursor, gemini, opencode, pi\n/,
    );
    expect(hintsIn(output)).toEqual(["tack adapter enable claude"]);
  });
});

describe("docs", () => {
  it("reports no attachments", () => {
    const output = render(envelopeOf("docsListNone"));
    expect(linesOf(output)[0]).toBe("tack docs · project workspace · ! partial");
    expect(output).toContain("No docs resources are attached.");
    expect(output).toMatch(/default writing\s+none set/);
    expect(hintsIn(output)).toHaveLength(1);
    expect(hintsIn(output)[0]).toMatch(/^tack docs attach \w+ --project workspace$/);
  });

  it("points a single attachment at the writing target", () => {
    const output = render(envelopeOf("docsListOne"));
    expect(output).toContain("✓ available");
    expect(output).toContain("handbook");
    expect(hintsIn(output)).toEqual([
      "tack sync --project workspace",
      "tack docs target --project workspace",
    ]);
  });

  it("points several attachments without a default at choosing one", () => {
    const output = render(envelopeOf("docsListNoDefault"));
    const hint = hintsIn(output)[1];
    expect(hintsIn(output)).toHaveLength(2);
    expect(hintsIn(output)[0]).toBe("tack sync --project workspace");
    expect(hint).toMatch(
      /^tack docs configure --project workspace --default [0-9a-f-]{36}:[a-z]+$/,
    );
  });

  it("shows the default writing resource, the destination and each resource's locations", () => {
    const output = render(envelopeOf("docsList"), wide);
    expect(output).toContain("2 resources");
    expect(output).toMatch(/destination\s+default/);
    expect(output).toMatch(/default writing\s+[0-9a-f-]{36}:handbook/);
    expect(output).toContain("default writing");
    expect(flat(output)).toContain(`docs ${captured.root}/handbook/notes`);
    expect(flat(output)).toContain(`source path ${captured.root}/guide`);
    expect(hintsIn(output)).toEqual(["tack docs target --project workspace"]);
  });

  it("shows unavailable resources with their issues and the partial diagnostic", () => {
    const output = render(envelopeOf("docsListPartial"));
    const lines = linesOf(output);
    expect(lines[0]).toBe("tack docs · project workspace · ! partial");
    expect(output).toContain("1 available · 1 unavailable");
    expect(lines.some((line) => line.includes("! unavailable") && line.includes("guide"))).toBe(
      true,
    );
    expect(output).toContain("docs-partial");
    expect(output).toContain("Some attached docs resources or documents are unavailable.");
    expect(hintsIn(output)).toEqual([
      "tack sync --project workspace",
      "tack docs target --project workspace",
    ]);
  });

  it("shows a custom destination and reader config", () => {
    const resource = {
      name: "handbook",

      sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
    };
    const payload = {
      complete: true,
      documents: 0,
      issues: [],
      mounts: [],
      project: { name: "demo", root: "/work/demo" },
      resources: [
        {
          ...resource,
          directoryPath: "/src/notes",
          readerConfig: { kind: "file" as const, path: "/src/reader.yaml" },
          sourcePath: "/src",
        },
      ],
      settings: { defaultWritingResource: resource, destination: "docs/mounts" },
    };
    const envelope = createPublicEnvelope("docs", docsListOutcome(payload));
    const output = render(envelope);
    expect(output).toMatch(/destination\s+docs\/mounts/);
    expect(flat(output)).toContain("reader config (file) /src/reader.yaml");
  });

  it("fits wide characters", () => {
    const resource = {
      name: "handbook",

      sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
    };
    const payload = {
      complete: false,
      documents: 0,
      issues: [
        {
          code: "docs-resource-unavailable",
          message: "登録されたソースはもう利用できません。ソースの場所を確認してください。",
          resource,
          sourcePath: "",
        },
      ],
      mounts: [],
      project: { name: "demo", root: "/work/デモ" },
      resources: [],
      settings: {},
    };
    const envelope = createPublicEnvelope("docs", docsListOutcome(payload));
    expectViewContract(envelope);
    for (const width of [40, 80, 120])
      expect(render(envelope, width)).toContain("登録されたソース");
  });

  it("fails as header, diagnostics and the command the message names", () => {
    const output = render(envelopeOf("docsListNoProject"));
    expect(linesOf(output)[0]).toBe("tack docs · ✗ invalid-configuration");
    expect(output).toContain("project-not-found");
    expect(hintsIn(output)).toEqual(["tack project"]);
  });
});

describe("docs target", () => {
  it("shows the verified writing mount", () => {
    const output = render(envelopeOf("docsTarget"), wide);
    const lines = linesOf(output);
    expect(lines[0]).toBe("tack docs target · project workspace · ✓ success");
    expect(output).toContain("Verified writing target");
    expect(flat(output)).toContain(`mount ${captured.root}/project/.tack/docs/`);
    expect(flat(output)).toContain("resource ");
    expect(flat(output)).toMatch(/docs directory \S*handbook\/notes/);
    expect(flat(output)).toMatch(/project root \S*\/project/);
    expect(hintsIn(output)).toEqual([]);
  });

  it("names the reconcile command a mount failure already names", () => {
    const envelope = envelopeOf("docsTargetUnmounted");
    const output = render(envelope);
    expect(linesOf(output)[0]).toBe("tack docs target · ✗ domain");
    expect(output).toContain("docs-mount-unavailable");
    expect(hintsIn(output)).toEqual(["tack sync --no-adapters --project workspace --apply"]);
  });

  it("names every configure command an unset default offers", () => {
    const output = render(envelopeOf("docsTargetNoDefault"));
    expect(output).toContain("docs-default-unset");
    const hints = hintsIn(output);
    expect(hints).toHaveLength(2);
    for (const hint of hints)
      expect(hint).toMatch(/^tack docs configure --project workspace --default [a-z]+$/);
  });

  it("skips the attach template and keeps the reconcile command when nothing is attached", () => {
    const output = render(envelopeOf("docsTargetNone"));
    expect(output).toContain("docs-default-unset");
    expect(hintsIn(output)).toEqual(["tack sync --no-adapters --project workspace --apply"]);
  });
});

describe("undecodable payloads", () => {
  it("returns undefined so the generic view is used", () => {
    for (const command of Object.keys(inspectionViews)) {
      for (const payload of [{ unexpected: true }, [], null]) {
        const envelope = createPublicEnvelope(command, resultOutcome(payload));
        expect(inspectionViews[command]?.(envelope, styleOf()), command).toBeUndefined();
        expect(render(envelope)).toContain(`tack ${command}`);
      }
    }
  });
});
