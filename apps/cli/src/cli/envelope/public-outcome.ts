import { Cause, Exit, Option, Schema } from "effect";
import { compareCodeUnits, sortAndDedupeBy } from "../../domain/identity/ordering.ts";
import type { NextCommands } from "../../domain/hints/next-commands.ts";
import { argvLine } from "../../domain/hints/next-commands.ts";

/** The only public command-envelope format supported by this Tack release. */
const publicEnvelopeVersion = 1 as const;

const publicOutcomeClassifications = [
  "success",
  "domain",
  "partial",
  "invalid-invocation",
  "invalid-configuration",
  "persistence",
  "internal",
  "interruption",
] as const;

type PublicOutcomeClassification = (typeof publicOutcomeClassifications)[number];
type PublicOutcomeStatus = "success" | "partial" | "failure";

const statusFor = (classification: PublicOutcomeClassification): PublicOutcomeStatus => {
  if (classification === "success") {
    return "success";
  }
  if (classification === "partial") {
    return "partial";
  }
  return "failure";
};

/** Stable process classifications used by the CLI host. */
const PublicOutcomeClassificationSchema = Schema.Literals(publicOutcomeClassifications).annotate({
  description:
    "The cause class of the outcome and its exit code: success 0; partial and domain 1; invalid-invocation and invalid-configuration 2; persistence and internal 3; interruption 130.",
});

/** One structured, JSON-safe diagnostic exposed to automation. */
export const PublicDiagnosticSchema = Schema.Struct({
  code: Schema.String,
  details: Schema.optionalKey(Schema.Json),
  message: Schema.String,
  severity: Schema.Literals(["info", "warning", "error"]),
});

/** The stable JSON boundary shared by all public commands. */
export const PublicEnvelopeSchema = Schema.Struct({
  applied: Schema.NullOr(Schema.Json).annotate({
    description: "What a run with --apply changed; null for a preview or a read-only command.",
  }),
  classification: PublicOutcomeClassificationSchema,
  command: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The command path that ran, such as `status` or `upgrade status`.",
  }),
  diagnostics: Schema.Array(PublicDiagnosticSchema).annotate({
    description: "Everything that went wrong or deserves a look, each with a stable `code`.",
  }),
  next: Schema.Array(Schema.String).annotate({
    description:
      "Exact commands to run next, the same ones the text view lists under Next. Run them as written; empty when nothing is suggested.",
  }),
  plan: Schema.NullOr(Schema.Json).annotate({
    description: "What a preview would change; null once applied or for a read-only command.",
  }),
  result: Schema.NullOr(Schema.Json).annotate({
    description: "What a read-only or immediate command found or did.",
  }),
  status: Schema.Literals(["success", "partial", "failure"]).annotate({
    description:
      "success: nothing needs attention. partial: the command ran and something needs attention, such as an unhealthy link, so the exit code is 1 and this is not a tack failure. failure: the command did not complete.",
  }),
  version: Schema.Literal(publicEnvelopeVersion),
}).check(
  Schema.makeFilter((envelope) =>
    envelope.status === statusFor(envelope.classification)
      ? []
      : ["Public envelope status must agree with its classification."],
  ),
);

/** A validated public command envelope. */
export type PublicEnvelope = typeof PublicEnvelopeSchema.Type;

/** Pure command result before it is placed in the versioned envelope. */
export type PublicOutcome = {
  readonly applied?: Schema.Json;
  readonly classification: typeof PublicOutcomeClassificationSchema.Type;
  readonly diagnostics: ReadonlyArray<typeof PublicDiagnosticSchema.Type>;
  /** The commands the diagnostics name as their fix, in the order they name them. */
  readonly next?: NextCommands;
  readonly plan?: Schema.Json;
  readonly result?: Schema.Json;
};

const canonicalizeJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  return value;
};

const diagnosticKey = (diagnostic: typeof PublicDiagnosticSchema.Type) =>
  `${diagnostic.severity}\u0000${diagnostic.code}\u0000${diagnostic.message}\u0000${JSON.stringify(canonicalizeJson(diagnostic.details ?? null))}`;

/**
 * Places a pure outcome into the fixed-key public envelope. `next` starts as the commands the
 * diagnostics name; a dedicated view lists them under Next with its own, and the host publishes
 * that list.
 */
export const createPublicEnvelope = (command: string, outcome: PublicOutcome): PublicEnvelope => ({
  applied: outcome.applied ?? null,
  classification: outcome.classification,
  command,
  diagnostics: sortAndDedupeBy(outcome.diagnostics, diagnosticKey),
  next: [...new Set((outcome.next ?? []).map(argvLine))],
  plan: outcome.plan ?? null,
  result: outcome.result ?? null,
  status: statusFor(outcome.classification),
  version: publicEnvelopeVersion,
});

const internalOutcome = (): PublicOutcome => ({
  classification: "internal",
  diagnostics: [
    {
      code: "internal-error",
      message: "An unexpected internal error occurred.",
      severity: "error",
    },
  ],
});

const interruptedOutcome = (): PublicOutcome => ({
  classification: "interruption",
  diagnostics: [
    {
      code: "interrupted",
      message: "The command was interrupted.",
      severity: "error",
    },
  ],
});

/**
 * Converts an Effect exit without exposing Cause, defects, or interruption metadata.
 * Typed errors remain the caller's responsibility through `onFailure`.
 */
export const envelopeFromExit = <A, E>(
  command: string,
  exit: Exit.Exit<A, E>,
  handlers: {
    readonly onFailure: (error: E) => PublicOutcome;
    readonly onSuccess: (value: A) => PublicOutcome;
  },
): PublicEnvelope =>
  Exit.match(exit, {
    onFailure: (cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return createPublicEnvelope(command, interruptedOutcome());
      }
      if (Cause.hasDies(cause)) {
        return createPublicEnvelope(command, internalOutcome());
      }
      return Option.match(Cause.findErrorOption(cause), {
        onNone: () => createPublicEnvelope(command, internalOutcome()),
        onSome: (error) => createPublicEnvelope(command, handlers.onFailure(error)),
      });
    },
    onSuccess: (value) => createPublicEnvelope(command, handlers.onSuccess(value)),
  });

const exitCodeByClassification = {
  domain: 1,
  internal: 3,
  interruption: 130,
  "invalid-configuration": 2,
  "invalid-invocation": 2,
  partial: 1,
  persistence: 3,
  success: 0,
} as const satisfies Record<PublicOutcomeClassification, 0 | 1 | 2 | 3 | 130>;

/** Maps the stable public classification to the CLI's coarse exit taxonomy. */
export const exitCodeForEnvelope = (envelope: PublicEnvelope): 0 | 1 | 2 | 3 | 130 =>
  exitCodeByClassification[envelope.classification];

/** Renders one canonical JSON value for stdout without logging or owning a runtime. */
export const renderPublicEnvelope = (envelope: PublicEnvelope): string =>
  JSON.stringify(canonicalizeJson(envelope));
