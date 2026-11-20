import type { ManagedLinkTarget } from "../../domain/links/managed-link-schema.ts";
import { commandLine, selectorFlags } from "./command-line.ts";

/**
 * One `tack pick exclude` command per candidate of a selection collision: excluding all but one
 * resolves it. The reference names each candidate as the caller prefers (a label for a person, a
 * registration ID where identifiers must stay stable), and the namespace flag comes from the
 * collision's own target so that the command changes the namespace that selected the candidates.
 */
export const collisionExcludeCommands = (
  subject: {
    readonly target: ManagedLinkTarget;
    readonly addresses: ReadonlyArray<{
      readonly kind: string;
      readonly name: string;
      readonly sourceRegistrationId: string;
    }>;
  },
  reference: (address: {
    readonly kind: string;
    readonly name: string;
    readonly sourceRegistrationId: string;
  }) => string,
): ReadonlyArray<string> =>
  subject.addresses.map((address) =>
    commandLine(
      "choice-exclude",
      reference(address),
      "--kind",
      address.kind,
      ...selectorFlags(subject.target),
    ),
  );
