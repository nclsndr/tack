import { describe, expect, it } from "vitest";
import { issueLine } from "./issues.ts";
import {
  fileTreeBudget,
  fileTreeReadable,
  parseTree,
  parseSize,
  readFileTree,
  type TreeModel,
} from "./file-tree-model.ts";

const release = [
  "~/.local/",
  "  bin/",
  "    tack -> ../share/tack/current/bin/tack     # created once, never rewritten",
  "  share/tack/",
  "    current -> releases/0.1.0+g1cfcfc7         # the pointer an update swaps [key]",
  "    previous -> releases/<older>               # rollback activates it [temp]",
  "    releases/",
  "      0.1.0+g1cfcfc7/                          # one immutable release [306 MB]",
  "        bin/tack         [69 MB]               # Bun plus the bundled CLI",
  "        node_modules/.bun/  [237 MB]           # production dependencies",
  "        ...",
  "    staging/                                   # only during an update [temp]",
  "    update.lock                                # only during an update [temp]",
].join("\n");

const ids = (model: Pick<TreeModel, "entries">): readonly string[] =>
  model.entries.map((entry) => entry.id);
const entry = (model: Pick<TreeModel, "entries">, id: string) =>
  model.entries.find((item) => item.id === id);

describe("the tree grammar", () => {
  it("reads depth, directories, links, notes, marks and sizes from each line", () => {
    const { model, issues } = parseTree(release);
    expect(issues).toEqual([]);
    expect(ids(model)).toEqual([
      "~/.local/",
      "~/.local/bin/",
      "~/.local/bin/tack",
      "~/.local/share/tack/",
      "~/.local/share/tack/current",
      "~/.local/share/tack/previous",
      "~/.local/share/tack/releases/",
      "~/.local/share/tack/releases/0.1.0+g1cfcfc7/",
      "~/.local/share/tack/releases/0.1.0+g1cfcfc7/bin/tack",
      "~/.local/share/tack/releases/0.1.0+g1cfcfc7/node_modules/.bun/",
      "~/.local/share/tack/releases/0.1.0+g1cfcfc7/...",
      "~/.local/share/tack/staging/",
      "~/.local/share/tack/update.lock",
    ]);
    expect(entry(model, "~/.local/bin/tack")).toMatchObject({
      name: "tack",
      depth: 2,
      line: 3,
      directory: false,
      target: "../share/tack/current/bin/tack",
      note: "created once, never rewritten",
      key: false,
      temp: false,
    });
    expect(entry(model, "~/.local/share/tack/current")).toMatchObject({
      key: true,
      note: "the pointer an update swaps",
    });
    expect(entry(model, "~/.local/share/tack/previous")).toMatchObject({ temp: true });
    expect(entry(model, "~/.local/share/tack/releases/0.1.0+g1cfcfc7/")).toMatchObject({
      directory: true,
      size: { text: "306 MB", bytes: 306 * 1024 ** 2 },
      note: "one immutable release",
    });
    expect(entry(model, "~/.local/share/tack/releases/0.1.0+g1cfcfc7/bin/tack")).toMatchObject({
      size: { text: "69 MB" },
      note: "Bun plus the bundled CLI",
    });
    expect(entry(model, "~/.local/share/tack/releases/0.1.0+g1cfcfc7/...")).toMatchObject({
      ellipsis: true,
      depth: 4,
    });
  });

  it("makes an entry with children a directory, without the slash too", () => {
    const { model } = parseTree("src\n  main.ts\n");
    expect(model.entries.map((item) => [item.id, item.directory])).toEqual([
      ["src", true],
      ["src/main.ts", false],
    ]);
  });

  it("keeps brackets that are part of a name, and skips blank lines", () => {
    const { model, issues } = parseTree("app/\n\n  [slug].tsx  # a dynamic route\n");
    expect(issues).toEqual([]);
    expect(entry(model, "app/[slug].tsx")).toMatchObject({ name: "[slug].tsx", line: 3 });
  });

  it("keeps an unknown bracket mark after a name as part of the name", () => {
    const { model } = parseTree("docs/\n  notes.md [draft]  # wip\n");
    expect(entry(model, "docs/notes.md [draft]")).toMatchObject({
      name: "notes.md [draft]",
      note: "wip",
    });
  });

  it("reports odd indentation and draws the line at the nearest valid depth", () => {
    const source = ["root/", "  a/", "    b", "   c", "  d", "      e", "\tf"].join("\n");
    const { model, issues } = parseTree(source);
    expect(issues.map(issueLine)).toEqual([
      "input: line 4: odd indentation (3 spaces); use two per level",
      "input: line 6: indented more than one level below the line above; drawn one level below it",
      "input: line 7: a tab in the indentation; use two spaces per level",
    ]);
    // Three spaces round down to one level; a tab counts as two spaces.
    expect(model.entries.map((item) => [item.id, item.depth])).toEqual([
      ["root/", 0],
      ["root/a/", 1],
      ["root/a/b", 2],
      ["root/c", 1],
      ["root/d", 1],
      ["root/d/e", 2],
      ["root/f", 1],
    ]);
  });

  it("reports a duplicate path once and keeps the first entry", () => {
    const { model, issues } = parseTree("a/\n  b\n  b\n");
    expect(issues.map(issueLine)).toEqual(['input: line 3: duplicate entry "a/b"; it is left out']);
    expect(ids(model)).toEqual(["a/", "a/b"]);
  });

  it("parses sizes in bytes, KB, MB, GB and TB", () => {
    expect(parseSize("12 B")).toBe(12);
    expect(parseSize("248 KB")).toBe(248 * 1024);
    expect(parseSize("1.5 GB")).toBe(1.5 * 1024 ** 3);
    expect(parseSize("2TB")).toBe(2 * 1024 ** 4);
    expect(parseSize("big")).toBeUndefined();
  });
});

describe("symlink resolution", () => {
  it("ends an arrow on the first link the target path passes through, and inks the chain", () => {
    const { model } = readFileTree({
      id: "t",
      title: "An update swaps one symlink",
      source: release,
    });
    expect(model.links.get("~/.local/bin/tack")).toEqual({
      arrow: "~/.local/share/tack/current",
      chain: [
        "~/.local/share/tack/current",
        "~/.local/share/tack/releases/0.1.0+g1cfcfc7/bin/tack",
      ],
    });
    expect(model.links.get("~/.local/share/tack/current")).toEqual({
      arrow: "~/.local/share/tack/releases/0.1.0+g1cfcfc7/",
      chain: ["~/.local/share/tack/releases/0.1.0+g1cfcfc7/"],
    });
  });

  it("shows a target that names no entry as text, with no arrow", () => {
    const { model } = readFileTree({
      id: "t",
      title: "An update swaps one symlink",
      source: release,
    });
    expect(model.links.has("~/.local/share/tack/previous")).toBe(false);
  });

  it("resolves absolute and home targets from the top of the tree", () => {
    const { model } = readFileTree({
      id: "t",
      title: "Two links reach one file",
      source: ["~/a/", "  f", "  g -> ~/a/f", "/etc/", "  h -> /etc/x", "  x"].join("\n"),
    });
    expect(model.links.get("~/a/g")?.arrow).toBe("~/a/f");
    expect(model.links.get("/etc/h")?.arrow).toBe("/etc/x");
  });

  it("stops at a link cycle instead of looping", () => {
    const { model } = readFileTree({
      id: "t",
      title: "Two links point at each other",
      source: ["d/", "  a -> b/x", "  b -> a/x"].join("\n"),
    });
    expect(model.links.get("d/a")?.arrow).toBe("d/b");
    expect(model.links.get("d/a")?.chain.length).toBeLessThanOrEqual(fileTreeBudget.chain);
  });
});

describe("readFileTree", () => {
  it("reads the fence attributes and checks the claim and the id", () => {
    const { issues } = readFileTree({ title: "Disk", source: "a\n" });
    expect(issues.map(issueLine)).toEqual([
      "input: id is required: a short lowercase slug",
      'input: title "Disk" reads as a noun phrase; write the claim the figure proves as a sentence',
    ]);
  });

  it("asks for a tree when the source is empty", () => {
    const { issues } = readFileTree({ id: "t", title: "Nothing is on the disk yet", source: "" });
    expect(issues.map(issueLine)).toEqual([
      "input: the tree is empty; write one entry per line in a ```tree block",
    ]);
  });

  it("checks lens ids, and that a present entry is temporary", () => {
    const { model, issues } = readFileTree({
      id: "t",
      title: "An update swaps one symlink",
      source: release,
      lenses: [
        {
          label: "During an update",
          note: "staging exists.",
          present: ["~/.local/share/tack/staging", "~/.local/share/tack/update.lock", "nope"],
        },
        { label: "Pointer", note: "x", present: ["~/.local/share/tack/current"], focus: ["gone"] },
        { note: "no label" },
      ],
    });
    expect(issues.map(issueLine)).toEqual([
      'input: lens "During an update" names an unknown entry "nope"',
      'input: lens "Pointer" lists "~/.local/share/tack/current" as present, but it is not marked [temp]',
      'input: lens "Pointer" names an unknown entry "gone"',
      "input: lens 3 has no label",
    ]);
    expect(model.lenses[0]).toMatchObject({
      id: "during-an-update",
      present: ["~/.local/share/tack/staging/", "~/.local/share/tack/update.lock"],
    });
  });

  it("names lenses with no sluggable label or a repeated id, and asks for a missing note", () => {
    const { model, issues } = readFileTree({
      id: "t",
      title: "A tree has lenses with odd names",
      source: "a [temp]\nb [temp]\n",
      lenses: [
        { label: "!!!", note: "n", present: ["a"] },
        { id: "same", label: "One", present: ["a"] },
        { id: "same", label: "Two", note: "n", present: ["b"] },
      ],
    });
    expect(issues.map(issueLine)).toEqual(['input: lens "One" has no note']);
    expect(model.lenses.map((lens) => lens.id)).toEqual(["lens-1", "same", "same-3"]);
  });

  it("reads a source that is not text as an empty tree", () => {
    const { issues } = readFileTree({
      id: "t",
      title: "A tree has no source text at all",
      source: 5,
    });
    expect(issues.map(issueLine)).toEqual([
      "input: the tree is empty; write one entry per line in a ```tree block",
    ]);
  });

  it("asks for ... above the entry budget", () => {
    const source = ["root/", ...Array.from({ length: 60 }, (_, index) => `  f${index}`)].join("\n");
    const { issues } = readFileTree({ id: "t", title: "The root holds too many files", source });
    expect(issues.map(issueLine)).toEqual([
      `input: 61 entries; the budget is ${fileTreeBudget.entries}. Fold entries the claim does not need into ...`,
    ]);
  });

  it("checks startWith ids", () => {
    const { model, issues } = readFileTree({
      id: "t",
      title: "An update swaps one symlink",
      source: release,
      startWith: ["~/.local/bin/tack", "zzz"],
    });
    expect(model.startWith).toEqual(["~/.local/bin/tack"]);
    expect(issues.map(issueLine)).toEqual(['input: startWith names an unknown entry "zzz"']);
  });
});

describe("the text equivalent", () => {
  it("is the tree as indented text with its notes, sizes and marks", () => {
    const { model } = readFileTree({
      id: "t",
      title: "An update swaps one symlink",
      summary: "One pointer moves.",
      rule: { title: "Arrows are symlinks", text: "An arrow ends where the link resolves." },
      source: release,
      lenses: [
        {
          label: "During an update",
          note: "staging exists.",
          present: ["~/.local/share/tack/staging/"],
        },
      ],
    });
    expect(fileTreeReadable(model).split("\n")).toEqual([
      "An update swaps one symlink",
      "One pointer moves.",
      "Arrows are symlinks. An arrow ends where the link resolves.",
      "~/.local/",
      "  bin/",
      "    tack -> ../share/tack/current/bin/tack  # created once, never rewritten",
      "  share/tack/",
      "    current -> releases/0.1.0+g1cfcfc7  [key]  # the pointer an update swaps",
      "    previous -> releases/<older>  [temp]  # rollback activates it",
      "    releases/",
      "      0.1.0+g1cfcfc7/  [306 MB]  # one immutable release",
      "        bin/tack  [69 MB]  # Bun plus the bundled CLI",
      "        node_modules/.bun/  [237 MB]  # production dependencies",
      "        ...",
      "    staging/  [temp]  # only during an update",
      "    update.lock  [temp]  # only during an update",
      "Lens During an update: staging exists. Present: ~/.local/share/tack/staging/",
    ]);
  });
});
