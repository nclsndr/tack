import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedPaths, needsGates, needsSuite } from "./ci-scope.ts";

/** Changes made of guidance documents only: the suite and the gates both skip. */
const guidanceOnly = [
  { label: "an agent guide change", paths: ["AGENTS.md"] },
  {
    label: "a change to every root guide",
    paths: ["README.md", "CONTRIBUTING.md", "CONTEXT.md", "SECURITY.md"],
  },
  { label: "a repository skill change", paths: [".ai/skills/tack-git/SKILL.md"] },
  { label: "a pull request template change", paths: [".github/pull_request_template.md"] },
  { label: "a workflows readme change", paths: [".github/workflows/README.md"] },
];

/** Changes that reach the CLI, its package, or CI itself: the suite and the gates both run. */
const fullRun = [
  { label: "a CLI change", paths: ["apps/cli/src/main.ts"] },
  { label: "a guide change with a CLI change", paths: ["AGENTS.md", "apps/cli/src/main.ts"] },
  { label: "a CLI readme change", paths: ["apps/cli/README.md"] },
  { label: "a built-in skill change", paths: ["apps/cli/src/builtins/skills/use-tack/SKILL.md"] },
  { label: "a harness change the website uses", paths: ["packages/harness/src/index.ts"] },
  {
    label: "a lockfile change beside the website",
    paths: ["apps/website/package.json", "bun.lock"],
  },
  { label: "a license change, which the package ships", paths: ["LICENSE"] },
  { label: "a source declaration change", paths: ["tack.yaml"] },
  { label: "a workflow change", paths: [".github/workflows/ci.yml"] },
  {
    label: "a workflow change beside the workflows readme",
    paths: [".github/workflows/README.md", ".github/workflows/ci.yml"],
  },
  { label: "a script change", paths: ["scripts/ci-scope.ts"] },
  {
    label: "a sibling folder whose name starts like the website's",
    paths: ["apps/website-x/a.ts"],
  },
  { label: "a root file whose name starts like the evals folder", paths: ["evals.md"] },
  { label: "a root file whose name starts like a guide", paths: ["AGENTS.md.bak"] },
  { label: "a folder whose name starts like the skills folder", paths: [".ai-tools/a.ts"] },
  { label: "a guide name in a nested folder", paths: ["packages/core/AGENTS.md"] },
  { label: "no changed file at all", paths: [] },
];

/** Changes to evals and the website, maybe with guides: the suite runs, the gates skip. */
const gateFree = [
  { label: "an evals-only change", paths: ["evals/src/main.ts", "evals/README.md"] },
  { label: "a website-only change", paths: ["apps/website/docs/index.mdx"] },
  {
    label: "a change to evals and the website only",
    paths: ["evals/tasks/a.ts", "apps/website/rspress.config.ts"],
  },
  { label: "a website change with a guide change", paths: ["apps/website/a.ts", "AGENTS.md"] },
];

describe("needsGates", () => {
  it.each([...guidanceOnly, ...gateFree])("skips the gates for $label", ({ paths }) => {
    expect(needsGates(paths)).toBe(false);
  });

  it.each(fullRun)("runs the gates for $label", ({ paths }) => {
    expect(needsGates(paths)).toBe(true);
  });
});

describe("needsSuite", () => {
  it.each(guidanceOnly)("skips the suite for $label", ({ paths }) => {
    expect(needsSuite(paths)).toBe(false);
  });

  it.each([...fullRun, ...gateFree])("runs the suite for $label", ({ paths }) => {
    expect(needsSuite(paths)).toBe(true);
  });
});

describe("changedPaths", () => {
  const roots: Array<string> = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=ci",
        "-c",
        "user.email=ci@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, stdio: "ignore" },
    );
  };

  const write = (cwd: string, path: string, text: string): void => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };

  /** A repository on `main` with one CLI and one evals file. */
  const repository = (): string => {
    const root = mkdtempSync(join(tmpdir(), "tack-ci-scope-"));
    roots.push(root);
    git(root, "init", "--quiet", "--initial-branch=main");
    write(root, "apps/cli/src/main.ts", "export {};\n");
    write(root, "evals/src/main.ts", "export {};\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "base");
    return root;
  };

  /** Commits the branch's change, then checks out its merge into `main` the way CI does. */
  const mergeBranch = (root: string, change: (root: string) => void): void => {
    git(root, "checkout", "--quiet", "-b", "feature");
    change(root);
    git(root, "add", "--all");
    git(root, "commit", "--quiet", "-m", "change");
    git(root, "checkout", "--quiet", "main");
    write(root, "README.md", "# Later\n");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "main moved on");
    git(root, "merge", "--quiet", "--no-ff", "-m", "merge", "feature");
  };

  it("lists what the branch changes against its base, not what the base gained since", () => {
    const root = repository();
    mergeBranch(root, (cwd) => write(cwd, "evals/src/main.ts", "export const a = 1;\n"));
    expect(changedPaths(root)).toEqual(["evals/src/main.ts"]);
  });

  it("lists both ends of a rename, so a file moved into evals still counts its old place", () => {
    const root = repository();
    mergeBranch(root, (cwd) => git(cwd, "mv", "apps/cli/src/main.ts", "evals/src/moved.ts"));
    expect(changedPaths(root)).toEqual(["apps/cli/src/main.ts", "evals/src/moved.ts"]);
  });

  it("knows nothing when HEAD is not a merge commit", () => {
    expect(changedPaths(repository())).toBeUndefined();
  });
});
