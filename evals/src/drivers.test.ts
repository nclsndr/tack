import { describe, expect, it } from "vitest";
import { drivers, normalize } from "./drivers.ts";

const claude = { driver: "claude", model: "sonnet", effort: "low" } as const;
const codexProfile = { driver: "codex", model: "gpt-6-luna", effort: "low" } as const;
const limits = { wallSeconds: 60, toolCalls: 5, outputBytes: 1024 };
const claudeResult = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "found",
    num_turns: 3,
    usage: {
      input_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
      output_tokens: 5,
    },
    total_cost_usd: 0.02,
    ...fields,
  });
const userLine = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  }) + "\n";

describe("native driver evidence", () => {
  it("keeps cached Codex input inside total input and identifies incomplete streams", () => {
    const events = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 30000, cached_input_tokens: 23000, output_tokens: 100 },
      }),
    ].join("\n");
    expect(normalize("codex", events)).toMatchObject({
      finalAnswer: "done",
      completed: true,
      usage: { input: 30000, cachedInput: 23000, output: 100, costUsd: null, complete: true },
    });
    expect(normalize("codex", events + '\n{"type":')).toMatchObject({ malformed: 1 });
    expect(normalize("codex", "").usage.complete).toBe(false);
  });
  it("uses Claude authoritative result usage instead of summing duplicated assistant messages", () => {
    const events = [
      JSON.stringify({ type: "assistant", message: { id: "same", usage: { input_tokens: 100 } } }),
      JSON.stringify({ type: "assistant", message: { id: "same", usage: { input_tokens: 100 } } }),
      claudeResult(),
    ];
    expect(normalize("claude", events.join("\n"))).toMatchObject({
      completed: true,
      finalAnswer: "found",
      userTurns: 1,
      nativeTurns: 3,
      limitReached: false,
      usage: { input: 110, cachedInput: 80, cacheWriteInput: 10, output: 5, costUsd: 0.02 },
    });
    expect(normalize("claude", JSON.stringify({ type: "result", is_error: true })).completed).toBe(
      false,
    );
  });
  it("sums usage across the results of a multi-turn Claude conversation and keeps the last answer", () => {
    const events = [claudeResult(), claudeResult({ result: "done", total_cost_usd: 0.03 })];

    expect(normalize("claude", events.join("\n"), 2)).toMatchObject({
      completed: true,
      finalAnswer: "done",
      userTurns: 2,
      nativeTurns: 6,
      usage: { input: 220, cachedInput: 160, cacheWriteInput: 20, output: 10, costUsd: 0.05 },
    });
    expect(normalize("claude", events[0] ?? "", 2).completed).toBe(false);
  });
  it("marks a Claude conversation its turn or budget limit stopped", () => {
    const stopped = normalize(
      "claude",
      claudeResult({ subtype: "error_max_turns", is_error: true, total_cost_usd: undefined }),
    );

    expect(stopped).toMatchObject({
      completed: false,
      limitReached: true,
      usage: { costUsd: null },
    });
  });
  it("disables native tools and unrelated integrations in both driver launch plans", () => {
    const { argv } = drivers.claude.invocation({
      profile: claude,
      limits,
      system: "",
      messages: ["x"],
    });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--tools");
    expect(argv).not.toContain("--bare");
    const codex = drivers.codex.invocation({
      profile: codexProfile,
      limits,
      system: "",
      messages: ["x"],
    }).argv;
    expect(codex).toContain("--ignore-user-config");
    expect(codex).toContain("features.shell_tool=false");
    expect(codex).toContain('web_search="disabled"');
    expect(codex).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });
});

describe("Claude conversation", () => {
  it("appends the environment to the system prompt and passes the trial's turn and budget limits", () => {
    const { argv } = drivers.claude.invocation({
      profile: claude,
      limits: { ...limits, maxTurns: 30, budgetUsd: 0.75 },
      system: "Environment frame",
      messages: ["Hello"],
    });

    expect(
      argv.slice(
        argv.indexOf("--append-system-prompt"),
        argv.indexOf("--append-system-prompt") + 2,
      ),
    ).toEqual(["--append-system-prompt", "Environment frame"]);
    expect(argv.join(" ")).toContain("--max-turns 30");
    expect(argv.join(" ")).toContain("--max-budget-usd 0.75");
    expect(argv.join(" ")).toContain("--input-format stream-json");
    expect(
      drivers.claude
        .invocation({ profile: claude, limits, system: "", messages: ["x"] })
        .argv.some((arg) => arg === "--max-turns" || arg === "--max-budget-usd"),
    ).toBe(false);
  });

  it("sends each follow-up after a successful result, then closes the input", () => {
    const { stdin, respond } = drivers.claude.invocation({
      profile: claude,
      limits,
      system: "",
      messages: ["Hello", "Yes"],
    });

    expect(stdin).toBe(userLine("Hello"));
    expect(respond?.('{"type":"assistant"}')).toBe(undefined);
    expect(respond?.("not json")).toBe(undefined);
    expect(respond?.(claudeResult())).toBe(userLine("Yes"));
    expect(respond?.(claudeResult())).toBe(null);
  });

  it("closes the input instead of sending a follow-up after a failed result", () => {
    const { respond } = drivers.claude.invocation({
      profile: claude,
      limits,
      system: "",
      messages: ["Hello", "Yes"],
    });

    expect(respond?.(claudeResult({ is_error: true, subtype: "error_max_turns" }))).toBe(null);
  });
});

it("retains provider errors and observed Claude model without inventing usage", () => {
  expect(normalize("codex", '{"type":"turn.failed","error":{"message":"quota"}}')).toMatchObject({
    completed: false,
    usage: { complete: false },
  });
  expect(
    normalize("claude", '{"type":"system","model":"claude-explicit"}\n{"type":"unknown"}'),
  ).toMatchObject({ observedModel: "claude-explicit", usage: { input: null, complete: false } });
});
it("does not treat missing Claude cache categories as known zero input", () => {
  const result = normalize(
    "claude",
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 20, output_tokens: 2 },
    }),
  );
  expect(result.usage.input).toBe(null);
  expect(result.usage.complete).toBe(false);
});
it("frames the single Codex prompt with the environment and forwards only the bridge variables", () => {
  const invocation = drivers.codex.invocation({
    profile: codexProfile,
    limits,
    system: "Environment frame",
    messages: ["Find it"],
  });
  const { argv, stdin } = invocation;
  expect(stdin).toBe("Environment frame\n\nFind it");
  expect("respond" in invocation).toBe(false);
  expect(argv).toContain('mcp_servers.task.env_vars=["TACK_EVAL_BRIDGE","TACK_EVAL_TOKEN"]');
  expect(argv.join(" ")).not.toContain("OPENAI_API_KEY");
  expect(argv.join(" ")).not.toContain("ANTHROPIC_API_KEY");
  expect(drivers.codex.capabilities).toEqual({
    followUps: false,
    maxTurns: false,
    budgetUsd: false,
  });
});
it("keeps native Codex sandboxing by default and disables it only for an explicit container invocation", () => {
  const request = { profile: codexProfile, limits, system: "", messages: ["x"] };
  expect(drivers.codex.invocation(request).argv).not.toContain(
    "--dangerously-bypass-approvals-and-sandbox",
  );
  const off = drivers.codex.invocation({ ...request, sandbox: "off-in-container" }).argv;
  expect(off).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(off.some((arg) => arg.startsWith("default_permissions="))).toBe(false);
});

it("treats an unreadable Claude auth status as not signed in", () => {
  expect(drivers.claude.authenticated("Not logged in")).toBe(false);
});
