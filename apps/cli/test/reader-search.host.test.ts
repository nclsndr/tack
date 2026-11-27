import { encodeStateFixture } from "./support/state-fixture.ts";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { exitCodeForEnvelope } from "../src/cli/envelope/public-outcome.ts";
import {
  ReaderCorpus,
  ReaderSearchError,
  type ReaderCorpusService,
} from "../src/services/reader-corpus.ts";
import { ReaderCorpusLive } from "../src/platform/reader/search.ts";
import { Git } from "../src/services/git.ts";

import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const unusedGit = Git.of({
  resolveCommonDirectory: () => Effect.die("Search must not discover registrations"),
  listWorktrees: () => Effect.die("Search must not discover other worktrees"),
});
const runSearch = Effect.fnUntraced(function* (args: string[], corpus: ReaderCorpusService) {
  const suppliedRoot = args[args.indexOf("--cwd") + 1];
  const root =
    args.includes("--cwd") && suppliedRoot !== undefined && suppliedRoot !== "/tmp/selected"
      ? suppliedRoot
      : yield* Effect.acquireRelease(
          Effect.promise(async () => realpath(await mkdtemp(join(tmpdir(), "tack-search-host-")))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        );
  yield* Effect.promise(async () => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "tack.yaml"),
      "version: 1\nname: demo\ndocs:\n  - name: docs\n    path: docs\n" +
        (args.includes("--config") ? "    reader: custom.yaml\n" : ""),
    );
    await writeFile(
      join(root, "state.json"),
      encodeStateFixture({
        version: 1,
        data: {
          sources: [{ id: "00000000-0000-4000-8000-000000000001", canonicalPath: root }],
          projects: [{ name: "demo", gitCommonDirectory: join(root, "git"), roots: [root] }],
          docsProjects: [
            {
              projectName: "demo",
              attachments: [
                {
                  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",

                  name: "docs",
                },
              ],
            },
          ],
        },
      }),
    );
  });
  const registeredArgs = [
    "--state-dir",
    root,
    ...args.filter(
      (value, index) =>
        value !== "--cwd" &&
        args[index - 1] !== "--cwd" &&
        value !== "--config" &&
        args[index - 1] !== "--config",
    ),
    "--project",
    "demo",
  ];
  const {
    exit,
    stdout: output,
    stderr,
  } = yield* runHost({ args: ["--json", ...registeredArgs], git: unusedGit }).pipe(
    Effect.provideService(ReaderCorpus, corpus),
    Effect.provide(LiveTestLayer),
  );
  expect(output.trim().split("\n")).toHaveLength(1);
  expect(stderr).toBe("");
  const envelope = decodeEnvelope(output);
  return { envelope, exit };
});

it.effect("searches the registered project corpus without Git discovery or reader startup", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const corpus = ReaderCorpus.of({
      checkFigures: () => Effect.die("the figure check is not used here"),
      loadProject: (input) => {
        calls.push(input.project.name);
        return Effect.succeed({ documents: [], resources: [], issues: [], complete: true });
      },
    });
    const { envelope, exit } = yield* runSearch(
      ["docs", "search", "unmatched", "--cwd", "/tmp/selected", "--config", "custom.yaml"],
      corpus,
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(envelope).toMatchObject({
      command: "docs search",
      classification: "success",
      applied: null,
      plan: null,
      result: {
        project: { name: "demo" },
        complete: true,
        query: "unmatched",
        limit: 10,
        total: 0,
        truncated: false,
        hits: [],
      },
    });
    expect(calls).toEqual(["demo"]);
  }),
);

it.effect(
  "classifies search loading failures and rejects invalid invocations before corpus access",
  () =>
    Effect.gen(function* () {
      for (const kind of ["configuration", "read"] as const) {
        const corpus = ReaderCorpus.of({
          checkFigures: () => Effect.die("the figure check is not used here"),
          loadProject: () =>
            Effect.fail(
              new ReaderSearchError({ kind, message: "Cannot load the declared corpus" }),
            ),
        });
        const { envelope, exit } = yield* runSearch(["docs", "search", "ownership"], corpus);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(envelope).toMatchObject({
          command: "docs search",
          classification: kind === "configuration" ? "invalid-configuration" : "internal",
          diagnostics: [
            {
              code: kind === "configuration" ? "reader-configuration" : "reader-search-read",
              message: "Cannot load the declared corpus",
            },
          ],
        });
        expect(exitCodeForEnvelope(envelope)).toBe(kind === "configuration" ? 2 : 3);
      }
      const unused = ReaderCorpus.of({
        checkFigures: () => Effect.die("the figure check is not used here"),
        loadProject: () => Effect.die("Invalid query must not load corpus"),
      });
      const invalid = yield* runSearch(["docs", "search", " "], unused);
      expect(invalid.envelope.classification).toBe("invalid-invocation");
      expect(exitCodeForEnvelope(invalid.envelope)).toBe(2);
    }),
);

it.effect("searches only configured saved documents and reloads imported contributor edits", () =>
  Effect.gen(function* () {
    const root = yield* Effect.promise(async () =>
      realpath(await mkdtemp(join(tmpdir(), "tack-search-"))),
    );
    try {
      yield* Effect.promise(async () => {
        await mkdir(join(root, "docs"));
        await writeFile(
          join(root, "custom.yaml"),
          Bun.YAML.stringify({
            version: 1,
            content: [{ root: "docs", include: ["**/*.mdx"], exclude: ["hidden.mdx"] }],
            navigation: { preset: "folders" },
            layouts: { preset: "reader" },
            components: { preset: "standard" },
            metadata: { preset: "working-docs" },
          }),
        );
        await writeFile(
          join(root, "docs", "page.mdx"),
          '---\ntitle: Decisions\ntype: spec\nstatus: active\n---\n\nimport { content } from "./_data.ts";\n\n<Example content={content} />\n',
        );
        await writeFile(
          join(root, "docs", "_data.ts"),
          'export const content = "ownership alpha";\n',
        );
        await writeFile(
          join(root, "docs", "hidden.mdx"),
          "---\ntitle: ownership hidden\n---\nHidden ownership.\n",
        );
      });
      const corpus = yield* ReaderCorpus;
      const args = [
        "docs",
        "search",
        "ownership alpha",
        "--cwd",
        root,
        "--config",
        "custom.yaml",
        "--type",
        "spec",
        "--status",
        "active",
      ];
      const first = yield* runSearch(args, corpus);
      expect(first.envelope).toMatchObject({
        classification: "success",
        result: {
          kind: "reader-search",
          total: 1,
          hits: [
            {
              document: { relativePath: "page.mdx" },
              matches: [
                {
                  excerpt: expect.stringContaining("ownership alpha"),
                  source: { path: join(root, "docs", "page.mdx"), startLine: 9, endLine: 9 },
                  contributors: [
                    {
                      path: join(root, "docs", "_data.ts"),
                      startLine: 1,
                      endLine: 1,
                      kind: "data",
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
      yield* Effect.promise(() =>
        writeFile(join(root, "docs", "_data.ts"), 'export const content = "ownership beta";\n'),
      );
      expect((yield* runSearch(args, corpus)).envelope).toMatchObject({
        result: { total: 0, hits: [] },
      });
      const revised = yield* runSearch(
        ["docs", "search", "ownership beta", "--cwd", root, "--config", "custom.yaml"],
        corpus,
      );
      expect(revised.envelope).toMatchObject({ result: { total: 1 } });
    } finally {
      yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(ReaderCorpusLive)),
);
