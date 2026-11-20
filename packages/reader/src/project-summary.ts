import { resourceIdentity, resourceLabel } from "./resource.ts";
import type { ReaderDocument, ReaderResource, ReaderResourceIssue } from "./types.ts";

/** An attached docs resource as the reader's boot payload carries it. */
export type AttachedResource = Pick<
  ReaderResource,
  "sourceRegistrationId" | "name" | "sourcePath" | "directoryPath"
>;

/** One attached docs resource as the project popover lists it. */
export type AttachedDocs = {
  identity: string;
  label: string;
  count: number;
  /** The docs directory relative to its source, `.` for the source itself. */
  directory: string;
};

/** One skipped document or unavailable resource as the issue popover lists it. */
export type IssueEntry = { name: string; summary: string; message: string };

const alphanumeric = /[\p{L}\p{N}]/u;

/**
 * The project's two-letter mark: its first and last letter or digit, upper-cased, so `tack` reads
 * `TK`. A one-character name gives one letter.
 */
export function projectMonogram(name: string): string {
  const characters = Array.from(name);
  const letters = characters.filter((character) => alphanumeric.test(character));
  const usable = letters.length > 0 ? letters : characters.slice(0, 1);
  const first = usable[0] ?? "";
  const last = usable.length > 1 ? (usable.at(-1) ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

const segments = (path: string) => path.split("/").filter((segment) => segment !== "");

/** A root path short enough for the popover: its last three folders, or the whole of a short one. */
export function rootLabel(root: string): string {
  const parts = segments(root);
  return parts.length <= 3 ? root : `…/${parts.slice(-3).join("/")}`;
}

/** The root's own folder name, which stands in for the branch outside git. */
export function rootName(root: string): string {
  return segments(root).at(-1) ?? root;
}

/** The first clause of a diagnostic: up to its first colon, sentence end or line break. */
export function firstClause(message: string): string {
  const clause = message.split(/:\s|\.\s|\.$|\n/)[0]?.trim() ?? "";
  return clause === "" ? message.trim() : clause;
}

/** Names an issue by its file or resource and keeps its cause, without the path, to one clause. */
export function issueEntry(issue: ReaderResourceIssue): IssueEntry {
  const { path, message } = issue;
  if (path !== undefined) {
    const cause = message.startsWith(path)
      ? message.slice(path.length).replace(/^(?::\d+)*:\s*/, "")
      : message;
    return { name: segments(path).at(-1) ?? path, summary: firstClause(cause), message };
  }
  return {
    name:
      issue.sourcePath === ""
        ? issue.resource.name
        : resourceLabel({ ...issue.resource, sourcePath: issue.sourcePath }),
    summary: firstClause(message),
    message,
  };
}

const counted = (count: number, singular: string, plural: string, state: string) =>
  count === 0 ? [] : [`${count} ${count === 1 ? singular : plural} ${state}`];

/**
 * Counts issues the way the reader states them: a document issue skipped one document, a resource
 * issue made a whole resource unavailable. Empty when there is no issue.
 */
export function issueCount(issues: readonly ReaderResourceIssue[]): string {
  const documents = issues.filter((issue) => issue.path !== undefined).length;
  return [
    ...counted(documents, "doc", "docs", "skipped"),
    ...counted(issues.length - documents, "resource", "resources", "unavailable"),
  ].join(" · ");
}

/**
 * States everything the issue popover lists, in one line: the issue count, the unknown icons, then a
 * failed rebuild of the served generation. Empty when there is nothing to report.
 * @param failure - The status route's rebuild failure, `""` when the last rebuild succeeded.
 * @param icons - The `<Icon>` uses of served documents that the reader cannot draw.
 * @param components - The author components of served documents used so they cannot work.
 */
export function issueLabel(
  issues: readonly ReaderResourceIssue[],
  failure: string,
  icons: readonly unknown[] = [],
  components: readonly unknown[] = [],
): string {
  return [
    issueCount(issues),
    icons.length === 0 ? "" : `${icons.length} unknown ${icons.length === 1 ? "icon" : "icons"}`,
    components.length === 0
      ? ""
      : `${components.length} component ${components.length === 1 ? "issue" : "issues"}`,
    failure === "" ? "" : "Rebuild failed",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** Lists attached resources with how many documents each supplied, matched by resource identity. */
export function attachedDocs(
  resources: readonly AttachedResource[],
  documents: readonly ReaderDocument[],
): AttachedDocs[] {
  return resources.map((resource) => {
    const identity = resourceIdentity(resource);
    const prefix = `${resource.sourcePath}/`;
    return {
      identity,
      label: resourceLabel(resource),
      count: documents.filter(
        (document) =>
          document.resource !== undefined && resourceIdentity(document.resource) === identity,
      ).length,
      directory:
        resource.directoryPath === resource.sourcePath
          ? "."
          : resource.directoryPath.startsWith(prefix)
            ? resource.directoryPath.slice(prefix.length)
            : resource.directoryPath,
    };
  });
}
