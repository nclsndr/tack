import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changedPaths, needsGates } from "./ci-scope.ts";

describe("needsGates", () => {
  it.each([
    { label: "an evals-only change", paths: ["evals/src/main.ts", "evals/README.md"] },
    { label: "a website-only change", paths: ["apps/website/docs/index.mdx"] },
    {
      label: "a change to evals and the website only",
      paths: ["evals/tasks/a.ts", "apps/website/rspress.config.ts"],
    },
  ])("skips the gates for $label", ({ paths }) => {
    expect(needsGates(paths)).toBe(false);
  });

  it.each([
    { label: "a CLI change", paths: ["apps/cli/src/main.ts"] },
    { label: "an evals change with a CLI change", paths: ["evals/src/main.ts", "apps/cli/x.ts"] },
    { label: "a harness change the website uses", paths: ["packages/harness/src/index.ts"] },
    {
      label: "a lockfile change beside the website",
      paths: ["apps/website/package.json", "bun.lock"],
    },
    { label: "a root doc change", paths: ["README.md"] },
    { label: "a workflow change", paths: [".github/workflows/ci.yml"] },
    {
      label: "a sibling folder whose name starts like the website's",
      paths: ["apps/website-x/a.ts"],
    },
    { label: "a root file whose name starts like the evals folder", paths: ["evals.md"] },
    { label: "no changed file at all", paths: [] },
  ])("runs the gates for $label", ({ paths }) => {
    expect(needsGates(paths)).toBe(true);
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
