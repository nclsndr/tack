/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests read JSON envelopes whose shape each test asserts. */
import { skillText } from "./support/source-tree.ts";
import { locationHelpText } from "../src/domain/imports/providers/registry.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSystemWorld, treeSnapshot, type SystemWorld } from "./support/import-system.ts";
import { readContracts } from "./support/contracts.ts";

/** The grammar and the JSON envelopes of the import group. */

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/docx/SKILL.md": skillText("docx"),
    "skills/bad/SKILL.md": "---\nname: Bad Name\ndescription: x\n---\n",
  },
} as const;
const preview = [
  "import",
  "add",
  "github:acme/skills",
  "--skill",
  "pdf",
  "--into",
  "personal-brain",
];

const envelopeKeys = [
  "applied",
  "classification",
  "command",
  "diagnostics",
  "next",
  "plan",
  "result",
  "status",
  "version",
];

describe("discovery", () => {
  it("describes the import group in the command contracts and --help, without stable payloads", async () => {
    const world = await makeSystemWorld({ inProcess: true, commits: [commit] });
    const contracts = await readContracts();
    const commands = contracts.commands.filter((entry) => entry.commandPath[0] === "import");
    expect(commands.map((entry) => entry.command)).toEqual([
      "import",
      "import add",
      "import remove",
    ]);
    const byName = Object.fromEntries(commands.map((entry) => [entry.command, entry]));
    const flags = (name: string) => byName[name]?.flags.map((flag) => flag.name) ?? [];
    expect(byName["import"]).toMatchObject({ mutation: "read-only" });
    expect(byName["import add"]).toMatchObject({ mutation: "preview-apply" });
    expect(byName["import remove"]).toMatchObject({ mutation: "preview-apply" });
    expect(flags("import add")).toEqual(
      expect.arrayContaining(["into", "skill", "all", "full-depth", "apply"]),
    );
    expect(flags("import remove")).toEqual(expect.arrayContaining(["force", "apply"]));
    expect(byName["import add"]?.arguments).toMatchObject([
      { name: "location", required: true, description: locationHelpText() },
    ]);
    expect(byName["import remove"]?.arguments).toMatchObject([
      { name: "reference", required: true },
    ]);
    expect(byName["import add"]?.responses).toEqual([
      { mode: "default", slots: { plan: "json" } },
      { mode: "apply", slots: { applied: "json", plan: "json" } },
    ]);
    // Import payloads are not part of the stable contract: no schema is published for them.
    expect(Object.keys(contracts.payloads).filter((kind) => kind.startsWith("import-"))).toEqual(
      [],
    );

    const help = await world.run(["import", "add", "--help"]);
    expect(help.code).toBe(0);
    for (const word of ["--into", "--skill", "--all", "--full-depth", "--apply", "location"])
      expect(help.stdout).toContain(word);
    const removeHelp = await world.run(["import", "remove", "--help"]);
    expect(removeHelp.stdout).toContain("--force");
    expect((await world.run(["import", "--help"])).stdout).toContain("remove");
  }, 60_000);
});

describe("envelopes", () => {
  const imported = async () => {
    const world = await makeSystemWorld({ inProcess: true, commits: [commit] });
    const applied = await world.json([...preview, "--apply"]);
    expect(applied.envelope.classification).toBe("success");
    return world;
  };

  const fails = async (world: SystemWorld, args: ReadonlyArray<string>) => {
    const run = await world.json(args);
    expect(Object.keys(run.envelope).sort()).toEqual(envelopeKeys);
    expect(run.envelope).toMatchObject({
      applied: null,
      plan: null,
      result: null,
      status: "failure",
    });
    expect(run.code).not.toBe(0);
    return run.envelope as {
      classification: string;
      diagnostics: ReadonlyArray<{ code: string; message: string; details?: unknown }>;
    };
  };

  it("carries the preview, the apply, the list and the removal in the nine-key envelope", async () => {
    const world = await makeSystemWorld({ inProcess: true, commits: [commit] });
    const stateBefore = await readFile(join(world.state, "state.json"), "utf8");
    const treeBefore = await treeSnapshot(world.brain);

    const previewRun = await world.json(preview);
    expect(Object.keys(previewRun.envelope).sort()).toEqual(envelopeKeys);
    expect(previewRun.envelope).toMatchObject({
      command: "import add",
      classification: "success",
      applied: null,
      result: null,
      plan: {
        kind: "import-plan",
        outcome: "ready",
        selected: ["pdf"],
        destination: { source: "personal-brain", folder: "skills", declaredFolder: "skills" },
        writes: [{ name: "pdf", path: "skills/pdf" }],
      },
    });
    // The preview lists the candidates with the catalog's own reason for the one it rejects.
    const candidates = previewRun.envelope.plan.candidates as ReadonlyArray<{
      name: string;
      verdict: { importable: boolean; code?: string };
    }>;
    expect(candidates.map((entry) => [entry.name, entry.verdict.importable])).toEqual([
      ["Bad Name", false],
      ["docx", true],
      ["pdf", true],
    ]);
    expect(await treeSnapshot(world.brain)).toEqual(treeBefore);
    expect(await readFile(join(world.state, "state.json"), "utf8")).toBe(stateBefore);

    // Without --into, the preview lists the sources that can receive the skills.
    const noDestination = await world.json(["import", "add", "github:acme/skills"]);
    expect(noDestination.envelope.plan).toMatchObject({
      outcome: "needs-selection",
      destinations: [{ name: "personal-brain", folders: ["skills"] }],
    });
    expect(noDestination.envelope.diagnostics.map((entry: { code: string }) => entry.code)).toEqual(
      expect.arrayContaining(["import-selection-required", "import-destination-required"]),
    );

    const applied = await world.json([...preview, "--apply"]);
    expect(Object.keys(applied.envelope).sort()).toEqual(envelopeKeys);
    expect(applied.envelope).toMatchObject({
      classification: "success",
      plan: { kind: "import-plan", outcome: "ready" },
      applied: {
        kind: "import-application",
        imported: [{ name: "pdf", path: "skills/pdf" }],
        written: ["skills/pdf/", "tack.yaml"],
        rejected: [],
        recovered: [],
      },
    });
    expect(await readFile(join(world.state, "state.json"), "utf8")).toBe(stateBefore);

    const listed = await world.json(["import"]);
    expect(listed.envelope).toMatchObject({
      command: "import",
      result: {
        kind: "import-list",
        problems: [],
        imports: [
          {
            reference: "personal-brain:pdf",
            path: "skills/pdf",
            location: "github:acme/skills",
            ref: { kind: "default", tracking: true },
            local: { state: "unchanged" },
            conditions: [],
          },
        ],
      },
    });

    const removePreview = await world.json(["import", "remove", "personal-brain:pdf"]);
    expect(removePreview.envelope).toMatchObject({
      command: "import remove",
      applied: null,
      plan: {
        kind: "import-removal-plan",
        reference: "personal-brain:pdf",
        path: "skills/pdf",
        folderPresent: true,
        files: 1,
        delivered: [],
        picks: [],
        force: false,
      },
    });
    const removed = await world.json(["import", "remove", "personal-brain:pdf", "--apply"]);
    expect(removed.envelope).toMatchObject({
      classification: "success",
      applied: { kind: "import-removal-application", removed: ["skills/pdf/", "tack.yaml"] },
    });
    expect((await world.json(["import"])).envelope.result.imports).toEqual([]);
    expect(await readFile(join(world.state, "state.json"), "utf8")).toBe(stateBefore);
  }, 90_000);

  it("marks a destination that declares no skills folder as refused, and --apply fails", async () => {
    const world = await makeSystemWorld({
      inProcess: true,
      declaration: "version: 1\nname: personal-brain\ndocs:\n  - path: docs\n",
      files: { "docs/readme.md": "# Docs\n" },
      commits: [commit],
    });
    const refused = await world.json(preview);
    expect(refused.envelope.plan).toMatchObject({
      outcome: "refused",
      refusal: { code: "import-destination-invalid" },
    });
    expect(refused.envelope.plan.refusal.message).toContain("skills: [{ path: skills }]");
    const failure = await fails(world, [...preview, "--apply"]);
    expect(failure.classification).toBe("invalid-configuration");
    expect(failure.diagnostics[0]?.code).toBe("import-destination-invalid");
    expect(await readFile(join(world.brain, "tack.yaml"), "utf8")).not.toContain("imports");
  }, 60_000);

  it("refuses bare shorthand with the exact retype in JSON and under Next, before any fetch", async () => {
    const world = await imported();
    const bare = await fails(world, [...preview.slice(0, 2), "acme/skills", ...preview.slice(3)]);
    expect(bare).toMatchObject({
      classification: "invalid-configuration",
      diagnostics: [
        {
          code: "import-location-invalid",
          details: {
            reason: "location-provider-missing",
            suggestion: "github:acme/skills",
            next: [
              "tack",
              "import",
              "add",
              "github:acme/skills",
              "--skill",
              "pdf",
              "--into",
              "personal-brain",
            ],
          },
        },
      ],
    });
    expect(bare.diagnostics[0]?.message).toBe(
      "Name the provider: github:acme/skills. Tack does not guess where org/repo lives. Providers: github.",
    );
    const human = await world.run([
      "import",
      "add",
      "acme/skills",
      "--skill",
      "pdf",
      "--into",
      "personal-brain",
    ]);
    expect(human.code).not.toBe(0);
    expect(human.stdout).toContain("Name the provider: github:acme/skills");
    expect(human.stdout).toMatch(
      /Next\n\s+tack import add github:acme\/skills --skill pdf --into personal-brain\n/,
    );
    // No remote was reached: the fixture world has acme/skills, and the output has no revision.
    expect(human.stdout).not.toContain("Revision");
  }, 60_000);

  it("prints the canonical location beside the URL that was typed, and Next uses it", async () => {
    const world = await makeSystemWorld({ inProcess: true, commits: [commit] });
    const url = await world.run([
      "import",
      "add",
      "https://github.com/acme/skills/tree/main/skills",
      "--skill",
      "pdf",
      "--into",
      "personal-brain",
    ]);
    expect(url.code).toBe(0);
    expect(url.stdout).toMatch(
      /Location\s+github:acme\/skills\/skills · tracking main \(from https URL\)/,
    );
    expect(url.stdout).toMatch(
      /Next\n\s+tack import add 'github:acme\/skills\/skills#main' --skill pdf/,
    );
    const typed = await world.run([
      "import",
      "add",
      "github:acme/skills",
      "--skill",
      "pdf",
      "--into",
      "personal-brain",
    ]);
    expect(typed.stdout).toContain("Location  github:acme/skills · tracking the default branch\n");
    expect(typed.stdout).not.toContain("(from");
  }, 60_000);

  it("names the unknown provider and the unserved host with the providers from the registry", async () => {
    const world = await imported();
    const unknown = await fails(world, ["import", "add", "gitlab:acme/skills"]);
    expect(unknown.diagnostics[0]).toMatchObject({
      code: "import-location-invalid",
      message: "Tack has no import provider named gitlab. Providers: github.",
      details: { reason: "location-provider-unknown" },
    });
    const host = await fails(world, ["import", "add", "https://gitlab.com/acme/skills"]);
    expect(host.diagnostics[0]).toMatchObject({
      message: "No import provider serves gitlab.com. Providers: github (github.com).",
      details: { reason: "location-other-provider" },
    });
  }, 60_000);

  it("reports each refusal as an error envelope with a stable code and the fix", async () => {
    const world = await imported();
    const location = await fails(world, ["import", "add", "acme/skills@v1"]);
    expect(location).toMatchObject({
      classification: "invalid-configuration",
      diagnostics: [
        {
          code: "import-location-invalid",
          details: { reason: "location-at-form", suggestion: "github:acme/skills#v1" },
        },
      ],
    });
    expect(location.diagnostics[0]?.message).toContain("github:acme/skills#v1");

    const unknown = await fails(world, [
      "import",
      "add",
      "github:acme/skills",
      "--skill",
      "nope",
      "--into",
      "personal-brain",
    ]);
    expect(unknown).toMatchObject({
      classification: "invalid-configuration",
      diagnostics: [{ code: "import-selection-unknown" }],
    });
    expect(unknown.diagnostics[0]?.message).toContain("docx");

    const notImportable = await fails(world, [
      "import",
      "add",
      "github:acme/skills",
      "--skill",
      "Bad Name",
      "--into",
      "personal-brain",
    ]);
    expect(notImportable.diagnostics[0]?.code).toBe("import-candidate-not-importable");

    const noInto = await fails(world, [
      "import",
      "add",
      "github:acme/skills",
      "--skill",
      "docx",
      "--apply",
    ]);
    expect(noInto).toMatchObject({
      classification: "invalid-configuration",
      diagnostics: [{ code: "import-destination-required" }],
    });
    expect(noInto.diagnostics[0]?.message).toContain("--into");

    const noSelection = await fails(world, [
      "import",
      "add",
      "github:acme/skills",
      "--into",
      "personal-brain",
      "--apply",
    ]);
    expect(noSelection.diagnostics[0]?.code).toBe("import-selection-required");

    const noSource = await fails(world, [
      "import",
      "add",
      "github:acme/skills",
      "--skill",
      "docx",
      "--into",
      "nowhere",
    ]);
    expect(noSource.diagnostics[0]?.code).toBe("import-destination-invalid");

    const missing = await fails(world, ["import", "remove", "personal-brain:nope"]);
    expect(missing.diagnostics[0]?.code).toBe("import-not-found");

    const both = await world.json([
      "import",
      "add",
      "github:acme/skills",
      "--all",
      "--skill",
      "pdf",
    ]);
    expect(both.envelope).toMatchObject({
      classification: "invalid-invocation",
      diagnostics: [{ code: "invalid-flag" }],
    });
  }, 120_000);

  it("refuses to remove a locally changed skill without --force, and lists what --force loses", async () => {
    const world = await imported();
    await writeFile(
      join(world.brain, "skills", "pdf", "SKILL.md"),
      skillText("pdf", { frontmatter: "license: MIT\n" }),
    );
    await writeFile(join(world.brain, "skills", "pdf", "notes.md"), "mine\n");

    const blocked = await fails(world, ["import", "remove", "personal-brain:pdf"]);
    expect(blocked.classification).toBe("domain");
    expect(blocked.diagnostics[0]?.code).toBe("import-removal-blocked");
    expect(blocked.diagnostics[0]?.message).toContain("SKILL.md changed");
    expect(blocked.diagnostics[0]?.message).toContain("notes.md added");
    const blockedApply = await fails(world, ["import", "remove", "personal-brain:pdf", "--apply"]);
    expect(blockedApply.diagnostics[0]?.code).toBe("import-removal-blocked");
    expect(await readFile(join(world.brain, "skills", "pdf", "notes.md"), "utf8")).toBe("mine\n");

    const listed = (await world.json(["import"])).envelope.result.imports[0];
    expect(listed).toMatchObject({
      local: { state: "changed", changed: ["SKILL.md"], added: ["notes.md"] },
      conditions: [{ code: "import-locally-changed" }],
    });

    const forced = await world.json(["import", "remove", "personal-brain:pdf", "--force"]);
    expect(forced.envelope).toMatchObject({
      classification: "success",
      plan: {
        force: true,
        local: { state: "changed", changed: ["SKILL.md"], added: ["notes.md"] },
      },
    });
    const done = await world.json(["import", "remove", "personal-brain:pdf", "--force", "--apply"]);
    expect(done.envelope.classification).toBe("success");
    expect((await treeSnapshot(world.brain))["skills/pdf/"]).toBeUndefined();
    expect((await world.json(["import"])).envelope.result.imports).toEqual([]);
  }, 90_000);
});
