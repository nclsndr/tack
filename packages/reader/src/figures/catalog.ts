/**
 * The catalog: the figure components the reader ships, and the issues of each one's props. The
 * page lists these issues under the figure and the figure check prints them, from this one place.
 */
import {
  claimIssues,
  type FigureIssue,
  idIssues,
  inputIssue,
  list,
  record,
  text,
} from "./issues.ts";
import { readArchitectureMap } from "./architecture-map-model.ts";
import { architectureLayoutIssues, layoutArchitecture } from "./architecture-map-layout.ts";
import { readFileTree } from "./file-tree-model.ts";
import { fileTreeLayoutIssues, layoutFileTree } from "./file-tree-layout.ts";
import { readAuthoredFigure } from "./authored-model.ts";
import { readSystem } from "./system-model.ts";
import { layoutSystem, systemLayoutIssues } from "./system-layout.ts";
import { loadLayoutEngine } from "./layout-engine.ts";
import { readSchema } from "./schema-model.ts";
import { layoutSchema, schemaLayoutIssues } from "./schema-layout.ts";

/** Issues of a `Walkthrough`: id, claim, and a title on every step. */
export function walkthroughIssues(props: unknown): readonly FigureIssue[] {
  const raw = record(props) ?? {};
  return [
    ...idIssues(raw["id"]),
    ...claimIssues(raw["title"]),
    ...list(raw["steps"]).flatMap((step, index) =>
      text(record(step)?.["title"]) === undefined
        ? [inputIssue(`step ${index + 1} has no title`)]
        : [],
    ),
  ];
}

/** Issues of a `Chart`: id, claim, and a label and a finite number on every value. */
export function chartIssues(props: unknown): readonly FigureIssue[] {
  const raw = record(props) ?? {};
  return [
    ...idIssues(raw["id"]),
    ...claimIssues(raw["title"]),
    ...list(raw["data"]).flatMap((value, index) => {
      const datum = record(value);
      const label = text(datum?.["label"]);
      if (label === undefined) return [inputIssue(`value ${index + 1} has no label`)];
      const number = datum?.["value"];
      return typeof number === "number" && Number.isFinite(number) === true
        ? []
        : [inputIssue(`value "${label}" is not a finite number`)];
    }),
  ];
}

/** Issues of an `ArchitectureMap`: its input issues, then its layout at column width. */
export function architectureMapIssues(props: unknown): readonly FigureIssue[] {
  const { model, issues } = readArchitectureMap(props);
  return [...issues, ...architectureLayoutIssues(layoutArchitecture(model))];
}

/** Issues of a `FileTree`: its grammar and input issues, then its layout at column width. */
export function fileTreeIssues(props: unknown): readonly FigureIssue[] {
  const { model, issues } = readFileTree(props);
  return [...issues, ...fileTreeLayoutIssues(layoutFileTree(model))];
}

/**
 * Issues of an authored `Figure`: its props and its drawing's kit elements, given as
 * `{ ...props, drawing: { height, elements } }`.
 */
export function authoredFigureIssues(input: unknown): readonly FigureIssue[] {
  return readAuthoredFigure(input).issues;
}

/**
 * Issues of a `System`: its input issues, then its layout at column width. Laying it out needs the
 * layout engine, so the check awaits it; the page lists the same lines once its drawing is laid out.
 */
async function systemIssues(props: unknown): Promise<readonly FigureIssue[]> {
  const { model, issues } = readSystem(props);
  return [...issues, ...systemLayoutIssues(await layoutSystem(model, await loadLayoutEngine()))];
}

/** Issues of a `Schema`: its input issues, then its packing at column width, laid out like `System`. */
async function schemaIssues(props: unknown): Promise<readonly FigureIssue[]> {
  const { model, issues } = readSchema(props);
  return [...issues, ...schemaLayoutIssues(await layoutSchema(model, await loadLayoutEngine()))];
}

/** Every catalog component by its MDX name, with the function that lists its issues. */
export const figureCatalog = {
  ArchitectureMap: architectureMapIssues,
  Chart: chartIssues,
  FileTree: fileTreeIssues,
  Figure: authoredFigureIssues,
  Schema: schemaIssues,
  System: systemIssues,
  Walkthrough: walkthroughIssues,
} as const satisfies Readonly<
  Record<string, (props: unknown) => readonly FigureIssue[] | Promise<readonly FigureIssue[]>>
>;

export type FigureComponentName = keyof typeof figureCatalog;

/** What the check reads but cannot verify, by component: an authored figure's raw shapes. */
export const figureUnchecked: Partial<
  Readonly<Record<FigureComponentName, (props: unknown) => readonly string[]>>
> = {
  Figure: (input) => readAuthoredFigure(input).unchecked,
};

/** Whether an MDX element name is a catalog figure. */
export function isFigureComponent(name: string): name is FigureComponentName {
  return Object.hasOwn(figureCatalog, name);
}
