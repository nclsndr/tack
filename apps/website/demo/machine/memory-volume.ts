/**
 * An in-memory POSIX-like volume: directories, files and symbolic links in one tree, resolved the
 * way the operating system resolves them. It backs the browser demo's file system, where no disk
 * exists, and stays synchronous so every caller sees one consistent tree.
 */

/** The `errno` codes a volume operation can fail with, named as Node names them. */
export type VolumeErrorCode =
  | "EEXIST"
  | "EINVAL"
  | "EISDIR"
  | "ELOOP"
  | "ENOENT"
  | "ENOTDIR"
  | "ENOTEMPTY";

/** A failed volume operation, carrying the `errno` code and the path it concerned. */
export class VolumeError extends Error {
  readonly code: VolumeErrorCode;
  readonly path: string;

  constructor(code: VolumeErrorCode, path: string) {
    super(`${code}: ${path}`);
    this.name = "VolumeError";
    this.code = code;
    this.path = path;
  }
}

type FileNode = { readonly kind: "file"; data: Uint8Array<ArrayBuffer>; mode: number; mtime: Date };
type DirectoryNode = {
  readonly kind: "directory";
  readonly children: Map<string, VolumeNode>;
  mode: number;
  mtime: Date;
};
type LinkNode = { readonly kind: "symlink"; readonly target: string; mode: number; mtime: Date };
type VolumeNode = FileNode | DirectoryNode | LinkNode;

/** What `stat` and `lstat` report about one entry. */
export type VolumeStat = {
  readonly type: "file" | "directory" | "symlink";
  readonly size: number;
  readonly mode: number;
  readonly mtime: Date;
};

/** One resolved path: its real spelling, the directory that holds it and the entry, if any. */
type Located = {
  readonly realPath: string;
  readonly parent: DirectoryNode;
  readonly name: string;
  readonly node: VolumeNode | undefined;
};

const maxLinkHops = 40;
const encoder = new TextEncoder();

const componentsOf = (path: string) =>
  path.split("/").filter((part) => part !== "" && part !== ".");

const spell = (components: ReadonlyArray<string>) => `/${components.join("/")}`;

const directory = (mode = 0o755): DirectoryNode => ({
  kind: "directory",
  children: new Map(),
  mode,
  mtime: new Date(),
});

const sizeOf = (node: VolumeNode) => {
  if (node.kind === "file") return node.data.byteLength;
  return node.kind === "symlink" ? encoder.encode(node.target).byteLength : 4096;
};

const statOf = (node: VolumeNode): VolumeStat => ({
  type: node.kind,
  size: sizeOf(node),
  mode: node.mode,
  mtime: node.mtime,
});

const copyDirectory = (node: DirectoryNode): DirectoryNode => ({
  ...node,
  children: new Map([...node.children].map(([name, child]) => [name, copyNode(child)])),
});

const copyNode = (node: VolumeNode): VolumeNode => {
  if (node.kind === "file") return { ...node, data: node.data.slice() };
  return node.kind === "symlink" ? { ...node } : copyDirectory(node);
};

/** Builds a volume over `root`; a fresh volume holds only an empty root directory. */
const volumeOver = (root: DirectoryNode) => {
  let version = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  /**
   * Walks `path` from the root. Every symbolic link on the way is followed, the last one only when
   * `followLast` is set; `..` steps out of the real directory reached so far, as the OS does.
   */
  const locate = (path: string, followLast: boolean, hops = 0): Located => {
    const parts = componentsOf(path);
    const real: Array<string> = [];
    const parents: Array<DirectoryNode> = [root];
    for (const [index, name] of parts.entries()) {
      // Coverage skip: `..` never pops the root, so `parents` always holds a directory.
      /* v8 ignore next -- @preserve */
      const current = parents.at(-1) ?? root;
      const last = index === parts.length - 1;
      if (name === "..") {
        if (real.length > 0) {
          real.pop();
          parents.pop();
        }
        if (last) {
          const parent = parents.at(-2) ?? root;
          return { realPath: spell(real), parent, name: real.at(-1) ?? "", node: parents.at(-1) };
        }
        continue;
      }
      const node = current.children.get(name);
      if (node === undefined) {
        if (last) return { realPath: spell([...real, name]), parent: current, name, node };
        throw new VolumeError("ENOENT", path);
      }
      if (node.kind === "symlink" && (last === false || followLast === true)) {
        if (hops >= maxLinkHops) throw new VolumeError("ELOOP", path);
        const target = node.target.startsWith("/") ? node.target : `${spell(real)}/${node.target}`;
        return locate(`${target}/${parts.slice(index + 1).join("/")}`, followLast, hops + 1);
      }
      if (last) return { realPath: spell([...real, name]), parent: current, name, node };
      if (node.kind !== "directory") throw new VolumeError("ENOTDIR", path);
      real.push(name);
      parents.push(node);
    }
    return { realPath: "/", parent: root, name: "", node: root };
  };

  const existing = (path: string, followLast: boolean) => {
    const located = locate(path, followLast);
    if (located.node === undefined) throw new VolumeError("ENOENT", path);
    return { ...located, node: located.node };
  };

  const directoryAt = (path: string) => {
    const { node } = existing(path, true);
    if (node.kind !== "directory") throw new VolumeError("ENOTDIR", path);
    return node;
  };

  /** Places a new entry; the name must be free and its parent must exist. */
  const create = (path: string, node: VolumeNode) => {
    const located = locate(path, false);
    if (located.node !== undefined || located.name === "") throw new VolumeError("EEXIST", path);
    located.parent.children.set(located.name, node);
    located.parent.mtime = new Date();
    changed();
  };

  const mkdir = (
    path: string,
    options: { readonly recursive?: boolean; readonly mode?: number } = {},
  ) => {
    if (options.recursive !== true) return create(path, directory(options.mode));
    const parts = componentsOf(path);
    parts.forEach((_part, index) => {
      const prefix = spell(parts.slice(0, index + 1));
      const located = locate(prefix, true);
      if (located.node === undefined) return create(prefix, directory(options.mode));
      if (located.node.kind !== "directory") throw new VolumeError("ENOTDIR", path);
      return undefined;
    });
  };

  const readFile = (path: string) => {
    const { node } = existing(path, true);
    // `existing` followed every link, so anything but a file is a directory here.
    if (node.kind !== "file") throw new VolumeError("EISDIR", path);
    return node.data.slice();
  };

  const writeFile = (
    path: string,
    data: Uint8Array,
    options: {
      readonly exclusive?: boolean;
      readonly append?: boolean;
      readonly mode?: number;
    } = {},
  ) => {
    const located = locate(path, true);
    if (located.node === undefined)
      return create(located.realPath, {
        kind: "file",
        data: data.slice(),
        mode: options.mode ?? 0o644,
        mtime: new Date(),
      });
    if (options.exclusive === true) throw new VolumeError("EEXIST", path);
    if (located.node.kind !== "file") throw new VolumeError("EISDIR", path);
    const file = located.node;
    file.data = options.append === true ? new Uint8Array([...file.data, ...data]) : data.slice();
    file.mtime = new Date();
    changed();
    return undefined;
  };

  const remove = (
    path: string,
    options: { readonly recursive?: boolean; readonly force?: boolean } = {},
  ) => {
    const located = locate(path, false);
    if (located.node === undefined) {
      if (options.force === true) return;
      throw new VolumeError("ENOENT", path);
    }
    if (
      located.node.kind === "directory" &&
      located.node.children.size > 0 &&
      options.recursive !== true
    )
      throw new VolumeError("ENOTEMPTY", path);
    located.parent.children.delete(located.name);
    changed();
  };

  const rename = (from: string, to: string) => {
    const source = existing(from, false);
    const target = locate(to, false);
    if (target.node?.kind === "directory" && target.node.children.size > 0)
      throw new VolumeError("ENOTEMPTY", to);
    source.parent.children.delete(source.name);
    target.parent.children.set(target.name, source.node);
    changed();
  };

  return {
    /** Counts the mutations so far; a view compares it to know when to redraw. */
    version: () => version,
    /** Calls `listener` after every mutation and returns the function that stops it. */
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** An independent deep copy, such as the pristine world a reset returns to. */
    clone: () => volumeOver(copyDirectory(root)),
    exists: (path: string) => {
      try {
        return locate(path, true).node !== undefined;
      } catch {
        return false;
      }
    },
    mkdir,
    readdir: (path: string) => [...directoryAt(path).children.keys()].toSorted(),
    readFile,
    writeFile,
    symlink: (target: string, path: string) =>
      create(path, { kind: "symlink", target, mode: 0o777, mtime: new Date() }),
    readlink: (path: string) => {
      const { node } = existing(path, false);
      if (node.kind !== "symlink") throw new VolumeError("EINVAL", path);
      return node.target;
    },
    realpath: (path: string) => existing(path, true).realPath,
    stat: (path: string) => statOf(existing(path, true).node),
    lstat: (path: string) => statOf(existing(path, false).node),
    remove,
    rename,
    link: (existingPath: string, path: string) => create(path, existing(existingPath, true).node),
    chmod: (path: string, mode: number) => {
      existing(path, true).node.mode = mode;
      changed();
    },
  };
};

/** One in-memory volume and the operations on it. */
export type MemoryVolume = ReturnType<typeof volumeOver>;

/** Creates an empty volume that holds only its root directory. */
export const makeMemoryVolume = (): MemoryVolume => volumeOver(directory());
