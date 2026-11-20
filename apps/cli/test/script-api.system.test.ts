import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunResultSchema } from "../src/domain/execution/execution-schema.ts";
import { encodeStateFixture } from "./support/state-fixture.ts";
import { builtEntrypoint, decodeEnvelope, runTack } from "./support/tack-process.ts";

const decodeRun = Schema.decodeUnknownSync(RunResultSchema);

/** Scripts written against the Effect-free API, in a source that installs nothing. */
const scripts = {
  greet: `import { defineScript } from "@tackup/cli";
export default defineScript({
  args: {
    name: { type: "string", description: "Who to greet" },
    times: { type: "number", default: 1 },
    tone: { type: "string", choices: ["warm", "dry"], default: "warm" },
  },
  secrets: ["API_TOKEN"],
  run: async ({ args, secrets, log, exec, fs }) => {
    log("using", secrets.API_TOKEN);
    const { stdout } = await exec("echo", ["exec-ran"]);
    await fs.writeJson("out/greet.json", { name: args.name });
    return {
      greeting: \`Hello, \${args.name}\`.repeat(args.times),
      tone: args.tone,
      echoed: stdout.trim(),
      listed: await fs.list("out/*.json"),
      token: secrets.API_TOKEN,
    };
  },
});
`,
  fails: `import { defineScript } from "@tackup/cli";
export default defineScript({ run: ({ fail }) => fail("Nothing to report.", { checked: 3 }) });
`,
  throws: `import { defineScript } from "@tackup/cli";
export default defineScript({
  secrets: ["API_TOKEN"],
  run: ({ secrets }) => { throw new Error(\`Upstream refused \${secrets.API_TOKEN}\`); },
});
`,
  "exec-fails": `import { defineScript } from "@tackup/cli";
export default defineScript({ run: ({ exec }) => exec("sh", ["-c", "echo nope >&2; exit 3"]) });
`,
  "bad-result": `import { defineScript } from "@tackup/cli";
export default defineScript({ run: () => ({ when: new Date(0) }) });
`,
  typo: `import { defineScript } from "@tackup/cli";
export default defineScript({ arg: {}, run: () => null });
`,
};

let root = "";
let home = "";
let state = "";
const run = async (name: string, input: unknown) => {
  const { stdout } = await runTack(
    ["--json", "script", "run", name, "--user", "--input-json", JSON.stringify(input)],
    {
      cwd: root,
      entrypoint: builtEntrypoint,
      home,
      state,
      env: { TACK_API_TOKEN: "s3cret-value" },
    },
  );
  return decodeRun(decodeEnvelope(stdout).result);
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "tack-script-api-")));
  home = join(root, "home");
  state = join(root, "state");
  const source = join(root, "source");
  await Promise.all(
    [home, state, join(source, "scripts"), join(source, "node_modules/@tackup/cli")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  // A decoy installed under the API's name: the running Tack must provide the API instead.
  await writeFile(
    join(source, "node_modules/@tackup/cli/package.json"),
    JSON.stringify({ name: "@tackup/cli", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(source, "node_modules/@tackup/cli/index.js"),
    'throw new Error("The installed decoy loaded.");\n',
  );
  await writeFile(
    join(source, "tack.yaml"),
    `version: 1\nscripts:\n${Object.keys(scripts)
      .map(
        (name) =>
          `  - name: ${name}\n    path: scripts/${name}.ts\n    description: Probe ${name}\n`,
      )
      .join("")}`,
  );
  await Promise.all(
    Object.entries(scripts).map(([name, body]) =>
      writeFile(join(source, `scripts/${name}.ts`), body),
    ),
  );
  await writeFile(
    join(state, "state.json"),
    encodeStateFixture({
      version: 1,
      data: { sources: [{ id: crypto.randomUUID(), canonicalPath: source }] },
    }),
  );
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("script API through the CLI", () => {
  it("runs a no-install script with validated arguments, exec, fs and scrubbed secrets", async () => {
    const result = await run("greet", { name: "Ada", times: 2 });

    expect(result.outcome).toMatchObject({ code: "success" });
    expect(result.core).toMatchObject({
      primary: {
        encoded: {
          greeting: "Hello, AdaHello, Ada",
          tone: "warm",
          echoed: "exec-ran",
          listed: ["out/greet.json"],
          token: "<redacted>",
        },
      },
    });
    expect(JSON.parse(await readFile(join(home, "out/greet.json"), "utf8"))).toEqual({
      name: "Ada",
    });
    expect(JSON.stringify(result.logs)).toContain("using <redacted>");
    expect(JSON.stringify(result)).not.toContain("s3cret-value");
  });

  it("reads the arguments from the words after -- and keeps those words in history", async () => {
    const { stdout } = await runTack(
      ["--json", "script", "run", "greet", "--user", "--", "--name", "Grace", "--times=2"],
      {
        cwd: root,
        entrypoint: builtEntrypoint,
        home,
        state,
        env: { TACK_API_TOKEN: "s3cret-value" },
      },
    );
    const result = decodeRun(decodeEnvelope(stdout).result);
    const record = JSON.parse(
      await readFile(join(state, "history", `${result.runId}.json`), "utf8"),
    );

    expect(result.core).toMatchObject({
      primary: { encoded: { greeting: "Hello, GraceHello, Grace" } },
    });
    expect(record).toMatchObject({ originalWords: ["--name", "Grace", "--times=2"] });
    expect(record).not.toHaveProperty("originalInput");
  });

  it("shows what a script declares without running it", async () => {
    const show = async (name: string) =>
      decodeEnvelope(
        (
          await runTack(["--json", "script", "show", name], {
            cwd: root,
            entrypoint: builtEntrypoint,
            home,
            state,
          })
        ).stdout,
      );
    const shown = await show("throws");
    const greet = await show("greet");
    const typo = await show("typo");

    expect(shown).toMatchObject({
      classification: "success",
      result: { kind: "script-show", description: "Probe throws", secrets: ["API_TOKEN"] },
    });
    expect(greet.result).toMatchObject({
      arguments: [
        { name: "name", type: "string", description: "Who to greet" },
        { name: "times", type: "number", default: 1 },
        { name: "tone", type: "string", choices: ["warm", "dry"], default: "warm" },
      ],
    });
    expect(typo).toMatchObject({
      classification: "invalid-configuration",
      diagnostics: [{ code: "invalid_definition" }],
    });
  });

  it("lists every argument problem with its help before the script runs", async () => {
    const result = await run("greet", { times: "two", tone: "loud", colour: "red" });

    expect(result.outcome).toMatchObject({ stage: "preflight", code: "invalid_args" });
    expect(result.outcome.message.split("\n")).toEqual([
      "Unknown argument --colour. Arguments: --name, --times, --tone.",
      "Missing --name (string: Who to greet).",
      '--times must be a number, got "two".',
      '--tone must be one of warm, dry, got "loud".',
    ]);
  });

  it("reports fail() as an expected failure and a thrown error by its scrubbed message", async () => {
    const failed = await run("fails", {});
    const thrown = await run("throws", {});
    const exec = await run("exec-fails", {});

    expect(failed.outcome).toMatchObject({ code: "expected_failure" });
    expect(JSON.stringify(failed.core)).toContain('"message":"Nothing to report."');
    expect(thrown.outcome).toMatchObject({
      code: "executed_defect",
      message: "Upstream refused <redacted>",
    });
    expect(exec.outcome).toMatchObject({
      code: "executed_defect",
      message: "sh exited with 3: nope",
    });
  });

  it("names a non-JSON result and a malformed definition", async () => {
    const result = await run("bad-result", {});
    const typo = await run("typo", {});

    expect(result.outcome).toMatchObject({
      code: "executed_defect",
      message: "result.when is a Date (use .toISOString()); return JSON data.",
    });
    expect(typo.outcome).toMatchObject({
      code: "invalid_definition",
      message:
        'defineScript has no "arg" option. Did you mean "args"? Options: args, secrets, run.',
    });
  });
});
