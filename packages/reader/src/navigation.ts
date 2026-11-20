import type { ReaderDocument } from "./types.ts";

type FolderNode = {
  kind: "folder";
  /** Worktree-relative folder path; it identifies the folder's open state. */
  path: string;
  label: string;
  /** Documents anywhere below this folder. */
  count: number;
  children: NavigationNode[];
};
export type NavigationNode = { kind: "document"; document: ReaderDocument } | FolderNode;

const stampPattern = /^\d{4}-\d{2}-\d{2}(?:-\d{2}:\d{2})?/;
const dayInMilliseconds = 86_400_000;

/** The worktree-relative folder that contains a document. */
export function folderOf(document: ReaderDocument): string {
  return document.relativePath.split("/").slice(0, -1).join("/");
}

/** Finds the deepest folder that every path shares, or `""` for the worktree root. */
export function sharedFolder(folders: string[]): string {
  const [first, ...rest] = folders.map((folder) => folder.split("/"));
  if (first === undefined) return "";
  const shared = first.filter((_segment, index) =>
    rest.every(
      (parts) => parts.slice(0, index + 1).join("/") === first.slice(0, index + 1).join("/"),
    ),
  );
  return shared.join("/");
}

/** Lists the folders between a tree root and a document, outermost first. */
export function folderAncestors(relativePath: string, root: string): string[] {
  const below = (root === "" ? relativePath : relativePath.slice(root.length + 1)).split("/");
  return below
    .slice(0, -1)
    .map((_segment, index) => [root, ...below.slice(0, index + 1)].filter((part) => part !== ""))
    .map((parts) => parts.join("/"));
}

/** A document is archived when it sits below one of the declared archive folders. */
export function isArchived(document: ReaderDocument, archive: string[]): boolean {
  return archive.some((folder) => document.relativePath.startsWith(`${folder}/`));
}

/** Reads a folder name without its leading date stamp, keeping a name that is only a date. */
export function folderLabel(name: string): string {
  const words = name.replace(stampPattern, "").replace(/^-/, "").replaceAll("-", " ").trim();
  return words === "" ? name : words;
}

/** The ISO date at the start of a document's file name. */
export function documentDate(relativePath: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2})/.exec(relativePath.split("/").at(-1) ?? "")?.[1];
}

/** States a dated document's age in whole local days, then months, then years. */
export function documentAge(relativePath: string, today: Date): string | undefined {
  const date = documentDate(relativePath);
  if (date === undefined) return undefined;
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const days = Math.round(
    (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
      Date.UTC(year, month - 1, day)) /
      dayInMilliseconds,
  );
  if (days <= 0) return "today";
  if (days < 60) return `${days}d`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** Orders date-stamped names newest first, then everything else by label with numeric awareness. */
function byRecency<Item>(name: (item: Item) => string, label: (item: Item) => string) {
  return (left: Item, right: Item): number => {
    const leftStamp = stampPattern.exec(name(left))?.[0];
    const rightStamp = stampPattern.exec(name(right))?.[0];
    if (leftStamp !== rightStamp) {
      if (leftStamp === undefined) return 1;
      if (rightStamp === undefined) return -1;
      return rightStamp.localeCompare(leftStamp);
    }
    return label(left).localeCompare(label(right), "en", { numeric: true });
  };
}

function nodesBelow(documents: ReaderDocument[], folder: string): NavigationNode[] {
  const depth = folder === "" ? 0 : folder.split("/").length;
  const children = [
    ...new Set(
      documents
        .map(folderOf)
        .filter((path) => path !== folder)
        .map((path) =>
          path
            .split("/")
            .slice(0, depth + 1)
            .join("/"),
        ),
    ),
  ];
  const lastSegment = (path: string) => path.split("/").at(-1) ?? path;
  return [
    ...documents
      .filter((document) => folderOf(document) === folder)
      .toSorted(
        byRecency(
          (document) => document.relativePath.split("/").at(-1) ?? "",
          (document) => document.title,
        ),
      )
      .map((document): NavigationNode => ({ kind: "document", document })),
    ...children
      .toSorted(byRecency(lastSegment, (path) => folderLabel(lastSegment(path))))
      .map((path): NavigationNode => {
        const inside = documents.filter((document) => document.relativePath.startsWith(`${path}/`));
        return {
          kind: "folder",
          path,
          label: folderLabel(lastSegment(path)),
          count: inside.length,
          children: nodesBelow(inside, path),
        };
      }),
  ];
}

/**
 * Nests documents into folders below `root`. Each level lists its documents before its folders,
 * both newest first by their date stamp.
 */
export function navigationTree(documents: ReaderDocument[], root: string): NavigationNode[] {
  return nodesBelow(documents, root);
}
