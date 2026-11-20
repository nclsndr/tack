import { skillText } from "./support/source-tree.ts";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  addProject,
  makeGitShim,
  makeSystemWorld,
  treeSnapshot,
  type SystemWorld,
} from "./support/import-system.ts";
import { tackEnvironment } from "./support/tack-process.ts";

/** Import writes hold the state writer lock; a second writer is refused, never interleaved. */

const holder = resolve(import.meta.dirname, "fixtures/hold-state-lock.ts");
const commit = {
  files: { "skills/pdf/SKILL.md": skillText("pdf"), "skills/docx/SKILL.md": skillText("docx") },
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

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Starts the fixture process that holds the writer lock until it is killed. */
const holdLock = async (world: SystemWorld) => {
  const child = Bun.spawn(["bun", holder], {
    env: tackEnvironment({ home: world.home, state: world.state }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("ready");
  return child;
};

it("a held writer lock refuses import add --apply and import remove --apply and changes nothing", async () => {
  const world = await makeSystemWorld({ commits: [commit] });
  expect((await world.json(addPdf)).envelope.classification).toBe("success");
  const stateBefore = await readFile(join(world.state, "state.json"), "utf8");
  const treeBefore = await treeSnapshot(world.brain);
  const child = await holdLock(world);
  try {
    const busy = await world.json([
      "import",
      "add",
      "github:acme/skills",
      "--skill",
      "docx",
      "--into",
      "personal-brain",
      "--apply",
    ]);
    expect(busy.envelope).toMatchObject({
      classification: "domain",
      status: "failure",
      diagnostics: [{ code: "state-busy", severity: "error" }],
    });
    const remove = await world.json(["import", "remove", "personal-brain:pdf", "--apply"]);
    expect(remove.envelope).toMatchObject({
      classification: "domain",
      diagnostics: [{ code: "state-busy" }],
    });
    expect(await treeSnapshot(world.brain)).toEqual(treeBefore);
    expect(await readFile(join(world.state, "state.json"), "utf8")).toBe(stateBefore);
    expect(await exists(join(world.brain, ".tack-import-staging"))).toBe(false);
    // Read-only commands do not take the lock.
    expect((await world.json(["import"])).envelope.classification).toBe("success");
    expect(
      (await world.json(["import", "remove", "personal-brain:pdf"])).envelope.classification,
    ).toBe("success");
  } finally {
    child.kill();
    await child.exited;
  }
}, 60_000);

it("sync --apply started during an import apply is refused as busy, then plans against the final folder and tack.yaml", async () => {
  const world = await makeSystemWorld({ commits: [commit] });
  await addProject(world, "demo");
  expect((await world.json(["adapter", "enable", "codex"])).envelope.classification).toBe(
    "success",
  );
  // The shim pauses the fetch, so the apply holds the writer lock for a known stretch of time.
  const shim = await makeGitShim(world.root, "slow", 4);
  const importing = world.json(addPdf, { env: shim.env });
  for (let attempt = 0; attempt < 200 && !(await exists(shim.started)); attempt += 1)
    await Bun.sleep(50);
  expect(await exists(shim.started)).toBe(true);

  const during = await world.json(["sync", "--all", "--apply"]);
  expect(during.envelope).toMatchObject({
    classification: "domain",
    diagnostics: [{ code: "state-busy" }],
  });
  expect(await exists(join(world.brain, "skills", "pdf"))).toBe(false);

  const finished = await importing;
  expect(finished.envelope.classification).toBe("success");
  const after = await world.json(["sync", "--all", "--apply"]);
  expect(after.envelope.classification).toBe("success");
  const link = join(world.root, "projects", "demo", ".agents", "skills", "pdf");
  expect(await exists(join(link, "SKILL.md"))).toBe(true);
  expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe(skillText("pdf"));
  expect(await readFile(join(world.brain, "tack.yaml"), "utf8")).toContain("path: skills/pdf");
}, 90_000);
