import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineScript as defineContractScript,
  encodeRunOutcome,
  NoExpectedFailure,
  runScript,
  type ShellCommand,
} from "@tackup/core";
import { Schema } from "effect";
import { defineScript, recognizeScript, type ArgSpec } from "@tackup/core/script-api";
import {
  adaptScript,
  jsonProblem,
  makeExec,
  makeFiles,
  declarationsOf,
  inputFromWords,
  parseArguments,
  prepareScript,
  scrubSecrets,
} from "./script-api-adapter.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scratch = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-script-api-")));
  roots.push(root);
  return root;
};

describe("argument parsing", () => {
  const specs: Record<string, ArgSpec> = {
    name: { type: "string" },
    times: { type: "number", default: 1 },
    labels: { type: "string", multiple: true, optional: true },
    shout: { type: "boolean", optional: true },
  };

  it("fills defaults and keeps optional arguments absent", () => {
    expect(parseArguments(specs, { name: "Ada", labels: ["a", "b"] })).toEqual({
      ok: true,
      args: { name: "Ada", times: 1, labels: ["a", "b"] },
    });
  });

  it("lists every problem, including list and finite-number checks", () => {
    expect(parseArguments(specs, { labels: "a", times: Infinity, shout: 1 })).toEqual({
      ok: false,
      problems: [
        "Missing --name (string).",
        "--times must be a number, got null.",
        '--labels takes a list, got "a".',
        "--shout must be a boolean, got 1.",
      ],
    });
    expect(
      parseArguments({ labels: specs["labels"] ?? { type: "string" } }, { labels: [1] }),
    ).toEqual({ ok: false, problems: ["--labels must be a string, got 1."] });
  });

  it("accepts a listed choice and names the arguments when one is unknown", () => {
    const tone: Record<string, ArgSpec> = { tone: { type: "string", choices: ["warm", "dry"] } };

    expect(parseArguments(tone, { tone: "dry" })).toEqual({ ok: true, args: { tone: "dry" } });
    expect(
      parseArguments(
        { tags: { type: "string", multiple: true, description: "Labels to add" } },
        {},
      ),
    ).toEqual({ ok: false, problems: ["Missing --tags (string list: Labels to add)."] });
    expect(parseArguments(tone, { tone: "loud" })).toEqual({
      ok: false,
      problems: ['--tone must be one of warm, dry, got "loud".'],
    });
    expect(parseArguments(tone, { tone: "dry", colour: "red" })).toEqual({
      ok: false,
      problems: ["Unknown argument --colour. Arguments: --tone."],
    });
  });

  it("refuses input that is not an object, and arguments a script without any does not take", () => {
    expect(parseArguments(specs, [])).toEqual({
      ok: false,
      problems: ['Pass arguments as a JSON object, such as {"name": "Ada"}.'],
    });
    expect(parseArguments({}, { extra: true })).toEqual({
      ok: false,
      problems: ["Unknown argument --extra. This script takes no arguments."],
    });
  });
});

describe("result and message checks", () => {
  it("replaces every declared secret value and ignores empty ones", () => {
    expect(scrubSecrets("a s3cret and k3y, s3cret", ["s3cret", "k3y", ""])).toBe(
      "a <redacted> and <redacted>, <redacted>",
    );
  });

  it("accepts JSON data and names the first value that is not", () => {
    expect(
      jsonProblem({ list: [1, "a", true, null], nested: Object.create(null) }),
    ).toBeUndefined();
    expect(jsonProblem({ when: new Date(0) })).toBe(
      "result.when is a Date (use .toISOString()); return JSON data.",
    );
    expect(jsonProblem([1, Number.NaN])).toBe("result[1] is NaN; return JSON data.");
    expect(jsonProblem({ items: new Map() })).toBe("result.items is a Map; return JSON data.");
    expect(jsonProblem(() => 1)).toBe("result is a function; return JSON data.");
    expect(jsonProblem({ value: undefined })).toBe(
      "result.value is an undefined; return JSON data.",
    );
  });
});

describe("file tools", () => {
  it("writes with parent directories, reads back, lists by glob and removes", async () => {
    const cwd = await scratch();
    const files = makeFiles(cwd, new AbortController().signal);

    await files.writeJson("reports/one.json", { one: 1 });
    await files.write(join(cwd, "reports/nested/two.txt"), "two");

    expect(await files.readJson("reports/one.json")).toEqual({ one: 1 });
    expect(await files.read("reports/nested/two.txt")).toBe("two");
    expect(await files.exists("reports/one.json")).toBe(true);
    expect(await files.list("reports/**/*")).toEqual([
      "reports/nested/two.txt",
      "reports/one.json",
    ]);
    expect(await files.list("reports/one.json")).toEqual(["reports/one.json"]);
    expect(await files.list("missing/*.json")).toEqual([]);
    await files.remove("reports");
    expect(await files.exists("reports/one.json")).toBe(false);
  });

  it("refuses every call once the run is cancelled", async () => {
    const controller = new AbortController();
    const files = makeFiles(await scratch(), controller.signal);
    controller.abort();

    await expect(files.read("any")).rejects.toThrow();
    await expect(files.list("*")).rejects.toThrow();
  });
});

describe("exec", () => {
  const recorded: ShellCommand[] = [];
  const exec = makeExec(async (command) => {
    recorded.push(command);
    return command.executable === "false"
      ? { stdout: "", stderr: "", exitCode: 1 }
      : { stdout: "out\n", stderr: "warn\n", exitCode: command.executable === "fail" ? 2 : 0 };
  }, "/work");

  it("runs one executable from the script's directory, or a directory relative to it", async () => {
    expect(await exec("git", ["status"], { cwd: "repo", env: { A: "1" } })).toEqual({
      stdout: "out\n",
      stderr: "warn\n",
      exitCode: 0,
    });
    await exec("ls");
    expect(recorded).toEqual([
      { executable: "git", args: ["status"], cwd: "/work/repo", env: { A: "1" } },
      { executable: "ls", args: [], cwd: "/work" },
    ]);
  });

  it("throws on a non-zero exit unless allowed, and explains a shell-style command line", async () => {
    await expect(exec("fail")).rejects.toThrow("fail exited with 2: warn");
    await expect(exec("false")).rejects.toThrow("false exited with 1.");
    expect(await exec("fail", [], { allowFailure: true })).toMatchObject({ exitCode: 2 });
    await expect(exec("git status")).rejects.toThrow(
      'exec runs one executable without a shell. Write exec("git", ["status"]).',
    );
  });
});

describe("the adapter on the contract 1 runner", () => {
  const shell = {
    execute: (command: ShellCommand) =>
      Effect.succeed({ stdout: `${command.executable} ran`, stderr: "", exitCode: 0 }),
  };
  const adapted = (options: Parameters<typeof defineScript>[0], args: unknown = {}, cwd = "/") => {
    const recognized = recognizeScript(defineScript(options));
    if (recognized === undefined) throw new Error("The definition was not recognized.");
    return adaptScript(recognized, args, cwd);
  };
  const run = async (definition: ReturnType<typeof adaptScript>) => {
    const logs: string[] = [];
    const outcome = await runScript(definition, {
      input: {},
      services: { secrets: { API_TOKEN: "s3cret" }, Shell: shell },
      onLog: (log) => logs.push(log.content),
    });
    return { outcome: encodeRunOutcome(outcome), logs };
  };

  it("gives the script its arguments, secrets, log and exec, and scrubs the result", async () => {
    const { outcome, logs } = await run(
      adapted(
        {
          args: { name: { type: "string" } },
          secrets: ["API_TOKEN"],
          run: async ({ args, secrets, log, exec, cwd }) => {
            log("token", secrets["API_TOKEN"], { cwd });
            log.debug("debug");
            log.warn("warn");
            log.error("error");
            return {
              name: args["name"],
              ran: (await exec("echo")).stdout,
              token: secrets["API_TOKEN"],
            };
          },
        },
        { name: "Ada" },
        "/project",
      ),
    );

    expect(outcome.primary).toMatchObject({
      code: "success",
      encoded: { name: "Ada", ran: "echo ran", token: "<redacted>" },
    });
    expect(logs).toContain('token <redacted> {"cwd":"/project"}');
    expect(logs).toEqual(expect.arrayContaining(["warn", "error"]));
  });

  it("turns fail(), a throw, a non-Error throw and a non-JSON result into readable outcomes", async () => {
    const failed = await run(adapted({ run: ({ fail }) => fail("No data.", { checked: 3 }) }));
    const bare = await run(adapted({ run: ({ fail }) => fail("No data.") }));
    const thrown = await run(
      adapted({
        secrets: ["API_TOKEN"],
        run: ({ secrets }) => {
          throw new Error(`refused ${secrets["API_TOKEN"]}`);
        },
      }),
    );
    const odd = await run(
      adapted({
        run: () => {
          // oxlint-disable-next-line typescript/only-throw-error -- Scripts may throw anything.
          throw 42;
        },
      }),
    );
    const date = await run(adapted({ run: () => new Date(0) }));
    const nothing = await run(adapted({ run: () => undefined }));

    expect(failed.outcome.primary).toMatchObject({
      code: "expected_failure",
      encoded: { message: "No data.", details: { checked: 3 } },
    });
    expect(bare.outcome.primary).toMatchObject({ encoded: { details: null } });
    expect(thrown.outcome.primary).toMatchObject({
      code: "executed_defect",
      message: "refused <redacted>",
    });
    expect(odd.outcome.primary).toMatchObject({ message: "The script threw 42." });
    expect(date.outcome.primary).toMatchObject({
      message: "result is a Date (use .toISOString()); return JSON data.",
    });
    expect(nothing.outcome.primary).toMatchObject({ code: "success", encoded: null });
  });

  it("waits for the script's own cleanup when the run is cancelled", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let cleaned = false;
    const pending = runScript(
      adapted({
        run: async ({ signal }) => {
          try {
            started.resolve();
            await new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            });
          } finally {
            await new Promise((resolve) => setTimeout(resolve, 20));
            cleaned = true;
          }
        },
      }),
      { input: {}, services: { secrets: {}, Shell: shell }, signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    const outcome = encodeRunOutcome(await pending);

    expect(cleaned).toBe(true);
    expect(outcome.primary).toMatchObject({ code: "interrupted" });
  });

  it("reports an error that cleanup raises after cancellation as a cleanup failure", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const pending = runScript(
      adapted({
        run: async ({ signal }) => {
          try {
            started.resolve();
            await new Promise((_, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason));
            });
          } finally {
            // oxlint-disable-next-line no-unsafe-finally -- The fixture models a cleanup that fails.
            throw new Error("cleanup canary");
          }
        },
      }),
      { input: {}, services: { secrets: {}, Shell: shell }, signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    const outcome = encodeRunOutcome(await pending);

    expect(outcome).toMatchObject({
      code: "cleanup_failed",
      primary: { code: "interrupted" },
      finalization: { status: "failed" },
    });
  });

  it("writes files relative to the run's directory", async () => {
    const cwd = await scratch();
    await run(adapted({ run: ({ fs }) => fs.write("note.txt", "kept") }, {}, cwd));

    expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("kept");
  });
});

describe("preparing a module's default export", () => {
  it("adapts a defineScript definition once its arguments check out", () => {
    const script = defineScript({ args: { name: { type: "string" } }, run: () => null });

    expect(prepareScript(script, { name: "Ada" }, "/")).toMatchObject({ ok: true });
    expect(prepareScript(script, {}, "/")).toEqual({
      ok: false,
      code: "invalid_args",
      message: "Missing --name (string).",
    });
  });

  it("refuses a contract 1 definition and anything else that defineScript did not return", () => {
    const contract = defineContractScript({
      contract: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      error: NoExpectedFailure,
      secrets: [],
      services: [],
      run: () => Effect.succeed("done"),
    });

    expect(prepareScript(contract, {}, "/")).toMatchObject({
      ok: false,
      code: "invalid_definition",
      message: expect.stringContaining("defineScript({ run: async (context) => { ... } })"),
    });
    expect(prepareScript({ run: () => null }, {}, "/")).toMatchObject({
      ok: false,
      code: "invalid_definition",
    });
  });
});

describe("arguments from command-line words", () => {
  const specs = {
    repo: { type: "string" },
    limit: { type: "number", default: 20 },
    dryRun: { type: "boolean", optional: true },
    labels: { type: "string", multiple: true, optional: true },
  } as const;
  const run = (words: ReadonlyArray<string>) =>
    prepareScript(defineScript({ args: specs, run: () => null }), {}, "/", words);

  it("reads values, inline values, kebab and negated booleans and repeated lists", () => {
    expect(
      inputFromWords(specs, [
        "--repo",
        "a/b",
        "--limit=5",
        "--dry-run",
        "--labels",
        "x",
        "--labels=y",
      ]),
    ).toEqual({
      input: { repo: "a/b", limit: 5, dryRun: true, labels: ["x", "y"] },
      problems: [],
    });
    expect(inputFromWords(specs, ["--no-dryRun", "--dryRun=false"]).input).toEqual({
      dryRun: false,
    });
    expect(run(["--repo", "a/b"])).toMatchObject({ ok: true });
  });

  it("lists every problem with the words and the declarations at once", () => {
    expect(
      run([
        "stray",
        "--repo",
        "--limit",
        "many",
        "--dry-run=maybe",
        "--color",
        "red",
        "--limit",
        "3",
      ]),
    ).toEqual({
      ok: false,
      code: "invalid_args",
      message: [
        'Unexpected "stray". Pass each argument as --name value.',
        "--repo needs a string value.",
        "--dryRun is a boolean: pass --dryRun or --no-dryRun.",
        "--limit was given more than once.",
        "Unknown argument --color. Arguments: --repo, --limit, --dryRun, --labels.",
        "Missing --repo (string).",
        '--limit must be a number, got "many".',
      ].join("\n"),
    });
  });
});

describe("what a script declares", () => {
  it("reads the arguments and secrets, defaulting both to none, or refuses what is no script", () => {
    expect(
      declarationsOf(
        defineScript({
          args: { name: { type: "string", description: "Who" } },
          secrets: ["TOKEN"],
          run: () => null,
        }),
      ),
    ).toEqual({
      ok: true,
      declarations: { args: { name: { type: "string", description: "Who" } }, secrets: ["TOKEN"] },
    });
    expect(declarationsOf(defineScript({ run: () => null }))).toEqual({
      ok: true,
      declarations: { args: {}, secrets: [] },
    });
    expect(declarationsOf(42)).toMatchObject({ ok: false, code: "invalid_definition" });
  });

  it("keeps an unknown argument's inline value for the declarations check", () => {
    expect(inputFromWords({}, ["--colour=red", "--loud"])).toEqual({
      input: { colour: "red", loud: true },
      problems: [],
    });
  });
});
