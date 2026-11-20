import type { MemoryVolume } from "./machine/memory-volume.ts";

/** One entry of the explorer tree: a folder with children, a file, or a symbolic link. */
export type TreeNode =
  | {
      readonly kind: "directory";
      readonly name: string;
      readonly path: string;
      readonly children: ReadonlyArray<TreeNode>;
    }
  | { readonly kind: "file"; readonly name: string; readonly path: string }
  | {
      readonly kind: "link";
      readonly name: string;
      readonly path: string;
      /** The link text, as `ls -l` shows it. */
      readonly target: string;
      /** Where the link resolves, or `undefined` when it dangles. */
      readonly resolved: string | undefined;
    };

/** A link drawn from where it sits to the real entry it reaches. */
export type LinkEdge = { readonly from: string; readonly to: string };

/** Names an explorer never shows: Git's own folder and Tack's state. */
const hidden: ReadonlySet<string> = new Set([".git", ".tack"]);

const resolve = (volume: MemoryVolume, path: string) =>
  volume.exists(path) ? volume.realpath(path) : undefined;

/**
 * The tree under `path`, read from the volume: folders first, then files and links, each sorted by
 * name. Links are leaves, never followed. Tack's state folder and `.git` are left out, but the docs
 * Tack mounts under a project's `.tack/docs` are kept.
 */
export const treeOf = (volume: MemoryVolume, path: string, name = path): TreeNode => {
  const type = volume.lstat(path).type;
  if (type === "symlink")
    return {
      kind: "link",
      name,
      path,
      target: volume.readlink(path),
      resolved: resolve(volume, path),
    };
  if (type === "file") return { kind: "file", name, path };
  const children = volume
    .readdir(path)
    .filter((child) => hidden.has(child) === false || isDocsMount(volume, `${path}/${child}`))
    .map((child) => treeOf(volume, `${path}/${child}`, child));
  return {
    kind: "directory",
    name,
    path,
    children: [
      ...children.filter((child) => child.kind === "directory"),
      ...children.filter((child) => child.kind !== "directory"),
    ],
  };
};

/** A project's `.tack` folder is shown when it holds docs mounts, which are links Tack manages. */
const isDocsMount = (volume: MemoryVolume, path: string) =>
  path.endsWith("/.tack") && volume.exists(`${path}/docs`);

/** Every link in the tree, with the real entry it reaches; dangling links are left out. */
export const linkEdges = (node: TreeNode): ReadonlyArray<LinkEdge> => {
  if (node.kind === "link")
    return node.resolved === undefined ? [] : [{ from: node.path, to: node.resolved }];
  return node.kind === "directory" ? node.children.flatMap(linkEdges) : [];
};

/** Whether `path` is `ancestor` or lies inside it. */
export const isWithin = (path: string, ancestor: string) =>
  path === ancestor || path.startsWith(`${ancestor}/`);

/** The links on the machine after a command, and the ones that count as new. */
export type FreshLinks = {
  readonly links: ReadonlySet<string>;
  readonly fresh: ReadonlySet<string>;
};

/**
 * Which links count as new after a command. The starting machine has none; a command that adds
 * links marks exactly those; a command that leaves the links alone keeps the previous mark, so a
 * `tack status` after a sync does not wipe it; a command that only removes links clears it.
 */
export const nextFreshLinks = (
  previous: FreshLinks | undefined,
  edges: ReadonlyArray<LinkEdge>,
): FreshLinks => {
  const links: ReadonlySet<string> = new Set(edges.map((edge) => edge.from));
  if (previous === undefined) return { links, fresh: new Set() };
  const unchanged =
    links.size === previous.links.size && [...links].every((link) => previous.links.has(link));
  if (unchanged === true) return { links, fresh: previous.fresh };
  return { links, fresh: new Set([...links].filter((link) => previous.links.has(link) === false)) };
};

/** A path as a shell prompt writes it: `~` for the home and everything inside it. */
export const homeRelative = (path: string, home: string) =>
  isWithin(path, home) ? `~${path.slice(home.length)}` : path;

/**
 * Whether the explorer shows a folder open before anyone clicks it: the roots always, and any folder
 * leading to a lit entry (a new link, or what a link reaches), so the change is in view without
 * unfolding the whole machine.
 */
export const opensByDefault = (path: string, depth: number, lit: ReadonlySet<string>) =>
  depth === 0 || [...lit].some((entry) => entry !== path && isWithin(entry, path));

/** What a read-only tab shows for one entry of the machine. */
export type EntryDetails =
  | { readonly kind: "file"; readonly path: string; readonly size: number; readonly text: string }
  | { readonly kind: "directory"; readonly path: string; readonly entries: ReadonlyArray<string> }
  | {
      readonly kind: "link";
      readonly path: string;
      /** The link text, as written. */
      readonly target: string;
      /** Where it resolves, or `undefined` when it dangles. */
      readonly resolved: string | undefined;
      readonly reaches: "file" | "directory" | undefined;
      /** What the folder it reaches holds; empty for a file or a dangling link. */
      readonly entries: ReadonlyArray<string>;
    }
  | { readonly kind: "missing"; readonly path: string };

/** Reads one entry for a read-only view: a file's text, a folder's names, a link's destination. */
export const describeEntry = (volume: MemoryVolume, path: string): EntryDetails => {
  if (volume.exists(path) === false && isDangling(volume, path) === false)
    return { kind: "missing", path };
  const type = volume.lstat(path).type;
  if (type === "file")
    return {
      kind: "file",
      path,
      size: volume.stat(path).size,
      text: new TextDecoder().decode(volume.readFile(path)),
    };
  if (type === "directory") return { kind: "directory", path, entries: volume.readdir(path) };
  const resolved = resolve(volume, path);
  const reaches =
    resolved === undefined
      ? undefined
      : volume.stat(resolved).type === "directory"
        ? "directory"
        : "file";
  return {
    kind: "link",
    path,
    target: volume.readlink(path),
    resolved,
    reaches,
    entries: reaches === "directory" && resolved !== undefined ? volume.readdir(resolved) : [],
  };
};

/** Whether `path` is a link whose destination is gone, which `exists` reports as absent. */
const isDangling = (volume: MemoryVolume, path: string) => {
  try {
    return volume.lstat(path).type === "symlink";
  } catch {
    return false;
  }
};
