import { Predicate } from "effect";
import type { PublicEnvelope } from "../public-outcome.ts";
import type { Style } from "./style.ts";
import { diagnosticLines, headerLines, hintLines, sections } from "./view.ts";

/** Narrows an unknown JSON value to a plain object. */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  Predicate.isObject(value);

/** Header, body blocks, diagnostics, then hints: the shape every dedicated view shares. */
export const frameView = (
  envelope: PublicEnvelope,
  style: Style,
  parts: {
    readonly scope?: string;
    readonly body: ReadonlyArray<ReadonlyArray<string> | undefined>;
    readonly hints?: ReadonlyArray<string>;
  },
): string =>
  sections(
    headerLines(envelope, parts.scope, style),
    ...parts.body,
    diagnosticLines(envelope.diagnostics, style),
    hintLines(parts.hints ?? [], style),
  );
