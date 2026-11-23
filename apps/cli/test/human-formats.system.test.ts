import { encodeStateFixture } from "./support/state-fixture.ts";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtEntrypoint, runTack } from "./support/tack-process.ts";

/** Runs the built CLI. Stdin is closed: any prompt or read in human output would fail the run. */
const spawnCli = async (
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly home: string; readonly state: string },
) => {
  const { exitCode, stdout, stderr } = await runTack(args, {
    ...options,
    entrypoint: builtEntrypoint,
  });
  return { code: exitCode, stdout, stderr };
};

/** A script on the script API; `body` is its async run function's body. */
const definition = (body: string) =>
  `import { defineScript } from "@tackup/cli"; export default defineScript({ run: async () => { ${body} } });`;

const withRoot = async (use: (root: string, home: string, state: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-human-formats-")));
  const home = join(root, "home");
  const state = join(root, "state");
  try {
    await Promise.all([mkdir(home), mkdir(state)]);
    await use(root, home, state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

it(
  "keeps script log mirroring on stderr identical across formats and prints a script view",
  () =>
    withRoot(async (root, home, state) => {
      const source = join(root, "source");
      await mkdir(join(source, "scripts"), { recursive: true });
      await writeFile(
        join(source, "tack.yaml"),
        "version: 1\nscripts:\n  - name: run\n    path: scripts/run.ts\n    description: Run fixture\n",
      );
      await writeFile(join(source, "package.json"), "{}");
      await writeFile(
        join(source, "scripts/run.ts"),
        definition(
          'console.log("captured stdout"); console.error("captured stderr"); return "done";',
        ),
      );
      await writeFile(
        join(state, "state.json"),
        encodeStateFixture({
          version: 1,
          data: { sources: [{ id: crypto.randomUUID(), canonicalPath: source }] },
        }),
      );
      const scriptArgs = ["script", "run", "run", "--user"];
      const options = { cwd: root, home, state };
      const json = await spawnCli(["--json", ...scriptArgs], options);
      const human = await spawnCli([...scriptArgs], options);
      expect(json.code).toBe(0);
      expect(human.code).toBe(json.code);
      expect(json.stderr).toContain("captured stderr");
      expect(human.stderr).toBe(json.stderr);
      expect(human.stdout).toContain("tack script run");
      expect(human.stdout).toContain("tack script history show");
      expect(human.stdout).not.toContain("\u001b[");
      expect(() => JSON.parse(human.stdout)).toThrow();
      expect(JSON.parse(json.stdout)).toMatchObject({ command: "script run", status: "success" });
    }),
  30000,
);

it(
  "keeps the reader failure on stderr identical across formats",
  () =>
    withRoot(async (root, home, state) => {
      await writeFile(
        join(state, "state.json"),
        encodeStateFixture({
          version: 1,
          data: {
            projects: [{ name: "demo", gitCommonDirectory: join(root, "git"), roots: [root] }],
          },
        }),
      );
      const listener = createServer();
      await new Promise<void>((resolveListening, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => resolveListening());
      });
      try {
        const address = listener.address();
        if (address === null || typeof address === "string") throw new Error("Expected a TCP port");
        const args = [
          "docs",
          "serve",
          "--project",
          "demo",
          "--no-open",
          "--port",
          String(address.port),
        ];
        const options = { cwd: root, home, state };
        const json = await spawnCli(["--json", ...args], options);
        const human = await spawnCli([...args], options);
        expect(json.code).toBe(1);
        expect(human.code).toBe(json.code);
        expect(human.stderr).toBe(json.stderr);
        expect(human.stdout).toContain("reader-port-in-use");
        expect(() => JSON.parse(human.stdout)).toThrow();
      } finally {
        await new Promise<void>((resolveClosed) => listener.close(() => resolveClosed()));
      }
    }),
  30000,
);

it(
  "completes immediate mutations in human format without reading stdin",
  () =>
    withRoot(async (root, home, state) => {
      const options = { cwd: root, home, state };
      const source = join(root, "source");
      await mkdir(source);
      await writeFile(join(source, "tack.yaml"), "version: 1\nskills:\n  - path: skills\n");
      await mkdir(join(source, "skills", "review"), { recursive: true });
      await writeFile(
        join(source, "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review\n---\n",
      );
      const runs = [
        ["state", "init"],
        ["source", "add", source, "--apply"],
        ["source", "add", source, "--apply"],
        ["adapter", "enable", "claude"],
        ["pick", "include", "review", "--user"],
        ["pick", "remove", "review", "--user"],
      ];
      for (const args of runs) {
        const human = await spawnCli([...args], options);
        expect(human.code, `${args.join(" ")}: ${human.stdout}${human.stderr}`).toBe(0);
        expect(human.stdout).toContain(
          `tack ${args.slice(0, args[0] === "init" ? 1 : 2).join(" ")}`,
        );
        expect(() => JSON.parse(human.stdout)).toThrow();
        expect(human.stderr).toBe("");
      }
    }),
  60000,
);
