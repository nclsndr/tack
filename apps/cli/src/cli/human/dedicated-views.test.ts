import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { agentAdapterIds } from "../../domain/agents/agent-adapter.ts";
import { HelpPayloadSchema } from "../commands/index.ts";
import { envelopeOf, flat, hintRecorder, humanFixture, plainStyle } from "./human.test-support.ts";
import { renderDedicated } from "./render.ts";
import { diagnosticLines } from "./view.ts";
import { period } from "./run-text.ts";
import { withReferences } from "./style.ts";
import { displayWidth, truncate } from "./text.ts";

const sourceId = "00000000-0000-4000-8000-000000000001";

describe("dedicated result views", () => {
  it.each(["check", "doctor", "upgrade", "upgrade status"])(
    "%s declines a result it cannot decode",
    (command) => {
      expect(renderDedicated(envelopeOf({ command, result: { kind: "other" } }), plainStyle)).toBe(
        undefined,
      );
    },
  );
});

describe("check view", () => {
  const finding = {
    code: "skill-name-mismatch",
    severity: "error",
    file: "/home/me/source/skills/lint/SKILL.md",
    line: 2,
    message: "The skill folder name must equal name.",
  } as const;
  it.each([
    { findings: [], loop: false },
    { findings: [finding], loop: true },
  ])("asks to repeat until clean only while findings remain: $loop", ({ findings, loop }) => {
    const text = renderDedicated(
      envelopeOf({
        command: "check",
        result: {
          kind: "check-report",
          checks: [{ kind: "source", path: "/home/me/source", details: [] }],
          findings,
          summary: { checked: 1, errors: findings.length, warnings: 0 },
        },
      }),
      plainStyle,
    );
    expect(text?.includes("repeat until clean")).toBe(loop);
  });
});

describe("doctor view", () => {
  const report = (
    checks: ReadonlyArray<{ readonly outcome: string } & Record<string, unknown>>,
  ) => {
    const count = (outcome: string) => checks.filter((check) => check.outcome === outcome).length;
    return {
      kind: "doctor-report",
      release: { stamp: "0.2.0+gaaaaaaa", sourceRun: false },
      stateDirectory: "/home/me/.tack",
      summary: {
        ok: count("ok"),
        warning: count("warning"),
        failed: count("failed"),
        skipped: count("skipped"),
        total: checks.length,
      },
      checks,
    };
  };

  it("says no problems were found and counts what was skipped", () => {
    const text = renderDedicated(
      envelopeOf({
        command: "doctor",
        result: report([
          { id: "release", outcome: "ok", message: "The release is active." },
          { id: "state", outcome: "skipped", message: "No state yet." },
        ]),
      }),
      plainStyle,
    );
    expect(text?.split("\n")[0]).toBe(
      "tack doctor · 0.2.0+gaaaaaaa · 1 ok · 1 skipped · ✓ success",
    );
    expect(text).toContain("\nNo problems found.\n");
    expect(text).toContain("Checked");
  });

  it("lists a warning without a command and no checked section when every check needs a look", () => {
    const { hints, style } = hintRecorder();
    const text = renderDedicated(
      envelopeOf({
        command: "doctor",
        result: report([{ id: "links", outcome: "warning", message: "A link drifted." }]),
      }),
      style,
    );
    expect(text?.split("\n")[0]).toBe(
      "tack doctor · 0.2.0+gaaaaaaa · 1 warning · 0 ok · ✓ success",
    );
    expect(text).toContain("Problems");
    expect(text).not.toContain("Checked");
    expect(hints).toEqual([]);
  });
});

describe("diagnostic lines", () => {
  it("names a subject by its unresolved address, its destinations, or nothing", () => {
    const lines = diagnosticLines(
      [
        {
          code: "dependency-missing",
          message: "A dependency is missing.",
          severity: "error",
          details: { subject: { address: { kind: "skill", name: "helper" } } },
        },
        {
          code: "destination-drift",
          message: "One link drifted.",
          severity: "warning",
          details: { subject: { destinationPaths: ["/home/me/a"] } },
        },
        {
          code: "destination-drift",
          message: "Links drifted.",
          severity: "warning",
          details: { subject: { destinationPaths: ["/home/me/a", "/home/me/b", "/home/me/c"] } },
        },
        {
          code: "pending-removals-outside-scope",
          message: "Other projects still owe removals.",
          severity: "info",
        },
      ],
      plainStyle,
    );
    expect(lines).toEqual([
      "Problems",
      "  ✗ A dependency is missing.",
      "    error dependency-missing · skill helper",
      "  ! One link drifted.",
      "    warning destination-drift · ~/a",
      "  ! Links drifted.",
      "    warning destination-drift · ~/a and 2 more",
      "  Other projects still owe removals.",
    ]);
  });
});

describe("help view", () => {
  it("marks required flags, lists flag choices, optional variadic arguments and example notes", () => {
    const result = Schema.decodeUnknownSync(HelpPayloadSchema)(
      humanFixture("help-choice-set").result,
    );
    const text = renderDedicated(
      envelopeOf({
        command: "help",
        result: {
          ...result,
          flags: [
            {
              name: "mode",
              required: true,
              type: "choice",
              choices: ["fast", "slow"],
              description: "How",
            },
          ],
          arguments: [{ name: "names", required: false, type: "string", variadic: true }],
          examples: [
            { command: "tack pick include review --user", description: "Include it for you." },
          ],
        },
      }),
      plainStyle,
    );
    expect(flat(text)).toContain("--mode <fast|slow> (required) How");
    expect(flat(text)).toContain("<names>... (optional)");
    expect(flat(text)).toContain("tack pick include review --user Include it for you.");
  });

  it("points the adapter group at the help of both enable and disable", () => {
    const result = Schema.decodeUnknownSync(HelpPayloadSchema)(
      humanFixture("help-choice-set").result,
    );
    const text = renderDedicated(
      envelopeOf({
        command: "help",
        result: {
          ...result,
          commandPath: ["adapter"],
          subcommands: [
            { name: "enable", description: "Enable adapters", executable: true },
            { name: "disable", description: "Disable an adapter", executable: true },
          ],
        },
      }),
      plainStyle,
    );
    expect(text?.split("Next\n")[1]).toBe(
      "  tack adapter enable --help\n  tack adapter disable --help\n",
    );
  });
  it.each(["source", "project", "pick", "import", "docs", "profile", "script", "state"])(
    "points the %s group at the help of every subcommand",
    (group) => {
      const result = Schema.decodeUnknownSync(HelpPayloadSchema)(
        humanFixture("help-choice-set").result,
      );
      const text = renderDedicated(
        envelopeOf({
          command: "help",
          result: {
            ...result,
            commandPath: [group],
            subcommands: [
              { name: "first", description: "First", executable: true },
              { name: "second", description: "Second", executable: true },
            ],
          },
        }),
        plainStyle,
      );
      expect(text?.split("Next\n")[1]).toBe(
        `  tack ${group} first --help\n  tack ${group} second --help\n`,
      );
    },
  );
});

describe("docs icons view", () => {
  it("shows a failure without a payload", () => {
    const failure = renderDedicated(
      envelopeOf({
        command: "docs icons",
        classification: "invalid-invocation",
        diagnostics: [{ code: "docs-icons-query", message: "Name one icon.", severity: "error" }],
      }),
      plainStyle,
    );
    expect(failure).toContain("Name one icon.");
  });
});

describe("docs icons lookup", () => {
  it("lists an icon that was never renamed by its name alone", () => {
    const text = renderDedicated(
      envelopeOf({
        command: "docs icons",
        result: {
          kind: "docs-icons",
          lucideVersion: "0.500.0",
          count: 1,
          categories: [{ category: "Objects and places", icons: [{ name: "house" }] }],
        },
      }),
      plainStyle,
    );
    expect(text).toContain("Objects and places\n  house\n");
  });
});

describe("run text", () => {
  it("shows a period whose ends are not ISO timestamps as given, and repeats a changed date", () => {
    expect(period("yesterday", "today")).toBe("yesterday → today");
    expect(period("2026-11-07T23:59:00Z", "2026-11-08T00:01:00Z")).toBe(
      "2026-11-07 23:59:00 → 2026-11-08 00:01:00 UTC",
    );
  });
});

describe("text truncation", () => {
  it("keeps only an ellipsis in one column and nothing in none", () => {
    expect(truncate("review", 1)).toBe("…");
    expect(truncate("review", 0)).toBe("");
  });
});

describe("display width", () => {
  it("gives control characters and lone format marks no columns", () => {
    expect(displayWidth("\u0007")).toBe(0);
    expect(displayWidth("a\u200bb")).toBe(2);
  });
});

describe("adapter list view", () => {
  it("lists no disabled adapters when all are on", () => {
    const { hints, style } = hintRecorder();
    const text = renderDedicated(
      envelopeOf({
        command: "adapter",
        result: {
          kind: "adapters",
          enabledAdapters: agentAdapterIds,
        },
      }),
      style,
    );
    expect(flat(text)).toContain(
      "Enabled claude, cline, codex, copilot, cursor, gemini, opencode, pi",
    );
    expect(text).not.toContain("Not enabled");
    expect(hints).toEqual(["tack status"]);
  });
});

describe("mutation failure hints", () => {
  it("offers no command when a failure's details cannot be read", () => {
    const { hints, style } = hintRecorder();
    const text = renderDedicated(
      envelopeOf({
        command: "adapter enable",
        classification: "domain",
        diagnostics: [
          {
            code: "project-registration-conflict",
            message: "The project is registered elsewhere.",
            severity: "error",
            details: { unexpected: true },
          },
        ],
      }),
      style,
    );
    expect(text).toContain("The project is registered elsewhere.");
    expect(hints).toEqual([]);
  });
});

describe("references", () => {
  it("names a source by the label the given catalog holds", () => {
    const style = withReferences(plainStyle, {
      entries: [],
      sources: [
        { registration: { id: sourceId }, label: "personal-brain", labelOrigin: "declared" },
      ],
    });
    expect(style.source(sourceId)).toBe("personal-brain");
  });
});

describe("sync view", () => {
  it("says no docs mounts are attached when a docs-only sync has nothing to plan", () => {
    expect(
      renderDedicated(
        envelopeOf({ command: "sync", plan: { kind: "sync-plan", resources: null, docs: [] } }),
        plainStyle,
      ),
    ).toBe("tack sync · docs only · ✓ success\n\nNo docs mounts are attached.\n");
  });
});
