import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runProcess,
  taskContainerArgs,
  agentContainerArgs,
  successful,
  docker,
} from "./process.ts";

describe("bounded execution", () => {
  it("retains stdout and stderr with an allowlisted environment", async () => {
    const result = await runProcess(
      [
        process.execPath,
        "-e",
        'console.log(process.env.ANTHROPIC_API_KEY ?? "clean"); console.error("diagnostic")',
      ],
      { timeoutMs: 1000, outputBytes: 1024 },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "clean\n",
      stderr: "diagnostic\n",
      stopped: null,
    });
  });
  it("terminates a hanging process and caps output", async () => {
    expect(
      (
        await runProcess([process.execPath, "-e", "setInterval(()=>{},1000)"], {
          timeoutMs: 30,
          outputBytes: 1024,
        })
      ).stopped,
    ).toBe("timed-out");
    const result = await runProcess(
      [process.execPath, "-e", 'console.log("x".repeat(20000)); setInterval(()=>{},1000)'],
      { timeoutMs: 1000, outputBytes: 100 },
    );
    expect(result.stopped).toBe("output-limit");
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      100,
    );
  });
  it("mounts only the world into the networkless task, and auth only into the agent", () => {
    const task = taskContainerArgs("trial", "image@sha256:x", "/tmp/world");
    expect(task).toContain("none");
    expect(task).toContain("--read-only");
    expect(task).toContain("--cap-drop=ALL");
    expect(task.join(" ")).not.toContain("/auth");
    const agent = agentContainerArgs("trial-agent", "image@sha256:x", "codex", {});
    expect(agent.join(" ")).toContain("tack-evals-auth-codex");
    expect(agent.join(" ")).not.toContain("/world");
    expect(agent.join(" ")).not.toContain("docker.sock");
  });
});
it("honors cancellation and reports spawn/control failures", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await runProcess([process.execPath, "-e", "setInterval(()=>{},1000)"], {
        timeoutMs: 1000,
        outputBytes: 100,
        signal: controller.signal,
      })
    ).stopped,
  ).toBe("cancelled");
  await expect(
    runProcess(["/nonexistent-tack-eval-test-executable"], { timeoutMs: 100, outputBytes: 100 }),
  ).rejects.toThrow();
  expect(() => successful({ stdout: "", stderr: "failed", exitCode: 1, stopped: null })).toThrow(
    "failed",
  );
  await expect(() => runProcess([], { timeoutMs: 100, outputBytes: 100 })).rejects.toThrow(
    "Empty argv",
  );
});
it("runs the Docker facade against a fake binary without a daemon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tack-eval-fake-docker-"));
  const path = join(directory, "docker");
  await writeFile(path, '#!/bin/sh\nprintf "fake docker\\n"\n');
  await chmod(path, 0o755);
  const previous = process.env["PATH"];
  process.env["PATH"] = directory;
  try {
    expect(successful(await docker(["version"]))).toBe("fake docker");
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
  }
});
it("keeps Docker security defaults while supporting credential-free probes", () => {
  const args = agentContainerArgs("probe", "image", "codex", {}, { auth: false });
  expect(args).not.toContain("--security-opt=seccomp=unconfined");
  expect(args).toContain("--cap-drop=ALL");
  expect(args).toContain("--security-opt=no-new-privileges");
  expect(args.join(" ")).not.toContain("type=volume");
  expect(taskContainerArgs("task", "image", "/tmp/world")).not.toContain(
    "--security-opt=seccomp=unconfined",
  );
});

describe("process group termination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const hanging = [process.execPath, "-e", "setInterval(()=>{},1000)"];
  const killFailing = (code: string) => {
    const original = process.kill.bind(process);
    return vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      original(pid, signal);
      throw Object.assign(new Error(`kill ${code}`), { code });
    });
  };

  it("keeps the first stop reason when cancellation arrives while the group is being killed", async () => {
    const controller = new AbortController();
    const original = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      controller.abort();
      return original(pid, signal);
    });

    const result = await runProcess(hanging, {
      timeoutMs: 10,
      outputBytes: 100,
      signal: controller.signal,
    });

    expect(result.stopped).toBe("timed-out");
  });

  it("treats a process group that is already gone as stopped", async () => {
    const kill = killFailing("ESRCH");

    const result = await runProcess(hanging, { timeoutMs: 10, outputBytes: 100 });

    expect(result.stopped).toBe("timed-out");
    expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGKILL");
  });

  it("rejects when the process group cannot be killed", async () => {
    killFailing("EPERM");

    await expect(runProcess(hanging, { timeoutMs: 10, outputBytes: 100 })).rejects.toThrow(
      "kill EPERM",
    );
  });

  it("reports a spawn failure even when cancellation arrived before the process existed", async () => {
    const controller = new AbortController();
    controller.abort();
    const kill = vi.spyOn(process, "kill");

    await expect(
      runProcess(["/nonexistent-tack-eval-test-executable"], {
        timeoutMs: 100,
        outputBytes: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  it("ignores a prompt the process exits without reading", async () => {
    const result = await runProcess([process.execPath, "-e", "process.exit(3)"], {
      timeoutMs: 5000,
      outputBytes: 100,
      stdin: "x".repeat(8 * 1024 * 1024),
    });

    expect(result).toMatchObject({ exitCode: 3, stopped: null });
  });
});

describe("conversational input", () => {
  // Echoes each input line back as `got:<line>`, and exits when its input closes.
  const echo = [
    process.execPath,
    "-e",
    'require("node:readline").createInterface({input:process.stdin}).on("line",(l)=>console.log("got:"+l)).on("close",()=>console.log("closed"))',
  ];

  it("answers each complete output line and closes the input when told to", async () => {
    const seen: string[] = [];
    const result = await runProcess(echo, {
      timeoutMs: 5000,
      outputBytes: 1024,
      stdin: "first\n",
      respond: (line) => {
        seen.push(line);
        return line === "got:first" ? "second\n" : line === "got:second" ? null : undefined;
      },
    });

    expect(seen).toEqual(["got:first", "got:second", "closed"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "got:first\ngot:second\nclosed\n" });
  });

  it("stops answering once the process has been stopped", async () => {
    let answered = 0;
    const result = await runProcess(
      [
        process.execPath,
        "-e",
        'console.log("x".repeat(200)); console.log("late"); setInterval(()=>{},1000)',
      ],
      {
        timeoutMs: 5000,
        outputBytes: 50,
        stdin: "",
        respond: () => {
          answered += 1;
          return "more\n";
        },
      },
    );

    expect(result.stopped).toBe("output-limit");
    expect(answered).toBe(0);
  });
});

it("mounts the trial's built-ins read-only for the agent to read and over the image's own", () => {
  const args = taskContainerArgs("task", "image", "/tmp/world", "/tmp/builtins").join(" ");

  expect(args).toContain("type=bind,source=/tmp/builtins,target=/instructions,readonly");
  expect(args).toContain("type=bind,source=/tmp/builtins,target=/opt/tack/builtins,readonly");
});
