import type { TrialLimits } from "./contract.ts";
import type { DriverCapabilities, DriverId, ModelProfile } from "./plan.ts";

type Usage = {
  input: number | null;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  costUsd: number | null;
  complete: boolean;
};
export type NativeResult = {
  /** The agent's last answer. */
  finalAnswer: string;
  /** Every user message got a successful answer. */
  completed: boolean;
  /** Answers the native stream reported: one per user message the agent finished. */
  userTurns: number;
  /** Agentic turns the native CLI reported, summed over answers, or `null` when unreported. */
  nativeTurns: number | null;
  /** The native CLI stopped at the trial's turn or budget limit. */
  limitReached: boolean;
  malformed: number;
  observedModel: string | null;
  usage: Usage;
};
export type CodexSandboxMode = "native" | "off-in-container";
/** One native launch: its argv, its first input and how it answers each output line. */
type Invocation = {
  argv: string[];
  stdin: string;
  /**
   * Called with each complete stdout line: text to write to the agent's input, `null` to close the
   * input, or `undefined` to wait. Absent when the input closes after `stdin`.
   */
  respond?: (line: string) => string | null | undefined;
};
/** New providers supply native argv and event normalization; tasks remain provider independent. */
export type AgentDriver = {
  id: DriverId;
  executable: string;
  login: readonly string[];
  authStatus: readonly string[];
  capabilities: DriverCapabilities;
  /**
   * Plan one launch. `system` is the harness environment frame; `messages` are the user's
   * messages in order, the first one sent at start.
   */
  invocation: (request: {
    profile: ModelProfile;
    limits: TrialLimits;
    system: string;
    messages: readonly string[];
    sandbox?: CodexSandboxMode;
  }) => Invocation;
  authenticated: (stdout: string, stderr: string) => boolean;
  /** Read the retained native output of a launch that sent `userTurns` messages. */
  normalize: (raw: string, userTurns: number) => NativeResult;
  isolation: { probe: readonly string[] | null; offProbe: readonly string[] | null };
};
/** Native filesystem policy shared by paid execution and the no-model containment probe. */
const codexFilesystemSettings = [
  'default_permissions="eval"',
  'permissions.eval.filesystem={":project_roots"="read", "/auth"="none", "/session"="write"}',
  "permissions.eval.network.enabled=false",
] as const;
const mcp = { mcpServers: { task: { command: "node", args: ["/opt/evals/mcp-client.mjs"] } } };
/** One user message in Claude's stream-json input format. */
const claudeUserMessage = (text: string) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  }) + "\n";
export const drivers = {
  claude: {
    id: "claude",
    isolation: { probe: null, offProbe: null },
    executable: "claude",
    login: ["auth", "login", "--claudeai"],
    authStatus: ["auth", "status", "--json"],
    capabilities: { followUps: true, maxTurns: true, budgetUsd: true },
    authenticated: (stdout) => {
      try {
        return object(JSON.parse(stdout))["authMethod"] === "claude.ai";
      } catch {
        return false;
      }
    },
    normalize: (raw, userTurns) => parseNative("claude", raw, userTurns),
    invocation: ({ profile, limits, system, messages }) => {
      const [first = "", ...followUps] = messages.map((text) => claudeUserMessage(text));
      return {
        argv: [
          "-p",
          "--model",
          profile.model,
          "--effort",
          profile.effort,
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--append-system-prompt",
          system,
          ...(limits.maxTurns === undefined ? [] : ["--max-turns", String(limits.maxTurns)]),
          ...(limits.budgetUsd === undefined ? [] : ["--max-budget-usd", String(limits.budgetUsd)]),
          "--no-session-persistence",
          "--tools",
          "",
          "--allowedTools",
          "mcp__task__exec",
          "--permission-mode",
          "dontAsk",
          "--permission-prompts",
          "none",
          "--strict-mcp-config",
          "--mcp-config",
          JSON.stringify(mcp),
          "--setting-sources",
          "",
          "--no-chrome",
          "--disable-slash-commands",
          "--settings",
          JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
        ],
        stdin: first,
        // Each result ends one user turn: send the next message, or close the input after the
        // last one or after a failed turn.
        respond: (line) => {
          let event: Record<string, unknown>;
          try {
            event = object(JSON.parse(line));
          } catch {
            return undefined;
          }
          if (event["type"] !== "result") return undefined;
          return event["is_error"] === false ? (followUps.shift() ?? null) : null;
        },
      };
    },
  },
  codex: {
    id: "codex",
    isolation: {
      offProbe: [
        "codex",
        "sandbox",
        "-c",
        'sandbox_mode="danger-full-access"',
        "--",
        "/bin/echo",
        "native-fs-probe-passed",
      ],
      probe: [
        "codex",
        "sandbox",
        ...codexFilesystemSettings.flatMap((setting) => ["-c", setting]),
        "--permission-profile",
        "eval",
        "-C",
        "/session",
        "--",
        "bash",
        "-c",
        'set -eu; test "$(cat /session/allowed)" = allowed; touch /session/write-allowed; if cat /auth/canary 2>/dev/null; then exit 41; fi; if cat /session/escape 2>/dev/null; then exit 42; fi; if touch /usr/.denied 2>/dev/null; then exit 43; fi; printf native-fs-probe-passed',
      ],
    },
    executable: "codex",
    login: ["login", "--device-auth"],
    authStatus: ["login", "status"],
    // Paused: `codex exec` takes one prompt and enforces neither a turn nor a budget limit.
    capabilities: { followUps: false, maxTurns: false, budgetUsd: false },
    authenticated: (stdout, stderr) => /ChatGPT/i.test(stdout + stderr),
    normalize: (raw) => parseNative("codex", raw, 1),
    invocation: ({ profile, system, messages, sandbox = "native" }) => ({
      argv: [
        "exec",
        ...(sandbox === "off-in-container" ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--model",
        profile.model,
        ...[
          `model_reasoning_effort=${JSON.stringify(profile.effort)}`,
          'approval_policy="never"',
          'web_search="disabled"',
          "features.shell_tool=false",
          "features.apps=false",
          "features.plugins=false",
          "features.memories=false",
          "features.multi_agent=false",
          "features.hooks=false",
          "features.browser_use=false",
          "features.computer_use=false",
          "features.image_generation=false",
          "features.view_image=false",
          "features.code_mode=false",
          "skills.bundled.enabled=false",
          "skills.include_instructions=false",
          'mcp_servers.task.command="node"',
          'mcp_servers.task.args=["/opt/evals/mcp-client.mjs"]',
          'mcp_servers.task.env_vars=["TACK_EVAL_BRIDGE","TACK_EVAL_TOKEN"]',
          "mcp_servers.task.required=true",
          'mcp_servers.task.enabled_tools=["exec"]',
          'mcp_servers.task.tools.exec.approval_mode="approve"',
          ...(sandbox === "native" ? codexFilesystemSettings : []),
        ].flatMap((setting) => ["-c", setting]),
        "-",
      ],
      // `codex exec` has no system prompt flag, so the environment frames the one prompt.
      stdin: `${system}\n\n${messages[0] ?? ""}`,
    }),
  },
} satisfies Record<DriverId, AgentDriver>;

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && Array.isArray(value) === false
    ? Object.fromEntries(Object.entries(value))
    : {};
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const sum = (values: readonly (number | null)[]): number | null =>
  values.length === 0 || values.some((value) => value === null)
    ? null
    : values.reduce<number>((total, value) => total + (value ?? 0), 0);
/** Parse retained native JSONL, using only authoritative final usage records. */
export function normalize(driver: DriverId, raw: string, userTurns = 1): NativeResult {
  return drivers[driver].normalize(raw, userTurns);
}
/**
 * Claude reports one `result` per user turn. Usage and cost are summed over them: if a later
 * Claude version reports them cumulatively, the sum overstates spend, which keeps a campaign budget
 * conservative.
 */
function parseNative(driver: DriverId, raw: string, userTurns: number): NativeResult {
  let result: NativeResult = {
    finalAnswer: "",
    completed: false,
    userTurns: 0,
    nativeTurns: null,
    limitReached: false,
    malformed: 0,
    observedModel: null,
    usage: {
      input: null,
      cachedInput: null,
      cacheWriteInput: null,
      output: null,
      reasoningOutput: null,
      costUsd: null,
      complete: false,
    },
  };
  const answers: Record<string, unknown>[] = [];
  for (const line of raw.split("\n").filter((candidate) => candidate.trim().length > 0)) {
    let event: Record<string, unknown>;
    try {
      event = object(JSON.parse(line));
    } catch {
      result.malformed += 1;
      continue;
    }
    if (driver === "codex") {
      const item = object(event["item"]);
      if (
        event["type"] === "item.completed" &&
        item["type"] === "agent_message" &&
        typeof item["text"] === "string"
      )
        result.finalAnswer = item["text"];
      if (event["type"] === "turn.completed") {
        const usage = object(event["usage"]);
        const input = number(usage["input_tokens"]);
        const output = number(usage["output_tokens"]);
        result = {
          ...result,
          completed: true,
          userTurns: 1,
          usage: {
            input,
            output,
            cachedInput: number(usage["cached_input_tokens"]),
            cacheWriteInput: number(usage["cache_write_input_tokens"]),
            reasoningOutput: number(usage["reasoning_output_tokens"]),
            costUsd: null,
            complete: input !== null && output !== null,
          },
        };
      }
      if (event["type"] === "turn.failed" || event["type"] === "error") result.completed = false;
    } else {
      if (event["type"] === "system" && typeof event["model"] === "string")
        result.observedModel = event["model"];
      if (event["type"] === "result") answers.push(event);
    }
  }
  if (driver === "codex") return result;
  const usages = answers.map((answer) => object(answer["usage"]));
  const field = (key: string) => sum(usages.map((usage) => number(usage[key])));
  const uncached = field("input_tokens");
  const cachedInput = field("cache_read_input_tokens");
  const cacheWriteInput = field("cache_creation_input_tokens");
  const output = field("output_tokens");
  const input =
    uncached === null || cachedInput === null || cacheWriteInput === null
      ? null
      : uncached + cachedInput + cacheWriteInput;
  const last = answers.at(-1);
  return {
    ...result,
    completed:
      answers.length === userTurns &&
      answers.every((answer) => answer["is_error"] === false && answer["subtype"] === "success"),
    finalAnswer: typeof last?.["result"] === "string" ? last["result"] : "",
    userTurns: answers.length,
    nativeTurns: sum(answers.map((answer) => number(answer["num_turns"]))),
    limitReached: answers.some(
      (answer) =>
        typeof answer["subtype"] === "string" && answer["subtype"].startsWith("error_max_"),
    ),
    usage: {
      input,
      cachedInput,
      cacheWriteInput,
      output,
      reasoningOutput: null,
      costUsd: sum(answers.map((answer) => number(answer["total_cost_usd"]))),
      complete: input !== null && output !== null,
    },
  };
}
