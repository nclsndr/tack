import { Schema } from "effect";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { StatusPayloadSchema, type StatusPayload } from "../../../domain/status/status-schema.ts";
import { envelopeOf, flat, hintRecorder, humanFixture } from "./human.test-support.ts";
import { renderStatus } from "./status.ts";

const trouble = humanFixture("status-trouble");
const payload = Schema.decodeUnknownSync(StatusPayloadSchema)(trouble.result);
const root = "/fx/リポジトリ";
const sourceId = "0d5b3402-2162-4620-ae41-ddc81538eb23";
const [namespace] = payload.namespaces;
if (namespace === undefined) throw new Error("The status-trouble fixture has no namespace.");

/** Renders the fixture's status with `changes` applied, recording the Next hints. */
const render = (changes: Partial<StatusPayload>, details = false) => {
  const { hints, style } = hintRecorder();
  const text = renderStatus(
    envelopeOf({
      command: "status",
      classification: trouble.classification,
      diagnostics: trouble.diagnostics,
      result: { ...payload, ...changes },
    }),
    style,
    details,
  );
  if (text === undefined) throw new Error("The changed status payload no longer decodes.");
  return { hints, text, flatText: flat(text) };
};

const byPath = (left: { destinationPath: string }, right: { destinationPath: string }) =>
  left.destinationPath < right.destinationPath
    ? -1
    : left.destinationPath > right.destinationPath
      ? 1
      : 0;

describe("status view", () => {
  it("shows a directory alias once, naming each adapter's own directory", () => {
    const sharing = (adapter: "claude" | "codex") => ({
      adapters: ["claude", "codex"] as const,
      directory: `${root}/${adapter === "codex" ? ".agents" : ".claude"}/skills`,
      physicalDirectory: `${root}/.agents/skills`,
      role: adapter === "codex" ? ("writer" as const) : ("shared" as const),
      writer: "codex" as const,
    });
    const { text, flatText } = render(
      {
        destinations: payload.destinations.map((destination) => ({
          ...destination,
          sharing: sharing(destination.adapter === "codex" ? "codex" : "claude"),
        })),
      },
      true,
    );
    expect(text).toContain("\nAgent directories 1 shared directory\n");
    expect(flatText).toContain(
      "Agent directories 1 shared directory codex /fx/リポジトリ/.agents/skills (physical) claude /fx/リポジトリ/.claude/skills → /fx/リポジトリ/.agents/skills For .gitignore",
    );
  });

  it.each([
    [1, "needs"],
    [2, "need"],
  ])("agrees the verb with %i destination(s) needing attention", (count, verb) => {
    const attention = payload.destinations.filter(({ _tag }) => _tag !== "matching");
    if (attention.length < count) throw new Error("The fixture has too few troubled destinations.");
    const { flatText } = render({ destinations: attention.slice(0, count) });
    expect(flatText).toContain(`0 linked, ${count} ${verb} attention`);
  });

  it("prints one .gitignore line per project link, unwrapped, only with --details", () => {
    const second = "/fx/second-worktree";
    const inSecondRoot = payload.destinations
      .filter(({ destinationPath }) => destinationPath.endsWith("/tester"))
      .map((destination) => ({
        ...destination,
        destinationPath: destination.destinationPath.replace(root, second),
        target: { ...destination.target, canonicalPath: second },
      }));
    const handMade = {
      _tag: "hand-made" as const,
      adapter: "cursor" as const,
      destinationPath: `${root}/.cursor/skills/mine`,
      observed: { _tag: "entry" as const, entryType: "directory" as const },
      target: { _tag: "project-root" as const, canonicalPath: root, projectName: "demo" },
      targetHealth: "healthy" as const,
    };
    // A link outside its repository has no line in that repository's .gitignore.
    const [tester] = inSecondRoot;
    if (tester === undefined) throw new Error("The status-trouble fixture has no tester link.");
    const outside = { ...tester, destinationPath: "/fx/elsewhere/.claude/skills/tester" };
    const destinations = [...payload.destinations, ...inSecondRoot, handMade, outside].sort(byPath);
    const { text } = render({ destinations }, true);
    const section = text.split("\nFor .gitignore in project demo\n")[1]?.split("\n\n")[0];
    // Both roots share each path, so each line shows once; a drifted link keeps its line.
    expect(section?.split("\n").filter((line) => line.startsWith("/"))).toEqual([
      "/.agents/skills/localized",
      "/.agents/skills/planner",
      "/.agents/skills/review",
      "/.agents/skills/reviewer-with-a-very-long-skill-name-that-stretches-columns",
      "/.agents/skills/tester",
      "/.agents/skills/writer",
      "/.claude/skills/localized",
      "/.claude/skills/planner",
      "/.claude/skills/review",
      "/.claude/skills/reviewer-with-a-very-long-skill-name-that-stretches-columns",
      "/.claude/skills/tester",
      "/.claude/skills/writer",
    ]);
    expect(flat(section)).toContain("no trailing /");
    expect(flat(section)).toContain("A new skill needs its own line");
    expect(render({ destinations }).text).not.toContain("For .gitignore");
  });

  it.each([
    [".tack/docs", "/.tack/"],
    ["vendor/docs", "/vendor/docs/"],
  ])("prints the folder of docs mounted under %s among the .gitignore lines", (folder, line) => {
    const projects = payload.projects.map((project) => ({ ...project, docsDestination: folder }));
    const ignored = (destinations: StatusPayload["destinations"]) =>
      render({ destinations, projects }, true)
        .text.split("\nFor .gitignore in project demo\n")[1]
        ?.split("\n\n")[0]
        ?.split("\n")
        .filter((entry) => entry.startsWith("/"));
    expect(ignored(payload.destinations)).toContain(line);
    const docsNote = "The docs mounts are in a folder, so their line ends with /.";
    expect(flat(render({ projects }, true).text)).toContain(docsNote);
    expect(flat(render({}, true).text)).not.toContain(docsNote);
    // A project with docs and no agent link still gets its docs line.
    expect(ignored([])).toEqual([line]);
    expect(render({ destinations: [], projects }).text).not.toContain("For .gitignore");
  });

  it("prints no .gitignore lines for the user's links", () => {
    const user = humanFixture("status-user");
    const text = renderStatus(user, hintRecorder().style, true);
    expect(text).not.toContain("For .gitignore");
  });

  it("shows no agent directories when no destination is shared", () => {
    expect(render({}, true).text).not.toContain("Agent directories");
  });

  it("shows a fixed profile's issues and a removing namespace with nothing selected", () => {
    const address = { kind: "skill", name: "review", sourceRegistrationId: sourceId } as const;
    const { text, flatText } = render({
      namespaces: [
        {
          ...namespace,
          profile: {
            application: {
              namespace: namespace.namespace,
              profileName: "daily",
              sourceRegistrationId: sourceId,
              direct: [address],
              inventory: [address],
              targets: [root],
            },
            issues: ["review is not delivered by codex"],
            delivery: {
              notes: [],
              issues: ["claude cannot read commands"],
              skipped: [],
              incomplete: true,
            },
          },
          lifecycle: "suspended-removing",
          desired: [],
          choices: namespace.choices.map((choice, index) =>
            index === 0 ? { ...choice, decision: "exclude" as const } : choice,
          ),
          undelivered: [
            { address, reason: "no-enabled-adapter" },
            { address, reason: "no-enabled-adapter" },
          ],
        },
      ],
    });
    expect(text).toContain(
      "Fixed profile daily: 1 retained members\n  review is not delivered by codex\n  claude cannot read commands\nProject demo  (removing)\n",
    );
    expect(flatText).toContain("selected nothing");
    expect(flatText).toContain(`choices −skill ${sourceId}:localized +skill ${sourceId}:planner`);
    expect(flatText).toContain(`not delivered skill ${sourceId}:review (no adapter enabled)`);
  });

  it("names a destination outside its target by path, and one without a resource by path alone", () => {
    const outside = {
      _tag: "foreign-entry" as const,
      adapter: "claude" as const,
      destinationPath: "/home/me/elsewhere/skill",
      target: { _tag: "project-root" as const, canonicalPath: root, projectName: "demo" },
      targetHealth: "healthy" as const,
    };
    const { text } = render({ destinations: [...payload.destinations, outside].sort(byPath) });
    expect(text).toMatch(/ {2}foreign {2}claude {2}~\/elsewhere\/skill *\n/);
  });

  it("says a hand-made entry is kept and names the exclude that keeps it on purpose", () => {
    const address = { kind: "skill", name: "review", sourceRegistrationId: sourceId } as const;
    const handMade = {
      _tag: "hand-made" as const,
      adapter: "claude" as const,
      address,
      destinationPath: `${root}/.cursor/skills/review`,
      observed: { _tag: "entry" as const, entryType: "directory" as const },
      target: { _tag: "project-root" as const, canonicalPath: root, projectName: "demo" },
      targetHealth: "healthy" as const,
    };
    // An entry no resource is named for has no exclude to suggest.
    const { address: _address, ...unnamed } = {
      ...handMade,
      destinationPath: `${root}/.cursor/skills/zz`,
    };
    const { flatText, hints } = render({ destinations: [handMade, unnamed] });
    expect(flatText).toContain(
      `0 linked, 2 need attention hand-made claude demo:.cursor/skills/review kept; Tack's skill ${sourceId}:review is not linked hand-made claude demo:.cursor/skills/zz Adapters`,
    );
    expect(hints).toEqual([
      "tack catalog",
      `tack pick exclude ${sourceId}:review --kind skill --project demo`,
    ]);
  });

  it("counts imports without local changes or problems", () => {
    const { flatText } = render({ imports: { total: 2, locallyChanged: 0, problems: [] } });
    expect(flatText).toContain("Imports 2 imported skills State");
  });

  it("counts imports, local changes, problems and owed docs removals, and offers the fixes", () => {
    const destinationPath = `${root}/.tack/docs/handbook`;
    const sourceDirectoryPath = "/fx/source/docs/handbook";
    const { flatText, hints } = render({
      imports: {
        total: 3,
        locallyChanged: 1,
        problems: [
          {
            code: "import-folder-not-cataloged",
            source: "personal-brain",
            registrationId: sourceId,
            reference: "personal-brain:writer",
            path: "skills/writer",
            message: "The imported folder is not in the catalog.",
          },
        ],
      },
      docsPendingRemovals: [
        {
          cause: "clean",
          evidence: {
            projectName: "demo",
            root,
            resource: { sourceRegistrationId: sourceId, name: "handbook" },
            destinationPath,
            sourceDirectoryPath,
            relativeTarget: posix.relative(posix.dirname(destinationPath), sourceDirectoryPath),
          },
        },
      ],
    });
    expect(flatText).toContain("Imports 3 imported skills, 1 locally changed, 1 problem");
    expect(flatText).toContain("Pending 1 cleanup obligation");
    expect(hints).toEqual([
      "tack sync --project demo",
      "tack sync --project demo --apply",
      "tack state clean --pending --project demo",
      "tack catalog",
    ]);
  });
});
