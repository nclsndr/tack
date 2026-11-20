import { encodeStateFixture } from "./support/state-fixture.ts";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runTack } from "./support/tack-process.ts";

it("exits with one actionable reader failure when the requested port is occupied", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-startup-")));
  const listener = createServer();
  try {
    await writeFile(
      join(root, "state.json"),
      encodeStateFixture({
        version: 1,
        data: {
          projects: [{ name: "demo", gitCommonDirectory: join(root, "git"), roots: [root] }],
        },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
    const {
      exitCode: code,
      stdout,
      stderr,
    } = await runTack(
      [
        "--json",
        "--state-dir",
        root,
        "docs",
        "serve",
        "--project",
        "demo",
        "--no-open",
        "--port",
        String(address.port),
      ],
      { cwd: root, home: root },
    );
    expect(code).toBe(1);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      command: "docs serve",
      status: "failure",
      classification: "domain",
      diagnostics: [
        {
          code: "reader-port-in-use",
          severity: "error",
          message: expect.stringContaining(`Reader port ${address.port} is already in use.`),
        },
      ],
    });
    expect(stdout).toContain("--port");
    expect(stderr).not.toMatch(/\[rsbuild:server\]|at getPort|error:|Error:/);
    expect(listener.listening).toBe(true);
  } finally {
    if (listener.listening === true) {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
    await rm(root, { recursive: true, force: true });
  }
});
