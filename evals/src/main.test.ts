import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({
  docker: vi.fn(),
  runProcess: vi.fn(),
  inspectImage: vi.fn(),
  checkAuth: vi.fn(),
  verifyAgentIsolation: vi.fn(),
  backend: vi.fn(),
  spawnSync: vi.fn(),
  question: vi.fn(),
  closePrompt: vi.fn(),
}));
vi.mock("./process.ts", async (original) => ({
  ...(await original<typeof import("./process.ts")>()),
  docker: mocks.docker,
  runProcess: mocks.runProcess,
}));
vi.mock("./docker-backend.ts", async (original) => ({
  ...(await original<typeof import("./docker-backend.ts")>()),
  inspectImage: mocks.inspectImage,
  checkAuth: mocks.checkAuth,
  verifyAgentIsolation: mocks.verifyAgentIsolation,
  dockerBackend: mocks.backend,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: mocks.spawnSync,
}));
vi.mock("node:readline/promises", async (original) => ({
  ...(await original<typeof import("node:readline/promises")>()),
  createInterface: () => ({ question: mocks.question, close: mocks.closePrompt }),
}));
import { runCli } from "./main.ts";
import { record } from "./plan.ts";

const suite = fileURLToPath(new URL("../test/fake-suite.ts", import.meta.url));
const success = { exitCode: 0, stdout: "ok", stderr: "", stopped: null };
let directory: string;
let campaign: string;
let output: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tack-eval-cli-test-"));
  campaign = join(directory, "campaign.json");
  await writeFile(
    campaign,
    JSON.stringify({
      seed: 1,
      profiles: [{ driver: "codex", model: "test", effort: "low" }],
      stages: [{ id: "smoke", taskIds: ["task-a"] }],
    }),
  );
  mocks.inspectImage.mockResolvedValue({
    id: "sha256:fixed",
    tackVersion: { version: 1 },
    agentVersions: { claude: "v1", codex: "v1" },
  });
  mocks.checkAuth.mockResolvedValue(undefined);
  mocks.verifyAgentIsolation.mockResolvedValue(undefined);
  mocks.docker.mockResolvedValue(success);
  mocks.runProcess.mockImplementation(async (argv: string[]) => ({
    ...success,
    stdout: argv.includes("rev-parse") ? "abc1234" : "",
  }));
  mocks.spawnSync.mockReturnValue({ status: 0 });
  mocks.backend.mockReturnValue({
    fixture: async () => ({
      context: { seed: 1, world: directory, exec: async () => success },
      close: async () => {},
    }),
    launch: async () => ({
      outcome: "completed",
      finalAnswer: "correct",
      commands: [],
      costUsd: null,
      metadata: {},
    }),
    record: async () => {},
  });
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.values(mocks).forEach((mock) => mock.mockReset());
});
it("offers help and discovery without any agent request", async () => {
  await runCli([]);
  expect(output).toHaveBeenCalledWith(expect.stringContaining("Docker only"));
  await runCli(["list", "--suite", suite]);
  expect(output).toHaveBeenCalledWith(expect.stringContaining("Fake discovery"));
  expect(mocks.inspectImage).not.toHaveBeenCalled();
});
it("prints a complete plan and refuses missing or stale run confirmation before auth", async () => {
  await runCli(["plan", campaign, "--json", "--suite", suite]);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('"confirmation"'));
  await expect(runCli(["run", campaign, "--suite", suite, "--confirm", "stale"])).rejects.toThrow(
    "confirmation required",
  );
  expect(mocks.checkAuth).not.toHaveBeenCalled();
});
it("runs the exact confirmed plan once and publishes inspectable results", async () => {
  await runCli(["plan", campaign, "--json", "--suite", suite]);
  const printed = output.mock.calls.find((call: readonly unknown[]) =>
    String(call[0]).includes('"confirmation"'),
  );
  const token = JSON.parse(String(printed?.[0])).confirmation;
  const destination = join(directory, "results");
  await runCli(["run", campaign, "--suite", suite, "--confirm", token, "--output", destination]);
  expect(mocks.checkAuth).toHaveBeenCalledWith("sha256:fixed", "codex");
  expect(JSON.parse(await readFile(join(destination, "results.json"), "utf8"))[0].pass).toBe(true);
  await runCli(["report", destination]);
  expect(output).toHaveBeenCalledWith(expect.stringContaining("1 fresh scored"));
});
it("uses only the native container sign-in command and refuses unsupported CLI ids", async () => {
  await runCli(["auth", "codex"]);
  expect(mocks.spawnSync.mock.calls[0]?.[1]).toContain("--device-auth");
  await expect(runCli(["auth", "unknown"])).rejects.toThrow("Choose");
  mocks.spawnSync.mockReturnValue({ status: 1 });
  await expect(runCli(["auth", "claude"])).rejects.toThrow("Sign-in exited");
});
it("builds outside runtime state and refuses uncommitted content unless explicitly requested", async () => {
  await runCli(["image"]);
  expect(mocks.docker.mock.calls[0]?.[0]).toContain("build");
  mocks.runProcess.mockResolvedValue({ ...success, stdout: "dirty" });
  await expect(runCli(["image"])).rejects.toThrow("Dirty checkout");
  await runCli(["image", "--allow-dirty"]);
});
it("reports auth prerequisites without inference and rejects unknown commands", async () => {
  mocks.checkAuth.mockRejectedValue(new Error("auth-required"));
  await runCli(["doctor", "--suite", suite]);
  expect(output).toHaveBeenCalledWith(expect.stringContaining("auth-required"));
  await expect(runCli(["unknown", "--suite", suite])).rejects.toThrow("Unknown command");
  await expect(runCli(["plan", "--suite", suite])).rejects.toThrow("explicit campaign");
  await expect(runCli(["report"])).rejects.toThrow("saved campaign");
});
it("regrades retained state with the original image and never authenticates or calls a model", async () => {
  await runCli(["plan", campaign, "--json", "--suite", suite]);
  const printed = output.mock.calls.find((call: readonly unknown[]) =>
    String(call[0]).includes('"confirmation"'),
  );
  const plan = JSON.parse(String(printed?.[0]));
  const fixture = join(directory, "fixture");
  await mkdir(join(fixture, "world"), { recursive: true });
  await writeFile(
    join(fixture, "prepared.json"),
    JSON.stringify({ cwd: "/world", request: "Find", publicFacts: {} }),
  );
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ suiteDigest: plan.suiteDigest, image: { id: "sha256:fixed" } }),
  );
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify([
      {
        ...plan.trials[0],
        outcome: "completed",
        score: 0,
        pass: false,
        excluded: false,
        error: null,
        grade: null,
        execution: {
          outcome: "completed",
          finalAnswer: "correct",
          commands: [],
          costUsd: null,
          metadata: { fixtureDirectory: fixture, suiteDigest: plan.suiteDigest },
        },
      },
    ]),
  );
  await runCli(["regrade", directory, "--suite", suite]);
  expect(JSON.parse(await readFile(join(directory, "regraded.json"), "utf8"))[0].pass).toBe(true);
  expect(JSON.parse(await readFile(join(directory, "results.json"), "utf8"))[0].pass).toBe(false);
  expect(mocks.checkAuth).not.toHaveBeenCalled();
  expect(mocks.backend).not.toHaveBeenCalled();
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ suiteDigest: "changed" }));
  await expect(runCli(["regrade", directory, "--suite", suite])).rejects.toThrow("digest changed");
});
it("checks successful auth, invalid suite contracts and failed code hashing without inference", async () => {
  await runCli(["doctor", "--suite", suite]);
  expect(output).toHaveBeenCalledWith("codex: subscription auth ready");
  const invalid = join(directory, "invalid.ts");
  await writeFile(invalid, "export const suite={contractVersion:99};");
  await expect(runCli(["list", "--suite", invalid])).rejects.toThrow("version-1");
  const built = await Bun.build({ entrypoints: [suite], target: "bun" });
  vi.spyOn(Bun, "build").mockResolvedValue({ ...built, success: false });
  await expect(runCli(["list", "--suite", suite])).rejects.toThrow("Cannot hash");
});
it("limits doctor to the drivers of an explicit campaign so paused Codex needs no auth", async () => {
  const claudeOnly = join(directory, "claude-only.json");
  await writeFile(
    claudeOnly,
    JSON.stringify({ seed: 1, profiles: [{ driver: "claude", model: "test", effort: "low" }] }),
  );
  await runCli(["doctor", claudeOnly, "--suite", suite]);
  expect(mocks.checkAuth.mock.calls).toEqual([["sha256:fixed", "claude"]]);
  expect(mocks.verifyAgentIsolation.mock.calls.map((call: readonly unknown[]) => call[1])).toEqual([
    "claude",
  ]);
  expect(output).toHaveBeenCalledWith("claude: subscription auth ready");
  expect(output).not.toHaveBeenCalledWith(expect.stringContaining("codex"));
});
it("binds the explicit container-only Codex mode to confirmation without changing the default", async () => {
  await runCli(["plan", campaign, "--json", "--suite", suite]);
  const first = output.mock.calls.find((call: readonly unknown[]) =>
    String(call[0]).includes('"confirmation"'),
  );
  const native = JSON.parse(String(first?.[0]));
  expect(native.codexSandbox).toBe("native");
  output.mockClear();
  await runCli([
    "plan",
    campaign,
    "--json",
    "--suite",
    suite,
    "--codex-sandbox",
    "off-in-container",
  ]);
  const second = output.mock.calls.find((call: readonly unknown[]) =>
    String(call[0]).includes('"confirmation"'),
  );
  const container = JSON.parse(String(second?.[0]));
  expect(container.codexSandbox).toBe("off-in-container");
  expect(container.confirmation).not.toBe(native.confirmation);
  await expect(
    runCli([
      "run",
      campaign,
      "--suite",
      suite,
      "--codex-sandbox",
      "off-in-container",
      "--confirm",
      native.confirmation,
    ]),
  ).rejects.toThrow("confirmation");
  expect(mocks.checkAuth).not.toHaveBeenCalled();
  await expect(
    runCli(["plan", campaign, "--json", "--suite", suite, "--codex-sandbox", "wrong"]),
  ).rejects.toThrow("Choose --codex-sandbox");
});

const planToken = async (extra: ReadonlyArray<string> = []) => {
  output.mockClear();
  await runCli(["plan", campaign, "--json", "--suite", suite, ...extra]);
  const printed = output.mock.calls.find((call: readonly unknown[]) =>
    String(call[0]).includes('"confirmation"'),
  );
  const plan = record(JSON.parse(String(printed?.[0])));
  const trials = plan["trials"];
  return {
    confirmation: String(plan["confirmation"]),
    suiteDigest: String(plan["suiteDigest"]),
    firstTrial: record(Array.isArray(trials) ? trials[0] : undefined),
  };
};

/** Saves one campaign directory whose single trial points at `fixture`, as `run` would leave it. */
const savedCampaign = async (options: {
  readonly fixture: string;
  readonly prepared?: unknown;
  readonly trial?: Record<string, unknown>;
  readonly execution?: null;
}) => {
  const plan = await planToken();
  await mkdir(join(options.fixture, "world"), { recursive: true });
  await writeFile(
    join(options.fixture, "prepared.json"),
    JSON.stringify(options.prepared ?? { cwd: "/world", request: "Find", publicFacts: {} }),
  );
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ suiteDigest: plan.suiteDigest, image: { id: "sha256:fixed" } }),
  );
  const result = {
    ...plan.firstTrial,
    outcome: "completed",
    score: 0,
    pass: false,
    excluded: false,
    error: null,
    grade: null,
    ...options.trial,
    execution:
      options.execution === null
        ? null
        : {
            outcome: "completed",
            finalAnswer: "correct",
            commands: [],
            costUsd: null,
            metadata: { fixtureDirectory: options.fixture, suiteDigest: plan.suiteDigest },
          },
  };
  await writeFile(join(directory, "results.json"), JSON.stringify([result]));
};

it("regrades only trials that executed and records the rest unchanged", async () => {
  await savedCampaign({
    fixture: join(directory, "fixture"),
    trial: { outcome: "unstarted", excluded: true },
    execution: null,
  });

  await runCli(["regrade", directory, "--suite", suite]);

  const regraded = JSON.parse(await readFile(join(directory, "regraded.json"), "utf8"));
  expect(regraded).toMatchObject([{ execution: null, outcome: "unstarted", grade: null }]);
  expect(mocks.docker).not.toHaveBeenCalled();
  expect(await readFile(join(directory, "regraded.md"), "utf8")).toContain("0 fresh scored");
});

it("regrades saved string facts and passes them to the grader", async () => {
  await savedCampaign({
    fixture: join(directory, "fixture"),
    prepared: { cwd: "/world", request: "Find", publicFacts: { version: "1.2.3" } },
  });

  await runCli(["regrade", directory, "--suite", suite]);

  expect(JSON.parse(await readFile(join(directory, "regraded.json"), "utf8"))[0].pass).toBe(true);
});

it.each([
  ["a trial whose task left the suite", { trial: { taskId: "task-z" } }, "Saved task unavailable"],
  [
    "saved fixture facts that are not strings",
    { prepared: { cwd: "/world", request: "Find", publicFacts: { version: 1 } } },
    "Invalid saved fixture facts",
  ],
  [
    "a saved fixture without a request",
    { prepared: { cwd: "/world", publicFacts: {} } },
    "Invalid saved fixture facts",
  ],
] as const)("refuses to regrade %s", async (_case, options, message) => {
  await savedCampaign({ fixture: join(directory, "fixture"), ...options });

  await expect(runCli(["regrade", directory, "--suite", suite])).rejects.toThrow(message);
  expect(await readdir(directory)).not.toContain("regraded.json");
});

it("removes the regrade container even when the saved facts are invalid", async () => {
  await savedCampaign({
    fixture: join(directory, "fixture"),
    prepared: { cwd: 1, request: "Find", publicFacts: {} },
  });

  await expect(runCli(["regrade", directory, "--suite", suite])).rejects.toThrow("Invalid saved");
  expect(mocks.docker.mock.calls.at(-1)?.[0]).toEqual(["rm", "--force", "ok"]);
});

it("refuses to regrade a fixture outside the campaign directory", async () => {
  const outside = await mkdtemp(join(tmpdir(), "tack-eval-cli-outside-"));
  await savedCampaign({ fixture: outside });

  await expect(runCli(["regrade", directory, "--suite", suite])).rejects.toThrow(
    "Saved fixture escapes the campaign",
  );
});

it("refuses to regrade a fixture whose world links outside it", async () => {
  const outside = await mkdtemp(join(tmpdir(), "tack-eval-cli-world-"));
  const fixture = join(directory, "fixture");
  await mkdir(fixture);
  await symlink(outside, join(fixture, "world"));
  await savedCampaign({ fixture });

  await expect(runCli(["regrade", directory, "--suite", suite])).rejects.toThrow(
    "Saved world escapes the fixture",
  );
  expect(mocks.docker).not.toHaveBeenCalled();
});

it("refuses doctor for a suite without tasks", async () => {
  const empty = join(directory, "empty-suite.ts");
  await writeFile(empty, "export const suite={contractVersion:1,families:[],tasks:[]};");

  await expect(runCli(["doctor", "--suite", empty])).rejects.toThrow("No tasks");
});

it("lists the checkout's own suite, its families and the harness prompts when no suite is named", async () => {
  await runCli(["list"]);

  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({
    prompts: ["task", "getting-started"],
    families: [{ id: "example" }],
    tasks: [
      {
        taskId: "report-version",
        family: "example",
        tags: ["example", "smoke"],
        prompt: "task",
        followUps: 0,
      },
    ],
  });
});

it("prints a readable dry run of every trial, its limits and the estimate", async () => {
  await runCli(["plan", campaign, "--suite", suite]);

  const printed = String(output.mock.calls.at(-1)?.[0]);
  expect(printed).toContain("Campaign plan: 1 trials (smoke 1). Nothing has run.");
  expect(printed).toContain("| task-a | codex | test | low | baseline | 1 | harness:task ");
  expect(printed).toContain("| none | 1 | 120 | 12 | none | none |");
  expect(printed).toContain(
    "Estimate: 1 user turns, 30k–150k input tokens (uncalibrated: 30k–150k per user turn). Per-trial budgets sum to none; the campaign budget is none.",
  );
  expect(printed).toMatch(/Confirmation token: [a-f0-9]{16}/);
});

it("plans only the stages, tags and tasks an operator names, and binds them to the token", async () => {
  await writeFile(
    campaign,
    JSON.stringify({
      seed: 1,
      profiles: [{ driver: "claude", model: "test", effort: "low" }],
      limits: { budgetUsd: 2 },
      families: { quick: { budgetUsd: 0.5 } },
      arms: [
        { id: "baseline" },
        { id: "short", skills: { "use-tack/SKILL.md": { file: "skill.md" } } },
      ],
      stages: [{ id: "smoke", tags: ["smoke"], arms: ["baseline"] }, { id: "full" }],
    }),
  );
  await writeFile(join(directory, "skill.md"), "Replaced");
  const trials = async (...filters: string[]) => {
    output.mockClear();
    await runCli(["plan", campaign, "--json", "--suite", suite, ...filters]);
    const plan = record(JSON.parse(String(output.mock.calls.at(-1)?.[0])));
    return {
      token: plan["confirmation"],
      ids: (Array.isArray(plan["trials"]) ? plan["trials"] : []).map(
        (trial) => record(trial)["id"],
      ),
    };
  };

  const all = await trials();
  const smoke = await trials("--stage", "smoke");
  const full = await trials("--stage", "full", "--task", "task-b", "--tag", "full,smoke");

  expect(all.ids).toHaveLength(5);
  expect(smoke.ids).toEqual([expect.stringMatching(/^smoke-task-a-claude-.*-baseline$/)]);
  expect(full.ids).toEqual([
    expect.stringMatching(/^full-task-b-.*-baseline$/),
    expect.stringMatching(/^full-task-b-.*-short$/),
  ]);
  expect(new Set([all.token, smoke.token, full.token]).size).toBe(3);
  output.mockClear();
  await runCli(["plan", campaign, "--suite", suite, "--stage", "full", "--task", "task-a"]);
  expect(String(output.mock.calls.at(-1)?.[0])).toContain(
    "Per-trial budgets sum to $1.00; the campaign budget is $2.00.",
  );
});

it.each([
  ["a relative path", "relative-results"],
  ["a path inside the checkout", resolve(fileURLToPath(new URL("../..", import.meta.url)), "x")],
])("refuses %s as the results directory", async (_case, destination) => {
  const { confirmation } = await planToken();

  await expect(
    runCli(["run", campaign, "--suite", suite, "--confirm", confirmation, "--output", destination]),
  ).rejects.toThrow("Choose an absolute results directory outside the checkout");
});

it("asks for the confirmation token on a terminal and runs into a fresh temporary directory", async () => {
  const { confirmation } = await planToken();
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const previousTmpdir = process.env["TMPDIR"];
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  process.env["TMPDIR"] = directory;
  mocks.question.mockResolvedValue(confirmation);
  try {
    await runCli(["run", campaign, "--suite", suite]);
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", descriptor);
    if (previousTmpdir === undefined) Reflect.deleteProperty(process.env, "TMPDIR");
    else process.env["TMPDIR"] = previousTmpdir;
  }

  expect(mocks.question).toHaveBeenCalledWith(`Type ${confirmation} to launch this campaign: `);
  expect(mocks.closePrompt).toHaveBeenCalledOnce();
  const evidence = output.mock.calls
    .map((call: readonly unknown[]) => String(call[0]))
    .find((line: string) => line.startsWith("Evidence: "));
  const results = String(evidence).slice("Evidence: ".length);
  expect(results.startsWith(join(directory, "tack-evals-campaign-"))).toBe(true);
  expect(JSON.parse(await readFile(join(results, "results.json"), "utf8"))[0].pass).toBe(true);
});

it("closes the terminal prompt when reading the confirmation fails", async () => {
  await planToken();
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  mocks.question.mockRejectedValue(new Error("prompt aborted"));
  try {
    await expect(runCli(["run", campaign, "--suite", suite])).rejects.toThrow("prompt aborted");
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", descriptor);
  }

  expect(mocks.closePrompt).toHaveBeenCalledOnce();
  expect(mocks.checkAuth).not.toHaveBeenCalled();
});

it("aborts the running campaign on an interrupt signal and then stops listening", async () => {
  const { confirmation } = await planToken();
  const before = process.listeners("SIGINT");
  const beforeTerm = process.listeners("SIGTERM");
  let abortedDuringLaunch = false;
  mocks.backend.mockReturnValue({
    fixture: async () => ({
      context: { seed: 1, world: directory, exec: async () => success },
      close: async () => {},
    }),
    launch: async (
      _trial: unknown,
      _task: unknown,
      _fixture: unknown,
      _prepared: unknown,
      signal: AbortSignal,
    ) => {
      const added = process.listeners("SIGINT").filter((listener) => !before.includes(listener));
      for (const listener of added) listener("SIGINT");
      abortedDuringLaunch = signal.aborted;
      return { outcome: "cancelled", finalAnswer: "", commands: [], costUsd: null, metadata: {} };
    },
    record: async () => {},
  });

  await runCli([
    "run",
    campaign,
    "--suite",
    suite,
    "--confirm",
    confirmation,
    "--output",
    join(directory, "results"),
  ]);

  expect(abortedDuringLaunch).toBe(true);
  expect(process.listeners("SIGINT")).toEqual(before);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
});
