import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { builtinSkills, builtinWorld } from "./support/builtin-world.ts";
import { sourceEntrypoint as entrypoint } from "./support/tack-process.ts";

// The process-level smoke test of the built-in skills, and of `pick`, `sync`, `status` and
// `state reset` on them. The other cases run in process, in `builtin-skills.host.test.ts`.
it("discovers the bundled skills without source registration and installs them only on apply", async () => {
  const { run, link } = await builtinWorld("process");
  expect((await run(["catalog"])).result).toMatchObject({
    complete: true,
    issues: [],
    resources: builtinSkills.map((name) =>
      expect.objectContaining({
        kind: "skill",
        origin: "builtin",
        address: expect.objectContaining({ kind: "skill", name }),
        activation: "opt-in",
        userActivation: "default",
      }),
    ),
  });
  await run(["sync", "--user"]);
  for (const name of builtinSkills) expect(existsSync(link(name))).toBe(false);
  await run(["sync", "--user", "--apply"]);
  for (const name of builtinSkills)
    for (const adapter of [".claude", ".agents", ".cursor"]) {
      expect(lstatSync(link(name, adapter)).isSymbolicLink()).toBe(true);
      expect(isAbsolute(readlinkSync(link(name, adapter)))).toBe(false);
      expect(readFileSync(join(link(name, adapter), "SKILL.md"), "utf8")).toBe(
        readFileSync(resolve(dirname(entrypoint), `builtins/skills/${name}/SKILL.md`), "utf8"),
      );
    }
  await run(["status", "--user"]);
  const skill = realpathSync(link("use-tack"));
  expect((await run(["pick", "exclude", "use-tack", "--user"], 2)).diagnostics).toMatchObject([
    { code: "builtin-skill-locked" },
  ]);
  await run(["sync", "--user", "--apply"]);
  expect(existsSync(link("use-tack"))).toBe(true);
  expect(existsSync(link("manage-tack-sources"))).toBe(true);
  expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  expect((await run(["pick", "remove", "use-tack", "--user"], 2)).diagnostics).toMatchObject([
    { code: "builtin-skill-locked" },
  ]);
  await run(["sync", "--user", "--apply"]);
  expect(existsSync(link("use-tack"))).toBe(true);
  await run(["state", "reset", "--apply"]);
  for (const name of builtinSkills) expect(existsSync(link(name))).toBe(false);
  expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
});
