import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TrialResult } from "./campaign.ts";
import type { EvalTask } from "./contract.ts";
import type { ProcessOptions } from "./process.ts";
import { digest, type PlannedTrial } from "./plan.ts";
import { plannedTrialFixture } from "./plan.test-support.ts";

const mock = vi.hoisted(() => ({ calls: [] as string[][], run: vi.fn() }));
vi.mock("./process.ts", async (original) => {
  const actual = await original<typeof import("./process.ts")>();
  return {
    ...actual,
    docker: async (args: string[], options: unknown) => {
      mock.calls.push(args);
      return await mock.run(args, options);
    },
  };
});
import { checkAuth, dockerBackend, inspectImage, verifyAgentIsolation } from "./docker-backend.ts";
afterEach(() => {
  mock.calls.length = 0;
  mock.run.mockReset();
});
const success = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, stopped: null });
const task: EvalTask = {
  taskId: "task-a",
  version: 1,
  title: "test",
  difficulty: "easy",
  tags: [],
  family: "quick",
  criteria: [{ id: "answer", weight: 1, requiredForPass: true }],
  prepare: async () => ({ cwd: "/world/demo", request: "find", publicFacts: {} }),
  oracle: async () => ({ commands: [], finalAnswer: "yes" }),
  grade: async () => ({ criteria: [], violatedInvariants: [] }),
};
const image = { id: "image", tackVersion: {}, agentVersions: { claude: "v1", codex: "v1" } };
const skillText = (name: string) =>
  `---\nname: ${name}\ndescription: Shipped ${name} skill.\n---\n\n# ${name}\n`;
/** Writes the image's built-ins, as `docker cp` copies them out of the never-started container. */
const writeShippedBuiltins = async (target: string) => {
  await writeFile(join(target, "tack.yaml"), "version: 1\nname: tack\n");
  for (const name of ["use-tack", "manage-tack-sources"]) {
    await mkdir(join(target, "skills", name), { recursive: true });
    await writeFile(join(target, "skills", name, "SKILL.md"), skillText(name));
  }
};
const trialFor = (driver: "claude" | "codex", change: Partial<PlannedTrial> = {}) =>
  plannedTrialFixture({
    id: `trial-${driver}`,
    profile: { driver, model: "test", effort: "low" },
    ...change,
  });
const codexCompleted =
  '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n';
const claudeResult = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "answer",
    num_turns: 2,
    usage: {
      input_tokens: 1,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 1,
      output_tokens: 1,
    },
    total_cost_usd: 0.01,
    ...fields,
  });
type Reply =
  | ReturnType<typeof success>
  | { stdout: string; stderr: string; exitCode: number; stopped: string | null };

/** Fakes the Docker CLI for fixtures and agent launches, answering the attached agent run. */
const fakeDocker = (
  attached: (args: string[], options: Partial<ProcessOptions>) => Promise<Reply> | Reply,
  overrides: (args: string[]) => Promise<Reply | undefined> | Reply | undefined = () => undefined,
) => {
  mock.run.mockImplementation(async (args: string[], options: Partial<ProcessOptions>) => {
    const override = await overrides(args);
    if (override !== undefined) return override;
    if (args[0] === "run") return success("task-id");
    if (args[0] === "create")
      return success(args.includes("--interactive") ? "agent-id" : "builtins-id");
    if (args[0] === "cp" && args[2] !== undefined) await writeShippedBuiltins(args[2]);
    if (args[0] === "start" && args.includes("--attach")) return await attached(args, options);
    return success();
  });
};
const launchOnce = async (
  trial: PlannedTrial,
  options: { readonly codexSandbox?: "native" | "off-in-container" } = {},
  launched: EvalTask = task,
) => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-backend-launch-"));
  const backend = dockerBackend({ image, directory, suiteDigest: "suite", ...options });
  const fixture = await backend.fixture(trial, launched, "agent");
  try {
    return await backend.launch(
      trial,
      launched,
      fixture,
      await launched.prepare(fixture.context),
      new AbortController().signal,
    );
  } finally {
    await fixture.close();
  }
};
const agentInput = async (execution: { metadata: Readonly<Record<string, unknown>> }) =>
  JSON.parse(
    await readFile(
      join(String(execution.metadata["fixtureDirectory"]), "agent-input.json"),
      "utf8",
    ),
  );

it("resolves an immutable image using credential-free offline version probes", async () => {
  mock.run.mockImplementation(async (args: string[]) =>
    success(
      args[0] === "image"
        ? `sha256:${"a".repeat(64)}`
        : args.includes("tack")
          ? '{"version":1}'
          : "native version",
    ),
  );
  const resolved = await inspectImage("tag");
  expect(resolved.id).toBe(`sha256:${"a".repeat(64)}`);
  expect(
    mock.calls.slice(1).every((args) => args.includes("none") && args.includes("--read-only")),
  ).toBe(true);
});
it("refuses API-key auth and accepts only subscription modes without exposing status", async () => {
  mock.run.mockResolvedValue(success('{"authMethod":"api_key"}'));
  await expect(checkAuth("image", "claude")).rejects.toThrow("subscription");
  mock.run.mockResolvedValue(success('{"authMethod":"claude.ai"}'));
  await checkAuth("image", "claude");
  mock.run.mockResolvedValue(success("Logged in using ChatGPT"));
  await checkAuth("image", "codex");
  mock.run.mockResolvedValue(success("API key"));
  await expect(checkAuth("image", "codex")).rejects.toThrow("subscription");
});
it("saves native evidence, reaps background jobs before grading and removes only owned containers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-backend-test-"));
  fakeDocker(() => success(codexCompleted));
  const backend = dockerBackend({ image, directory, suiteDigest: "suite" });
  const fixture = await backend.fixture(trialFor("codex"), task, "agent");
  expect(
    mock.calls.find((args) => args[0] === "exec")?.filter((arg) => arg.startsWith("GIT_CONFIG")),
  ).toEqual([
    "GIT_CONFIG_COUNT=2",
    "GIT_CONFIG_KEY_0=core.hooksPath",
    "GIT_CONFIG_VALUE_0=/dev/null",
    "GIT_CONFIG_KEY_1=credential.helper",
    "GIT_CONFIG_VALUE_1=",
  ]);
  const execution = await backend.launch(
    trialFor("codex"),
    task,
    fixture,
    await task.prepare(fixture.context),
    new AbortController().signal,
  );
  expect(execution).toMatchObject({
    outcome: "completed",
    finalAnswer: "answer",
    costUsd: null,
    metadata: {
      budgetDenials: { toolCalls: 0, outputBytes: 0, busy: 0 },
      nativeOutputLimit: false,
    },
  });
  const agent = mock.calls.find((args) => args[0] === "create" && args.includes("--interactive"));
  expect(agent).not.toContain("--security-opt=seccomp=unconfined");
  await expect(stat(join(fixture.context.world, "builtins"))).rejects.toThrow();
  expect(execution.metadata["instructionFiles"]).toContainEqual({
    path: "skills/use-tack/SKILL.md",
    sha256: createHash("sha256").update(skillText("use-tack")).digest("hex"),
  });
  expect(
    await readFile(join(String(execution.metadata["fixtureDirectory"]), "stdout.jsonl"), "utf8"),
  ).toContain("turn.completed");
  expect(mock.calls).toContainEqual(["stop", "--time", "0", "task-id"]);
  expect(mock.calls).toContainEqual(["rm", "--force", "agent-id"]);
  await fixture.close();
  expect(mock.calls.at(-1)).toEqual(["rm", "--force", "task-id"]);
});
it("copies the image's built-ins once, applies each trial's skill overrides and mounts them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-backend-builtins-"));
  fakeDocker(() => success(codexCompleted));
  const backend = dockerBackend({ image, directory, suiteDigest: "suite" });
  const overridden = trialFor("claude", {
    skills: [
      { path: "use-tack/SKILL.md", source: "inline", text: skillText("use-tack-v2"), sha256: "" },
      { path: "use-tack/references/new.md", source: "inline", text: "added", sha256: "" },
    ],
  });

  const first = await backend.fixture(trialFor("claude"), task, "oracle");
  const second = await backend.fixture(overridden, task, "agent");

  expect(mock.calls.filter((args) => args[0] === "cp")).toEqual([
    ["cp", "builtins-id:/opt/tack/builtins/.", join(directory, "shipped-builtins")],
  ]);
  expect(mock.calls).toContainEqual(["rm", "--force", "builtins-id"]);
  const builtinsOf = (world: string) => join(world, "..", "builtins");
  expect(
    await readFile(join(builtinsOf(first.context.world), "skills/use-tack/SKILL.md"), "utf8"),
  ).toBe(skillText("use-tack"));
  expect(
    await readFile(join(builtinsOf(second.context.world), "skills/use-tack/SKILL.md"), "utf8"),
  ).toBe(skillText("use-tack-v2"));
  expect(
    await readFile(
      join(builtinsOf(second.context.world), "skills/use-tack/references/new.md"),
      "utf8",
    ),
  ).toBe("added");
  const mounts = mock.calls
    .filter((args) => args[0] === "run")
    .at(-1)
    ?.join(" ");
  expect(mounts).toContain(`source=${builtinsOf(second.context.world).replace("/world/..", "")}`);
  expect(mounts).toContain("target=/opt/tack/builtins,readonly");
});
it("starts Claude from the rendered prompt and sends each follow-up after a finished turn", async () => {
  const conversation = { ...task, followUps: ["Yes, go ahead."] };
  const writes: (string | null | undefined)[] = [];
  fakeDocker((_args, options) => {
    writes.push(
      options.stdin,
      options.respond?.(claudeResult()),
      options.respond?.(claudeResult()),
    );
    return success(`${claudeResult()}\n${claudeResult({ result: "done" })}\n`);
  });
  const trial = trialFor("claude", {
    prompt: { source: "inline", text: "Please: {{request}} in {{cwd}}", sha256: "template" },
    limits: { wallSeconds: 60, toolCalls: 3, outputBytes: 4096, maxTurns: 7, budgetUsd: 0.2 },
    followUps: 1,
  });

  const execution = await launchOnce(trial, {}, conversation);

  expect(writes[0]).toContain('"content":"Please: find in /world/demo"');
  expect(writes[1]).toContain('"content":"Yes, go ahead."');
  expect(writes[2]).toBe(null);
  expect(execution).toMatchObject({ outcome: "completed", finalAnswer: "done", costUsd: 0.02 });
  expect(execution.metadata).toMatchObject({
    userTurns: 2,
    nativeTurns: 4,
    agentInput: {
      prompt: {
        source: "inline",
        templateSha256: "template",
        sha256: digest("Please: find in /world/demo"),
      },
      followUps: [digest("Yes, go ahead.")],
    },
  });
  const input = await agentInput(execution);
  expect(input.messages).toEqual(["Please: find in /world/demo", "Yes, go ahead."]);
  expect(input.system).toContain("Working directory: /world/demo.");
  expect(input.system).toContain(
    "- use-tack: Shipped use-tack skill. Read /instructions/skills/use-tack/SKILL.md",
  );
  expect(execution.metadata["agentInput"]).toMatchObject({ systemSha256: digest(input.system) });
  const launch = mock.calls.find((args) => args.includes("--interactive") && args[0] === "create");
  expect(launch?.join(" ")).toContain("--max-turns 7 --max-budget-usd 0.2");
});
it("records a Claude run its turn limit stopped as limit-reached", async () => {
  fakeDocker(() =>
    success(claudeResult({ subtype: "error_max_turns", is_error: true, total_cost_usd: 0.05 })),
  );

  const execution = await launchOnce(trialFor("claude"));

  expect(execution).toMatchObject({ outcome: "limit-reached", costUsd: 0.05 });
});
it("records each skill override's path, source and digest and the Tack processes the agent ran", async () => {
  fakeDocker(
    async () => {
      const create =
        mock.calls.find((args) => args[0] === "create" && args.includes("--interactive")) ?? [];
      const setting = (key: string) =>
        String(create.find((arg) => arg.startsWith(`${key}=`))).slice(key.length + 1);
      await fetch(setting("TACK_EVAL_BRIDGE").replace("host.docker.internal", "127.0.0.1"), {
        method: "POST",
        headers: { authorization: `Bearer ${setting("TACK_EVAL_TOKEN")}` },
        body: JSON.stringify({ argv: ["bash", "-c", "tack status; tack nope"], cwd: "/world" }),
      });
      return success(claudeResult());
    },
    (args) => {
      if (args.includes("read-trace") === false) return undefined;
      return success(
        [0, 2]
          .map((exitCode) =>
            JSON.stringify({ argv: ["tack"], cwd: "/world", exitCode, stdout: "", stderr: "" }),
          )
          .join("\n"),
      );
    },
  );
  const skill = { path: "use-tack/extra.md", source: "file:/x.md", text: "extra", sha256: "abc" };

  const execution = await launchOnce(trialFor("claude", { skills: [skill] }));

  expect(execution.metadata).toMatchObject({
    tackCommandCount: 2,
    failedTackCommands: 1,
    agentInput: {
      skillOverrides: [{ path: "use-tack/extra.md", source: "file:/x.md", sha256: "abc" }],
    },
  });
});
it("refuses a delivered skill without a name and description", async () => {
  fakeDocker(() => success(claudeResult()));
  const broken = trialFor("claude", {
    skills: [
      { path: "use-tack/SKILL.md", source: "inline", text: "# No front matter", sha256: "" },
    ],
  });

  await expect(launchOnce(broken)).rejects.toThrow("Skill use-tack has no name and description");
});
it("rejects floating image identities, missing auth and failed containment before launch", async () => {
  mock.run.mockResolvedValue(success("floating"));
  await expect(inspectImage("tag")).rejects.toThrow("immutable");
  mock.run.mockResolvedValue({ ...success(), exitCode: 1 });
  await expect(checkAuth("image", "codex")).rejects.toThrow("auth-required");
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-denied-"));
  fakeDocker(
    () => success(),
    (args) =>
      args[0] === "run"
        ? success("owned-id")
        : args[0] === "exec" && args.includes("read-trace") === false
          ? { ...success(), exitCode: 1 }
          : undefined,
  );
  const backend = dockerBackend({ image, directory, suiteDigest: "suite" });
  await expect(backend.fixture(trialFor("claude"), task, "agent")).rejects.toThrow("containment");
  expect(mock.calls.at(-1)).toEqual(["rm", "--force", "owned-id"]);
});
it("preflights the native filesystem sandbox with synthetic files and no auth volume", async () => {
  mock.run.mockResolvedValue(success("native-fs-probe-passed"));
  await verifyAgentIsolation("image", "codex", "off-in-container");
  expect(mock.calls[0]).not.toContain("--security-opt=seccomp=unconfined");
  expect(mock.calls[0]).toContain('sandbox_mode="danger-full-access"');
  expect(mock.calls[0]?.join(" ")).not.toContain("type=volume");
  expect(mock.calls[0]).toContain("CODEX_HOME=/session/codex");
  mock.run.mockResolvedValue({ ...success(), exitCode: 1, stderr: "namespace denied" });
  await expect(verifyAgentIsolation("image", "codex", "off-in-container")).rejects.toThrow(
    "namespace denied",
  );
});

it("retains traced Tack processes inside one tool call without leaking them into tool output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-traced-backend-"));
  const processEvidence = {
    argv: ["tack", "sync", "--project", "demo"],
    cwd: "/world/projects/demo",
    exitCode: 0,
    stdout: "plan",
    stderr: "",
  };
  fakeDocker(
    () => success(),
    (args) =>
      args.includes("read-trace") ? success(JSON.stringify(processEvidence) + "\n") : undefined,
  );
  const backend = dockerBackend({ image, directory, suiteDigest: "suite" });
  const fixture = await backend.fixture(trialFor("claude"), task, "agent");
  try {
    const result = await fixture.context.exec({
      argv: ["bash", "-lc", "T=$(command -v tack); $T sync --project demo | head"],
      cwd: "/world/projects/demo",
    });
    expect(result.executions).toEqual([processEvidence]);
    expect(
      await readFile(join(fixture.context.world, "../trusted-commands.jsonl"), "utf8"),
    ).toContain('"executions":[{"argv":["tack","sync"');
  } finally {
    await fixture.close();
  }
});

it("skips the native filesystem probe for a driver without one", async () => {
  await verifyAgentIsolation("image", "claude");

  expect(mock.calls).toEqual([]);
});

it("refuses a native filesystem probe that does not report containment", async () => {
  mock.run.mockResolvedValue(success("probe printed something else"));

  await expect(verifyAgentIsolation("image", "codex")).rejects.toThrow(
    "Native filesystem probe did not confirm containment",
  );
  expect(mock.calls[0]?.join(" ")).toContain("permissions.eval.filesystem");
});

it("removes the built-ins container when copying the built-ins fails, and starts no task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-backend-copy-"));
  fakeDocker(
    () => success(),
    (args) =>
      args[0] === "cp" ? { ...success(), exitCode: 1, stderr: "no such path" } : undefined,
  );
  const backend = dockerBackend({ image, directory, suiteDigest: "suite" });

  await expect(backend.fixture(trialFor("claude"), task, "oracle")).rejects.toThrow("no such path");
  expect(mock.calls.at(-1)).toEqual(["rm", "--force", "builtins-id"]);
  expect(mock.calls.some((args) => args[0] === "run")).toBe(false);
});

it("refuses to launch into a fixture another backend created", async () => {
  fakeDocker(() => success(codexCompleted));
  const owner = dockerBackend({
    image,
    directory: await mkdtemp(join(tmpdir(), "tack-eval-backend-owner-")),
    suiteDigest: "suite",
  });
  const stranger = dockerBackend({
    image,
    directory: await mkdtemp(join(tmpdir(), "tack-eval-backend-stranger-")),
    suiteDigest: "suite",
  });
  const fixture = await owner.fixture(trialFor("codex"), task, "agent");

  await expect(
    stranger.launch(
      trialFor("codex"),
      task,
      fixture,
      await task.prepare(fixture.context),
      new AbortController().signal,
    ),
  ).rejects.toThrow("Unknown owned fixture");
  await fixture.close();
});

it.each([
  ["timed-out", { stopped: "timed-out" }, "timed-out"],
  ["cancelled", { stopped: "cancelled" }, "cancelled"],
  ["output-limit", { stopped: "output-limit" }, "protocol-error"],
  ["a quota message", { exitCode: 1, stderr: "usage limit reached" }, "quota-limited"],
  ["a failed exit", { exitCode: 2, stderr: "crashed" }, "protocol-error"],
] as const)("classifies an agent run that ended with %s", async (_case, ending, outcome) => {
  fakeDocker(() => ({ ...success(codexCompleted), ...ending }));

  const execution = await launchOnce(trialFor("codex"));

  expect(execution.outcome).toBe(outcome);
  expect(execution.metadata["nativeOutputLimit"]).toBe(_case === "output-limit");
});

it("records the enforcement each driver and sandbox mode actually ran with", async () => {
  fakeDocker(() => success(codexCompleted));

  const claude = await launchOnce(trialFor("claude"));
  const container = await launchOnce(trialFor("codex"), { codexSandbox: "off-in-container" });

  expect(claude.metadata["enforcement"]).toMatchObject({
    codexSandbox: "not applicable",
    controlFilesystem: "native policy or disabled file tools",
  });
  expect(container.metadata["enforcement"]).toMatchObject({
    codexSandbox: "off-in-container",
    controlFilesystem: "Docker-only; eval auth volume present",
  });
});

it("logs each bridged task command beside the fixture as it happens", async () => {
  fakeDocker(async () => {
    const create =
      mock.calls.find((args) => args[0] === "create" && args.includes("--interactive")) ?? [];
    const setting = (key: string) =>
      String(create.find((arg) => arg.startsWith(`${key}=`))).slice(key.length + 1);
    const response = await fetch(
      setting("TACK_EVAL_BRIDGE").replace("host.docker.internal", "127.0.0.1"),
      {
        method: "POST",
        headers: { authorization: `Bearer ${setting("TACK_EVAL_TOKEN")}` },
        body: JSON.stringify({ argv: ["tack", "status"], cwd: "/world" }),
      },
    );
    expect(response.status).toBe(200);
    return success(codexCompleted);
  });

  const execution = await launchOnce(trialFor("codex"));

  expect(execution.commands.map((command) => command.argv)).toEqual([["tack", "status"]]);
  const logged = await readFile(
    join(String(execution.metadata["fixtureDirectory"]), "commands.jsonl"),
    "utf8",
  );
  expect(JSON.parse(logged.trim())).toMatchObject({ argv: ["tack", "status"], cwd: "/world" });
});

it("removes no agent container when creating it fails", async () => {
  fakeDocker(
    () => success(codexCompleted),
    (args) =>
      args[0] === "create" && args.includes("--interactive")
        ? { ...success(), exitCode: 1, stderr: "no image" }
        : undefined,
  );

  await expect(launchOnce(trialFor("codex"))).rejects.toThrow("no image");
  expect(mock.calls.some((args) => args[0] === "rm" && args.includes("agent-id"))).toBe(false);
});

it("refuses instruction context that is not made of regular files", async () => {
  fakeDocker(
    () => success(codexCompleted),
    async (args) => {
      if (args[0] !== "cp" || args[2] === undefined) return undefined;
      await writeShippedBuiltins(args[2]);
      await symlink("/etc/hosts", join(args[2], "skills", "use-tack", "linked.md"));
      return success();
    },
  );

  await expect(launchOnce(trialFor("codex"))).rejects.toThrow(
    "Instruction context must contain regular files only",
  );
});

it("saves each trial result under its id in the campaign directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-backend-record-"));
  const backend = dockerBackend({ image, directory, suiteDigest: "suite" });
  const result = {
    ...trialFor("codex"),
    outcome: "unstarted",
    score: null,
    pass: false,
    excluded: true,
    grade: null,
    execution: null,
    error: null,
  } satisfies TrialResult;

  await backend.record(result);

  expect(JSON.parse(await readFile(join(directory, "trial-codex.json"), "utf8"))).toEqual(result);
});
