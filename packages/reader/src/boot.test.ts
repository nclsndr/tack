import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { readerBoot } from "./boot.ts";
import { generatedCorpus } from "./generated-corpus.test-support.ts";
import { loadProjectCorpus } from "./project-corpus.ts";
import { readerRoutes } from "./routes.ts";
import type { ReaderProjectCorpus, ReaderProjectInput } from "./types.ts";

let input: ReaderProjectInput;
let corpus: ReaderProjectCorpus;

beforeAll(async () => {
  input = await generatedCorpus(3);
  corpus = await loadProjectCorpus({
    ...input,
    resources: [
      ...input.resources,
      { ...input.resources[0]!, name: "gone", directoryPath: join(input.project.root, "gone") },
    ],
  });
});

describe("readerBoot", () => {
  it("names the project and lists every attached resource, loaded or not", async () => {
    const boot = readerBoot({
      input,
      corpus,
      generation: "generation-one",
      token: "session",
      checkout: { kind: "branch", name: "feat/billing-export" },
      version: "0.1.0+dev",
    });
    const sourcePath = await realpath(input.project.root);

    expect(boot).toMatchObject({
      worktree: input.project.root,
      project: { name: "Generated notes" },
      checkout: { kind: "branch", name: "feat/billing-export" },
      version: "0.1.0+dev",
      complete: false,
      token: "session",
    });
    expect(boot.resources).toEqual([
      {
        sourceRegistrationId: "generated",
        name: "notes",
        sourcePath,
        directoryPath: join(sourcePath, "docs"),
      },
      {
        sourceRegistrationId: "generated",
        name: "gone",
        sourcePath: input.project.root,
        directoryPath: join(input.project.root, "gone"),
      },
    ]);
    expect(boot.documents).toHaveLength(3);
    expect(boot.issues).toEqual(corpus.issues);
  });

  it("boots with the revision the status route reports for the same generation", () => {
    const boot = readerBoot({
      input,
      corpus,
      generation: "generation-one",
      token: "session",
      checkout: null,
    });

    expect(boot.revision).toBe(
      readerRoutes({ token: "session", load: async () => corpus }).publish(
        corpus,
        "generation-one",
      ),
    );
  });

  it("keeps a project outside git without a checkout, and a reader without a version", () => {
    const boot = readerBoot({ input, corpus, generation: "one", token: "session", checkout: null });

    expect(boot.checkout).toBeNull();
    expect("version" in boot).toBe(false);
  });

  it("lists the unusable Icon names of the served documents for the issue popover", () => {
    const [first, ...rest] = corpus.documents;
    if (first === undefined) throw new Error("Missing document");
    const withIcon = {
      ...first,
      path: first.path.replace(/\.mdx?$/, ".mdx"),
      source: '# Icons\n\n<Icon name="home" />\n\n<Term>bare</Term>\n',
    };
    const boot = readerBoot({
      input,
      corpus: { ...corpus, documents: [withIcon, ...rest] },
      generation: "one",
      token: "session",
      checkout: null,
    });

    expect(boot.iconIssues).toEqual([
      {
        path: withIcon.path,
        line: 3,
        name: "home",
        message: 'unknown icon "home": Lucide renamed it "house"',
        suggestions: ["house"],
      },
    ]);
    expect(boot.componentIssues).toEqual([
      {
        path: withIcon.path,
        line: 5,
        component: "Term",
        message: 'a Term needs its definition, such as title="A folder Tack reads"',
      },
    ]);
    expect(
      readerBoot({ input, corpus, generation: "one", token: "s", checkout: null }).iconIssues,
    ).toEqual([]);
  });

  it("names each archive folder by its resource and its path inside the docs directory", () => {
    const resources = corpus.resources.map((entry) =>
      entry.config === undefined
        ? entry
        : {
            ...entry,
            config: {
              ...entry.config,
              navigation: {
                ...entry.config.navigation,
                archive: [join(entry.resource.directoryPath, "old", "2024")],
              },
            },
          },
    );
    const boot = readerBoot({
      input,
      corpus: { ...corpus, resources },
      generation: "one",
      token: "session",
      checkout: null,
    });

    expect(boot.archive).toEqual([`generated:notes:${join("old", "2024")}`]);
  });
});
