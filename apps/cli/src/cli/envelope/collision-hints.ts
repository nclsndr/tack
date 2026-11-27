import { Option, Schema } from "effect";
import { UserLinkedExcludeSchema } from "../../domain/choices/choice-schema.ts";
import type { ManagedLinkTarget } from "../../domain/links/managed-link-schema.ts";
import { argvLine } from "../../domain/hints/next-commands.ts";
import { commandLine, selectorFlags, userExcludeCommand } from "./command-line.ts";

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
      "pick-exclude",
      reference(address),
      "--kind",
      address.kind,
      ...selectorFlags(subject.target),
    ),
  );

const decodeUserLinkedExclude = Schema.decodeUnknownOption(
  Schema.Struct({ subject: UserLinkedExcludeSchema }),
);

/**
 * One `tack pick exclude … --user` command per `project-exclude-linked-for-user` diagnostic: a
 * project cannot hide what the user namespace links, so the user exclude is the one that turns
 * the resource off, everywhere.
 */
export const userExcludeCommands = (
  diagnostics: ReadonlyArray<{ readonly code: string; readonly details?: unknown }>,
  reference: (address: {
    readonly kind: string;
    readonly name: string;
    readonly sourceRegistrationId: string;
  }) => string,
): ReadonlyArray<string> =>
  diagnostics
    .filter((diagnostic) => diagnostic.code === "project-exclude-linked-for-user")
    .flatMap((diagnostic) => Option.toArray(decodeUserLinkedExclude(diagnostic.details)))
    .map(({ subject: { address } }) =>
      argvLine(userExcludeCommand(reference(address), address.kind)),
    );
