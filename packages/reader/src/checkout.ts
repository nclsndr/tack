import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ReaderCheckout } from "./types.ts";

const branchPrefix = "refs/heads/";
const commitPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Reads a whole small file, or `undefined` when it cannot be read as one. */
async function text(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Parses a `HEAD` file: a symbolic reference to a branch, or the commit of a detached head. */
function parseHead(head: string): ReaderCheckout | null {
  const value = head.trim();
  if (value.startsWith("ref: ")) {
    const reference = value.slice("ref: ".length).trim();
    return {
      kind: "branch",
      name: reference.startsWith(branchPrefix) ? reference.slice(branchPrefix.length) : reference,
    };
  }
  return commitPattern.test(value) ? { kind: "detached", commit: value.slice(0, 7) } : null;
}

/**
 * Reads the checkout of the repository whose `.git` entry sits in `directory`.
 * @returns `undefined` when `directory` has no `.git` entry, so the caller looks further up.
 */
async function checkoutAt(directory: string): Promise<ReaderCheckout | null | undefined> {
  const dotGit = join(directory, ".git");
  const entry = await stat(dotGit).catch(() => undefined);
  if (entry === undefined) return undefined;
  // A linked worktree or submodule has a `.git` file naming its git directory.
  const gitDirectory =
    entry.isDirectory() === true
      ? dotGit
      : /^gitdir: (.+)$/m.exec((await text(dotGit)) ?? "")?.[1]?.trim();
  if (gitDirectory === undefined) return null;
  const head = await text(join(resolve(directory, gitDirectory), "HEAD"));
  return head === undefined ? null : parseHead(head);
}

/**
 * Reads what a project root has checked out straight from git's files, without spawning git, so
 * the reader can re-read it on every status check. Like git, it looks for the repository from
 * `root` upwards.
 * @returns `null` when `root` is outside any repository or its `HEAD` cannot be read; it never
 * fails, because a project or source need not be versioned with git at all.
 */
export async function readCheckout(root: string): Promise<ReaderCheckout | null> {
  const directory = resolve(root);
  const found = await checkoutAt(directory);
  if (found !== undefined) return found;
  const parent = dirname(directory);
  return parent === directory ? null : readCheckout(parent);
}
