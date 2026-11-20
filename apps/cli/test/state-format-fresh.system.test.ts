import { afterAll, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTackSync } from "./support/tack-process.ts";

let scratch: string | undefined;
afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

it("starts from an empty directory and writes one format 1 file that status reads back", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-format-fresh-"));
  scratch = root;
  const home = join(root, "home");
  const state = join(root, "state");
  const source = join(root, "source");
  const project = join(root, "project");
  await mkdir(home);
  await mkdir(join(source, "skills", "pdf"), { recursive: true });
  await mkdir(join(source, "knowledge"), { recursive: true });
  await mkdir(project);
  await writeFile(
    join(source, "tack.yaml"),
    "version: 1\nname: team\nskills:\n  - path: skills\ndocs:\n  - name: handbook\n    path: knowledge\n",
  );
  await writeFile(
    join(source, "skills", "pdf", "SKILL.md"),
    "---\nname: pdf\ndescription: Read PDFs\n---\n",
  );
  await writeFile(join(source, "knowledge", "index.md"), "# Handbook\n");
  expect(Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: project }).exitCode).toBe(0);

  const run = (args: ReadonlyArray<string>, cwd = root) => {
    const result = runTackSync(["--json", "--state-dir", state, ...args], { home, cwd });
    // The test reads deep into each result, so it keeps the parsed JSON rather than the decoded envelope.
    const envelope = JSON.parse(result.stdout);
    expect(
      envelope.classification,
      `${args.join(" ")}: ${JSON.stringify(envelope.diagnostics)}`,
    ).toBe("success");
    return envelope;
  };

  run(["state", "init"]);
  run(["adapter", "enable", "claude"]);
  run(["source", "add", source]);
  run(["project", "add", "demo"], project);
  run(["pick", "include", "pdf", "--project", "demo"]);
  run(["docs", "attach", "handbook", "--project", "demo"]);
  run(["sync", "--project", "demo", "--apply"]);

  const document = JSON.parse(await readFile(join(state, "state.json"), "utf8"));
  expect(Object.keys(document)).toEqual(["format", "data"]);
  expect(document.format).toBe(1);
  expect(document).not.toHaveProperty("version");
  const deliveries = document.data.links.map(
    (record: { delivery: { _tag: string } }) => record.delivery._tag,
  );
  expect(deliveries.toSorted()).toEqual(["agent", "docs"]);
  for (const record of document.data.links) {
    expect(record.resource.sourceRegistrationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await lstat(record.destinationPath).then((entry) => entry.isSymbolicLink())).toBe(true);
  }
  expect(document.data.projects[0].choices).toEqual([
    {
      address: expect.objectContaining({ kind: "skill", name: "pdf" }),
      decision: "include",
    },
  ]);
  expect(document.data.projects[0].docs.attachments).toEqual([
    expect.objectContaining({ name: "handbook" }),
  ]);
  expect(document.data).not.toHaveProperty("docsManagedLinks");
  expect(document.data).not.toHaveProperty("journal");

  const status = run(["status", "--project", "demo"], project);
  const choices = status.result.namespaces.flatMap(
    (namespace: { choices: ReadonlyArray<unknown> }) => namespace.choices,
  );
  expect(choices).toHaveLength(1);
  expect(
    status.result.destinations.some(
      (destination: { _tag: string; adapter?: string }) =>
        destination._tag === "matching" && destination.adapter === "claude",
    ),
  ).toBe(true);
}, 180_000);
