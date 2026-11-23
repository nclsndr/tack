import { skillText } from "./support/source-tree.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addProject,
  git,
  makeGitShim,
  makeSystemWorld,
  shimCalls,
  treeSnapshot,
  type SystemWorld,
} from "./support/import-system.ts";

/** Credentials, the network, and version control: what an import must never touch or reveal. */

const commit = {
  files: {
    "skills/pdf/SKILL.md": skillText("pdf"),
    "skills/pdf/scripts/fill.py": { content: "print('x')\n", executable: true },
    "skills/docx/SKILL.md": skillText("docx"),
  },
} as const;
const addPdf = [
  "import",
  "add",
  "github:acme/skills",
  "--skill",
  "pdf",
  "--into",
  "personal-brain",
  "--apply",
];

/** Every file under the given directories, as text, for searching. */
const textsUnder = async (directories: ReadonlyArray<string>) =>
  (await Promise.all(directories.map((directory) => treeSnapshot(directory)))).flatMap((tree) =>
    Object.values(tree),
  );

describe("credentials", () => {
  const token = "SEKRET-TOKEN-4f9a1c";

  it("never reach tack.yaml, state, output or any file after a credentialed run", async () => {
    const world = await makeSystemWorld({ inProcess: true, commits: [commit] });
    // A global git configuration with a helper that would hand out the token, and the usual
    // token variables, tracing and verbose switches: none of it may be read back or printed.
    const config = join(world.root, "gitconfig");
    await writeFile(
      config,
      `[credential]\n\thelper = "!f() { echo username=oauth; echo password=${token}; }; f"\n`,
    );
    const env = {
      GIT_CONFIG_GLOBAL: config,
      GITHUB_TOKEN: token,
      GH_TOKEN: token,
      GIT_ASKPASS: "echo",
      GIT_TRACE: "1",
      GIT_CURL_VERBOSE: "1",
    };
    const outputs = [
      await world.run(["import", "add", "github:acme/skills"], { env }),
      await world.run(["--json", ...addPdf], { env }),
      await world.run(addPdf.slice(0, 4).concat(["nope", "--into", "personal-brain"]), { env }),
      await world.run(["import", "add", "github:acme/missing", "--into", "personal-brain"], {
        env,
      }),
      await world.run(["import"], { env }),
    ];
    expect(outputs[1]?.code).toBe(0);
    for (const run of outputs) {
      expect(run.stdout).not.toContain(token);
      expect(run.stderr).not.toContain(token);
    }
    const files = await textsUnder([world.state, world.brain, world.home]);
    expect(files.length).toBeGreaterThan(3);
    for (const text of files) expect(text).not.toContain(token);
    expect(await readFile(join(world.brain, "tack.yaml"), "utf8")).not.toMatch(/token|password|@/i);
  }, 90_000);

  it("in a location are refused by the grammar without being echoed", async () => {
    const world = await makeSystemWorld({ inProcess: true, commits: [commit] });
    const location = "https://user:sekret-location-token@github.com/acme/skills";
    const human = await world.run(["import", "add", location]);
    const json = await world.json([
      "import",
      "add",
      location,
      "--into",
      "personal-brain",
      "--apply",
    ]);
    expect(human.code).not.toBe(0);
    expect(json.envelope).toMatchObject({
      classification: "invalid-configuration",
      diagnostics: [{ code: "import-location-invalid" }],
    });
    for (const run of [human, json]) {
      expect(run.stdout + run.stderr).not.toContain("sekret-location-token");
      expect(run.stdout + run.stderr).not.toContain("user:");
    }
    expect(await readFile(join(world.brain, "tack.yaml"), "utf8")).not.toContain("sekret");
  }, 60_000);
});

/** The git subcommands that talk to a remote or build a fetch area; none may run offline. */
const remoteGit = new Set([
  "ls-remote",
  "fetch",
  "clone",
  "init",
  "remote",
  "sparse-checkout",
  "ls-tree",
  "cat-file",
  "checkout",
]);

/** The subcommand of a logged call, after the `-c name=value` pairs Tack's hardening prepends. */
const subcommandOf = (call: string) => {
  const words = (call.split("\t")[1] ?? "").split(" ");
  const rest = words.flatMap((word, index) =>
    word === "-c" || words[index - 1] === "-c" ? [] : [word],
  );
  return rest[0] ?? "";
};

describe("offline", () => {
  it("every local command works without git reaching a remote, and import add fails changing nothing", async () => {
    const world = await makeSystemWorld({ inProcess: true, commits: [commit] });
    await addProject(world, "demo");
    expect((await world.json(["adapter", "enable", "codex"])).code).toBe(0);
    expect((await world.json(addPdf)).envelope.classification).toBe("success");
    // Delivered, so doctor finds the links as Tack expects them.
    expect((await world.json(["sync", "--all", "--apply"])).envelope.classification).toBe(
      "success",
    );
    const shim = await makeGitShim(world.root, "failing");
    const env = shim.env;

    const local: ReadonlyArray<ReadonlyArray<string>> = [
      ["import"],
      ["import", "remove", "personal-brain:pdf"],
      ["source"],
      ["catalog"],
      ["status", "--all"],
      ["doctor"],
      ["pick"],
      ["sync", "--all"],
    ];
    for (const args of local) {
      const run = await world.json(args, { env });
      expect([0, 1], `${args.join(" ")}: ${run.stdout.slice(0, 300)}`).toContain(run.code);
      expect(run.envelope.classification, args.join(" ")).toMatch(/^(success|partial)$/);
    }
    // Local commands may look at their own repositories, but never at a remote.
    const calls = await shimCalls(shim.log);
    expect(calls.filter((call) => remoteGit.has(subcommandOf(call)))).toEqual([]);

    const stateBefore = await readFile(join(world.state, "state.json"), "utf8");
    const treeBefore = await treeSnapshot(world.brain);
    const failed = await world.json(
      [
        "import",
        "add",
        "github:acme/skills",
        "--skill",
        "docx",
        "--into",
        "personal-brain",
        "--apply",
      ],
      { env },
    );
    expect(failed.code).not.toBe(0);
    expect(failed.envelope).toMatchObject({
      classification: "domain",
      status: "failure",
      diagnostics: [{ code: "import-network-failed" }],
    });
    const preview = await world.json(
      ["import", "add", "github:acme/skills", "--skill", "docx", "--into", "personal-brain"],
      { env },
    );
    expect(preview.envelope.diagnostics[0].code).toBe("import-network-failed");
    expect(await treeSnapshot(world.brain)).toEqual(treeBefore);
    expect(await readFile(join(world.state, "state.json"), "utf8")).toBe(stateBefore);
  }, 120_000);
});

/** Replaces what legitimately differs between two worlds, so their results can be compared. */
const normalize = (world: SystemWorld, text: string) =>
  text
    .replaceAll(world.root, "<root>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g, "<id>")
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b[0-9a-f]{12}\b/g, "<short>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");

const versionControlWords =
  /\bgit\b|version control|uncommitted|committed|working tree|\bstaged\b/i;

describe("no version control in the destination", () => {
  const flow = async (world: SystemWorld, env: Record<string, string>) => {
    const steps: ReadonlyArray<ReadonlyArray<string>> = [
      ["import", "add", "github:acme/skills", "--skill", "pdf", "--into", "personal-brain"],
      addPdf,
      ["import"],
      ["import", "remove", "personal-brain:pdf"],
      ["import", "remove", "personal-brain:pdf", "--apply"],
      ["import"],
    ];
    const jsonOutputs: string[] = [];
    const humanOutputs: string[] = [];
    for (const args of steps) {
      jsonOutputs.push(normalize(world, (await world.json(args, { env })).stdout));
    }
    // The same flow once more in human output, which a person reads. A line broken after a hyphen
    // or a slash is joined first, so a temporary path wrapped across two lines is replaced whole.
    for (const args of steps)
      humanOutputs.push(
        normalize(world, (await world.run(args, { env })).stdout.replace(/([-/])\n +/g, "$1")),
      );
    return { jsonOutputs, humanOutputs };
  };

  it("behaves the same in a plain directory and in a git working tree, and runs no git there", async () => {
    const plain = await makeSystemWorld({ inProcess: true, commits: [commit] });
    const tracked = await makeSystemWorld({ inProcess: true, commits: [commit] });
    await git(tracked.brain, ["init", "--quiet", "--initial-branch=main"]);
    await git(tracked.brain, ["add", "-A"]);
    await git(tracked.brain, ["commit", "--quiet", "-m", "personal-brain"]);

    const plainShim = await makeGitShim(plain.root, "logging");
    const trackedShim = await makeGitShim(tracked.root, "logging");
    const plainResults = await flow(plain, plainShim.env);
    const trackedResults = await flow(tracked, trackedShim.env);

    expect(trackedResults.jsonOutputs).toEqual(plainResults.jsonOutputs);
    expect(trackedResults.humanOutputs).toEqual(plainResults.humanOutputs);
    // The flow really did work: pdf was imported, listed and removed again.
    expect(JSON.parse(plainResults.jsonOutputs[1] ?? "{}")).toMatchObject({
      classification: "success",
      applied: { kind: "import-application" },
    });

    for (const [world, shim] of [
      [plain, plainShim],
      [tracked, trackedShim],
    ] as const) {
      const calls = await shimCalls(shim.log);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        const [cwd = "", args = ""] = call.split("\t");
        expect(cwd.startsWith(world.brain), call).toBe(false);
        expect(args.includes(world.brain), call).toBe(false);
      }
    }
    for (const text of [...plainResults.jsonOutputs, ...plainResults.humanOutputs]) {
      // Locations such as github:acme/skills are not the word git; no message speaks of history.
      expect(text.replace(/github/gi, "")).not.toMatch(versionControlWords);
    }
  }, 180_000);
});
