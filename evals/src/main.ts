import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { evalPrompts } from "@tackup/harness/prompts/evals";
import type { TaskSuite } from "./contract.ts";
import {
  digest,
  driverIds,
  planCampaign,
  record,
  scoreGrade,
  type CampaignPlan,
  type PlanFilters,
} from "./plan.ts";
import { loadCampaign } from "./campaign-file.ts";
import { docker, successful, agentContainerArgs, taskContainerArgs } from "./process.ts";
import { drivers, type CodexSandboxMode } from "./drivers.ts";
import { checkAuth, dockerBackend, inspectImage, verifyAgentIsolation } from "./docker-backend.ts";
import { executeCampaign } from "./campaign.ts";
import { renderReport } from "./report.ts";
import { readCampaign } from "./store.ts";
import { commandRequest } from "./bridge.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** Execute an explicit internal eval operator command. Ordinary checks call this only with fakes. */
export async function runCli(cliArgs: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args: cliArgs,
    allowPositionals: true,
    options: {
      image: { type: "string", default: "tack-evals:p1" },
      suite: { type: "string" },
      output: { type: "string" },
      confirm: { type: "string" },
      "allow-dirty": { type: "boolean", default: false },
      "codex-sandbox": { type: "string", default: "native" },
      stage: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
      task: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
    },
  });
  // Each filter repeats, or takes a comma-separated list.
  const listed = (given: string[] | undefined) =>
    given === undefined ? undefined : given.flatMap((value) => value.split(","));
  const filters: PlanFilters = Object.fromEntries(
    Object.entries({
      stages: listed(values.stage),
      tags: listed(values.tag),
      taskIds: listed(values.task),
    }).filter(([, list]) => list !== undefined),
  );
  const [command, argument] = positionals;
  const imageTag = values.image;
  const selectedSandbox = values["codex-sandbox"];
  if (selectedSandbox !== "native" && selectedSandbox !== "off-in-container")
    throw new Error("Choose --codex-sandbox native or off-in-container");
  const codexSandbox: CodexSandboxMode = selectedSandbox;
  if (command === undefined || command === "help") {
    console.log(
      `Tack evals (internal, Docker only)\n\n  bun run evals image [--image tack-evals:p1]\n  bun run evals auth <claude|codex> [--image tack-evals:p1]\n  bun run evals doctor [campaign.json] [--image tack-evals:p1]\n  bun run evals list\n  bun run evals plan <campaign.json> [filters] [--json] [--image tack-evals:p1]\n  bun run evals run <campaign.json> [filters] [--image tack-evals:p1] [--confirm <plan token>] [--output <absolute new directory>] [--codex-sandbox native|off-in-container]\n  bun run evals report <campaign directory>\n  bun run evals regrade <campaign directory>\n\nFilters narrow a campaign: --stage <id>, --tag <tag> and --task <id>, each repeatable or comma-separated. Plan is the dry run: it prints every trial and the estimate, and runs nothing.\nNo scheduler, API keys, host credential copies or automatic retries. Auth signs in inside dedicated eval-only Docker volumes. Run always prints the complete plan and requires explicit confirmation.\n--codex-sandbox defaults to native. off-in-container is an explicit, per-invocation Docker-only mode for doctor, plan and run; it never changes normal CLI configuration.`,
    );
  } else if (command === "image") {
    const commit = successful(await dockerGit(["rev-parse", "HEAD"]));
    const dirty = successful(await dockerGit(["status", "--porcelain"]));
    if (dirty.length > 0 && values["allow-dirty"] === false)
      throw new Error(
        "Dirty checkout refused; commit first, or explicitly use --allow-dirty for development",
      );
    const build = await docker(
      [
        "build",
        "--file",
        join(root, "evals/container/Dockerfile"),
        "--build-arg",
        `TACK_COMMIT=${commit}`,
        "--label",
        `io.tack.evals.commit=${commit}`,
        "--label",
        `io.tack.evals.dirty=${dirty.length > 0}`,
        "--tag",
        imageTag,
        root,
      ],
      { timeoutMs: 600000, outputBytes: 8388608 },
    );
    console.log(build.stdout);
    console.error(build.stderr);
    successful(build);
    console.log(JSON.stringify(await inspectImage(imageTag), null, 2));
  } else if (command === "auth") {
    const driver = driverIds.find((id) => id === argument);
    if (driver === undefined) throw new Error("Choose claude or codex");
    const native = drivers[driver];
    const args = agentContainerArgs(`tack-evals-auth-lock-${driver}`, imageTag, driver, {
      XDG_CONFIG_HOME: "/session/.config",
      XDG_CACHE_HOME: "/tmp/cache",
    });
    args.splice(1, 0, "--rm", "--interactive", "--tty");
    // Credentials are created by the native CLI inside its dedicated volume. No host env is forwarded.
    const result = spawnSync("docker", [...args, native.executable, ...native.login], {
      stdio: "inherit",
    });
    if (result.status !== 0)
      throw new Error(`Sign-in exited ${result.status}; no model was launched`);
    console.log(
      `Signed in to eval-only ${driver} volume. Verify with bun run evals doctor --image ${imageTag}`,
    );
  } else if (command === "report" || command === "regrade") {
    if (argument === undefined) throw new Error("Pass the saved campaign directory");
    const directory = await realpath(argument);
    const results = await readCampaign(directory);
    if (command === "regrade") {
      const { suite, suiteDigest } = await loadSuite();
      const manifest = record(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
      if (manifest["suiteDigest"] !== suiteDigest)
        throw new Error("Suite digest changed; regrade requires the original task/grader code");
      const identity = record(manifest["image"]);
      const image = await inspectImage(String(identity["id"]));
      for (const result of results) {
        if (result.execution === null) continue;
        const task = suite.tasks.find((candidate) => candidate.taskId === result.taskId);
        if (task === undefined) throw new Error("Saved task unavailable");
        const fixtureDirectory = await realpath(
          String(result.execution.metadata["fixtureDirectory"]),
        );
        if (fixtureDirectory.startsWith(`${directory}${sep}`) === false)
          throw new Error("Saved fixture escapes the campaign");
        const world = await realpath(join(fixtureDirectory, "world"));
        if (world.startsWith(`${fixtureDirectory}${sep}`) === false)
          throw new Error("Saved world escapes the fixture");
        const id = successful(
          await docker(
            taskContainerArgs(`tack-evals-regrade-${crypto.randomUUID()}`, image.id, world),
          ),
        );
        try {
          const raw = record(
            JSON.parse(await readFile(join(fixtureDirectory, "prepared.json"), "utf8")),
          );
          const facts = record(raw["publicFacts"]);
          if (
            typeof raw["cwd"] !== "string" ||
            typeof raw["request"] !== "string" ||
            Object.values(facts).some((fact) => typeof fact !== "string")
          )
            throw new Error("Invalid saved fixture facts");
          const prepared = {
            cwd: raw["cwd"],
            request: raw["request"],
            publicFacts: Object.fromEntries(
              Object.entries(facts).map(([key, value]) => [key, String(value)]),
            ),
          };
          const grade = await task.grade({
            seed: result.seed,
            world,
            prepared,
            commands: result.execution.commands,
            finalAnswer: result.execution.finalAnswer,
            outcome: result.outcome,
            exec: async (request) => {
              const contained = commandRequest(request);
              const observed = await docker([
                "exec",
                "--workdir",
                contained.cwd,
                id,
                "timeout",
                "30",
                ...contained.argv,
              ]);
              return {
                exitCode: observed.exitCode,
                stdout: observed.stdout,
                stderr: observed.stderr,
              };
            },
          });
          Object.assign(result, { grade, ...scoreGrade(task, grade, result.outcome) });
        } finally {
          successful(await docker(["rm", "--force", id]));
        }
      }
      await writeFile(join(directory, "regraded.json"), JSON.stringify(results, null, 2));
    }
    const report = renderReport(results);
    console.log(report);
    if (command === "regrade") await writeFile(join(directory, "regraded.md"), report);
  } else {
    const { suite, suiteDigest } = await loadSuite();
    if (command === "list")
      console.log(
        JSON.stringify(
          {
            prompts: Object.keys(evalPrompts),
            families: suite.families,
            tasks: suite.tasks.map((task) => ({
              taskId: task.taskId,
              title: task.title,
              family: task.family,
              tags: task.tags,
              prompt: task.prompt ?? "task",
              followUps: task.followUps?.length ?? 0,
            })),
          },
          null,
          2,
        ),
      );
    else if (command === "doctor") {
      const task = suite.tasks[0];
      if (task === undefined) throw new Error("No tasks");
      // An explicit campaign limits checks to its drivers, so a paused driver needs no sign-in.
      const plan =
        argument === undefined
          ? planCampaign(
              { seed: 0, profiles: [{ driver: "claude", model: "doctor", effort: "low" }] },
              suite,
              { taskIds: [task.taskId] },
            )
          : planCampaign(await loadCampaign(argument), suite, filters);
      const checked =
        argument === undefined
          ? driverIds
          : new Set(plan.trials.map((trial) => trial.profile.driver));
      const image = await inspectImage(imageTag);
      const directory = await mkdtemp(join(tmpdir(), "tack-evals-doctor-"));
      const backend = dockerBackend({ image, directory, suiteDigest, codexSandbox });
      const [trial] = plan.trials;
      // Coverage skip: a plan always holds at least one trial; planCampaign refuses an empty one.
      /* v8 ignore next -- @preserve */
      if (trial === undefined) throw new Error("No trials selected");
      const trialTask = suite.tasks.find((candidate) => candidate.taskId === trial.taskId) ?? task;
      const fixture = await backend.fixture(trial, trialTask, "oracle");
      await fixture.close();
      console.log(`Container containment passed: ${image.id}`);
      for (const driver of checked) {
        try {
          await verifyAgentIsolation(image.id, driver, codexSandbox);
          await checkAuth(image.id, driver);
          console.log(`${driver}: subscription auth ready`);
        } catch (error) {
          console.log(String(error));
        }
      }
    } else if (command === "plan" || command === "run") {
      if (argument === undefined) throw new Error("Pass an explicit campaign JSON file");
      const image = await inspectImage(imageTag);
      const plan = planCampaign(await loadCampaign(argument), suite, filters);
      plan.confirmation = digest(JSON.stringify({ plan, image, suiteDigest, codexSandbox })).slice(
        0,
        16,
      );
      console.log(
        values.json === true
          ? JSON.stringify({ image, suiteDigest, codexSandbox, ...plan }, null, 2)
          : renderPlan(plan, { imageId: image.id, suiteDigest, codexSandbox }),
      );
      if (command === "run") {
        let confirmation = values.confirm;
        if (confirmation === undefined && process.stdin.isTTY === true) {
          const input = createInterface({ input: process.stdin, output: process.stdout });
          try {
            confirmation = await input.question(
              `Type ${plan.confirmation} to launch this campaign: `,
            );
          } finally {
            input.close();
          }
        }
        if (confirmation !== plan.confirmation)
          throw new Error(
            `Explicit campaign confirmation required: --confirm ${plan.confirmation}`,
          );
        for (const driver of new Set(plan.trials.map((trial) => trial.profile.driver))) {
          await verifyAgentIsolation(image.id, driver, codexSandbox);
          await checkAuth(image.id, driver);
        }
        const directory =
          values.output === undefined
            ? await mkdtemp(join(tmpdir(), "tack-evals-campaign-"))
            : values.output;
        if (
          isAbsolute(directory) === false ||
          directory === root ||
          directory.startsWith(`${root}${sep}`)
        )
          throw new Error("Choose an absolute results directory outside the checkout");
        if (values.output !== undefined) await mkdir(directory, { recursive: false, mode: 0o700 });
        await writeFile(
          join(directory, "manifest.json"),
          JSON.stringify(
            { plan, image, suiteDigest, codexSandbox, startedAt: new Date().toISOString() },
            null,
            2,
          ),
        );
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          const results = await executeCampaign({
            plan,
            suite,
            confirmation,
            backend: dockerBackend({ image, directory, suiteDigest, codexSandbox }),
            signal: controller.signal,
          });
          await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
          const report = renderReport(results);
          await writeFile(join(directory, "report.md"), report);
          console.log(report);
          console.log(`Evidence: ${directory}`);
        } finally {
          process.removeListener("SIGINT", cancel);
          process.removeListener("SIGTERM", cancel);
        }
      }
    } else throw new Error(`Unknown command: ${command}`);
  }

  async function loadSuite(): Promise<{ suite: TaskSuite; suiteDigest: string }> {
    const path =
      values.suite === undefined ? join(root, "evals/tasks/index.ts") : resolve(values.suite);
    // Task modules are reviewed local code, never downloaded data or agent-authored files.
    const module: { suite?: TaskSuite } = await import(pathToFileURL(path).href);
    if (module.suite?.contractVersion !== 1) throw new Error("Expected version-1 suite export");
    const build = await Bun.build({ entrypoints: [path], target: "bun" });
    if (build.success === false || build.outputs[0] === undefined)
      throw new Error("Cannot hash the complete trusted suite");
    return { suite: module.suite, suiteDigest: digest(await build.outputs[0].text()) };
  }
  async function dockerGit(args: string[]) {
    const { runProcess } = await import("./process.ts");
    return await runProcess(["git", "-C", root, ...args], {
      timeoutMs: 10000,
      outputBytes: 1048576,
    });
  }
}

/** The dry run an operator reads before confirming: every trial, its limits and the estimate. */
function renderPlan(
  plan: CampaignPlan,
  identity: { imageId: string; suiteDigest: string; codexSandbox: CodexSandboxMode },
): string {
  const money = (value: number | null) => (value === null ? "none" : `$${value.toFixed(2)}`);
  const stages = [...new Set(plan.trials.map((trial) => trial.stage))].map(
    (stage) => `${stage} ${plan.trials.filter((trial) => trial.stage === stage).length}`,
  );
  const thousands = (value: number) => `${Math.round(value / 1000)}k`;
  return [
    `Campaign plan: ${plan.trials.length} trials (${stages.join(", ")}). Nothing has run.`,
    "",
    "| Trial | Task | Agent | Model | Effort | Arm | Seed | Prompt | Skill overrides | User turns | Wall s | Tool calls | Max turns | Budget |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...plan.trials.map(
      (trial) =>
        `| ${[
          trial.id,
          trial.taskId,
          trial.profile.driver,
          trial.profile.model,
          trial.profile.effort,
          trial.arm,
          trial.seed,
          `${trial.prompt.source} ${trial.prompt.sha256.slice(0, 12)}`,
          trial.skills.map((skill) => `${skill.path} ${skill.sha256.slice(0, 12)}`).join(", ") ||
            "none",
          1 + trial.followUps,
          trial.limits.wallSeconds,
          trial.limits.toolCalls,
          trial.limits.maxTurns ?? "none",
          money(trial.limits.budgetUsd ?? null),
        ].join(" | ")} |`,
    ),
    "",
    `Estimate: ${plan.estimate.userTurns} user turns, ${thousands(plan.estimate.inputTokens.low)}–${thousands(plan.estimate.inputTokens.high)} input tokens (uncalibrated: 30k–150k per user turn). Per-trial budgets sum to ${money(plan.estimate.trialBudgetsUsd)}; the campaign budget is ${money(plan.limits.budgetUsd)}.`,
    `Limits: ${plan.limits.trials} trials, ${plan.limits.wallSeconds} s of campaign wall time, one trial at a time, no retries. API-equivalent USD is not subscription allowance.`,
    `Image ${identity.imageId}, suite ${identity.suiteDigest.slice(0, 12)}, Codex sandbox ${identity.codexSandbox}. Task network: none. Auth: dedicated eval volumes only.`,
    `Confirmation token: ${plan.confirmation}`,
  ].join("\n");
}

// Coverage skip: the executable boundary only delegates to the tested command dispatcher.
/* v8 ignore next */
if (import.meta.main === true) await runCli(process.argv.slice(2));
