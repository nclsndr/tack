import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { expect } from "vitest";
import type { ReferenceIndex } from "../../features/sources/resource-reference.ts";
import {
  PublicEnvelopeSchema,
  type PublicEnvelope,
  type PublicOutcome,
} from "../envelope/public-outcome.ts";
import { humanViews, renderHuman, type HumanViewRegistry } from "./render.ts";
import { makeStyle, type Style } from "./style.ts";
import { displayWidth } from "./text.ts";

/** The home directory every view test shortens paths against. */
export const testHome = "/home/me";

/** A colourless, 100-column style whose paths under {@link testHome} read `~/…`. */
export const plainStyle: Style = makeStyle({ color: false, homeDirectory: testHome, width: 100 });

/** The style with `hint` recording the commands a view lists under Next. */
export const hintRecorder = (style: Style = plainStyle) => {
  const hints: string[] = [];
  return {
    hints,
    style: { ...style, hint: (commands) => hints.push(...commands) } satisfies Style,
  };
};

const statusOf = (classification: PublicOutcome["classification"]) =>
  classification === "success" ? "success" : classification === "partial" ? "partial" : "failure";

/**
 * A validated envelope for `command`. Payloads are decoded through the public schema, so a test
 * cannot hand a view something the CLI could never publish.
 */
export const envelopeOf = (input: {
  readonly command: string;
  readonly classification?: PublicOutcome["classification"];
  readonly diagnostics?: ReadonlyArray<unknown>;
  readonly result?: unknown;
  readonly plan?: unknown;
  readonly applied?: unknown;
}): PublicEnvelope => {
  const classification = input.classification ?? "success";
  return Schema.decodeUnknownSync(PublicEnvelopeSchema)({
    applied: input.applied ?? null,
    classification,
    command: input.command,
    diagnostics: input.diagnostics ?? [],
    next: [],
    plan: input.plan ?? null,
    result: input.result ?? null,
    status: statusOf(classification),
    version: 1,
  });
};

/** Collapses row padding and wrapping, which depend on the terminal width. */
export const flat = (text: string | undefined) => (text ?? "").replaceAll(/\s+/g, " ");

/** The lines of a rendered view. */
export const lines = (text: string) => text.split("\n");

/** The text without the ANSI escapes a coloured style adds. */
// oxlint-disable-next-line no-control-regex -- Tests strip the escapes the styles add.
const stripAnsi = (text: string) => text.replaceAll(/\u001B\[[0-9;]*m/g, "");

/** The terminal a view test renders for, and the registry it renders through. */
export type ViewOptions = {
  /** Terminal columns; 80 when absent. */
  readonly width?: number;
  readonly color?: boolean;
  /** The directory paths are shortened against; none when absent. */
  readonly homeDirectory?: string;
  /** The catalog references are named from; registration IDs when absent. */
  readonly references?: ReferenceIndex;
  /** The views to render through; every registered view when absent. */
  readonly views?: HumanViewRegistry;
  /** Renders as `--details` does: every row a view would otherwise cap. */
  readonly details?: boolean;
};

/** The style a terminal with these options gets. */
export const styleOf = (options: ViewOptions = {}): Style =>
  makeStyle({
    color: options.color ?? false,
    homeDirectory: options.homeDirectory,
    width: options.width ?? 80,
    ...(options.references === undefined ? {} : { references: options.references }),
  });

/** The terminal widths every view fits. */
const contractWidths = [40, 80, 120] as const;

/**
 * Checks what every view keeps for any envelope: at each of {@link contractWidths} the lines above
 * `Next` fit, unless a line is one word that cannot break, so a hinted command stays whole; the
 * colourless text carries no ANSI escape; and the coloured text is painted and differs from it
 * only by escapes. A painted empty cell can leave trailing spaces on a coloured line, so those are
 * not compared.
 */
export const expectViewContract = (envelope: PublicEnvelope, options: ViewOptions = {}) => {
  const views = options.views ?? humanViews;
  for (const width of contractWidths) {
    const render = (style: Style) =>
      renderHuman(envelope, style, views, { details: options.details === true });
    const plain = render(styleOf({ ...options, width, color: false }));
    const label = `tack ${envelope.command} at ${width} columns`;
    expect(plain, label).not.toContain("\u001B");
    const colored = render(styleOf({ ...options, width, color: true }));
    expect(colored, label).toContain("\u001B[");
    expect(
      lines(stripAnsi(colored)).map((line) => line.trimEnd()),
      label,
    ).toEqual(lines(plain));
    const overflowing = lines(plain.split("\nNext\n")[0] ?? "").filter(
      (line) => displayWidth(line) > width && line.trim().includes(" "),
    );
    expect(overflowing, `${label}\n${plain}`).toEqual([]);
  }
};

/** Renders `envelope` as the CLI prints it on a terminal with these options. */
export const renderView = (envelope: PublicEnvelope, options: ViewOptions = {}): string =>
  renderHuman(envelope, styleOf(options), options.views ?? humanViews, {
    details: options.details === true,
  });

const fixtureDirectory = new URL("../../../test/fixtures/human/", import.meta.url);

/** The names of the envelopes captured from the built CLI, for {@link humanFixture}. */
export const humanFixtureNames: ReadonlyArray<string> = readdirSync(fixtureDirectory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .toSorted();

/** A real envelope captured from the built CLI, shared with `apps/cli/test/human-views.unit.test.ts`. */
export const humanFixture = (name: string): PublicEnvelope =>
  Schema.decodeUnknownSync(PublicEnvelopeSchema)(
    JSON.parse(readFileSync(new URL(`${name}.json`, fixtureDirectory), "utf8")),
  );
