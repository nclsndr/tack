import { Effect } from "effect";
import {
  attachDocs,
  configureDocs,
  detachDocs,
  inspectDocs,
  resolveDocsTarget,
} from "../../../features/docs/docs.ts";
import { appliedAs, docsListOutcome, resultAs } from "../outcomes.ts";
import type { RoutesFor } from "./route.ts";

const docsSelector = (invocation: { readonly projectName?: string; readonly cwd?: string }) => ({
  ...(invocation.projectName === undefined ? {} : { projectName: invocation.projectName }),
  ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
});

/** Docs settings, attachments, mounts and writing targets. */
export const docsRoutes: RoutesFor<
  "docs-attach" | "docs-configure" | "docs-detach" | "docs-list" | "docs-target"
> = {
  "docs-list": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      inspectDocs(stateOptions, docsSelector(invocation)).pipe(Effect.map(docsListOutcome)),
  },
  "docs-target": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      resolveDocsTarget(stateOptions, {
        ...docsSelector(invocation),
        ...(invocation.resource === undefined ? {} : { resource: invocation.resource }),
      }).pipe(Effect.map(resultAs("docs-target"))),
  },
  "docs-configure": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      configureDocs(stateOptions, docsSelector(invocation), {
        ...(invocation.destination === undefined ? {} : { destination: invocation.destination }),
        ...(invocation.defaultWritingResource === undefined
          ? {}
          : { defaultWritingResource: invocation.defaultWritingResource }),
        clearDefault: invocation.clearDefault,
      }).pipe(Effect.map(appliedAs("docs-configure"))),
  },
  "docs-attach": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      attachDocs(stateOptions, docsSelector(invocation), invocation.resource).pipe(
        Effect.map(appliedAs("docs-attach")),
      ),
  },
  "docs-detach": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      detachDocs(stateOptions, docsSelector(invocation), invocation.resource).pipe(
        Effect.map(appliedAs("docs-detach")),
      ),
  },
};
