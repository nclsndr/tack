import type { TreeEntry } from "../../services/import-remote.ts";
import { agentAdapterDescriptors } from "../../domain/agents/agent-adapter.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";

/** One folder that holds a skill, and which documented place it was found in. */
export type DiscoveredSkillFolder = {
  /** The repository path of the folder, empty for a skill at the repository root. */
  readonly path: string;
  readonly place: string;
};

type DiscoveryOptions = {
  /** The folder scope, absent for the whole repository. */
  readonly scope?: string | undefined;
  readonly fullDepth?: boolean | undefined;
};

/** Each supported agent's project skill folder, in adapter table order. */
const agentSkillPlaces = agentAdapterDescriptors.map((adapter) =>
  adapter.projectSkillDirectory.join("/"),
);

/** The places inside a scope that are searched by name, walked three levels deep. */
const namedPlaces = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ...agentSkillPlaces,
];

const containerDepth = 3;
const fullDepthLimit = 5;
const skippedFolders: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
]);

const join = (base: string, rest: string) =>
  base.length === 0 ? rest : rest.length === 0 ? base : `${base}/${rest}`;

/**
 * What to ask the remote to list. A folder scope is searched as a whole; the repository root is
 * searched only in its named places unless full depth asks for everything.
 */
export const discoveryPathspecs = (options: DiscoveryOptions): ReadonlyArray<string> => {
  const scope = options.scope ?? "";
  if (options.fullDepth === true) return scope.length === 0 ? [] : [scope];
  if (scope.length > 0) return [scope];
  return ["SKILL.md", "skills", ...agentSkillPlaces];
};

/**
 * Finds skill folders from a tree listing: a directory with a regular file named exactly
 * `SKILL.md`. A SKILL.md in the scope ends the search unless full depth is requested. Otherwise the
 * named places are walked three levels deep, a folder scope is walked as a container, and full
 * depth adds every directory up to five levels deep except build and vendor folders.
 */
export const discoverSkillFolders = (
  entries: ReadonlyArray<TreeEntry>,
  options: DiscoveryOptions,
): ReadonlyArray<DiscoveredSkillFolder> => {
  const scope = options.scope ?? "";
  const skillDirectories = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) continue;
    if (entry.path === "SKILL.md") skillDirectories.add("");
    else if (entry.path.endsWith("/SKILL.md"))
      skillDirectories.add(entry.path.slice(0, -"/SKILL.md".length));
  }
  const relative = (directory: string): ReadonlyArray<string> | undefined => {
    if (scope.length === 0) return directory.length === 0 ? [] : directory.split("/");
    if (directory === scope) return [];
    return directory.startsWith(`${scope}/`)
      ? directory.slice(scope.length + 1).split("/")
      : undefined;
  };
  const found = new Map<string, string>();
  const add = (directory: string, place: string) => {
    if (!found.has(directory)) found.set(directory, place);
  };
  // Below the scope or container, a vendor or build folder and a folder named with a leading
  // underscore are not searched; a remote repository has no declarations to exclude them with.
  const skipped = (segments: ReadonlyArray<string>) =>
    segments.some((segment) => skippedFolders.has(segment) || segment.startsWith("_"));

  if (skillDirectories.has(scope)) {
    add(scope, "scope");
    if (options.fullDepth !== true) return [{ path: scope, place: "scope" }];
  }
  const ancestorIsSkill = (directory: string, container: string) => {
    let current = directory;
    while (current.length > container.length) {
      const slash = current.lastIndexOf("/");
      current = slash === -1 ? "" : current.slice(0, slash);
      if (current.length > container.length && skillDirectories.has(current)) return true;
    }
    return false;
  };
  const containers = [
    ...namedPlaces.map((place) => [join(scope, place), place] as const),
    ...(scope.length === 0 ? [] : ([[scope, "folder"]] as const)),
  ];
  for (const [container, place] of containers) {
    for (const directory of skillDirectories) {
      if (directory === container || !directory.startsWith(`${container}/`)) continue;
      const segments = directory.slice(container.length + 1).split("/");
      if (segments.length > containerDepth || skipped(segments)) continue;
      if (ancestorIsSkill(directory, container)) continue;
      add(directory, place);
    }
  }
  if (options.fullDepth === true) {
    for (const directory of skillDirectories) {
      const segments = relative(directory);
      if (segments === undefined || segments.length === 0) continue;
      if (segments.length <= fullDepthLimit && !skipped(segments)) add(directory, "full depth");
    }
  }
  return [...found.entries()]
    .map(([path, place]): DiscoveredSkillFolder => ({ path, place }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
};

// oxlint-disable-next-line eslint/no-control-regex -- Control characters are refused in paths.
const controlPattern = /[\u0000-\u001f\u007f-\u009f\\]/;

/**
 * Explains why a path relative to a skill folder must not be written into a snapshot, or
 * `undefined` when it is plain: no empty, `.` or `..` segment, no `.git` segment, no backslash,
 * NUL or other control character, and never absolute.
 */
export const unsafeRelativePath = (path: string): string | undefined => {
  if (path.length === 0) return "the path is empty";
  if (path.startsWith("/")) return "the path is absolute";
  if (controlPattern.test(path)) return "the path has a backslash or control character";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") return "the path has an empty segment";
    if (segment === "." || segment === "..") return "the path has a dot segment";
    if (segment.toLowerCase() === ".git") return "the path has a .git segment";
  }
  return undefined;
};
