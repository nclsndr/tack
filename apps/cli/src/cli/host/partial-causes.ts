import { Schema } from "effect";
import type {
  PartialCause,
  PartialCauseCode,
} from "../../features/reconciliation/partial-cause.ts";
import { collisionExcludeCommands } from "./collision-hints.ts";
import { commandLine } from "./command-line.ts";
import type { PublicDiagnosticSchema } from "./public-outcome.ts";

/**
 * The public message for every partial-cause code. Codes are kebab-case CLI diagnostic codes; the
 * subject in `details.subject` names what each cause is about.
 */
export const partialCauseRegistry: { readonly [K in PartialCauseCode]: string } = {
  "profile-inventory-unresolved":
    "The retained fixed inventory or complete target boundary is unresolved. Restore its sources or explicitly reapply; sync does not add new dependencies or defaults.",
  "profile-delivery-incomplete":
    "The fixed inventory cannot be fully delivered by the enabled adapters. Supported members still reconcile; enable suitable adapters or explicitly reapply a compatible inventory.",
  "capability-blocked": "An adapter cannot deliver the required capability.",
  "catalog-quarantined": "A catalog candidate is quarantined and cannot be selected.",
  "dependency-blocked":
    "Selected resources are blocked by required dependencies that cannot be selected.",
  "destination-directory-conflict":
    "An agent resource directory is occupied by an entry Tack cannot use.",
  "destination-drift": "A managed destination differs from its recorded or desired link.",
  "destination-evidence-absent": "A recorded managed link is absent and no longer desired.",
  "destination-evidence-changed":
    "A recorded managed link was changed outside Tack and is no longer desired; sync releases it.",
  "destination-expected-absent": "A desired link is not delivered.",
  "destination-foreign-entry":
    "An entry Tack does not own is in the way of a link Tack recorded or shares with another adapter.",
  "destination-hand-made":
    "A hand-made entry is kept where a selected resource would link, so Tack does not link it there. Exclude the resource to keep yours on purpose, or move yours away and sync.",
  "destination-observation-failed": "A destination could not be observed.",
  "destination-target-missing": "The target directory of a managed destination is missing.",
  "destination-unrecorded":
    "A link Tack would write is in place but not recorded, as when a clone checks out a committed link; sync adopts it.",
  "foreign-destination":
    "An entry Tack does not own occupies a destination, and it is not the link Tack would write. Tack never replaces it: `git rm` it when the repository commits it, or move it away, and ignore Tack's links in .gitignore; then sync.",
  "import-folder-missing":
    "An imported skill's folder is gone. Move it back, or remove the import's record.",
  "import-folder-not-cataloged":
    "An imported skill's folder is not a skill of its source's catalog.",
  "import-staging-left-over": "An interrupted import write left its staging folder.",
  "imports-invalid": "A source's imports section cannot be read.",
  "link-action-failed": "A planned link change failed.",
  "managed-link-drift": "A managed link changed after Tack recorded it.",
  "no-adapters-enabled": `No agent adapter is enabled, so nothing is delivered. Run \`${commandLine("machine-init")}\` to enable the agents found in this home, or \`${commandLine("adapter-set")} <adapter>\` to enable one.`,
  "pending-removal": "A cleanup obligation is pending.",
  "project-anchor-unhealthy": "A project's repository anchor cannot be observed.",
  "project-removing":
    "A project is being removed; its selections are suspended until cleanup ends.",
  "relative-target-unavailable":
    "A relative link target cannot be computed for a selected resource.",
  "removal-blocked": "A cleanup removal is blocked and keeps its obligation.",
  "removal-failed": "A cleanup removal failed and keeps its obligation.",
  "removal-skipped": "A cleanup removal was skipped and keeps its obligation.",
  "root-missing": "A registered project root is missing, so Tack cannot deliver to it.",
  "root-removing": "A project root is being removed and keeps cleanup obligations.",
  "project-exclude-linked-for-user":
    "A project exclude cannot hide a resource that the user namespace links, so every agent in the project still sees it. Exclude it for the user to turn it off everywhere.",
  "root-unhealthy": "A registered project root cannot be used.",
  "selection-collision": "Two or more selected resources need the same destination name.",
  "source-unhealthy": "A registered source is unhealthy, so its resources are unavailable.",
  "unresolved-choice": "An include choice names a resource that the catalog cannot provide.",
};

const toJson = Schema.decodeUnknownSync(Schema.Json);

/**
 * The public message of one cause. A selection collision also names the fix: one exclude command per
 * candidate, by registration ID because the diagnostic is a stable identifier, not a view.
 */
const messageOf = (cause: PartialCause): string =>
  cause.code === "selection-collision"
    ? `${partialCauseRegistry[cause.code]} Exclude all but one: ${collisionExcludeCommands(
        cause.subject,
        (address) => `${address.sourceRegistrationId}:${address.name}`,
      ).join(" or ")}.`
    : partialCauseRegistry[cause.code];

/** One warning diagnostic for one partial cause, with its subject as details. */
export const partialCauseDiagnostic = (
  cause: PartialCause,
): Omit<typeof PublicDiagnosticSchema.Type, "severity"> => ({
  code: cause.code,
  details: { subject: toJson(cause.subject) },
  message: messageOf(cause),
});
