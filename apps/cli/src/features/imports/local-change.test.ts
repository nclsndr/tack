import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filesDigest, sha256Hex, type ImportRecord } from "../../domain/imports/import-record.ts";
import {
  compareFolderToRecord,
  localChangeCount,
  localChangeSummary,
  type LocalChange,
} from "./local-change.ts";

const encoder = new TextEncoder();
let root = "";
let counter = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "tack-local-change-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const initial = [
  { path: "SKILL.md", text: "# pdf\n", executable: false },
  { path: "scripts/fill.py", text: "print('hi')\n", executable: true },
  { path: "templates/a/b.txt", text: "deep\n", executable: false },
] as const;

const recordOf = (files: typeof initial): ImportRecord => {
  const entries = files.map((file) => ({
    path: file.path,
    sha256: sha256Hex(encoder.encode(file.text)),
    executable: file.executable,
  }));
  return {
    path: "skills/pdf",
    location: "github:anthropics/skills",
    transport: "https",
    "ref-kind": "default",
    revision: "a".repeat(40),
    "upstream-path": "skills/pdf",
    "upstream-tree": "b".repeat(40),
    "imported-at": "2026-11-11T12:40:00Z",
    digest: filesDigest(entries),
    files: [...entries].sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
};

const fresh = async () => {
  counter += 1;
  const folder = join(root, `case-${counter}`, "pdf");
  await mkdir(folder, { recursive: true });
  for (const file of initial) {
    const target = join(folder, file.path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.text);
    await chmod(target, file.executable ? 0o755 : 0o644);
  }
  return folder;
};

const compare = (folder: string) =>
  Effect.runPromise(
    compareFolderToRecord(folder, recordOf(initial)).pipe(Effect.provide(BunServices.layer)),
  );

type Changed = Extract<LocalChange, { state: "changed" }>;
const changed = (partial: Partial<Omit<Changed, "state">>): Changed => ({
  state: "changed",
  added: [],
  removed: [],
  changed: [],
  executable: [],
  special: [],
  ...partial,
});

describe("compareFolderToRecord", () => {
  it("reads a fresh copy as unchanged", async () => {
    expect(await compare(await fresh())).toEqual({ state: "unchanged" });
  });

  it("reads a byte-for-byte cp -R copy as unchanged", async () => {
    const folder = await fresh();
    const copy = join(root, `copy-${counter}`);
    await cp(folder, copy, { recursive: true });
    expect(await compare(copy)).toEqual({ state: "unchanged" });
  });

  it("reports a missing folder", async () => {
    expect(await compare(join(root, "nowhere"))).toEqual({ state: "missing" });
  });

  it("reports an edited file", async () => {
    const folder = await fresh();
    await writeFile(join(folder, "SKILL.md"), "# edited\n");
    expect(await compare(folder)).toEqual(changed({ changed: ["SKILL.md"] }));
  });

  it("reports an added file at any depth", async () => {
    const folder = await fresh();
    await writeFile(join(folder, "notes.md"), "mine\n");
    await mkdir(join(folder, "templates", "c"), { recursive: true });
    await writeFile(join(folder, "templates", "c", "d.txt"), "x");
    expect(await compare(folder)).toEqual(changed({ added: ["notes.md", "templates/c/d.txt"] }));
  });

  it("reports a removed file", async () => {
    const folder = await fresh();
    await rm(join(folder, "templates", "a", "b.txt"));
    expect(await compare(folder)).toEqual(changed({ removed: ["templates/a/b.txt"] }));
  });

  it("reports an executable-bit change in both directions without a content change", async () => {
    const folder = await fresh();
    await chmod(join(folder, "scripts", "fill.py"), 0o644);
    await chmod(join(folder, "SKILL.md"), 0o755);
    expect(await compare(folder)).toEqual(changed({ executable: ["SKILL.md", "scripts/fill.py"] }));
  });

  it("counts a symlink as a change and not as a removed file", async () => {
    const folder = await fresh();
    await rm(join(folder, "SKILL.md"));
    await symlink("scripts/fill.py", join(folder, "SKILL.md"));
    await symlink("scripts", join(folder, "linked"));
    expect(await compare(folder)).toEqual(changed({ special: ["SKILL.md", "linked"] }));
  });

  it("ignores .DS_Store and Thumbs.db at any depth", async () => {
    const folder = await fresh();
    await writeFile(join(folder, ".DS_Store"), "x");
    await writeFile(join(folder, "scripts", "Thumbs.db"), "x");
    expect(await compare(folder)).toEqual({ state: "unchanged" });
  });

  it("reports every file as removed from an empty folder", async () => {
    const folder = await fresh();
    await rm(folder, { recursive: true });
    await mkdir(folder);
    expect(await compare(folder)).toEqual(
      changed({ removed: ["SKILL.md", "scripts/fill.py", "templates/a/b.txt"] }),
    );
  });

  it("reports a folder replaced by a file or link as a special entry", async () => {
    const folder = await fresh();
    await rm(folder, { recursive: true });
    await writeFile(folder, "not a folder");
    expect(await compare(folder)).toEqual(
      changed({ removed: ["SKILL.md", "scripts/fill.py", "templates/a/b.txt"], special: ["."] }),
    );
  });

  it("reports an unreadable file as special", async () => {
    const folder = await fresh();
    await chmod(join(folder, "SKILL.md"), 0o000);
    const result = await compare(folder);
    await chmod(join(folder, "SKILL.md"), 0o644);
    // Running as a user that can read anything leaves the file unchanged instead.
    expect([changed({ special: ["SKILL.md"] }), { state: "unchanged" }]).toContainEqual(result);
  });
});

describe("compareFolderToRecord with an unreadable folder", () => {
  it("reports it as a special entry instead of failing", async () => {
    const folder = await fresh();
    await chmod(join(folder, "scripts"), 0o000);
    const result = await compare(folder);
    await chmod(join(folder, "scripts"), 0o755);
    expect([result.state === "changed" && result.special.includes("."), result.state]).toSatisfy(
      ([flagged, state]) => flagged === true || state === "unchanged",
    );
  });
});

describe("localChangeSummary and localChangeCount", () => {
  it("is empty for unchanged and missing folders", () => {
    expect(localChangeSummary({ state: "unchanged" })).toBe("unchanged");
    expect(localChangeSummary({ state: "missing" })).toBe("folder missing");
    expect(localChangeCount({ state: "unchanged" })).toBe(0);
    expect(localChangeCount({ state: "missing" })).toBe(0);
  });

  it("names every kind of change", () => {
    const result = changed({
      changed: ["SKILL.md"],
      added: ["notes.md", "more.md"],
      removed: ["old.md"],
      executable: ["run.sh"],
      special: ["link"],
    });
    expect(localChangeSummary(result)).toBe(
      "SKILL.md changed · notes.md, more.md added · old.md removed · run.sh executable bit changed · link not a regular file",
    );
    expect(localChangeCount(result)).toBe(6);
  });
});
