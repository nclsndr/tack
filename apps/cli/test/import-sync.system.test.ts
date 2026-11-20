/* oxlint-disable typescript/no-unsafe-type-assertion -- Tests read JSON envelopes whose shape each test asserts; Public plans use Effect-style tagged unions. */
import { skillText } from "./support/source-tree.ts";
import { mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addProject, makeSystemWorld, type SystemWorld } from "./support/import-system.ts";

/** What the next sync does with an imported skill, against what it does for an equal source. */

const pdfCommit = { files: { "skills/pdf/SKILL.md": skillText("pdf") } } as const;
const importPdf = [
  "import",
  "add",
  "github:acme/skills",
  "--skill",
  "pdf",
  "--into",
  "personal-brain",
];

/** Registers another source that holds the skills, as a plain directory. */
const addSource = async (
  world: SystemWorld,
  name: string,
  skills: Readonly<Record<string, string>>,
) => {
  const directory = join(world.root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "tack.yaml"),
    `version: 1\nname: ${name}\nskills:\n  - path: skills\n`,
  );
  for (const [skill, text] of Object.entries(skills)) {
    await mkdir(join(directory, "skills", skill), { recursive: true });
    await writeFile(join(directory, "skills", skill, "SKILL.md"), text);
  }
  const added = await world.run(["source", "add", directory]);
  expect(added.code).toBe(0);
  return directory;
};

type Unit = {
  readonly target: { readonly projectName?: string; readonly _tag: string };
  readonly collisions: ReadonlyArray<{ readonly name: string }>;
  readonly linkedForUser?: ReadonlyArray<{ readonly sourceRegistrationId: string }>;
  readonly summary: Readonly<Record<string, number>>;
  readonly actions: ReadonlyArray<{
    readonly _tag: string;
    readonly reason?: string;
    readonly destinationPath?: string;
    readonly evidence?: { readonly address: { readonly name: string } };
  }>;
};

/** The sync plan's units, in a form that does not depend on paths or registration IDs. */
const syncRows = async (world: SystemWorld, name: string) => {
  const run = await world.json(["sync", "--all"]);
  const units: ReadonlyArray<Unit> = run.envelope.plan.resources.units;
  return units
    .map((unit) => ({
      target: unit.target.projectName ?? unit.target._tag,
      collisions: unit.collisions.map((collision) => collision.name).filter((n) => n === name),
      actions: unit.actions
        .filter((action) => (action.destinationPath ?? "").endsWith(`/${name}`))
        .map((action) => [action._tag, action.reason ?? ""]),
      summary: unit.summary,
    }))
    .sort((left, right) => (left.target < right.target ? -1 : 1));
};

describe("parity with source add", () => {
  /** A world where `other` delivers pdf to demo, and the destination also gets a pdf. */
  const scenario = async (how: "import" | "register") => {
    const world = await makeSystemWorld({ commits: [pdfCommit] });
    await addSource(world, "other", { pdf: skillText("pdf") });
    await addProject(world, "demo");
    expect((await world.json(["adapter", "enable", "codex"])).code).toBe(0);
    expect((await world.json(["sync", "--all", "--apply"])).code).toBe(0);
    const link = join(world.root, "projects", "demo", ".agents", "skills", "pdf");
    expect(await readlink(link)).toContain("other/skills/pdf");
    if (how === "import") {
      const applied = await world.json([...importPdf, "--apply"]);
      expect(applied.envelope.classification).toBe("success");
    } else {
      // The equivalent: a second source that holds a skill of the same name.
      await addSource(world, "brain2", { pdf: skillText("pdf") });
    }
    return world;
  };

  it("plans the same rows after an import as after registering an equal source, and pick exclude resolves it", async () => {
    const imported = await scenario("import");
    const registered = await scenario("register");
    const importedRows = await syncRows(imported, "pdf");
    const registeredRows = await syncRows(registered, "pdf");
    expect(importedRows).toEqual(registeredRows);
    const demo = importedRows.find((row) => row.target === "demo");
    // A collision row, no create, and the existing link is removed with reason collision.
    expect(demo).toMatchObject({
      collisions: ["pdf"],
      actions: [["link-remove", "collision"]],
      summary: { collision: 1, create: 0, remove: 1 },
    });

    const excluded = await imported.json([
      "pick",
      "exclude",
      "personal-brain:pdf",
      "--project",
      "demo",
    ]);
    expect(excluded.envelope.classification).toBe("success");
    const excludedEqual = await registered.json([
      "pick",
      "exclude",
      "brain2:pdf",
      "--project",
      "demo",
    ]);
    expect(excludedEqual.envelope.classification).toBe("success");
    const resolved = await syncRows(imported, "pdf");
    expect(resolved).toEqual(await syncRows(registered, "pdf"));
    expect(resolved.find((row) => row.target === "demo")).toMatchObject({
      collisions: [],
      actions: [],
    });
  }, 120_000);
});

describe("reach equals sync", () => {
  it("lists the projects, user decision, and collisions that sync plans after apply", async () => {
    const world = await makeSystemWorld({
      commits: [
        {
          files: {
            "skills/pdf/SKILL.md": skillText("pdf", {
              tack: ["projects: [alpha, beta]", "user-activation: default"],
            }),
          },
        },
      ],
    });
    for (const name of ["alpha", "beta", "gamma"]) await addProject(world, name);
    expect((await world.json(["adapter", "enable", "codex"])).code).toBe(0);
    // Another source already delivers a pdf to the projects that select it by default.
    await addSource(world, "other", { pdf: skillText("pdf") });
    // beta keeps the other source's pdf out, so the imported one does not collide there.
    const otherPdf = (await world.json(["catalog"])).envelope.result.resources.find(
      (resource: { address: { name: string }; sourceRegistrationId: string }) =>
        resource.address.name === "pdf",
    ).sourceRegistrationId as string;
    expect(
      (await world.json(["pick", "exclude", `${otherPdf}:pdf`, "--project", "beta"])).code,
    ).toBe(0);
    expect((await world.json(["sync", "--all", "--apply"])).code).toBe(0);

    const preview = await world.json(importPdf);
    expect(preview.envelope.classification).toBe("success");
    const reach = preview.envelope.plan.reach[0] as {
      readonly projects: ReadonlyArray<{ project: string; receives: boolean; reason?: string }>;
      readonly user: { receives: boolean };
      readonly collisions: ReadonlyArray<{ namespace: string; with: string }>;
    };
    const received = (project: string) => reach.projects.find((entry) => entry.project === project);
    // alpha receives it, and collides with other:pdf; beta receives it because it excludes
    // other:pdf; gamma is outside the skill's own project list; the user namespace takes it by
    // upstream metadata. A pick always names its source, so none is ever ambiguous.
    expect(received("alpha")).toMatchObject({ receives: true });
    expect(received("beta")).toMatchObject({ receives: true });
    expect(received("gamma")).toMatchObject({ receives: false });
    expect(received("gamma")?.reason).toContain("metadata.tack.projects");
    expect(reach.user.receives).toBe(true);
    expect(reach.collisions).toEqual([{ namespace: "project alpha", with: "other:pdf" }]);

    expect((await world.json([...importPdf, "--apply"])).envelope.classification).toBe("success");
    const run = await world.json(["sync", "--all"]);
    const units: ReadonlyArray<Unit> = run.envelope.plan.resources.units;
    const brain = (await world.json(["source"])).envelope.result.sources.find(
      (source: { label?: string }) => source.label === "personal-brain",
    ).registration.id as string;
    const unit = (target: string) =>
      units.find((entry) => (entry.target.projectName ?? entry.target._tag) === target);
    const involvesBrain = (entry: Unit | undefined) =>
      entry !== undefined &&
      (entry.actions.some(
        (action) =>
          action._tag === "link-create" &&
          (action.destinationPath ?? "").endsWith("/pdf") &&
          JSON.stringify(action).includes(brain),
      ) ||
        JSON.stringify(entry.collisions).includes(brain) ||
        (entry.linkedForUser ?? []).some((address) => address.sourceRegistrationId === brain));
    // What sync plans for each namespace agrees with the preview's reach.
    expect(involvesBrain(unit("alpha"))).toBe(true);
    expect(unit("alpha")?.collisions.map((collision) => collision.name)).toEqual(["pdf"]);
    // beta receives it through the user's link, so its own unit does not link it.
    expect(involvesBrain(unit("beta"))).toBe(true);
    expect(unit("beta")?.linkedForUser).toHaveLength(1);
    expect(unit("beta")?.collisions).toEqual([]);
    expect(involvesBrain(unit("gamma"))).toBe(false);
    expect(unit("gamma")?.collisions).toEqual([]);
    expect(involvesBrain(unit("user"))).toBe(true);
    expect(unit("user")?.collisions).toEqual([]);
  }, 180_000);
});

describe("delivery after import", () => {
  it("catalogs the skill under the destination and sync links the folder, live for later edits", async () => {
    const world = await makeSystemWorld({ commits: [pdfCommit] });
    const project = await addProject(world, "demo");
    expect((await world.json(["adapter", "enable", "codex"])).code).toBe(0);
    expect((await world.json([...importPdf, "--apply"])).envelope.classification).toBe("success");

    const catalog = await world.json(["catalog", "--kind", "skill"]);
    const brainId = (await world.json(["source"])).envelope.result.sources.find(
      (source: { label?: string }) => source.label === "personal-brain",
    ).registration.id as string;
    const entry = (
      catalog.envelope.result.resources as ReadonlyArray<{
        address: { name: string; sourceRegistrationId: string };
        directoryPath: string;
      }>
    ).find((resource) => resource.address.name === "pdf");
    expect(entry?.address.sourceRegistrationId).toBe(brainId);
    expect(entry?.directoryPath).toBe(join(world.brain, "skills", "pdf"));
    expect(catalog.envelope.result.issues).toEqual([]);

    const rows = await syncRows(world, "pdf");
    expect(rows.find((row) => row.target === "demo")).toMatchObject({
      actions: [["link-create", ""]],
      collisions: [],
    });
    expect((await world.json(["sync", "--all", "--apply"])).envelope.classification).toBe(
      "success",
    );
    const link = join(project, ".agents", "skills", "pdf");
    expect(await realpath(link)).toBe(await realpath(join(world.brain, "skills", "pdf")));
    // The copy is the operator's: an edit in the destination is live through the link.
    await writeFile(
      join(world.brain, "skills", "pdf", "SKILL.md"),
      skillText("pdf", { frontmatter: "license: MIT\n" }),
    );
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toContain("license: MIT");
    // And the edit is a local change the listing reports.
    const listed = (await world.json(["import"])).envelope.result.imports as ReadonlyArray<{
      local: { state: string; changed: ReadonlyArray<string> };
    }>;
    expect(listed[0]?.local).toMatchObject({ state: "changed", changed: ["SKILL.md"] });
  }, 120_000);
});
