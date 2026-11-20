import { appendFile, cp, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { environmentPrompt } from "@tackup/harness/prompts/evals";
import type { CampaignBackend, Fixture, TrialResult } from "./campaign.ts";
import type { CommandRequest, TaskContext } from "./contract.ts";
import { commandEvidence } from "./command-evidence.ts";
import { commandRequest, startBridge } from "./bridge.ts";
import { drivers, type AgentDriver, type CodexSandboxMode } from "./drivers.ts";
import { docker, successful, taskContainerArgs, agentContainerArgs } from "./process.ts";
import { saveTrial } from "./store.ts";
import {
  digest,
  driverIds,
  record,
  renderPrompt,
  type DriverId,
  type PlannedTrial,
} from "./plan.ts";

export type ImageIdentity = {
  id: string;
  tackVersion: unknown;
  agentVersions: Readonly<Record<string, string>>;
};
/** Resolve an immutable local image and probe only versions, without credentials or model calls. */
export async function inspectImage(image: string): Promise<ImageIdentity> {
  const id = successful(await docker(["image", "inspect", "--format", "{{.Id}}", image]));
  if (/^sha256:[a-f0-9]{64}$/.test(id) === false)
    throw new Error("Expected immutable Docker image identity");
  const probe = async (argv: string[]) =>
    successful(
      await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop=ALL",
        "--tmpfs",
        "/tmp",
        id,
        ...argv,
      ]),
    );
  return {
    id,
    tackVersion: JSON.parse(await probe(["tack", "--json", "--version"])),
    agentVersions: Object.fromEntries(
      await Promise.all(
        driverIds.map(async (driverId) => [
          driverId,
          await probe([drivers[driverId].executable, "--version"]),
        ]),
      ),
    ),
  };
}
/** Probe only the dedicated persisted eval volume; never read or copy host credentials. */
export async function checkAuth(image: string, driver: DriverId): Promise<void> {
  const native = drivers[driver];
  const args = agentContainerArgs(`tack-evals-auth-probe-${randomUUID()}`, image, driver, {
    XDG_CONFIG_HOME: "/session/.config",
    XDG_CACHE_HOME: "/tmp/cache",
  });
  args.splice(1, 0, "--rm");
  const result = await docker([...args, native.executable, ...native.authStatus]);
  if (result.exitCode !== 0)
    throw new Error(`auth-required: run bun run evals auth ${driver} --image ${image}`);
  if (native.authenticated(result.stdout, result.stderr) === false)
    throw new Error(`auth-required: ${driver} must use subscription authentication`);
}
/** Prove the provider's native filesystem sandbox with synthetic files, without auth or inference. */
export async function verifyAgentIsolation(
  image: string,
  driver: DriverId,
  sandbox: CodexSandboxMode = "native",
): Promise<void> {
  const native = drivers[driver];
  const probe = sandbox === "off-in-container" ? native.isolation.offProbe : native.isolation.probe;
  if (probe === null) return;
  const args = agentContainerArgs(
    `tack-evals-native-probe-${randomUUID()}`,
    image,
    driver,
    {
      CODEX_HOME: "/session/codex",
      XDG_CONFIG_HOME: "/session/.config",
      XDG_CACHE_HOME: "/tmp/cache",
    },
    { auth: false },
  );
  args.splice(1, 0, "--rm", "--network", "none", "--tmpfs", "/auth:uid=1000,gid=1000");
  const result = await docker([
    ...args,
    "bash",
    "-c",
    'set -eu; mkdir -p /session/codex; printf canary > /auth/canary; printf allowed > /session/allowed; ln -s /auth/canary /session/escape; exec "$@"',
    "native-probe",
    ...probe,
  ]);
  const output = successful(result);
  if (output !== "native-fs-probe-passed")
    throw new Error("Native filesystem probe did not confirm containment");
}
/** Verify Docker-enforced containment using synthetic files only, without inference. */
async function verifyTaskIsolation(context: TaskContext): Promise<void> {
  const result = await context.exec({
    cwd: "/world",
    argv: [
      "bash",
      "-c",
      'set -eu; test ! -S /var/run/docker.sock; test ! -f /auth/codex/auth.json; test ! -f /auth/claude/.credentials.json; test ! -e /build/apps/cli/src; touch /world/.write-canary; if touch /opt/.denied 2>/dev/null; then exit 41; fi; node -e \'const n=require("node:net");const s=n.connect({host:"1.1.1.1",port:443});s.on("connect",()=>process.exit(42));s.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),500)\'',
    ],
  });
  if (result.exitCode !== 0) throw new Error(`Task containment check failed: ${result.stderr}`);
}
/** Own fresh containers and their evidence; no task or agent receives a host Docker socket. */
export function dockerBackend(options: {
  image: ImageIdentity;
  directory: string;
  suiteDigest: string;
  codexSandbox?: CodexSandboxMode;
}): CampaignBackend {
  const contexts = new WeakMap<TaskContext, { id: string; directory: string; builtins: string }>();
  let shipped: Promise<string> | undefined;
  // The image's built-ins, copied once per campaign from a container that never starts.
  const shippedBuiltins = () => {
    shipped ??= (async () => {
      const target = join(options.directory, "shipped-builtins");
      await mkdir(target, { recursive: true });
      const id = successful(
        await docker(["create", "--name", `tack-evals-builtins-${randomUUID()}`, options.image.id]),
      );
      try {
        successful(await docker(["cp", `${id}:/opt/tack/builtins/.`, target]));
      } finally {
        successful(await docker(["rm", "--force", id]));
      }
      return target;
    })();
    return shipped;
  };
  const fixture = async (
    trial: PlannedTrial,
    _task: unknown,
    purpose: "oracle" | "agent",
  ): Promise<Fixture> => {
    const directory = join(options.directory, `${purpose}-${trial.seed}-${randomUUID()}`);
    const world = join(directory, "world");
    const builtins = join(directory, "builtins");
    await cp(await shippedBuiltins(), builtins, { recursive: true });
    // The arm's overrides replace or add files under the built-ins' skills folder.
    for (const skill of trial.skills) {
      const path = join(builtins, "skills", skill.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, skill.text);
    }
    await mkdir(join(world, "home"), { recursive: true });
    await mkdir(join(world, "state"));
    const name = `tack-evals-task-${randomUUID()}`;
    const id = successful(await docker(taskContainerArgs(name, options.image.id, world, builtins)));
    const context: TaskContext = {
      world,
      seed: trial.seed,
      exec: async (request: CommandRequest) => {
        const command = commandRequest(request);
        const trace = `/tmp/tack-eval-${randomUUID()}.jsonl`;
        const result = await docker([
          "exec",
          "--env",
          `TACK_EVAL_TRACE=${trace}`,
          "--env",
          "GIT_CONFIG_COUNT=2",
          "--env",
          "GIT_CONFIG_KEY_0=core.hooksPath",
          "--env",
          "GIT_CONFIG_VALUE_0=/dev/null",
          "--env",
          "GIT_CONFIG_KEY_1=credential.helper",
          "--env",
          "GIT_CONFIG_VALUE_1=",
          "--workdir",
          command.cwd,
          id,
          "timeout",
          "--signal=KILL",
          "30",
          ...command.argv,
        ]);
        const observed = successful(
          await docker([
            "exec",
            id,
            "sh",
            "-c",
            'if [ -f "$1" ]; then cat "$1"; fi',
            "read-trace",
            trace,
          ]),
        );
        const executions =
          observed.trim() === ""
            ? []
            : observed
                .trim()
                .split("\n")
                .map((line) => commandEvidence(JSON.parse(line)));
        const evidence = {
          ...command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          executions,
        };
        await appendFile(
          join(directory, "trusted-commands.jsonl"),
          JSON.stringify(evidence) + "\n",
        );
        return evidence;
      },
    };
    contexts.set(context, { id, directory, builtins });
    const close = async () => {
      successful(await docker(["rm", "--force", id]));
    };
    try {
      await verifyTaskIsolation(context);
    } catch (error) {
      await close();
      throw error;
    }
    return { context, close };
  };
  return {
    fixture,
    launch: async (trial, task, current, prepared, signal) => {
      const control = contexts.get(current.context);
      if (control === undefined) throw new Error("Unknown owned fixture");
      const instructionFiles = await hashInstructions(control.builtins);
      const system = environmentPrompt({
        cwd: prepared.cwd,
        skills: await installedSkills(join(control.builtins, "skills")),
      });
      const messages = [
        renderPrompt(trial.prompt.text, { request: prepared.request, cwd: prepared.cwd }),
        ...(task.followUps ?? []),
      ];
      await writeFile(join(control.directory, "prepared.json"), JSON.stringify(prepared, null, 2));
      await writeFile(
        join(control.directory, "agent-input.json"),
        JSON.stringify({ system, messages }, null, 2),
      );
      const bridge = await startBridge({
        exec: current.context.exec,
        toolCalls: trial.limits.toolCalls,
        outputBytes: trial.limits.outputBytes,
        onCommand: async (command) => {
          await appendFile(
            join(control.directory, "commands.jsonl"),
            JSON.stringify(command) + "\n",
          );
        },
      });
      const native: AgentDriver = drivers[trial.profile.driver];
      const environment = {
        TACK_EVAL_BRIDGE: bridge.url.replace("127.0.0.1", "host.docker.internal"),
        TACK_EVAL_TOKEN: bridge.token,
        XDG_CONFIG_HOME: "/session/.config",
        XDG_CACHE_HOME: "/tmp/cache",
      };
      const args = agentContainerArgs(
        `tack-evals-auth-lock-${trial.profile.driver}`,
        options.image.id,
        trial.profile.driver,
        environment,
      );
      args[0] = "create";
      args.splice(1, 0, "--interactive");
      const sandbox = options.codexSandbox ?? "native";
      const invocation = native.invocation({
        profile: trial.profile,
        limits: trial.limits,
        system,
        messages,
        sandbox,
      });
      let agentId: string | undefined;
      const started = Date.now();
      try {
        agentId = successful(await docker([...args, native.executable, ...invocation.argv]));
        const raw = await docker(["start", "--attach", "--interactive", agentId], {
          stdin: invocation.stdin,
          ...(invocation.respond === undefined ? {} : { respond: invocation.respond }),
          timeoutMs: trial.limits.wallSeconds * 1000,
          outputBytes: trial.limits.outputBytes,
          signal,
        });
        await writeFile(join(control.directory, "stdout.jsonl"), raw.stdout);
        await writeFile(join(control.directory, "stderr.txt"), raw.stderr);
        // Reap all task descendants, including background jobs, before trusted grading.
        successful(await docker(["stop", "--time", "0", control.id]));
        successful(await docker(["start", control.id]));
        const normalized = native.normalize(raw.stdout, messages.length);
        const outcome =
          raw.stopped === "timed-out"
            ? "timed-out"
            : raw.stopped === "cancelled"
              ? "cancelled"
              : raw.stopped === "output-limit"
                ? "protocol-error"
                : normalized.limitReached === true
                  ? "limit-reached"
                  : normalized.completed === true &&
                      normalized.malformed === 0 &&
                      raw.exitCode === 0
                    ? "completed"
                    : /quota|rate.limit|usage.limit/i.test(raw.stdout + raw.stderr)
                      ? "quota-limited"
                      : "protocol-error";
        const tackProcesses = bridge.commands.flatMap((command) => command.executions ?? []);
        return {
          outcome,
          commands: bridge.commands,
          finalAnswer: normalized.finalAnswer,
          costUsd: normalized.usage.costUsd,
          metadata: {
            ...normalized,
            budgetDenials: bridge.denials,
            nativeOutputLimit: raw.stopped === "output-limit",
            wallMs: Date.now() - started,
            exitCode: raw.exitCode,
            fixtureDirectory: control.directory,
            image: options.image,
            suiteDigest: options.suiteDigest,
            launchArguments: invocation.argv,
            agentInput: {
              prompt: {
                source: trial.prompt.source,
                templateSha256: trial.prompt.sha256,
                sha256: digest(messages[0] ?? ""),
              },
              followUps: messages.slice(1).map((message) => digest(message)),
              systemSha256: digest(system),
              skillOverrides: trial.skills.map(({ path, source, sha256 }) => ({
                path,
                source,
                sha256,
              })),
            },
            instructionFiles,
            instructionContextDigest: digest(JSON.stringify(instructionFiles)),
            tackCommandCount: tackProcesses.length,
            failedTackCommands: tackProcesses.filter((process) => process.exitCode !== 0).length,
            enforcement: {
              taskNetwork: "none",
              taskSeccomp: "default",
              controlSeccomp: "default",
              codexSandbox: trial.profile.driver === "codex" ? sandbox : "not applicable",
              taskRoot: "read-only",
              capabilities: "dropped",
              nativeCommandTools: "disabled",
              controlFilesystem:
                trial.profile.driver === "codex" && sandbox === "off-in-container"
                  ? "Docker-only; eval auth volume present"
                  : "native policy or disabled file tools",
              taskTools: "trusted MCP bridge",
              authVolume: `tack-evals-auth-${trial.profile.driver}`,
              realHomeMounted: false,
              gradersMounted: false,
              dockerSocketMounted: false,
              hardTokenCap: false,
              toolTrace: "complete bridge calls",
              toolCalls: bridge.commands.length,
              cached: false,
            },
          },
        };
      } finally {
        try {
          await bridge.close();
        } finally {
          if (agentId !== undefined) successful(await docker(["rm", "--force", agentId]));
        }
      }
    },
    record: async (result: TrialResult) => {
      await saveTrial(options.directory, result);
    },
  };
}

/**
 * The skills a built-ins folder delivers, as the agent's skill listing shows them: each folder's
 * `SKILL.md` front matter name and description, at its path in the task container.
 */
async function installedSkills(
  directory: string,
): Promise<{ name: string; description: string; path: string }[]> {
  const folders = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return await Promise.all(
    folders.map(async (folder) => {
      const text = await readFile(join(directory, folder, "SKILL.md"), "utf8");
      const frontMatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
      const fields = frontMatter === undefined ? {} : record(Bun.YAML.parse(frontMatter));
      if (typeof fields["name"] !== "string" || typeof fields["description"] !== "string")
        throw new Error(`Skill ${folder} has no name and description`);
      return {
        name: fields["name"],
        description: fields["description"],
        path: `/instructions/skills/${folder}/SKILL.md`,
      };
    }),
  );
}

async function hashInstructions(
  directory: string,
  prefix = "",
): Promise<{ path: string; sha256: string }[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
        const location = join(directory, entry.name);
        if (entry.isDirectory()) return await hashInstructions(location, path);
        if (entry.isFile() === false)
          throw new Error("Instruction context must contain regular files only");
        return [
          {
            path,
            sha256: createHash("sha256")
              .update(await readFile(location))
              .digest("hex"),
          },
        ];
      }),
    )
  ).flat();
}
