import type { ManagedLinkTarget } from "../links/managed-link-schema.ts";

/**
 * Names a destination by where it is, as `app:.claude/skills/review` for project `app` or
 * `user:.claude/skills/review` for the user target, so `status` and `doctor` name it alike.
 *
 * @returns `undefined` when the destination is not inside its target's directory.
 */
export const destinationPlace = (destination: {
  readonly destinationPath: string;
  readonly target: ManagedLinkTarget;
}): string | undefined => {
  const root = destination.target.canonicalPath;
  const place =
    destination.target._tag === "project-root" ? destination.target.projectName : "user";
  return destination.destinationPath.startsWith(`${root}/`)
    ? `${place}:${destination.destinationPath.slice(root.length + 1)}`
    : undefined;
};
