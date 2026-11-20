import { describe, expect, it } from "vitest";
import {
  doneStatus,
  keptOutput,
  liveStatus,
  replyBlocks,
  streamedText,
  toolSummary,
  withCall,
  withCallOutput,
  withReplyShown,
  type AgentEntry,
} from "./agent-screen.ts";

describe("agent tool summary", () => {
  it.each([
    [2, false, "Ran 2 shell commands"],
    [1, false, "Ran 1 shell command"],
    [1, true, "Running 1 shell command…"],
    [3, true, "Running 3 shell commands…"],
  ] as const)("sums up %i calls (running: %s) as %j", (count, running, summary) => {
    expect(toolSummary(count, running)).toBe(summary);
  });
});

describe("agent tool output", () => {
  it("keeps the first lines that say something and counts the rest", () => {
    const escape = String.fromCharCode(27);
    const output = `one\n\n${escape}[2m${escape}[22m\ntwo\nthree\nfour\n`;

    expect(keptOutput(output, 2)).toEqual({ lines: ["one", "two"], more: 2 });
    expect(keptOutput(output, 9)).toEqual({ lines: ["one", "two", "three", "four"], more: 0 });
    expect(keptOutput("", 3)).toEqual({ lines: [], more: 0 });
  });
});

describe("agent screen entries", () => {
  const user: AgentEntry = { kind: "user", text: "Yes." };
  const shell = { kind: "tool-call", tool: "shell", command: "tack sync" } as const;

  it("groups calls that follow each other into one block, running until its output lands", () => {
    const first = withCall([user], shell);
    const second = withCall(withCallOutput(first, "planned\n", 3), shell);

    expect(second).toEqual([
      user,
      {
        kind: "tools",
        running: true,
        calls: [
          { call: shell, output: { lines: ["planned"], more: 0 } },
          { call: shell, output: undefined },
        ],
      },
    ]);
    expect(withCallOutput(second, "", 3).at(-1)).toMatchObject({ running: false });
  });

  it("shows more of the last reply as it streams, and nothing else changes", () => {
    const reply: AgentEntry = { kind: "assistant", text: "One two three.", shown: 0 };

    expect(withReplyShown([user, reply], 2)).toEqual([user, { ...reply, shown: 2 }]);
    expect(withReplyShown([reply, user], 2)).toEqual([reply, user]);
  });

  it("starts a new block after anything else, and leaves entries alone with no call running", () => {
    const reply: AgentEntry = { kind: "assistant", text: "Ok.", shown: 1 };
    const after = withCall([user, reply], shell);

    expect(after.map((entry) => entry.kind)).toEqual(["user", "assistant", "tools"]);
    expect(withCallOutput([user, reply], "x", 3)).toEqual([user, reply]);
  });
});

describe("agent replies", () => {
  it("splits a reply into paragraphs and list items with code and bold spans", () => {
    expect(replyBlocks("**Preview:** 4 links in `app`.\n\n- one `a`\n- two")).toEqual([
      {
        kind: "paragraph",
        spans: [
          { kind: "bold", text: "Preview:" },
          { kind: "text", text: " 4 links in " },
          { kind: "code", text: "app" },
          { kind: "text", text: "." },
        ],
      },
      { kind: "gap", spans: [] },
      {
        kind: "item",
        spans: [
          { kind: "text", text: "one " },
          { kind: "code", text: "a" },
        ],
      },
      { kind: "item", spans: [{ kind: "text", text: "two" }] },
    ]);
  });

  it("streams a reply word by word without cutting a code span open", () => {
    const text = "Run `tack sync --apply` now, please.";

    expect([streamedText(text, 0), streamedText(text, 2), streamedText(text, 99)]).toEqual([
      "",
      "Run `tack sync --apply`",
      text,
    ]);
  });
});

describe("agent status lines", () => {
  it("reads like a working agent while live, and like a finished turn after", () => {
    expect(liveStatus("Contemplating", { seconds: 8, tokens: 695 })).toBe(
      "Contemplating… (8s · ↓ 695 tokens)",
    );
    expect(liveStatus("Pondering", { seconds: 0, tokens: 0 })).toBe("Pondering…");
    expect(doneStatus("Crunched", 7)).toBe("Crunched for 7s");
  });
});
