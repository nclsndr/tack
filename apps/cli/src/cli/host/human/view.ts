import { Predicate } from "effect";
import type { ResourceKind } from "../../../domain/resources/kinds.ts";
import { argvLine } from "../command-line.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import { dependencyBlockerSentences } from "./dependency-blockers.ts";
import type { ReferenceAddress, Style } from "./style.ts";
import { cell, flow, paragraph, wrapText, type Cell } from "./text.ts";

type Diagnostic = PublicEnvelope["diagnostics"][number];

/**
 * Names a resource by its kind and shortest reference. A dependency edge or a diagnostic subject
 * names a kind and a name before any source resolves it, so only those callers pass no source.
 */
export const addressText = (
  address: Omit<ReferenceAddress, "sourceRegistrationId"> & {
    readonly sourceRegistrationId?: string;
  },
  style: Style,
) =>
  `${address.kind} ${address.sourceRegistrationId === undefined ? address.name : style.reference({ ...address, sourceRegistrationId: address.sourceRegistrationId })}`;

/** `1 skill`, `2 skills`. */
export const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/** `1 needs attention`, `2 items need attention`: a count, optionally of a noun, with its verb agreed. */
export const needAttention = (count: number, noun?: string) =>
  `${noun === undefined ? count : plural(count, noun)} ${count === 1 ? "needs" : "need"} attention`;

/** How each resource kind reads as a plural noun: `2 skills`, `2 context`. */
export const kindPlurals: Readonly<Record<ResourceKind, string>> = {
  skill: "skills",
  command: "commands",
  context: "context",
  script: "scripts",
  docs: "docs",
};

/** The heading of a section that lists resources of one kind: `Skills`, `Context`. */
export const kindHeading = (kind: ResourceKind): string =>
  `${kindPlurals[kind].charAt(0).toUpperCase()}${kindPlurals[kind].slice(1)}`;

/** Joins non-empty sections with one blank line between them, ending with a newline. */
export const sections = (...parts: ReadonlyArray<ReadonlyArray<string> | undefined>): string =>
  `${parts
    .filter((part): part is ReadonlyArray<string> => part !== undefined && part.length > 0)
    .map((part) => part.join("\n"))
    .join("\n\n")}\n`;

const badge = (envelope: PublicEnvelope, style: Style): Cell => {
  if (envelope.status === "success") return cell("✓ success", style.green);
  if (envelope.status === "partial") return cell("! partial", style.yellow);
  return cell(`✗ ${envelope.classification}`, style.red);
};

/**
 * The first line of every dedicated view: the operation, its scope when it has one, and its status.
 * It wraps instead of overflowing.
 */
export const headerLines = (
  envelope: PublicEnvelope,
  scope: string | undefined,
  style: Style,
): ReadonlyArray<string> =>
  flow(
    [
      cell(`tack ${envelope.command}`, style.bold),
      ...(scope === undefined || scope === ""
        ? []
        : [cell("·", style.dim), ...scope.split(/\s+/).map((word) => cell(word, style.dim))]),
      cell("·", style.dim),
      badge(envelope, style),
    ],
    { width: style.width, indent: 0, hang: 2 },
  );

const isAddress = (value: unknown): value is ReferenceAddress =>
  Predicate.isObject(value) &&
  typeof value["kind"] === "string" &&
  typeof value["name"] === "string";

const stringsOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** `project demo` or `user` for a target or namespace value, whatever its tag spelling. */
const placeText = (value: unknown): string | undefined => {
  if (!Predicate.isObject(value)) return undefined;
  if (typeof value["projectName"] === "string") return `project ${value["projectName"]}`;
  return value["_tag"] === "user" ? "user" : undefined;
};

/** Flat details as `key value` pairs, with home paths shortened; anything nested as compact JSON. */
type Primitive = string | number | boolean;
const isPrimitive = (value: unknown): value is Primitive =>
  ["string", "number", "boolean"].includes(typeof value);

/**
 * Flat details as `key value` pairs: text trimmed with home paths shortened, a list of words as one
 * shell line, and an empty list left out because it states nothing. Details that nest further stay
 * compact JSON, so that no fact is dropped.
 */
const detailsText = (details: unknown, style: Style): string | undefined => {
  if (details === undefined) return undefined;
  if (!Predicate.isObject(details)) return JSON.stringify(details);
  const entries = Object.entries(details).filter(
    ([, value]) => Array.isArray(value) === false || value.length > 0,
  );
  if (entries.length === 0) return undefined;
  const flat = entries.flatMap(([key, value]) =>
    isPrimitive(value)
      ? [[key, typeof value === "string" ? style.path(value.trim()) : String(value)] as const]
      : Array.isArray(value) && value.every(isPrimitive)
        ? [[key, argvLine(value.map(String))] as const]
        : [],
  );
  return flat.length === entries.length
    ? flat.map(([key, value]) => `${key} ${value}`).join(" · ")
    : JSON.stringify(details);
};

/**
 * What a diagnostic is about, read from its `details.subject`. A subject the view cannot summarize
 * is shown as compact JSON, so that no diagnostic fact is dropped.
 */
export const subjectText = (diagnostic: Diagnostic, style: Style): string | undefined => {
  const subject = Predicate.isObject(diagnostic.details)
    ? diagnostic.details["subject"]
    : undefined;
  if (subject === undefined) return detailsText(diagnostic.details, style);
  if (!Predicate.isObject(subject)) return JSON.stringify(subject);
  const parts: string[] = [];
  const addresses = [
    subject["address"],
    ...(Array.isArray(subject["addresses"]) ? subject["addresses"] : []),
    ...(Array.isArray(subject["members"]) ? subject["members"] : []),
  ].filter(isAddress);
  if (addresses.length > 0)
    parts.push([...new Set(addresses.map((address) => addressText(address, style)))].join(", "));
  if (typeof subject["adapter"] === "string") parts.push(subject["adapter"]);
  for (const place of [subject["target"], subject["namespace"]]) {
    const text = placeText(place);
    if (text !== undefined) parts.push(text);
  }
  const destinations = stringsOf(subject["destinationPaths"]);
  if (destinations.length > 0)
    parts.push(
      destinations.length === 1
        ? style.path(destinations[0] ?? "")
        : `${style.path(destinations[0] ?? "")} and ${destinations.length - 1} more`,
    );
  for (const key of ["destinationPath", "candidatePath", "root", "path"] as const) {
    const value = subject[key];
    if (typeof value === "string") parts.push(style.path(value));
  }
  if (typeof subject["projectName"] === "string" && placeText(subject["target"]) === undefined)
    parts.push(`project ${subject["projectName"]}`);
  const registration = subject["registration"];
  if (Predicate.isObject(registration) && typeof registration["canonicalPath"] === "string")
    parts.push(style.path(registration["canonicalPath"]));
  for (const key of ["capability", "reason", "cause", "failure"] as const) {
    const value = subject[key];
    if (typeof value === "string") parts.push(value);
  }
  const issue = subject["issue"];
  if (Predicate.isObject(issue) && typeof issue["message"] === "string")
    parts.push(
      `${typeof issue["code"] === "string" ? `${issue["code"]}: ` : ""}${issue["message"]}`,
    );
  if (parts.length > 0) return parts.join(" · ");
  const keys = Object.keys(subject);
  return keys.length === 0 || (keys.length === 1 && keys[0] === "enabledAdapters")
    ? undefined
    : JSON.stringify(subject);
};

const severityMark = (severity: Diagnostic["severity"], style: Style): Cell =>
  severity === "error"
    ? cell("✗", style.red)
    : severity === "warning"
      ? cell("!", style.yellow)
      : cell("i", style.cyan);

const severityWord = (severity: Diagnostic["severity"]) =>
  severity === "error" ? "error" : severity === "warning" ? "warning" : "info";

/**
 * The diagnostics block: each diagnostic's message, then its code and subject. The mark is never the
 * only carrier of severity: the second line names it.
 */
export const diagnosticLines = (
  diagnostics: ReadonlyArray<Diagnostic>,
  style: Style,
): ReadonlyArray<string> => {
  if (diagnostics.length === 0) return [];
  const heading = diagnostics.some(({ severity }) => severity === "error")
    ? "Problems"
    : diagnostics.some(({ severity }) => severity === "warning")
      ? "Warnings"
      : "Notes";
  return [
    style.bold(heading),
    ...diagnostics.flatMap((diagnostic) => {
      if (diagnostic.code === "pending-removals-outside-scope") {
        return paragraph(diagnostic.message, { width: style.width, indent: 2, paint: style.dim });
      }
      const mark = severityMark(diagnostic.severity, style);
      // A message that lists several problems keeps one line per problem.
      const message = diagnostic.message
        .split("\n")
        .flatMap((line) => wrapText(line, style.width - 4));
      const subject = subjectText(diagnostic, style);
      const detail = `${severityWord(diagnostic.severity)} ${diagnostic.code}${subject === undefined ? "" : ` · ${subject}`}`;
      const blockers =
        diagnostic.code === "dependency-blocked" && Predicate.isObject(diagnostic.details)
          ? dependencyBlockerSentences(diagnostic.details["subject"], style)
          : [];
      return [
        ...message.map((line, index) =>
          index === 0 ? `  ${mark.paint?.(mark.text) ?? mark.text} ${line}` : `    ${line}`,
        ),
        ...blockers.flatMap((sentence) =>
          wrapText(sentence, style.width - 4).map((line) => `    ${line}`),
        ),
        ...paragraph(detail, { width: style.width, indent: 4, paint: style.dim }),
      ];
    }),
  ];
};

/** A section title with a dim summary beside it; the summary wraps instead of overflowing. */
export const headingLines = (title: string, summary: string, style: Style): ReadonlyArray<string> =>
  flow([cell(title, style.bold), ...summary.split(/\s+/).map((word) => cell(word, style.dim))], {
    width: style.width,
    indent: 0,
    hang: 2,
  });

/**
 * Next-step hints, one command per line, last in the view. A command too long for the width wraps
 * with a trailing backslash so that it stays copyable.
 */
export const hintLines = (commands: ReadonlyArray<string>, style: Style): ReadonlyArray<string> => {
  style.hint(commands);
  return commands.length === 0
    ? []
    : [
        style.bold("Next"),
        ...commands.flatMap((command) =>
          flow(
            command.split(" ").map((word) => cell(word, style.cyan)),
            { width: style.width, indent: 2, hang: 4, continuation: " \\", keepWords: true },
          ),
        ),
      ];
};

/**
 * A dedicated header and diagnostics for an envelope that carries no payload, such as a failure,
 * and the commands its failure names as the fix. An envelope with an unreadable payload returns
 * `undefined` so that the generic view shows it.
 */
export const withoutPayload = (
  envelope: PublicEnvelope,
  scope: string | undefined,
  style: Style,
): string | undefined =>
  envelope.result === null && envelope.plan === null && envelope.applied === null
    ? sections(
        headerLines(envelope, scope, style),
        diagnosticLines(envelope.diagnostics, style),
        hintLines(envelope.next, style),
      )
    : undefined;

/** One labelled fact: the label and the cells of its value, each cell painted on every line. */
export type FactRow = readonly [label: string, value: ReadonlyArray<Cell>];

/** A key and value row: `Adapters  claude, codex`, with the value wrapping under itself. */
export const factRows = (rows: ReadonlyArray<FactRow>, style: Style): ReadonlyArray<string> => {
  const keyWidth = Math.max(0, ...rows.map(([key]) => key.length)) + 2;
  return rows.flatMap(([key, value]) => {
    const words = value.flatMap((piece) =>
      piece.text
        .split(" ")
        .filter((word) => word !== "")
        .map((word) => cell(word, piece.paint)),
    );
    const lines = flow(words, {
      width: style.width,
      indent: 2 + keyWidth,
      hang: 2 + keyWidth,
    });
    const [first = "", ...rest] = lines;
    return [
      `  ${style.dim(key)}${" ".repeat(keyWidth - key.length)}${first.slice(2 + keyWidth)}`.trimEnd(),
      ...rest,
    ];
  });
};
