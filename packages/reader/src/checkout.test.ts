import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCheckout } from "./checkout.ts";

async function directory(...parts: string[]): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "tack-checkout-")), ...parts);
  await mkdir(path, { recursive: true });
  return path;
}

async function repository(head: string): Promise<string> {
  const root = await directory("project");
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "HEAD"), head);
  return root;
}

describe("readCheckout", () => {
  it("names the checked-out branch, keeping slashes in its name", async () => {
    const root = await repository("ref: refs/heads/feat/billing-export\n");

    expect(await readCheckout(root)).toEqual({ kind: "branch", name: "feat/billing-export" });
  });

  it("keeps the whole reference of a symbolic head outside refs/heads", async () => {
    const root = await repository("ref: refs/remotes/origin/main\n");

    expect(await readCheckout(root)).toEqual({ kind: "branch", name: "refs/remotes/origin/main" });
  });

  it("shortens a detached head to its abbreviated commit", async () => {
    const root = await repository("0123456789abcdef0123456789abcdef01234567\n");

    expect(await readCheckout(root)).toEqual({ kind: "detached", commit: "0123456" });
  });

  it("follows the gitdir file of a linked worktree to its own HEAD", async () => {
    const main = await repository("ref: refs/heads/main\n");
    const worktreeGit = join(main, ".git", "worktrees", "second");
    await mkdir(worktreeGit, { recursive: true });
    await writeFile(join(worktreeGit, "HEAD"), "ref: refs/heads/review\n");
    const linked = await directory("second");
    await writeFile(join(linked, ".git"), `gitdir: ${worktreeGit}\n`);

    expect(await readCheckout(linked)).toEqual({ kind: "branch", name: "review" });
  });

  it("resolves a relative gitdir against the worktree", async () => {
    const root = await directory("project");
    await mkdir(join(root, "modules", "child"), { recursive: true });
    await writeFile(join(root, "modules", "child", "HEAD"), "ref: refs/heads/topic\n");
    const linked = join(root, "linked");
    await mkdir(linked);
    await writeFile(join(linked, ".git"), "gitdir: ../modules/child\n");

    expect(await readCheckout(linked)).toEqual({ kind: "branch", name: "topic" });
  });

  it("finds the repository from a folder inside it, as git does", async () => {
    const root = await repository("ref: refs/heads/main\n");
    const nested = join(root, "packages", "docs");
    await mkdir(nested, { recursive: true });

    expect(await readCheckout(nested)).toEqual({ kind: "branch", name: "main" });
  });

  it("reports no checkout for a folder outside any repository", async () => {
    expect(await readCheckout(await directory("plain"))).toBeNull();
  });

  it("reports no checkout for a missing root instead of failing", async () => {
    expect(await readCheckout(join(await directory("gone"), "missing"))).toBeNull();
  });

  it.each([
    ["an unreadable HEAD", "", "directory"],
    ["a HEAD it cannot parse", "not a reference\n", "file"],
  ])("reports no checkout for %s", async (_case, head, kind) => {
    const root = await directory("project");
    await mkdir(join(root, ".git"));
    if (kind === "directory") await mkdir(join(root, ".git", "HEAD"));
    else await writeFile(join(root, ".git", "HEAD"), head);

    expect(await readCheckout(root)).toBeNull();
  });

  it("reports no checkout for a gitdir file that names no repository, even inside another", async () => {
    const outer = await repository("ref: refs/heads/main\n");
    const root = join(outer, "vendored");
    await mkdir(root);
    await writeFile(join(root, ".git"), "not a gitdir line\n");

    expect(await readCheckout(root)).toBeNull();
  });
});
