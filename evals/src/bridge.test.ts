import { expect, it } from "vitest";
import { startBridge } from "./bridge.ts";

it("authenticates and validates bounded argv, records independent command evidence", async () => {
  const commands: string[][] = [];
  const bridge = await startBridge({
    toolCalls: 1,
    outputBytes: 1000,
    exec: async (request) => {
      commands.push([...request.argv]);
      return { exitCode: 0, stdout: "ok", stderr: "", executions: [] };
    },
  });
  const invoke = async (body: unknown, token = bridge.token) =>
    await fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  try {
    expect((await invoke({ argv: ["tack"], cwd: "/world" }, "wrong")).status).toBe(401);
    expect((await invoke({ argv: ["tack"], cwd: "/world/../auth" })).status).toBe(400);
    expect(await (await invoke({ argv: ["tack", "--help"], cwd: "/world/demo" })).json()).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect((await invoke({ argv: ["tack"], cwd: "/world" })).status).toBe(429);
    expect(commands).toEqual([["tack", "--help"]]);
    expect(bridge.commands).toEqual([
      {
        argv: ["tack", "--help"],
        cwd: "/world/demo",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        executions: [],
      },
    ]);
  } finally {
    await bridge.close();
  }
});
it("rejects unknown routes and oversized requests without executing", async () => {
  let executed = false;
  const bridge = await startBridge({
    toolCalls: 1,
    outputBytes: 100,
    exec: async () => {
      executed = true;
      throw new Error("unexpected");
    },
  });
  try {
    const headers = { authorization: `Bearer ${bridge.token}` };
    expect((await fetch(bridge.url, { headers })).status).toBe(404);
    expect(
      (await fetch(bridge.url, { method: "POST", headers, body: "x".repeat(16385) })).status,
    ).toBe(400);
    expect(executed).toBe(false);
  } finally {
    await bridge.close();
  }
});

it.each([
  { toolCalls: 1, outputBytes: 100, code: "tool-call-limit" },
  { toolCalls: 10, outputBytes: 2, code: "output-budget-limit" },
])("reports $code independently", async ({ toolCalls, outputBytes, code }) => {
  const bridge = await startBridge({
    toolCalls,
    outputBytes,
    exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
  });
  const invoke = () =>
    fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ argv: ["tack"], cwd: "/world" }),
    });
  try {
    await invoke();
    expect(await (await invoke()).json()).toMatchObject({ code });
    expect(bridge.denials).toEqual({
      toolCalls: code === "tool-call-limit" ? 1 : 0,
      outputBytes: code === "output-budget-limit" ? 1 : 0,
      busy: 0,
    });
  } finally {
    await bridge.close();
  }
});

it("reports simultaneous exhausted budgets without calling either one a busy command", async () => {
  const bridge = await startBridge({
    toolCalls: 0,
    outputBytes: 0,
    exec: async () => {
      throw new Error("must not run");
    },
  });
  try {
    const result = await fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}` },
      body: "{}",
    });
    expect(await result.json()).toMatchObject({
      reasons: ["tool-call-limit", "output-budget-limit"],
    });
    expect(bridge.denials).toEqual({ toolCalls: 1, outputBytes: 1, busy: 0 });
  } finally {
    await bridge.close();
  }
});

it("reports a busy command separately from exhausted budgets", async () => {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
  const bridge = await startBridge({
    toolCalls: 10,
    outputBytes: 1000,
    exec: () => {
      started.resolve();
      return result.promise;
    },
  });
  const invoke = () =>
    fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ argv: ["tack"], cwd: "/world" }),
    });
  const first = invoke();
  try {
    await started.promise;
    expect(await (await invoke()).json()).toMatchObject({ reasons: ["command-busy"] });
    expect(bridge.denials).toEqual({ toolCalls: 0, outputBytes: 0, busy: 1 });
  } finally {
    result.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
    await first;
    await bridge.close();
  }
});

it("reports a failure to close a bridge that is no longer listening", async () => {
  const bridge = await startBridge({
    toolCalls: 1,
    outputBytes: 100,
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", executions: [] }),
  });
  await bridge.close();

  await expect(bridge.close()).rejects.toThrow();
});
