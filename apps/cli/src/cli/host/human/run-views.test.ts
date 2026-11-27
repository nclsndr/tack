import { searchDocuments, type ReaderDocument } from "@tackup/reader/search-core";
import { expect, it } from "@effect/vitest";
import { Effect, Record, type Schema } from "effect";
import { expectViewContract, flat, lines, renderView, styleOf } from "./human.test-support.ts";
import { renderDedicated } from "./render.ts";
import { runViews } from "./run-views.ts";
import { commandNameOf } from "../../commands/index.ts";
import {
  historyListOutcome,
  docsSearchOutcome,
  resultAs,
  resultOutcome,
  scriptRunOutcome,
} from "../outcomes.ts";
import { ReaderSessionPayloadSchema } from "../../../features/reader/session.ts";
import { createPublicEnvelope, type PublicEnvelope } from "../public-outcome.ts";
import {
  summarizeHistory,
  type HistoryList,
  type HistoryRecord,
  type OperatorRunResult,
} from "../../../domain/execution/execution-schema.ts";
import { hintsIn, parseHintsIn } from "../../../../test/support/hints.ts";

const terminal = { homeDirectory: "/Users/ada" } as const;
const render = (envelope: PublicEnvelope, width = 80) =>
  renderView(envelope, { ...terminal, width });
/** The text with line breaks and their indentation removed, to read back a wrapped path. */
const unwrapped = (text: string) => text.replace(/\n +/g, "");

const runId = "5d2f9a64-1c3b-4e7a-9b0d-2f6a8c1e7b30";
const otherRunId = "0c9e3d7b-6a41-4f28-8d15-b7e2a4c90f13";
const address = {
  kind: "script",
  name: "report",
  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
} as const;
const noLogLimits = { truncated: false, observedBytes: 0, observedEvents: 0, reasons: [] };

const runResult = (overrides: Partial<OperatorRunResult> = {}): OperatorRunResult => ({
  runId,
  outcome: {
    stage: "output",
    code: "success",
    message: "The script completed.",
    classification: "success",
  },
  logs: [],
  logTruncation: noLogLimits,
  finalization: "complete",
  ...overrides,
});
/** The core outcome a worker reports for a run that returned `encoded`. */
const successCore = (encoded: Schema.Json) => ({
  status: "success",
  stage: "output",
  code: "success",
  primary: { status: "success", stage: "output", code: "success", encoded },
  finalization: { status: "complete" },
  truncation: [],
});
const runEnvelope = (result: OperatorRunResult) =>
  createPublicEnvelope("script run", scriptRunOutcome(result));

// ---------------------------------------------------------------- reader

const readerEnvelope = (root = "/Users/ada/Code/demo") =>
  createPublicEnvelope(
    "docs serve",
    resultAs(ReaderSessionPayloadSchema)({
      url: "http://127.0.0.1:3000",
      project: { name: "demo", root },
    }),
  );

it("shows the reader URL, project and root at startup", () => {
  const output = render(readerEnvelope());
  expect(lines(output)[0]).toBe("tack docs serve · demo · ✓ success");
  expect(output).toContain("Reader ready");
  expect(output).toContain("http://127.0.0.1:3000");
  expect(output).toContain("~/Code/demo");
  expect(output).toContain("until interrupted");
  expect(hintsIn(output)).toEqual([]);
});

it("keeps the reader readable at narrow and wide widths with long roots", () => {
  const root = "/Users/ada/Code/a-very-long-directory-name/with/many/nested/folders/demo";
  expectViewContract(readerEnvelope(root), terminal);
  for (const width of [40, 80, 120]) {
    const output = render(readerEnvelope(root), width);
    expect(output).toContain("http://127.0.0.1:3000");
    expect(unwrapped(output)).toContain(
      "~/Code/a-very-long-directory-name/with/many/nested/folders/demo",
    );
  }
});

it("renders a reader startup failure as header and diagnostics", () => {
  const envelope = createPublicEnvelope("docs serve", {
    classification: "invalid-configuration",
    diagnostics: [
      {
        code: "reader-configuration",
        message: "Cannot load the declared corpus",
        severity: "error",
      },
    ],
  });
  const output = render(envelope);
  expect(lines(output)[0]).toBe("tack docs serve · ✗ invalid-configuration");
  expect(output).toContain("Cannot load the declared corpus");
  expect(output).toContain("reader-configuration");
});

// ---------------------------------------------------------------- reader search

const documentOf = (
  title: string,
  relativePath: string,
  text: string,
  extra: Partial<ReaderDocument> = {},
): ReaderDocument => ({
  id: relativePath,
  path: `/Users/ada/Code/demo/docs/${relativePath}`,
  relativePath,
  route: `/${relativePath}`,
  title,
  metadata: { title, type: "spec", status: "active", tags: ["skills", "cli"] },
  blocks: [
    {
      id: `${relativePath}#1`,
      kind: "paragraph",
      readable: text,
      raw: text,
      version: "1",
      source: {
        path: `/Users/ada/Code/demo/docs/${relativePath}`,
        startLine: 9,
        endLine: 11,
      },
      contributors: [
        { path: "/Users/ada/Code/demo/docs/_data.ts", startLine: 1, endLine: 1, kind: "data" },
      ],
    },
  ],
  imports: [],
  searchText: text,
  source: text,
  resource: {
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",

    name: "docs",
    sourcePath: "/Users/ada/Code/demo",
  },
  ...extra,
});

const searchEnvelope = (
  documents: ReaderDocument[],
  options: { query?: string; limit?: number; complete?: boolean } = {},
) => {
  const search = searchDocuments(documents, {
    query: options.query ?? "ownership",
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const complete = options.complete ?? true;
  const result = {
    project: { name: "demo", root: "/Users/ada/Code/demo" },
    complete,
    issues: complete
      ? []
      : [
          {
            resource: {
              sourceRegistrationId: "00000000-0000-4000-8000-000000000002",

              name: "notes",
            },
            sourcePath: "/Users/ada/Code/notes",
            code: "docs-resource-unavailable",
            message: "The registered source is unavailable.",
          },
        ],
    ...search,
  };
  return createPublicEnvelope("docs search", docsSearchOutcome(result));
};

it("lists search hits with resource, location, excerpt and the total", () => {
  const output = render(
    searchEnvelope([
      documentOf("Decisions", "decisions.mdx", "Skill ownership stays with the source."),
      documentOf("Roadmap", "roadmap.mdx", "No relevant words here."),
    ]),
  );
  expect(lines(output)[0]).toBe("tack docs search · demo · ✓ success");
  expect(output).toContain("Results   1 hit, within the limit of 10");
  expect(output).toContain("Coverage  complete");
  expect(output).toContain("  1. Decisions");
  expect(output).toContain("decisions.mdx · 00000000-0000-4000-8000-000000000001:docs");
  expect(output).toContain("type spec · status active · tags skills, cli");
  expect(output).toContain("~/Code/demo/docs/decisions.mdx:9-11");
  expect(output).toContain("Skill ownership stays with the source.");
  expect(output).toContain("via ~/Code/demo/docs/_data.ts:1 (data)");
  expect(output).not.toContain("Roadmap");
  expect(hintsIn(output)).toEqual([]);
});

it("says so when nothing matches", () => {
  const output = render(searchEnvelope([documentOf("Roadmap", "roadmap.mdx", "Nothing.")]));
  expect(output).toContain("Results   no documents match");
  expect(output).not.toContain("Hits");
});

it("reports truncated results with the shown and total counts", () => {
  const documents = Array.from({ length: 12 }, (_, index) =>
    documentOf(`Doc ${index}`, `doc-${String(index).padStart(2, "0")}.mdx`, "ownership matters"),
  );
  const output = render(searchEnvelope(documents));
  expect(output).toContain("10 of 12 hits shown, truncated at the limit of 10");
  expect(output).toContain("Raise --limit (up to 50)");
  expect(output).toContain("10. Doc 9");
  expect(output).toContain(" 1. Doc 0");

  const atMaximum = searchEnvelope(documents, { limit: 50 });
  expect(render(atMaximum)).not.toContain("truncated");
  const full = Array.from({ length: 51 }, (_, index) =>
    documentOf(`Doc ${index}`, `doc-${String(index).padStart(2, "0")}.mdx`, "ownership matters"),
  );
  expect(render(searchEnvelope(full, { limit: 50 }))).toContain(
    "limit is at its maximum of 50; refine the query",
  );
});

it.effect("flags an incomplete search and hints at the docs listing", () =>
  Effect.gen(function* () {
    const envelope = searchEnvelope([documentOf("Decisions", "decisions.mdx", "ownership rules")], {
      complete: false,
    });
    const output = render(envelope);
    expect(lines(output)[0]).toBe("tack docs search · demo · ! partial");
    expect(output).toContain("Coverage  incomplete, 1 issue found");
    expect(output).toContain("Coverage issues");
    expect(output).toContain("notes · docs-resource-unavailable");
    expect(output).toContain("~/Code/notes");
    expect(output).toContain("reader-incomplete");
    expect(hintsIn(output)).toEqual(["tack docs --project demo"]);
    expect(yield* parseHintsIn(output)).toEqual(["docs"]);
  }),
);

it("shows a hit without text blocks by its file", () => {
  const document = documentOf("Ownership", "ownership.mdx", "irrelevant", { blocks: [] });
  const output = render(searchEnvelope([document]));
  expect(output).toContain("no matching text; whole file ~/Code/demo/docs/ownership.mdx");
});

it("fits search hits with wide characters at every width", () => {
  const document = documentOf(
    "所有権の決定事項と長い見出しの例 for the skills catalog",
    "決定.mdx",
    "スキルの ownership は元のソースに残ります。これは非常に長い説明文で、端末の幅に収まるように切り詰められます。",
  );
  expectViewContract(searchEnvelope([document]), terminal);
  for (const width of [40, 80, 120])
    expect(render(searchEnvelope([document]), width)).toContain("決定.mdx");
});

it("renders search failures as header and diagnostics", () => {
  const failure = createPublicEnvelope("docs search", {
    classification: "invalid-configuration",
    diagnostics: [
      {
        code: "reader-configuration",
        message: "Cannot load the declared corpus",
        severity: "error",
      },
    ],
  });
  expect(render(failure)).toContain("Cannot load the declared corpus");
});

// ---------------------------------------------------------------- script run

it.effect("summarizes a successful run with its value, logs and history hint", () =>
  Effect.gen(function* () {
    const output = render(
      runEnvelope(
        runResult({
          core: successCore({ changed: 3, names: ["a", "b"] }),
          logs: [
            { source: "stdout", sequence: 1, timestamp: "2026-11-07T14:02:12.000Z", content: "a" },
            { source: "stdout", sequence: 2, timestamp: "2026-11-07T14:02:12.100Z", content: "b" },
            { source: "stderr", sequence: 3, timestamp: "2026-11-07T14:02:12.200Z", content: "c" },
          ],
          logTruncation: { truncated: false, observedBytes: 1300, observedEvents: 3, reasons: [] },
        }),
      ),
    );
    expect(lines(output)[0]).toBe("tack script run · ✓ success");
    expect(output).toContain(`Run           ${runId}`);
    expect(output).toContain("Outcome       ✓ success at output stage");
    expect(output).toContain("Message       The script completed.");
    expect(output).toContain("Finalization  complete");
    expect(output).toContain("History       full record saved");
    expect(output).toContain('{"changed":3,"names":["a","b"]}');
    expect(output).not.toContain("primary");
    expect(output).toContain("3 of 3 events kept, 1.3 KiB observed (stdout 2, stderr 1)");
    expect(output).toContain("Not truncated; the limits are 10000 events and 10 MiB.");
    expect(hintsIn(output)).toEqual([`tack script history show ${runId}`]);
    expect(yield* parseHintsIn(output)).toEqual(["script history show"]);
  }),
);

it.each([
  [
    "an expected failure shows its encoded failure",
    { reason: "missing" },
    ["Failure value", '{"reason":"missing"}'],
  ],
  ["a failure without an encoded value shows no value", undefined, []],
] as const)("%s", (_name, encoded, expected) => {
  const core = {
    status: "failure",
    stage: "execution",
    code: "expected_failure",
    primary: {
      status: "failure",
      stage: "execution",
      code: "expected_failure",
      message: "The script failed.",
      ...(encoded === undefined ? {} : { encoded, encodedFailures: [encoded] }),
    },
    finalization: { status: "complete" },
    truncation: [],
  };
  const output = render(
    runEnvelope(
      runResult({
        outcome: {
          stage: "execution",
          code: "expected_failure",
          message: "The script failed.",
          classification: "domain",
        },
        core,
      }),
    ),
  );
  expect(output).not.toContain("primary");
  expect(output).not.toMatch(/^Value$/m);
  for (const text of expected) expect(output).toContain(text);
  if (expected.length === 0) expect(output).not.toContain("Failure value");
});

it.effect("names the outcome code and stage of a timed out run", () =>
  Effect.gen(function* () {
    const output = render(
      runEnvelope(
        runResult({
          outcome: {
            stage: "execution",
            code: "timeout",
            message: "The script exceeded its timeout.",
            classification: "domain",
          },
          finalization: "incomplete",
          termination: { reason: "timeout", forced: true },
          logTruncation: {
            truncated: true,
            observedBytes: 11 * 1024 * 1024,
            observedEvents: 10001,
            reasons: ["log-bytes"],
          },
        }),
      ),
    );
    expect(lines(output)[0]).toBe("tack script run · ✗ domain");
    expect(output).toContain("Outcome       ✗ timeout at execution stage (domain)");
    expect(output).toContain("Finalization  incomplete");
    expect(output).toContain("Termination   timeout (forced)");
    expect(output).toContain("History       full record saved");
    expect(output).toContain("Truncated (log-bytes); the limits are 10000 events and 10 MiB.");
    expect(output).toContain("The script exceeded its timeout.");
    expect(output).toContain("timeout");
    expect(hintsIn(output)).toEqual([`tack script history show ${runId}`]);
    expect(yield* parseHintsIn(output)).toEqual(["script history show"]);
  }),
);

it("states when the history write failed and shows the run outcome before it", () => {
  const output = render(
    runEnvelope(
      runResult({
        outcome: {
          stage: "history",
          code: "history_finish_failed",
          message: "Run history could not be saved.",
          classification: "persistence",
          details: {
            runOutcome: {
              stage: "output",
              code: "success",
              message: "The script completed.",
              classification: "success",
            },
          },
        },
      }),
    ),
  );
  expect(output).toContain("Outcome       ✗ history_finish_failed at history stage (persistence)");
  expect(output).toContain("History       not saved; the history write failed");
  expect(output).toContain("Run outcome   ✓ success at output stage: The script completed.");
  expect(hintsIn(output)).toEqual([]);
});

it("renders an uninitialized-state run without a history pointer", () => {
  const output = render(
    runEnvelope(
      runResult({
        outcome: {
          stage: "resolution",
          code: "state_not_initialized",
          message: "Tack is not initialized in the selected state directory.",
          classification: "invalid-configuration",
        },
        finalization: "not-started",
      }),
    ),
  );
  expect(output).toContain("Finalization  not started");
  expect(output).toContain("History       no record; Tack state is not initialized");
  expect(hintsIn(output)).toEqual([]);
});

it("cuts a large primary value and points at the JSON report", () => {
  const big = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`key${index}`, "x".repeat(30)]),
  );
  expectViewContract(runEnvelope(runResult({ core: successCore(big) })), terminal);
  for (const width of [40, 80, 120]) {
    const output = render(runEnvelope(runResult({ core: successCore(big) })), width);
    expect(flat(output)).toContain("Value cut to fit; --json prints the whole report.");
    expect(
      lines(output).filter((line) => line.startsWith("  ") && line.includes("key")).length,
    ).toBeLessThanOrEqual(12);
  }
});

it("keeps the run identifier whole in its hint at narrow widths", () => {
  expectViewContract(runEnvelope(runResult()), terminal);
  expect(hintsIn(render(runEnvelope(runResult()), 40))).toEqual([
    `tack script history show ${runId}`,
  ]);
});

it("renders a run envelope without a payload", () => {
  const failure = createPublicEnvelope("script run", {
    classification: "invalid-invocation",
    diagnostics: [
      { code: "invalid-flag", message: "Choose exactly one run target.", severity: "error" },
    ],
  });
  const output = render(failure);
  expect(lines(output)[0]).toBe("tack script run · ✗ invalid-invocation");
  expect(output).toContain("invalid-flag");
});

// ---------------------------------------------------------------- script history

const record = (index: number, overrides: Partial<HistoryRecord> = {}): HistoryRecord => {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    version: 1,
    runId: id,
    status: "complete",
    startedAt: `2026-11-07T14:${String(index % 60).padStart(2, "0")}:11.000Z`,
    finishedAt: `2026-11-07T14:${String(index % 60).padStart(2, "0")}:14.500Z`,
    address,
    result: runResult({ runId: id }),
    ...overrides,
  };
};

const listOf = (records: ReadonlyArray<HistoryRecord>, overrides: Partial<HistoryList> = {}) => {
  const list: HistoryList = {
    runs: records.map(summarizeHistory),
    total: records.length,
    offset: 0,
    limit: 20,
    truncated: false,
    issues: [],
    ...overrides,
  };
  return createPublicEnvelope("script history", historyListOutcome(list));
};

it.effect("pages a truncated history with the next page hint", () =>
  Effect.gen(function* () {
    const records = Array.from({ length: 20 }, (_, index) => record(40 - index));
    const output = render(listOf(records, { total: 57, truncated: true }), 140);
    expect(lines(output)[0]).toBe("tack script history · ✓ success");
    expect(output).toContain("Runs 1-20 of 57, newest first.");
    expect(output).toContain("Page: limit 20, offset 0, more runs follow.");
    expect(output).toContain("00000000-0000-4000-8000-000000000040");
    expect(output).toContain("script 00000000-0000-4000-8000-000000000001:report");
    expect(output).toContain("2026-11-07 14:40:11 → 14:40:14 UTC");
    expect(lines(output).filter((line) => /^ {2}✓ success +00000000/.test(line))).toHaveLength(20);
    expect(hintsIn(output)).toEqual([
      "tack script history --offset 20",
      "tack script history show 00000000-0000-4000-8000-000000000040",
    ]);
    expect(yield* parseHintsIn(output)).toEqual(["script history", "script history show"]);
  }),
);

it.effect("hints the previous page and keeps a non-default limit", () =>
  Effect.gen(function* () {
    const records = Array.from({ length: 5 }, (_, index) => record(10 - index));
    const output = render(
      listOf(records, { total: 30, offset: 10, limit: 5, truncated: true }),
      140,
    );
    expect(output).toContain("Runs 11-15 of 30, newest first.");
    expect(hintsIn(output).slice(0, 2)).toEqual([
      "tack script history --limit 5 --offset 15",
      "tack script history --limit 5 --offset 5",
    ]);
    expect(yield* parseHintsIn(output)).toEqual([
      "script history",
      "script history",
      "script history show",
    ]);
  }),
);

it("stacks each run under its outcome when the table does not fit", () => {
  const failed = record(3, {
    result: runResult({
      runId: "00000000-0000-4000-8000-000000000003",
      outcome: {
        stage: "execution",
        code: "timeout",
        message: "The script exceeded its timeout.",
        classification: "domain",
      },
    }),
  });
  const pending = record(2, { status: "pending" });
  const { result: _omitted, finishedAt: _finished, ...pendingFields } = pending;
  expectViewContract(listOf([failed, pendingFields]), terminal);
  for (const [width, gap] of [
    [40, "\n    "],
    [80, "  "],
  ] as const) {
    const output = render(listOf([failed, pendingFields]), width);
    expect(output).toContain(`  ✗ timeout (domain)${gap}00000000-0000-4000-8000-000000000003\n`);
    expect(output).toContain(`  … pending${gap}00000000-0000-4000-8000-000000000002\n`);
    expect(output).toContain("    2026-11-07 14:03:11 → 14:03:14 UTC\n");
  }
});

it("shows an empty history and a page past the end", () => {
  expect(render(listOf([]))).toContain("No retained runs.");
  expect(render(listOf([], { total: 57, offset: 60 }))).toContain(
    "No runs at offset 60; 57 runs retained.",
  );
  expect(hintsIn(render(listOf([], { total: 57, offset: 60 })))).toEqual([
    "tack script history --offset 40",
  ]);
});

it("shows skipped record files of a partial listing", () => {
  const envelope = listOf([record(1)], {
    issues: [
      { path: "/Users/ada/.tack/history/broken.json", reason: "invalid" },
      { path: "/Users/ada/.tack/history/x.json", reason: "unreadable" },
    ],
  });
  const output = render(envelope);
  expect(lines(output)[0]).toBe("tack script history · ! partial");
  expect(output).toContain("Skipped records (2)");
  expect(output).toContain("! invalid");
  expect(output).toContain("~/.tack/history/broken.json");
  expect(output).toContain("history-partial");
});

it("renders history failures", () => {
  const failure = createPublicEnvelope("script history", {
    classification: "invalid-configuration",
    diagnostics: [
      { code: "state-not-initialized", message: "Tack is not initialized.", severity: "error" },
    ],
  });
  expect(render(failure)).toContain("Tack is not initialized.");
});

// ---------------------------------------------------------------- script history show

const showEnvelope = (value: HistoryRecord) =>
  createPublicEnvelope("script history show", resultOutcome(value));

it("shows a complete record in full", () => {
  const complete = record(7, {
    originalInput: { name: "world" },
    target: { _tag: "project-root", canonicalPath: "/Users/ada/Code/demo", projectName: "demo" },
    diagnostics: { worker: "ok" },
    result: runResult({
      runId: "00000000-0000-4000-8000-000000000007",
      core: successCore({ changed: 3 }),
      logs: [
        {
          source: "stdout",
          sequence: 1,
          timestamp: "2026-11-07T14:07:12.000Z",
          content: "hello\nworld",
        },
      ],
      logTruncation: { truncated: false, observedBytes: 12, observedEvents: 1, reasons: [] },
    }),
  });
  const output = render(showEnvelope(complete));
  expect(lines(output)[0]).toBe("tack script history show · ✓ success");
  expect(output).toContain("Run           00000000-0000-4000-8000-000000000007");
  expect(output).toContain("Script        script 00000000-0000-4000-8000-000000000001:report");
  expect(output).toContain("Status        complete");
  expect(output).toContain("Started       2026-11-07 14:07:11 UTC");
  expect(output).toContain("Finished      2026-11-07 14:07:14 UTC");
  expect(output).toContain("Target        project demo · ~/Code/demo");
  expect(output).toContain("Outcome       ✓ success at output stage");
  expect(output).toContain("Finalization  complete");
  expect(output).toContain('{"name":"world"}');
  expect(output).toContain('{"changed":3}');
  expect(output).not.toContain("primary");
  expect(output).toContain("#1 stdout 14:07:12  hello world");
  expect(output).toContain('{"worker":"ok"}');
  expect(output).not.toContain("--json");
});

it("shows the command-line words a run was given in place of its JSON input", () => {
  const output = render(
    showEnvelope(record(5, { originalWords: ["--name", "Ada Lovelace", "--times=2"] })),
  );
  expect(output).toContain("Arguments");
  expect(output).toContain("--name 'Ada Lovelace' --times=2");
  expect(output).not.toContain("Input");
});

it("shows a pending record without a result", () => {
  const { result: _result, finishedAt: _finished, ...pending } = record(4);
  const output = render(showEnvelope({ ...pending, status: "pending" }));
  expect(output).toContain("Status   pending; no result is recorded yet");
  expect(output).not.toContain("Outcome");
  expect(output).not.toContain("Logs");
});

it("cuts large record values and points at the full JSON record", () => {
  const big = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`key${index}`, "y".repeat(80)]),
  );
  const logs = Array.from({ length: 25 }, (_, index) => ({
    source: "stdout" as const,
    sequence: index + 1,
    timestamp: "2026-11-07T14:07:12.000Z",
    content: "line ".repeat(40),
  }));
  const envelope = showEnvelope(
    record(7, {
      originalInput: big,
      result: runResult({
        runId: "00000000-0000-4000-8000-000000000007",
        logs,
        logTruncation: {
          truncated: false,
          observedBytes: 5000,
          observedEvents: 25,
          reasons: [],
        },
      }),
    }),
  );
  expectViewContract(envelope, terminal);
  for (const width of [40, 80, 120]) {
    const output = render(envelope, width);
    expect(output).toContain("… 5 more events not shown");
    expect(flat(output)).toContain("Some values are cut to fit; --json prints the full record.");
    expect(lines(output).filter((line) => line.startsWith("  #"))).toHaveLength(20);
  }
});

it("shows wide characters in a record within the width", () => {
  const envelope = showEnvelope(
    record(8, {
      originalInput: { 名前: "世界を含む非常に長いテキスト".repeat(8) },
      result: runResult({
        runId: "00000000-0000-4000-8000-000000000008",
        logs: [
          {
            source: "stderr",
            sequence: 1,
            timestamp: "2026-11-07T14:08:12.000Z",
            content: "警告：処理が完了しました。".repeat(8),
          },
        ],
      }),
    }),
  );
  expectViewContract(envelope, terminal);
  expect(render(envelope, 40)).toContain("名前");
});

it.effect("renders an unknown run identifier as a failure with a listing hint", () =>
  Effect.gen(function* () {
    const envelope = createPublicEnvelope("script history show", {
      classification: "domain",
      diagnostics: [
        {
          code: "history-not-found",
          message: "No retained run has this identifier.",
          severity: "error",
        },
      ],
    });
    const output = render(envelope);
    expect(lines(output)[0]).toBe("tack script history show · ✗ domain");
    expect(output).toContain("No retained run has this identifier.");
    expect(output).toContain("history-not-found");
    expect(hintsIn(output)).toEqual(["tack script history"]);
    expect(yield* parseHintsIn(output)).toEqual(["script history"]);
  }),
);

// ---------------------------------------------------------------- undecodable payloads

it("returns undefined for an undecodable payload so the generic view is used", () => {
  for (const tag of Record.keys(runViews)) {
    const command = commandNameOf(tag);
    for (const payload of [{ unexpected: true }, { runId: otherRunId }, [], null]) {
      const envelope = createPublicEnvelope(command, resultOutcome(payload));
      expect(renderDedicated(envelope, styleOf(terminal), runViews), command).toBeUndefined();
      expect(render(envelope)).toContain(`tack ${command}`);
    }
  }
});
