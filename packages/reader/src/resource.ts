import type { DocsResourceReference } from "./types.ts";

/** A stable browser key for one source-qualified documentation resource. */
export function resourceIdentity(resource: DocsResourceReference): string {
  return `${resource.sourceRegistrationId}:${resource.name}`;
}

/** Gives a short label to source-qualified document groups without exposing UUIDs in the layout. */
export function resourceLabel(resource: DocsResourceReference & { sourcePath: string }): string {
  return `${resource.sourcePath.split("/").at(-1) ?? resource.sourceRegistrationId} / ${resource.name}`;
}
