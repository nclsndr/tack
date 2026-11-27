import type { Path } from "effect";
import { linkableKinds, resourceKinds, type LinkableKind } from "../resources/kinds.ts";
import type { AgentAdapterDescriptor, AgentAdapterId } from "../links/agent-adapter-schema.ts";
import { agentAdapterDescriptor, agentAdapterIds } from "./agent-adapter.ts";

/** A concrete user or project-root target whose adapter directories can receive managed links. */
export type AgentLayoutTarget = {
  readonly _tag: "project-root" | "user";
  readonly canonicalPath: string;
};

/** A resource kind that an adapter can receive as a managed link. */
export type AgentLayoutKind = LinkableKind;

/** The facts that place one managed link: its adapter, kind and name, and target. */
export type AgentLayoutLink = {
  readonly adapter: AgentAdapterId;
  readonly address: { readonly kind: AgentLayoutKind; readonly name: string };
  readonly target: AgentLayoutTarget;
};

type TargetKind = Pick<AgentLayoutTarget, "_tag">;

const resourceDirectorySegments = (
  descriptor: AgentAdapterDescriptor,
  target: TargetKind,
  kind: AgentLayoutKind,
): ReadonlyArray<string> | undefined => {
  const project = target._tag === "project-root";
  if (kind === "skill") {
    return project ? descriptor.projectSkillDirectory : descriptor.userSkillDirectory;
  }
  return project ? descriptor.projectCommandDirectory : descriptor.userCommandDirectory;
};

const windowsPathPattern = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Appends adapter-owned segments to a canonical path using that path's own separator, so a
 * Windows-shaped target derives the same destination on every host platform.
 */
const joinCanonicalPath = (canonicalPath: string, segments: ReadonlyArray<string>) => {
  const windowsPath = windowsPathPattern.test(canonicalPath);
  const separator = windowsPath ? "\\" : "/";
  const normalized = windowsPath ? canonicalPath.replaceAll("/", "\\") : canonicalPath;
  const prefix = normalized.endsWith(separator) ? normalized : `${normalized}${separator}`;
  return `${prefix}${segments.join(separator)}`;
};

/**
 * Reports whether an adapter delivers one resource kind to a target kind.
 *
 * Delivery derives only from the adapter's directories, so the planner, status, and persisted
 * evidence cannot disagree about which kinds an adapter receives.
 */
export const deliversKind = (
  descriptor: AgentAdapterDescriptor,
  target: TargetKind,
  kind: AgentLayoutKind,
) => resourceDirectorySegments(descriptor, target, kind) !== undefined;

/** Derives a kind-specific adapter directory, or absence when the adapter does not deliver it. */
export const resourceDirectory = (
  adapter: AgentAdapterId,
  target: AgentLayoutTarget,
  kind: AgentLayoutKind,
): string | undefined => {
  const segments = resourceDirectorySegments(agentAdapterDescriptor(adapter), target, kind);
  return segments === undefined ? undefined : joinCanonicalPath(target.canonicalPath, segments);
};

/** Returns the adapter filename for one resource: commands are Markdown files, skills directories. */
export const resourceName = (address: AgentLayoutLink["address"]) =>
  resourceKinds[address.kind].entryType === "file" ? `${address.name}.md` : address.name;

/**
 * Derives the physical destination of one managed link from its adapter, address, and target.
 * Managed-link evidence always names a delivered kind, so any other input is a programming error.
 */
export const managedLinkDestinationPath = (link: AgentLayoutLink) => {
  const directory = resourceDirectory(link.adapter, link.target, link.address.kind);
  if (directory === undefined)
    throw new Error("Managed-link evidence requires a supported adapter destination.");
  return joinCanonicalPath(directory, [resourceName(link.address)]);
};

/**
 * Derives the exact relative link text Tack writes so that a managed link resolves to its source.
 *
 * @param linkDirectory - The real directory containing the link, which is where the OS resolves
 *   its text. A lexical parent that crosses a symbolic link would produce a dangling link.
 * @returns Absence when no relative text can reach the source, such as across Windows volumes.
 */
export const managedLinkRelativeTarget = (
  linkDirectory: string,
  sourcePath: string,
  path: Path.Path,
): string | undefined => {
  const relativeTarget = path.relative(linkDirectory, sourcePath);
  return relativeTarget.length === 0 || path.isAbsolute(relativeTarget) === true
    ? undefined
    : relativeTarget;
};

/** Every folder where an adapter may hold managed links for these targets, in every linkable kind. */
export const agentLinkFolders = (
  targets: ReadonlyArray<AgentLayoutTarget>,
): ReadonlyArray<string> =>
  targets.flatMap((target) =>
    agentAdapterIds.flatMap((adapter) =>
      linkableKinds.flatMap((kind) => resourceDirectory(adapter, target, kind) ?? []),
    ),
  );
