import { describe, expect, it } from "vitest";
import { makeMemoryVolume, VolumeError } from "./memory-volume.ts";

const text = (data: Uint8Array) => new TextDecoder().decode(data);
const bytes = (value: string) => new TextEncoder().encode(value);

/** The error code a volume operation throws, or `undefined` when it succeeds. */
const codeOf = (operation: () => unknown) => {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error instanceof VolumeError ? error.code : "not-a-volume-error";
  }
};

describe("memory volume", () => {
  it("writes, reads and lists files in nested directories", () => {
    const volume = makeMemoryVolume();
    volume.mkdir("/home/you/skills", { recursive: true });
    volume.writeFile("/home/you/skills/SKILL.md", bytes("# Review"));
    volume.mkdir("/home/you/skills/review");

    expect(text(volume.readFile("/home/you/skills/SKILL.md"))).toBe("# Review");
    expect(volume.readdir("/home/you/skills")).toEqual(["SKILL.md", "review"]);
    expect(volume.stat("/home/you/skills/SKILL.md")).toMatchObject({ type: "file", size: 8 });
    expect(volume.stat("/home/you")).toMatchObject({ type: "directory" });
  });

  it.each([
    ["a missing parent", () => makeMemoryVolume().mkdir("/a/b"), "ENOENT"],
    ["an existing directory", () => makeMemoryVolume().mkdir("/"), "EEXIST"],
    ["a missing file", () => makeMemoryVolume().readFile("/missing"), "ENOENT"],
    ["a directory read as a file", () => makeMemoryVolume().readFile("/"), "EISDIR"],
    [
      "a file used as a directory",
      () => {
        const volume = makeMemoryVolume();
        volume.writeFile("/file", bytes(""));
        volume.readdir("/file/child");
      },
      "ENOTDIR",
    ],
    [
      "a recursive directory through a file",
      () => {
        const volume = makeMemoryVolume();
        volume.writeFile("/file", bytes(""));
        volume.mkdir("/file/child", { recursive: true });
      },
      "ENOTDIR",
    ],
    [
      "listing a file",
      () => {
        const volume = makeMemoryVolume();
        volume.writeFile("/file", bytes(""));
        volume.readdir("/file");
      },
      "ENOTDIR",
    ],
    [
      "an exclusive write over an existing file",
      () => {
        const volume = makeMemoryVolume();
        volume.writeFile("/file", bytes(""));
        volume.writeFile("/file", bytes(""), { exclusive: true });
      },
      "EEXIST",
    ],
    ["writing over a directory", () => makeMemoryVolume().writeFile("/", bytes("")), "EISDIR"],
    [
      "reading the link of a plain file",
      () => {
        const volume = makeMemoryVolume();
        volume.writeFile("/file", bytes(""));
        volume.readlink("/file");
      },
      "EINVAL",
    ],
    [
      "removing a non-empty directory",
      () => {
        const volume = makeMemoryVolume();
        volume.mkdir("/dir/child", { recursive: true });
        volume.remove("/dir");
      },
      "ENOTEMPTY",
    ],
    [
      "renaming onto a non-empty directory",
      () => {
        const volume = makeMemoryVolume();
        volume.mkdir("/full/child", { recursive: true });
        volume.mkdir("/other");
        volume.rename("/other", "/full");
      },
      "ENOTEMPTY",
    ],
    ["removing a missing entry", () => makeMemoryVolume().remove("/missing"), "ENOENT"],
    [
      "a link cycle",
      () => {
        const volume = makeMemoryVolume();
        volume.symlink("/b", "/a");
        volume.symlink("/a", "/b");
        volume.stat("/a");
      },
      "ELOOP",
    ],
  ])("fails on %s", (_name, operation, code) => {
    expect(codeOf(operation)).toBe(code);
  });

  it("appends, keeps exclusive writes for new files, and creates parents recursively", () => {
    const volume = makeMemoryVolume();
    volume.mkdir("/a/b", { recursive: true });
    volume.mkdir("/a/b", { recursive: true });
    volume.writeFile("/a/b/log", bytes("one"), { exclusive: true });
    volume.writeFile("/a/b/log", bytes(" two"), { append: true });

    expect(text(volume.readFile("/a/b/log"))).toBe("one two");
  });

  it("resolves relative symbolic links from the real directory that holds them", () => {
    const volume = makeMemoryVolume();
    volume.mkdir("/home/you/skills/review", { recursive: true });
    volume.writeFile("/home/you/skills/review/SKILL.md", bytes("review"));
    volume.mkdir("/home/you/app/.claude/skills", { recursive: true });
    volume.symlink("../../../skills/review", "/home/you/app/.claude/skills/review");

    expect(volume.readlink("/home/you/app/.claude/skills/review")).toBe("../../../skills/review");
    expect(volume.lstat("/home/you/app/.claude/skills/review")).toMatchObject({ type: "symlink" });
    expect(volume.stat("/home/you/app/.claude/skills/review")).toMatchObject({
      type: "directory",
    });
    expect(volume.realpath("/home/you/app/.claude/skills/review")).toBe("/home/you/skills/review");
    expect(text(volume.readFile("/home/you/app/.claude/skills/review/SKILL.md"))).toBe("review");
    expect(volume.realpath("/home/you/app/.claude/skills/review/../..")).toBe("/home/you");
    expect(volume.realpath("/../..")).toBe("/");
  });

  it("follows absolute links and reports a dangling link as missing only when followed", () => {
    const volume = makeMemoryVolume();
    volume.mkdir("/real");
    volume.symlink("/real", "/alias");
    volume.symlink("/nowhere", "/dangling");

    expect(volume.realpath("/alias")).toBe("/real");
    expect(volume.lstat("/dangling")).toMatchObject({ type: "symlink" });
    expect(codeOf(() => volume.stat("/dangling"))).toBe("ENOENT");
    expect(volume.exists("/dangling")).toBe(false);
    expect(volume.exists("/alias")).toBe(true);
    volume.writeFile("/file", new Uint8Array());
    expect(volume.exists("/file/child")).toBe(false);
  });

  it("removes links without touching their targets and removes trees recursively", () => {
    const volume = makeMemoryVolume();
    volume.mkdir("/real/child", { recursive: true });
    volume.symlink("/real", "/link");
    volume.remove("/link");
    volume.remove("/missing", { force: true });

    expect(volume.exists("/real/child")).toBe(true);
    expect(volume.exists("/link")).toBe(false);

    volume.remove("/real", { recursive: true });
    expect(volume.readdir("/")).toEqual([]);
  });

  it("renames entries, replacing a file at the destination", () => {
    const volume = makeMemoryVolume();
    volume.writeFile("/state.json.tmp", bytes("new"));
    volume.writeFile("/state.json", bytes("old"));
    volume.rename("/state.json.tmp", "/state.json");
    volume.mkdir("/dir/inner", { recursive: true });
    volume.rename("/dir", "/moved");

    expect(text(volume.readFile("/state.json"))).toBe("new");
    expect(volume.readdir("/")).toEqual(["moved", "state.json"]);
    expect(volume.readdir("/moved")).toEqual(["inner"]);
  });

  it("hard links a file so both names read the same content, and refuses an existing name", () => {
    const volume = makeMemoryVolume();
    volume.writeFile("/staging", bytes("pid"));
    volume.link("/staging", "/state.lock");

    expect(text(volume.readFile("/state.lock"))).toBe("pid");
    expect(codeOf(() => volume.link("/staging", "/state.lock"))).toBe("EEXIST");
  });

  it("changes modes and counts each mutation in its version", () => {
    const volume = makeMemoryVolume();
    const seen: Array<number> = [];
    const unsubscribe = volume.subscribe(() => seen.push(volume.version()));
    volume.writeFile("/secret", bytes(""), { mode: 0o600 });
    volume.chmod("/secret", 0o644);
    unsubscribe();
    volume.mkdir("/after");

    expect(volume.stat("/secret").mode).toBe(0o644);
    expect(seen).toEqual([1, 2]);
    expect(volume.version()).toBe(3);
  });

  it("clones into an independent copy", () => {
    const volume = makeMemoryVolume();
    volume.mkdir("/home");
    volume.writeFile("/home/note", bytes("before"));
    volume.symlink("note", "/home/link");
    const copy = volume.clone();
    volume.writeFile("/home/note", bytes("after"));

    expect(text(copy.readFile("/home/link"))).toBe("before");
    expect(copy.readdir("/home")).toEqual(["link", "note"]);
  });
});
