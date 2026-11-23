import { Option, Schema } from "effect";
import {
  renderSourceRegistrationPlan,
  renderSourceScaffold,
  sourceCheckLines,
} from "./source-authoring.ts";
import type { DocsResourceReference } from "../../../domain/docs/docs-schema.ts";
import type { SelectableAddress } from "../../../domain/sources/catalog-schema.ts";
import {
  ChoiceAddressCandidatesSchema,
  ChoiceChangePayloadSchema,
  ChoiceRemovalPayloadSchema,
} from "../../../features/choices/choice.ts";
import { DocsSettingsPayloadSchema } from "../../../features/docs/docs.ts";
import {
  ProjectRegistrationConflictDetailsSchema,
  ProjectRegistrationPayloadSchema,
} from "../../../features/projects/project.ts";
import { AdapterSettingsPayloadSchema } from "../../../features/reconciliation/agent.ts";
import {
  SourceRegistrationPayloadSchema,
  SourceRelocationPayloadSchema,
} from "../../../features/sources/source.ts";
import { StateInitializationPayloadSchema } from "../../../services/state-store.ts";
import { commandLine, selectorFlags } from "../command-line.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import { handMadeLines } from "./hand-made.ts";
import { displayWidth, padEnd, wrapText } from "./text.ts";
import {
  addressText,
  diagnosticLines,
  headerLines,
  hintLines,
  namespaceText,
  plural,
  sections,
} from "./view.ts";
import type { HumanView, HumanViewRegistry } from "./render.ts";
import type { Style } from "./style.ts";

// Diagnostic details are read through the schema of the failure or warning that carries them.
const decodeCandidates = Schema.decodeUnknownOption(ChoiceAddressCandidatesSchema);
const decodeProjectConflict = Schema.decodeUnknownOption(ProjectRegistrationConflictDetailsSchema);

/** What a mutation view contributes around the shared header. */
type Parts = {
  readonly scope?: string;
  /** The single confirmation sentence, wrapped to the width. */
  readonly confirmation: string;
  /** Supporting facts, one block of labelled rows. */
  readonly facts?: ReadonlyArray<Fact>;
  /** Blocks that belong after the diagnostics, such as the catalog candidates. */
  readonly after?: ReadonlyArray<string>;
  readonly hints?: ReadonlyArray<string>;
};

/** A labelled value, or several values listed under one label. */
type Fact = readonly [label: string, values: ReadonlyArray<string>];

/**
 * Lays facts out as aligned `label  value` rows. A fact whose rows would pass the width drops its
 * values below the label instead, wrapped, so long paths and identifiers stay whole.
 */
const factLines = (allFacts: ReadonlyArray<Fact>, style: Style): ReadonlyArray<string> => {
  const facts = allFacts.filter(([, values]) => values.length > 0);
  const labelWidth = Math.max(0, ...facts.map(([label]) => displayWidth(label)));
  return facts.flatMap(([label, values]) => {
    const inline = values.map(
      (value, index) => `  ${padEnd(index === 0 ? style.dim(label) : "", labelWidth)}  ${value}`,
    );
    return inline.every((line) => displayWidth(line) <= style.width)
      ? inline
      : [
          `  ${style.dim(label)}`,
          ...values.flatMap((value) =>
            wrapText(value, Math.max(10, style.width - 4), { keepWords: true }).map(
              (line) => `    ${line}`,
            ),
          ),
        ];
  });
};

const compose = (envelope: PublicEnvelope, style: Style, parts: Parts): string =>
  sections(
    headerLines(envelope, parts.scope, style),
    wrapText(parts.confirmation, style.width, { keepWords: true }),
    factLines(parts.facts ?? [], style),
    diagnosticLines(envelope.diagnostics, style),
    parts.after,
    hintLines(parts.hints ?? [], style),
  );

const addressOperands = (address: SelectableAddress, style: Style) => [
  style.reference(address),
  "--kind",
  address.kind,
];

const adaptersText = (adapters: ReadonlyArray<string>) =>
  adapters.length === 0 ? "none" : adapters.join(", ");

const resourceText = (resource: DocsResourceReference, style: Style) =>
  style.reference({ ...resource, kind: "docs" });

/** A hint naming what the failure's own message tells the operator to run next. */
const failureHints = (envelope: PublicEnvelope): ReadonlyArray<string> =>
  envelope.diagnostics.flatMap((diagnostic): ReadonlyArray<string> => {
    const details = Option.fromNullishOr(diagnostic.details);
    switch (diagnostic.code) {
      case "registration-not-found":
        return [commandLine("source-list")];
      case "project-not-found":
        return [commandLine("project-list")];
      case "docs-resource-unavailable":
        return [commandLine("catalog")];
      case "project-registration-conflict":
        return Option.match(Option.flatMap(details, decodeProjectConflict), {
          onNone: () => [],
          // Different roots for this repository are repaired by refresh; a different repository is not.
          onSome: (conflict) =>
            conflict.existingAnchor === conflict.observedAnchor
              ? [commandLine("project-refresh", "--project", conflict.projectName)]
              : [],
        });
      default:
        return [];
    }
  });

const unique = (hints: ReadonlyArray<string>) => [...new Set(hints)];

/** The view's own hints for a failure it knows, else the commands the failure names as its fix. */
const failureView = (envelope: PublicEnvelope, style: Style): string => {
  const own = unique(failureHints(envelope));
  return sections(
    headerLines(envelope, undefined, style),
    diagnosticLines(envelope.diagnostics, style),
    hintLines(own.length === 0 ? envelope.next : own, style),
  );
};

/**
 * Builds one mutation view: failures keep header and diagnostics; successes read `applied` through
 * the payload schema its producer builds it from, and leave any other payload to the generic view.
 */
const mutationView = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  build: (applied: S["Type"], style: Style, envelope: PublicEnvelope) => Parts,
): HumanView => {
  const decode = Schema.decodeUnknownOption(schema);
  return (envelope, style) => {
    if (envelope.status === "failure") return failureView(envelope, style);
    const applied = decode(envelope.applied);
    return Option.isSome(applied)
      ? compose(envelope, style, build(applied.value, style, envelope))
      : undefined;
  };
};

const initView = mutationView(StateInitializationPayloadSchema, (applied, style) => {
  const directory = style.path(applied.stateDirectory);
  return {
    confirmation: applied.alreadyInitialized
      ? `Tack was already initialized in ${directory}; the existing state was kept.`
      : `Initialized Tack state in ${directory}.`,
    // State alone links nothing: init sets up the agents and their built-in skills.
    hints: [commandLine("machine-init")],
  };
});

const sourceRegistrationView = mutationView(
  SourceRegistrationPayloadSchema,
  (applied, style, envelope) => {
    // The name a reference types, beside the path; the ID row already shows a source without a label.
    const folder = style.path(applied.registration.canonicalPath);
    const source =
      applied.name === applied.registration.id ? folder : `${applied.name} (${folder})`;
    return {
      confirmation:
        applied.scaffolded !== undefined
          ? `Created ${style.path(applied.scaffolded)}. Registered source ${source}.`
          : applied.alreadyRegistered
            ? `Source ${source} is already registered; nothing changed.`
            : `Registered source ${source}.`,
      facts: [
        ["id", [applied.registration.id]],
        ["docs", applied.docs.map((docs) => docs.name)],
      ],
      // The route names where the new resources go next: a project to register or to sync.
      hints: envelope.next,
      ...(applied.inspection === undefined
        ? {}
        : { after: sourceCheckLines(applied.inspection, style) }),
    };
  },
);

const sourceRelocateView = mutationView(SourceRelocationPayloadSchema, (applied, style) => {
  const path = style.path(applied.registration.canonicalPath);
  const id = applied.registration.id;
  return {
    confirmation: applied.relocated
      ? `Relocated source ${id} to ${path}.`
      : `Source ${id} already points at ${path}; nothing changed.`,
  };
});

const projectAddView = mutationView(ProjectRegistrationPayloadSchema, (applied, style) => {
  return {
    scope: applied.project.name,
    confirmation: applied.alreadyRegistered
      ? `Project ${applied.project.name} is already registered; nothing changed.`
      : `Registered project ${applied.project.name}.`,
    facts: [
      ["anchor", [style.path(applied.project.gitCommonDirectory)]],
      ["roots", applied.project.roots.map((root) => style.path(root))],
    ],
    after: handMadeLines(applied.handMade, style),
    hints: [commandLine("catalog"), commandLine("sync", "--project", applied.project.name)],
  };
});

/** The `choice-address-not-in-catalog` warning's candidate addresses, when it carries them. */
const warnedCandidates = (envelope: PublicEnvelope) =>
  Option.flatMap(
    Option.fromNullishOr(
      envelope.diagnostics.find((diagnostic) => diagnostic.code === "choice-address-not-in-catalog")
        ?.details,
    ),
    decodeCandidates,
  );

const choiceSetView = mutationView(
  ChoiceChangePayloadSchema,
  ({ changed, choice }, style, envelope) => {
    const subject = addressText(choice.address, style);
    const where = namespaceText(choice.namespace, "prose");
    const flags = selectorFlags(choice.namespace);
    const warned = warnedCandidates(envelope);
    const closest = Option.flatMap(warned, ({ candidates }) => Option.fromNullishOr(candidates[0]));
    return {
      scope: namespaceText(choice.namespace, "label"),
      confirmation: changed
        ? `Set ${subject} to ${choice.decision} for ${where}.`
        : `${subject} is already set to ${choice.decision} for ${where}; nothing changed.`,
      after: Option.match(warned, {
        onNone: () => [],
        onSome: ({ candidates }) => [
          style.bold("Closest catalog addresses"),
          ...(candidates.length === 0
            ? ["  none; no catalog address is close to it"]
            : candidates.map((address) => `  ${addressText(address, style)}`)),
        ],
      }),
      hints: [
        ...Option.match(closest, {
          onNone: () => [],
          onSome: (address) => [
            commandLine(
              choice.decision === "include" ? "choice-set" : "choice-exclude",
              ...addressOperands(address, style),
              ...flags,
            ),
            commandLine("choice-remove", ...addressOperands(choice.address, style), ...flags),
          ],
        }),
        commandLine("sync", ...flags),
      ],
    };
  },
);

const choiceRemoveView = mutationView(ChoiceRemovalPayloadSchema, (applied, style) => {
  const subject = addressText(applied.address, style);
  const where = namespaceText(applied.namespace, "prose");
  return {
    scope: namespaceText(applied.namespace, "label"),
    confirmation: applied.removed
      ? `Removed the choice for ${subject} from ${where}.`
      : `No choice for ${subject} exists in ${where}; nothing changed.`,
    hints: applied.removed ? [commandLine("sync", ...selectorFlags(applied.namespace))] : [],
  };
});

const adapterSetView = mutationView(AdapterSettingsPayloadSchema, (applied) => ({
  confirmation: applied.changed
    ? `Enabled adapters are now ${adaptersText(applied.enabledAdapters)}.`
    : `Enabled adapters are already ${adaptersText(applied.enabledAdapters)}; nothing changed.`,
  // A bare `tack sync` only resolves inside a registered project; `--all` runs from anywhere.
  hints: applied.changed ? [commandLine("sync", "--all")] : [],
}));

/** The docs settings the three docs mutations all return, after the change. */
const docsFacts = (
  settings: typeof DocsSettingsPayloadSchema.Type,
  style: Style,
): ReadonlyArray<Fact> => [
  [
    "attached",
    settings.attachments.length === 0
      ? ["none"]
      : settings.attachments.map((resource) => resourceText(resource, style)),
  ],
  ["destination", settings.destination === undefined ? [] : [settings.destination]],
  [
    "default",
    settings.defaultWritingResource === undefined
      ? []
      : [resourceText(settings.defaultWritingResource, style)],
  ],
];

const docsReconcileHint = (projectName: string) =>
  commandLine("sync", "--no-adapters", "--project", projectName);

// The envelope returns the project's docs settings, not which resource the call named or whether
// the settings changed, so these confirmations state only what is certain after the call.
const docsAttachView = mutationView(DocsSettingsPayloadSchema, (settings, style) => ({
  scope: settings.projectName,
  confirmation: `Docs attach saved for project ${settings.projectName}; it has ${plural(settings.attachments.length, "attached resource")}.`,
  facts: docsFacts(settings, style),
  hints: [docsReconcileHint(settings.projectName)],
}));

const docsDetachView = mutationView(DocsSettingsPayloadSchema, (settings, style) => ({
  scope: settings.projectName,
  confirmation: `Docs detach saved for project ${settings.projectName}; ${
    settings.attachments.length === 0
      ? "no attached resources remain"
      : `${plural(settings.attachments.length, "attached resource")} remain${settings.attachments.length === 1 ? "s" : ""}`
  }.`,
  facts: docsFacts(settings, style),
  hints: [docsReconcileHint(settings.projectName)],
}));

const docsConfigureView = mutationView(DocsSettingsPayloadSchema, (settings, style) => ({
  scope: settings.projectName,
  confirmation: `Docs settings saved for project ${settings.projectName}.`,
  facts: docsFacts(settings, style),
}));

/** Dedicated views for the immediate mutations. */
export const mutationViews: HumanViewRegistry = {
  "adapter enable": adapterSetView,
  "pick remove": choiceRemoveView,
  "pick include": choiceSetView,
  "pick exclude": choiceSetView,
  "docs attach": docsAttachView,
  "docs configure": docsConfigureView,
  "docs detach": docsDetachView,
  "state init": initView,
  "project add": projectAddView,
  "source add": (envelope, style) =>
    renderSourceScaffold(envelope, style) ??
    renderSourceRegistrationPlan(envelope, style) ??
    sourceRegistrationView(envelope, style),
  "source relocate": sourceRelocateView,
};
