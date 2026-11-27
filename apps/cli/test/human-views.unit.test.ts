import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { readFileSync } from "node:fs";
import { HelpPayloadSchema, parseInvocation } from "../src/cli/commands/index.ts";
import { rootFlagNames } from "../src/cli/host/human/help.ts";
import { operationMap } from "../src/cli/host/human/help-map.ts";
import { renderGeneric, renderHuman } from "../src/cli/host/human/render.ts";
import { makeStyle } from "../src/cli/host/human/style.ts";
import { shellWord } from "../src/cli/host/command-line.ts";
import { expectViewContract } from "../src/cli/host/human/human.test-support.ts";
import { displayWidth } from "../src/cli/host/human/text.ts";
import { PublicEnvelopeSchema, type PublicEnvelope } from "../src/cli/host/public-outcome.ts";
import { ReconciliationPlanSchema } from "../src/domain/reconciliation/reconciliation-schema.ts";
import { StatusPayloadSchema } from "../src/domain/status/status-schema.ts";

/*
 * The fixtures are real envelopes captured from the built CLI against a temporary state with two
 * adapters, a project whose repository directory is in Japanese, a skill described in Japanese,
 * quarantined candidates, a drifted link and a deselected skill. Paths are normalized to /fx.
 */
const fixtureDirectory = new URL("./fixtures/human/", import.meta.url);
const decodeEnvelope = Schema.decodeUnknownSync(PublicEnvelopeSchema);
const fixture = (name: string): PublicEnvelope =>
  decodeEnvelope(JSON.parse(readFileSync(new URL(`${name}.json`, fixtureDirectory), "utf8")));

const fixtureNames = [
  "catalog",
  "help-choice-set",
  "help-reconcile",
  "help-root",
  "help-script",
  "help-status",
  "plan-after",
  "plan-before",
  "plan-remove",
  "plan-trouble",
  "reconcile-apply",
  "reconcile-preview",
  "reconcile-trouble",
  "script-list",
  "status-after",
  "status-bare-before",
  "status-before",
  "status-trouble",
  "status-user",
] as const;

const widths = [40, 80, 120] as const;
const plainStyle = (width: number) => makeStyle({ color: false, homeDirectory: "/fx/home", width });
const colorStyle = (width: number) => makeStyle({ color: true, homeDirectory: "/fx/home", width });

const linesOf = (text: string) => text.split("\n");

it.each(fixtureNames)("%s is a valid envelope with a dedicated view", (name) => {
  const envelope = fixture(name);
  const text = renderHuman(envelope, plainStyle(80));
  const generic = renderGeneric(envelope, plainStyle(80));
  expect(text).not.toBe(generic);
  expect(text.startsWith(`tack ${envelope.command} ·`) || envelope.command === "help").toBe(true);
  expect(text.endsWith("\n")).toBe(true);
  expect(text).not.toContain('"kind"');
});

const view = (name: (typeof fixtureNames)[number], width = 80) =>
  renderHuman(fixture(name), plainStyle(width), undefined, { details: true });

it("renders status before the first reconcile as rows and the plan and apply hints", () => {
  const text = view("status-before");
  const lines = linesOf(text);
  expect(lines[0]).toBe("tack status · project demo · ! partial");
  expect(text).toContain("0 linked, 12 need attention");
  expect(lines.filter((line) => /^ {2}missing /.test(line))).toHaveLength(12);
  expect(text).toContain("demo:.claude/skills/review");
  expect(text).toContain("demo:.agents/skills/localized");
  expect(text).toContain("2 quarantined candidates");
  expect(text.slice(text.indexOf("Next"))).toBe(
    [
      "Next",
      "  tack sync --project demo",
      "  tack sync --project demo --apply",
      "  tack catalog",
      "",
    ].join("\n"),
  );
  // The destination and quarantine diagnostics are the rows and the catalog line, not repeated.
  expect(text).not.toContain("destination-expected-absent");
  expect(text).not.toContain("catalog-quarantined");
});

it("names each destination's resource through the catalog the style carries, not the payload", () => {
  const registration = "0d5b3402-2162-4620-ae41-ddc81538eb23";
  const referenced = (names: ReadonlyArray<string>, label: string) =>
    makeStyle({
      color: false,
      homeDirectory: "/fx/home",
      width: 120,
      references: {
        entries: names.map((name) => ({
          address: { kind: "skill", name },
          sourceRegistrationId: registration,
        })),
        sources: [{ registration: { id: registration }, label, labelOrigin: "declared" }],
      },
    });
  const render = (style: ReturnType<typeof makeStyle>) =>
    renderHuman(fixture("status-before"), style, undefined, { details: true });
  // `localized` is unique in this catalog, so it keeps its bare name.
  expect(render(referenced(["localized", "review"], "team"))).toContain("skill localized");
  // A resource the catalog does not list keeps its source qualifier: the bare name could mean another.
  expect(render(referenced([], "team"))).toContain("skill team:localized");
  // Without any catalog the registration ID stands in, and the payload alone supplies nothing.
  expect(render(plainStyle(120))).toContain(`skill ${registration}:localized`);
});

it("renders status after reconcile with every destination linked and no destination hints", () => {
  const text = view("status-after");
  expect(text).toContain("12 linked, 0 need attention");
  expect(linesOf(text).filter((line) => /^ {2}linked /.test(line))).toHaveLength(12);
  expect(linesOf(text).filter((line) => /^ {2}(missing|gone|drifted) /.test(line))).toEqual([]);
  expect(text.slice(text.indexOf("Next"))).toBe("Next\n  tack catalog\n");
  const compact = renderHuman(fixture("status-after"), plainStyle(80));
  expect(compact).toContain("12 linked, 0 need attention");
  expect(compact).not.toMatch(/^ {2}linked /m);
});

it("names drifted destinations in words and the scope in the header", () => {
  const text = view("status-trouble");
  expect(text).toContain("2 need attention");
  expect(text).toMatch(/drifted {2}codex {3}demo:\.agents\/skills\/review/);
  expect(text).toMatch(/drifted {2}claude {2}demo:\.claude\/skills\/writer/);
  expect(view("status-user").split("\n")[0]).toBe("tack status · user · ! partial");
  expect(view("status-bare-before").split("\n")[0]).toBe("tack status · project demo · ! partial");
});

it("reproduces the bare scope in hints without adding a selector", () => {
  const text = view("status-bare-before");
  expect(text.slice(text.indexOf("Next"))).toBe(
    "Next\n  tack sync\n  tack sync --apply\n  tack catalog\n",
  );
});

it("shows out-of-scope pending removals as one quiet status line", () => {
  const original = fixture("status-before");
  const withNote = decodeEnvelope({
    ...original,
    diagnostics: [
      ...original.diagnostics,
      {
        code: "pending-removals-outside-scope",
        details: { count: 2, owners: ["other", "user"] },
        message: "2 pending removals outside this scope (other, user).",
        severity: "info",
      },
    ],
  });
  const text = renderHuman(withNote, plainStyle(80));
  expect(text).toContain("  2 pending removals outside this scope (other, user).");
  expect(text).not.toContain("info pending-removals-outside-scope");
});

it("names the containing root on a bare reconciliation plan", () => {
  const original = fixture("plan-before");
  if (original.plan === null || typeof original.plan !== "object" || Array.isArray(original.plan))
    throw new Error("Expected a reconciliation plan fixture.");
  const bare = decodeEnvelope({
    ...original,
    plan: Object.assign({}, original.plan, {
      selection: {
        selector: { _tag: "bare" },
        containingRoot: { projectName: "demo", root: "/fx/リポジトリ" },
        targets: [],
      },
    }),
  });
  expect(renderHuman(bare, plainStyle(120))).toContain(
    "selected from the containing root /fx/リポジトリ",
  );
});

it("reproduces --all in status hints", () => {
  const original = fixture("status-before");
  if (
    original.result === null ||
    typeof original.result !== "object" ||
    Array.isArray(original.result)
  )
    throw new Error("Expected a status fixture.");
  const all = decodeEnvelope({
    ...original,
    result: Object.assign({}, original.result, {
      scope: { _tag: "all" },
      selection: { selector: { _tag: "all" }, targets: [] },
    }),
  });
  const text = renderHuman(all, plainStyle(120));
  expect(text).toContain("tack status · all projects and user");
  expect(text).toContain("tack sync --all");
  expect(text).toContain("tack sync --all --apply");
});

it("lists the user target's destinations with the target they belong to", () => {
  expect(view("status-user", 120)).toContain("user:.claude/skills/use-tack");
});

it("shows catalog resources by kind with tags, and each issue with the file to fix", () => {
  const text = view("catalog", 120);
  expect(text).toContain("Skills (7)");
  expect(text).toContain("Commands (1)");
  expect(text).toContain("Scripts (1)");
  expect(text).toMatch(/use-tack\s+builtin · opt-in/);
  expect(text).toContain("日本語の説明がここにあり");
  expect(text).toContain("Issues (2)");
  expect(text).toMatch(/skill [0-9a-f-]{36}:broken · skill-frontmatter-schema-invalid/);
  expect(text).toContain("/fx/source/skills/broken/SKILL.md");
  expect(text).toContain("/fx/source/skills/日本語スキル/SKILL.md");
  // The summary diagnostic is not repeated once the issues explain it.
  expect(text).not.toContain("catalog-partial");
});

it("tags the user activation a resource resolves to, not the one it declares", () => {
  const text = renderHuman(
    mutated("catalog", (envelope) => {
      const command = envelope.result.resources.find(
        (resource: { kind: string }) => resource.kind === "command",
      );
      const variant = (name: string, userActivation?: string) => ({
        ...command,
        address: { ...command.address, name },
        filePath: `/fx/source/commands/${name}.md`,
        ...(userActivation === undefined ? {} : { userActivation }),
      });
      envelope.result.resources.push(
        variant("c-plain"),
        variant("c-userdefault", "default"),
        variant("c-useroptin", "opt-in"),
      );
    }),
    plainStyle(120),
  );
  const row = (name: string) =>
    linesOf(text)
      .find((line) => line.startsWith(`  ${name} `))
      ?.replace(/\s+/g, " ")
      .trim();
  // An omitted user-activation is opt-in, so it reads the same as a declared one.
  expect(row("c-plain")).toBe("c-plain user opt-in Ship it");
  expect(row("c-useroptin")).toBe("c-useroptin user opt-in Ship it");
  // A user default that matches the project activation needs no tag.
  expect(row("c-userdefault")).toBe("c-userdefault Ship it");
});

it("shows where a context file lives, since context has no description", () => {
  const text = renderHuman(
    mutated("catalog", (envelope) => {
      const source = envelope.result.resources[0];
      envelope.result.resources.push({
        kind: "context",
        address: {
          kind: "context",
          name: "house-rules",
          sourceRegistrationId: source.sourceRegistrationId,
        },
        directoryPath: "/fx/source/context",
        filePath: "/fx/source/context/house-rules.md",
        origin: "registered",
        sourcePath: source.sourcePath,
        sourceRegistrationId: source.sourceRegistrationId,
      });
    }),
    plainStyle(120),
  );
  const section = text.slice(text.indexOf("Context (1)"));
  expect(section).toMatch(/house-rules\s.*\/fx\/source\/context\/house-rules\.md/);
});

it("renders script list as scripts only", () => {
  const text = view("script-list");
  expect(text).toContain("tack catalog · 1 script · ✓ success");
  expect(text).toContain("Scripts (1)");
  expect(text).toMatch(/run\s+Run fixture/);
  expect(text).not.toContain("Skills");
});

it("states that a preview wrote nothing and lists one row per action", () => {
  const text = view("plan-before", 200);
  // The headline counts every row, the directories with the links, as the applied count does.
  expect(text).toContain("Nothing was written. 14 changes planned.");
  expect(linesOf(text).filter((line) => /^ {2}create {2}/.test(line))).toHaveLength(14);
  expect(text).toContain("claude → demo · 6 to link");
  expect(text).toMatch(/create {2}\.claude\/skills\/review\s+skill [0-9a-f-]{36}:review/);
  expect(text).toMatch(/create {2}\.claude\/skills\/\s+directory/);
  expect(text.slice(text.indexOf("Next"))).toBe("Next\n  tack sync --project demo --apply\n");
  expect(view("reconcile-preview")).toContain("Nothing was written.");
});

it("says up to date when nothing is planned and suggests nothing", () => {
  const text = view("plan-after");
  expect(text).toContain("Nothing was written. No change is planned. Everything is up to date.");
  expect(text).toContain("claude → demo · up to date");
  expect(text).not.toContain("Next");
});

it("shows conflicts as rows and as attention, not as planned changes", () => {
  const text = view("plan-trouble", 120);
  expect(text).toContain("No change is planned. 2 items need attention.");
  expect(text).toMatch(/conflict {2}\.claude\/skills\/writer {2}managed-link-drift/);
  expect(text).not.toContain("Everything is up to date");
  expect(text).not.toContain("Next");
});

it("shows removals with their reason", () => {
  const text = view("plan-remove", 120);
  expect(text).toMatch(
    /remove {4}\.claude\/skills\/planner {2}skill [0-9a-f-]{36}:planner · deselected/,
  );
});

/** The `plan-remove` unit with one released and one absent record and no other work. */
const releaseEnvelopes = () => {
  const original = fixture("plan-remove");
  const [unit] = Schema.decodeUnknownSync(ReconciliationPlanSchema)(original.plan).units;
  const removal = unit?.actions[0];
  if (unit === undefined || removal?._tag !== "link-remove") throw new Error("Expected a removal.");
  const retirement = (name: string, reason: "absent" | "released") => ({
    _tag: "evidence-retire" as const,
    destinationPath: removal.destinationPath.replace(/planner$/, name),
    evidence: {
      ...removal.evidence,
      address: { ...removal.evidence.address, name },
      sourceDirectoryPath: `/fx/source/skills/${name}`,
    },
    reason,
  });
  const actions = [retirement("old", "absent"), retirement("planner", "released")];
  // The fixture's plan also carries the selection echo, which the plan schema leaves out.
  const releasePlan = Object.assign({}, original.plan, {
    units: [
      {
        ...unit,
        actions,
        conflicts: [],
        summary: {
          adopt: 0,
          blocked: 0,
          collision: 0,
          conflict: 0,
          create: 0,
          release: 1,
          remove: 0,
          retire: 1,
        },
      },
    ],
  });
  const envelope = {
    ...original,
    classification: "success",
    diagnostics: [],
    plan: releasePlan,
    status: "success",
  };
  return {
    applied: decodeEnvelope({
      ...envelope,
      applied: {
        kind: "skill-reconciliation-application",
        units: [
          {
            actions: actions.map((action) => ({ _tag: "applied", action })),
            adapter: unit.adapter,
            status: "success",
            target: unit.target,
          },
        ],
        version: 1,
      },
    }),
    preview: decodeEnvelope(envelope),
  };
};

it("notes each released link once, apart from the records it only forgets", () => {
  const { applied, preview } = releaseEnvelopes();
  const flat = (text: string) => text.replaceAll(/\s+/g, " ");
  const planned = flat(renderHuman(preview, plainStyle(120)));
  expect(planned).toContain("Nothing was written. 2 changes planned.");
  expect(planned).toContain("claude → demo · 1 to forget, 1 to release");
  expect(planned).toMatch(
    /release \.claude\/skills\/planner skill [0-9a-f-]{36}:planner · changed outside Tack, no longer managed/,
  );
  expect(planned).toMatch(/forget \.claude\/skills\/old skill [0-9a-f-]{36}:old · record only/);
  expect(planned.match(/changed outside Tack/g)).toHaveLength(1);
  const done = flat(renderHuman(applied, plainStyle(120)));
  expect(done).toContain("Applied 1 unit: 2 actions applied, 0 failed, 0 skipped.");
  expect(done).toMatch(
    /applied release \.claude\/skills\/planner skill [0-9a-f-]{36}:planner · changed outside Tack, no longer managed/,
  );
  for (const envelope of [preview, applied])
    expectViewContract(envelope, { homeDirectory: "/fx/home" });
});

it("marks each applied action and counts the outcomes", () => {
  const text = view("reconcile-apply");
  expect(text).toContain("Applied 2 units: 14 actions applied, 0 failed, 0 skipped.");
  expect(linesOf(text).filter((line) => /^ {2}applied {2}create /.test(line))).toHaveLength(14);
  expect(text).not.toContain("Nothing was written");
  expect(text).not.toContain("Next");
});

it("renders help with usage, mode, flags, root flags and examples", () => {
  const text = view("help-status");
  expect(text.split("\n")[0]).toBe("tack help · status · ✓ success");
  expect(text).toMatch(
    /Usage {2}tack status \[flags\]\n {2}Mode {3}read-only|Usage {2}tack status/,
  );
  expect(text).toContain("--project <string>");
  expect(text).toContain("Root flags");
  expect(text.indexOf("--project")).toBeLessThan(text.indexOf("Root flags"));
  expect(text.indexOf("--json")).toBeGreaterThan(text.indexOf("Root flags"));
  expect(text).toContain("Examples");
  expect(text).toContain("  tack status --project demo");
  // A leaf's help points nowhere else: the machine-readable forms are not advertised.
  expect(text).not.toContain("Next");
  expect(text).not.toContain("schema");
  expect(text).not.toContain("--help --json");
});

it("explains what each link state means and what to run, after the examples", () => {
  const text = view("help-status", 100);
  const flat = text.replaceAll(/\s+/g, " ");
  expect(text.indexOf("Examples")).toBeLessThan(text.indexOf("Link states"));
  expect(text).toMatch(/linked {2,}healthy: the link is where Tack recorded it/);
  for (const state of [
    "missing",
    "gone",
    "drifted",
    "changed",
    "hand-made",
    "foreign",
    "conflict",
    "no target",
  ])
    expect(text, state).toContain(state);
  expect(flat).toContain(
    "hand-made a file or folder that was there before Tack linked; Tack keeps it and does not link its resource there. Run `tack pick exclude <source>:<name>` to keep yours on purpose, or move it, then sync",
  );
  expect(flat).toContain("`tack sync --apply`");
  expect(flat).toContain("`tack pick exclude <source>:<name>`");
  expect(text).toMatch(/Exit status\n {2}0 {2}every link is linked/);
  expect(text).toMatch(/ {2}1 {2}something needs attention: the classification is `partial`/);
});

it("labels a changed, deselected link as changed and points at the sync that releases it", () => {
  const original = fixture("status-trouble");
  const report = Schema.decodeUnknownSync(StatusPayloadSchema)(original.result);
  const changed = decodeEnvelope({
    ...original,
    result: Schema.encodeSync(StatusPayloadSchema)({
      ...report,
      destinations: report.destinations.map((destination) =>
        destination._tag === "drift" ? { ...destination, _tag: "evidence-changed" } : destination,
      ),
    }),
  });
  const text = renderHuman(changed, plainStyle(120), undefined, { details: true });
  const rows = linesOf(text).filter((line) => line.startsWith("  changed "));
  expect(rows).toHaveLength(2);
  expect(text).not.toContain("drifted");
  expect(text).toContain("  tack sync --project demo --apply");
});

it("renders group help with its subcommands and a details hint", () => {
  const text = view("help-script");
  expect(text).toContain("Commands");
  expect(text).toMatch(/run {2}Run one declared script/);
  expect(text.slice(text.indexOf("Next"))).toBe("Next\n  tack script run --help\n");
  const root = view("help-root");
  expect(root).not.toContain("Root flags");
  expect(root).toContain("--json");
  expect(root).toMatch(/\n {2}--version +Print/);
});

it("renders the root help as the operation map, grouped by task, with no schema pointer", () => {
  const text = view("help-root", 100);
  expect(text.split("\n")[0]).toBe("tack help · root · ✓ success");
  for (const { title, rows } of operationMap) {
    expect(linesOf(text), title).toContain(title);
    for (const { usage, mode } of rows)
      expect(
        linesOf(text).some((line) => line.startsWith(`  ${usage} `) && line.includes(` ${mode} `)),
        usage,
      ).toBe(true);
  }
  expect(linesOf(text)).toEqual(expect.arrayContaining(["Modes", "Flags"]));
  const flat = text.replaceAll(/\s+/g, " ");
  expect(flat).toContain("--project <name> takes a registered project name, not a path");
  expect(flat).toContain(
    "its payload is stable only for status, sync, doctor, upgrade and --version",
  );
  expect(text).not.toContain("schema");
  expect(text).not.toContain("--help --json");
  expect(text).not.toContain("Next");
  expect(text).not.toContain("Commands");
});

it("keeps every line of the root help within a narrow terminal", () => {
  for (const width of [40, 60, 80])
    expect(
      linesOf(view("help-root", width)).filter((line) => line.length > width),
      `${width} columns`,
    ).toEqual([]);
});

it("lists arguments", () => {
  expect(view("help-choice-set", 120)).toContain("Arguments");
});

it("keeps the root-flag list in step with the root help payload", () => {
  const root = Schema.decodeUnknownSync(HelpPayloadSchema)(fixture("help-root").result);
  expect(root.flags.map(({ name }) => name).toSorted()).toEqual([...rootFlagNames].toSorted());
});

/** The hint commands a view printed, with wrapped continuation lines joined. */
const hintsOf = (text: string): ReadonlyArray<string> => {
  const lines = linesOf(text);
  const start = lines.indexOf("Next");
  if (start === -1) return [];
  const commands: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") continue;
    if (/^ {2}\S/.test(line)) commands.push(line.trim());
    else commands[commands.length - 1] = `${commands.at(-1)?.replace(/ \\$/, "")} ${line.trim()}`;
  }
  return commands.map((command) => command.replace(/ \\$/, ""));
};

const parsed = (command: string) =>
  parseInvocation(command.split(" ").slice(1)).pipe(Effect.provide(BunServices.layer));

it.effect.each(fixtureNames.flatMap((name) => widths.map((width) => [name, width] as const)))(
  "every hint of %s at %i columns parses as the operation it names",
  ([name, width]) =>
    Effect.gen(function* () {
      const text = renderHuman(fixture(name), plainStyle(width));
      for (const hint of hintsOf(text)) {
        expect(hint.startsWith("tack ")).toBe(true);
        const { invocation } = yield* parsed(hint);
        expect(invocation._tag, hint).toMatch(
          /^(sync|clean|catalog|help|status|script-list|choice-set)$/,
        );
      }
    }),
);

it.effect("hints name the scope the envelope reports", () =>
  Effect.gen(function* () {
    const scoped = (name: (typeof fixtureNames)[number]) => hintsOf(view(name));
    expect(scoped("status-before")).toEqual([
      "tack sync --project demo",
      "tack sync --project demo --apply",
      "tack catalog",
    ]);
    expect(scoped("plan-before")).toEqual(["tack sync --project demo --apply"]);
    expect(scoped("status-bare-before")).toEqual([
      "tack sync",
      "tack sync --apply",
      "tack catalog",
    ]);
    const plan = yield* parsed("tack sync --project demo");
    const apply = yield* parsed("tack sync --project demo --apply");
    expect(plan.invocation).toMatchObject({
      _tag: "sync",
      selector: { _tag: "project", projectName: "demo" },
    });
    expect(apply.invocation).toMatchObject({
      _tag: "sync",
      apply: true,
      selector: { _tag: "project", projectName: "demo" },
    });
    const user = yield* parsed("tack sync --user --apply");
    expect(user.invocation).toMatchObject({ _tag: "sync", selector: { _tag: "user" } });
  }),
);

it("wraps a hint with a project name too long for the width and keeps it copyable", () => {
  const envelope = fixture("plan-before");
  const name = "a-project-with-a-rather-long-name";
  const renamed = JSON.parse(
    JSON.stringify(envelope).replaceAll('"projectName":"demo"', `"projectName":"${name}"`),
  );
  const text = renderHuman(decodeEnvelope(renamed), plainStyle(40));
  for (const line of linesOf(text)) expect(displayWidth(line)).toBeLessThanOrEqual(40);
  expect(text).toContain(" \\\n");
  expect(hintsOf(text)).toEqual([`tack sync --project ${name} --apply`]);
});

it("quotes a hint word that a shell would split", () => {
  expect(shellWord("demo-1.x")).toBe("demo-1.x");
  expect(shellWord("a b")).toBe("'a b'");
  expect(shellWord("it's")).toBe("'it'\\''s'");
});

it("renders an unreadable payload through the generic view with every fact", () => {
  for (const [name, slot] of [
    ["status-before", "result"],
    ["catalog", "result"],
    ["script-list", "result"],
    ["help-status", "result"],
    ["plan-before", "plan"],
    ["reconcile-apply", "applied"],
  ] as const) {
    const envelope = fixture(name);
    const broken = decodeEnvelope({ ...envelope, [slot]: { kind: "future-shape", extra: [1, 2] } });
    const text = renderHuman(broken, plainStyle(80));
    expect(text, name).toBe(renderGeneric(broken, plainStyle(80)));
    expect(text, name).toContain('"future-shape"');
  }
});

it("shows a failure with its classification and diagnostics, without a payload", () => {
  const failure = decodeEnvelope({
    applied: null,
    classification: "domain",
    command: "sync",
    diagnostics: [
      {
        code: "project-unknown",
        details: { subject: { projectName: "nope" } },
        message: "The project is not registered.",
        severity: "error",
      },
    ],
    next: [],
    plan: null,
    result: null,
    status: "failure",
    version: 1,
  });
  const text = renderHuman(failure, plainStyle(80));
  expect(text.split("\n")[0]).toBe("tack sync · ✗ domain");
  expect(text).toContain("Problems");
  expect(text).toContain("The project is not registered.");
  expect(text).toContain("error project-unknown · project nope");
  expect(text).not.toContain("Next");
});

it("keeps unknown diagnostic subjects instead of dropping them", () => {
  const envelope = decodeEnvelope({
    ...fixture("catalog"),
    diagnostics: [
      {
        code: "future-code",
        details: { subject: { surprise: { nested: true } } },
        message: "Something new.",
        severity: "warning",
      },
    ],
  });
  expect(renderHuman(envelope, plainStyle(80))).toContain('{"surprise":{"nested":true}}');
});

it("measures wide characters when it pads and wraps", () => {
  const text = view("catalog", 160);
  const localized = linesOf(text).find((line) => line.includes("localized"));
  expect(localized).toBeDefined();
  // The Japanese description starts in the same column as every other description.
  const column = (line: string, marker: string) =>
    displayWidth(line.slice(0, line.indexOf(marker)));
  const planner = linesOf(text).find((line) => line.includes("planner"));
  expect(column(localized ?? "", "日本語")).toBe(column(planner ?? "", "Plan work"));
  for (const line of linesOf(text)) expect(displayWidth(line)).toBeLessThanOrEqual(160);
});

const mutated = (
  name: (typeof fixtureNames)[number],
  // oxlint-disable-next-line typescript/no-explicit-any -- Tests edit captured JSON in place.
  change: (envelope: any) => void,
): PublicEnvelope => {
  const copy: unknown = JSON.parse(JSON.stringify(fixture(name)));
  change(copy);
  return decodeEnvelope(copy);
};

it("never lets third-party control characters reach the terminal", () => {
  const evil = mutated("script-list", (envelope) => {
    envelope.result.resources[0].description = "evil \u001B[2J\u001B]0;pwned\u0007 done\u009B";
  });
  for (const style of [plainStyle(80), colorStyle(80)]) {
    const text = renderHuman(evil, style);
    // oxlint-disable-next-line no-control-regex -- Only the view's own color escapes may remain.
    expect(plainText(text)).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(text).toContain("evil");
  }
});

// oxlint-disable-next-line no-control-regex -- The tests strip color escapes.
const plainText = (text: string) => text.replace(/\u001B\[[0-9;]*m/g, "");

it("keeps a hint word whole even when it is wider than the line", () => {
  const name = "p".repeat(60);
  const renamed = decodeEnvelope(
    JSON.parse(
      JSON.stringify(fixture("plan-before")).replaceAll(
        '"projectName":"demo"',
        `"projectName":"${name}"`,
      ),
    ),
  );
  expect(hintsOf(renderHuman(renamed, plainStyle(40)))).toEqual([
    `tack sync --project ${name} --apply`,
  ]);
});

it("fits a single overlong name in a table at the narrowest width", () => {
  const long = mutated("script-list", (envelope) => {
    envelope.result.resources[0].address.name = "a".repeat(100);
  });
  for (const line of linesOf(renderHuman(long, plainStyle(40))))
    expect(displayWidth(line)).toBeLessThanOrEqual(40);
});

it("shows the reason of a diagnostic issue and not only its path", () => {
  const text = renderHuman(
    mutated("catalog", (envelope) => {
      envelope.diagnostics = [
        {
          code: "source-unhealthy",
          details: {
            subject: {
              issue: { code: "source-missing", message: "Directory does not exist" },
              registration: { canonicalPath: "/fx/source" },
            },
          },
          message: "A registered source is unhealthy.",
          severity: "warning",
        },
      ];
    }),
    plainStyle(120),
  );
  expect(text).toContain("/fx/source · source-missing: Directory does not exist");
});

it("counts quarantined candidates in the status overview", () => {
  expect(view("status-before")).toContain("2 quarantined candidates");
});

it("does not paint a unit with collisions or blocked work as up to date", () => {
  const collided = mutated("plan-after", (envelope) => {
    envelope.plan.units[0].summary.collision = 1;
  });
  const heading = renderHuman(collided, colorStyle(80))
    .split("\n")
    .find((line) => line.includes("1 collision"));
  expect(heading).toBeDefined();
  expect(heading).not.toContain("\u001B[32m1\u001B[39m");
  expect(plainText(heading ?? "")).not.toContain("up to date");
});

it("wraps key and value rows at words, not inside a word", () => {
  const text = view("status-before", 40);
  expect(text).toContain("candidates");
  expect(text).not.toMatch(/c\n *andidates/);
});

it("names a failed or blocked unit in an apply report", () => {
  const failed = mutated("reconcile-apply", (envelope) => {
    envelope.applied.units[0].status = "failed";
  });
  expect(plainText(renderHuman(failed, plainStyle(80)))).toContain("unit failed");
});

/** A combined sync envelope around a fixture's resource plan, as `sync` reports it. */
const syncEnvelope = (options: object | undefined): PublicEnvelope => {
  const { plan, ...rest } = fixture("plan-before");
  return decodeEnvelope({
    ...rest,
    plan: {
      kind: "sync-plan",
      resources: plan,
      docs: [],
      ...(options === undefined ? {} : { options }),
    },
  });
};

it("keeps every narrowing flag of a sync preview on the apply command it suggests", () => {
  expect(hintsOf(renderHuman(syncEnvelope(undefined), plainStyle(200)))).toEqual([
    "tack sync --project demo --apply",
  ]);
  expect(
    hintsOf(
      renderHuman(
        syncEnvelope({
          adapters: ["claude", "codex"],
          includeOptional: true,
          noDocs: true,
          requiredCapability: "skill-links",
        }),
        plainStyle(200),
      ),
    ),
  ).toEqual([
    "tack sync --project demo --adapter claude --adapter codex --require-capability skill-links --include-optional --no-docs --apply",
  ]);
});
