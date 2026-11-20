import { useState } from "react";
import type { ReactNode } from "react";
import { numericState, useVisualState } from "./state.ts";
import { visualStyles } from "./visual-styles.ts";
import { FigureFrame } from "./figures/frame.tsx";
import { chartIssues, walkthroughIssues } from "./figures/catalog.ts";

export type WalkthroughStep = {
  readonly title: string;
  readonly body: ReactNode;
  readonly readable?: string;
};
export type WalkthroughProps = {
  readonly id: string;
  readonly title?: string;
  readonly steps: readonly WalkthroughStep[];
};
export type ChartDatum = { readonly label: string; readonly value: number };
export type ChartScenario = {
  readonly id: string;
  readonly label: string;
  readonly multiplier: number;
};
export type ChartProps = {
  readonly id: string;
  readonly title?: string;
  readonly data: readonly ChartDatum[];
  readonly unit?: string;
  readonly scenarios?: readonly ChartScenario[];
};

const baselineScenario: ChartScenario = { id: "baseline", label: "Baseline", multiplier: 1 };
const defaultScenarios: readonly ChartScenario[] = [baselineScenario];

function stepReadable(step: WalkthroughStep): string {
  return (
    step.readable ??
    (typeof step.body === "string" || typeof step.body === "number" ? String(step.body) : "")
  );
}

/** Displays an authored sequence while keeping every step available to readable copy and search. */
export function Walkthrough({ id, title: authoredTitle, steps }: WalkthroughProps): ReactNode {
  const title = authoredTitle ?? "Walkthrough";
  const [state, update] = useVisualState(id);
  const step =
    steps.length === 0
      ? 0
      : numericState(state["step"], { fallback: 1, min: 1, max: steps.length, integer: true });
  const readable = [
    title,
    ...steps.map((item, index) => `${index + 1}. ${item.title}\n${stepReadable(item)}`),
    `Current step: ${step} of ${steps.length}`,
  ].join("\n\n");
  return (
    <FigureFrame
      id={id}
      kind="steps"
      title={title}
      issues={walkthroughIssues({ id, title: authoredTitle, steps })}
      readable={readable}
      state={{ step }}
      className="tack-walkthrough"
    >
      <div className="tack-figure-body">
        <nav
          aria-label={`${title} steps`}
          className="flex overflow-x-auto border-b border-rule px-2.5"
        >
          {steps.map((item, index) => (
            <button
              key={index}
              type="button"
              aria-current={index + 1 === step ? "step" : undefined}
              data-passed={index + 1 < step}
              className={`group/step ${visualStyles.stepTab}`}
              onClick={() => update({ step: String(index + 1) })}
            >
              <span
                className={`${visualStyles.stepNumber} group-aria-[current=step]/step:text-pen group-data-[passed=true]/step:text-print`}
              >
                {index + 1}.
              </span>{" "}
              {item.title}
            </button>
          ))}
        </nav>
        {steps.length === 0 ? (
          <p className={visualStyles.readout}>No steps have been authored.</p>
        ) : (
          steps.map((item, index) => (
            <section
              key={index}
              hidden={index + 1 !== step}
              aria-label={item.title}
              className="px-4.5 pt-4.5 pb-5 font-serif text-base leading-relaxed"
            >
              <h3 className="mb-1.5">{item.title}</h3>
              <div className="max-w-prose">{item.body}</div>
            </section>
          ))
        )}
        <div className={visualStyles.footer}>
          <button
            type="button"
            aria-label="Previous step"
            disabled={step <= 1}
            onClick={() => update({ step: String(step - 1) })}
          >
            Previous
          </button>
          <output aria-live="polite" className={visualStyles.output}>
            Step {step} of {steps.length}
          </output>
          <button
            type="button"
            aria-label="Next step"
            disabled={step >= steps.length}
            onClick={() => update({ step: String(step + 1) })}
          >
            Next
          </button>
        </div>
      </div>
    </FigureFrame>
  );
}

/** Renders authored values with a reproducible scenario, multiplier, scale, and selection. */
export function Chart({
  id,
  title: authoredTitle,
  data,
  unit = "",
  scenarios = defaultScenarios,
}: ChartProps): ReactNode {
  const title = authoredTitle ?? "Chart";
  const [state, update] = useVisualState(id);
  const [hovered, setHovered] = useState<string | null>(null);
  const availableScenarios = scenarios.length === 0 ? defaultScenarios : scenarios;
  const scenario =
    availableScenarios.find((item) => item.id === state["scenario"]) ??
    availableScenarios[0] ??
    baselineScenario;
  const multiplier = numericState(state["multiplier"], { fallback: 1, min: 0.1, max: 5 });
  const scale = state["scale"] === "sqrt" ? "sqrt" : "linear";
  const values = data
    .filter((item) => Number.isFinite(item.value) === true)
    .map((item) => ({ ...item, value: item.value * multiplier * scenario.multiplier }));
  const maximum = Math.max(1, ...values.map((item) => Math.abs(item.value)));
  const selected = values.find((item) => item.label === state["selected"]);
  const labelValue = (item: ChartDatum): string =>
    `${item.label}: ${Number(item.value.toFixed(2))}${unit === "" ? "" : ` ${unit}`}`;
  const readable = [
    title,
    ...values.map((item) => labelValue(item)),
    `Scenario: ${scenario.label}; multiplier: ${multiplier}; scale: ${scale}; selected: ${selected?.label ?? "none"}`,
  ].join("\n");
  return (
    <FigureFrame
      id={id}
      kind="quantities"
      title={title}
      issues={chartIssues({ id, title: authoredTitle, data })}
      readable={readable}
      state={{
        scenario: scenario.id,
        multiplier,
        scale,
        selected: selected?.label ?? null,
      }}
      className="tack-chart"
    >
      <div className="tack-figure-body">
        <div className={visualStyles.toolbar}>
          <label className={visualStyles.label}>
            Scenario
            <select
              value={scenario.id}
              onChange={(event) => update({ scenario: event.target.value })}
            >
              {availableScenarios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className={visualStyles.label}>
            Multiplier
            <input
              aria-label="Multiplier"
              type="range"
              min="0.1"
              max="5"
              step="0.1"
              value={multiplier}
              onChange={(event) => update({ multiplier: event.target.value })}
            />
            <output className={visualStyles.output}>{multiplier}×</output>
          </label>
          <label className={visualStyles.label}>
            Scale
            <select value={scale} onChange={(event) => update({ scale: event.target.value })}>
              <option value="linear">Linear</option>
              <option value="sqrt">Square root</option>
            </select>
          </label>
        </div>
        {values.length === 0 ? (
          <p className={visualStyles.readout}>No values have been authored.</p>
        ) : (
          <svg
            className="block h-auto w-full pt-2.5 pr-4.5 pb-1"
            role="group"
            aria-label={title}
            viewBox={`0 0 640 ${values.length * 44 + 8}`}
          >
            <line
              className="stroke-rule-strong"
              x1="160"
              x2="160"
              y1="0"
              y2={values.length * 44 + 8}
            />
            {values.map((item, index) => {
              const magnitude = Math.abs(item.value) / maximum;
              const width = (scale === "sqrt" ? Math.sqrt(magnitude) : magnitude) * 360;
              const active = hovered === item.label || selected?.label === item.label;
              return (
                <g
                  key={item.label}
                  className="cursor-pointer focus-visible:outline-none"
                  data-active={active}
                  role="button"
                  tabIndex={0}
                  aria-label={labelValue(item)}
                  aria-pressed={selected?.label === item.label}
                  onClick={() =>
                    update({ selected: selected?.label === item.label ? null : item.label })
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      update({ selected: selected?.label === item.label ? null : item.label });
                    }
                  }}
                  onMouseEnter={() => setHovered(item.label)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(item.label)}
                  onBlur={() => setHovered(null)}
                >
                  <title>{labelValue(item)}</title>
                  <rect x="0" y={index * 44} width="640" height="44" fill="transparent" />
                  <text
                    x="148"
                    y={index * 44 + 27}
                    textAnchor="end"
                    className="fill-body font-sans text-sm"
                  >
                    {item.label}
                  </text>
                  <rect
                    x="160"
                    y={index * 44 + 10}
                    width={Math.max(1, width)}
                    height="24"
                    rx="2"
                    className="transition-[width,fill] duration-300"
                    fill={
                      active === true
                        ? "var(--tack-visual-active)"
                        : item.value < 0
                          ? "var(--tack-visual-negative)"
                          : "var(--tack-visual-fill)"
                    }
                  />
                  <text
                    className={`font-mono text-xs ${active === true ? "fill-pen" : "fill-muted"}`}
                    x={170 + width}
                    y={index * 44 + 27}
                  >
                    {Number(item.value.toFixed(2))} {unit}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        <p aria-live="polite" className={visualStyles.readout}>
          {selected === undefined
            ? "Hover or select a bar to inspect its value."
            : labelValue(selected)}
        </p>
      </div>
    </FigureFrame>
  );
}

import { ArchitectureMap } from "./figures/architecture-map.tsx";
import { FileTree } from "./figures/file-tree.tsx";
import { Badge, Band, Box, Drawing, Figure, Label, Link, Note } from "./figures/figure.tsx";
import { System } from "./figures/system.tsx";
import { Schema } from "./figures/schema.tsx";

export {
  ArchitectureMap,
  Badge,
  Band,
  Box,
  Drawing,
  Figure,
  FileTree,
  Label,
  Link,
  Note,
  Schema,
  System,
};
export type {
  BadgeProps,
  BandProps,
  BoxProps,
  DrawingProps,
  FigureProps,
  LabelProps,
  LinkProps,
  NoteProps,
} from "./figures/figure.tsx";
export type { FileTreeProps } from "./figures/file-tree-model.ts";
export type { SchemaColumnInput, SchemaProps, SchemaTableInput } from "./figures/schema-model.ts";
export type {
  SystemGroupInput,
  SystemLinkInput,
  SystemNodeInput,
  SystemProps,
} from "./figures/system-model.ts";

/**
 * The components every document can use without importing them: the catalog figures and the kit
 * elements of authored figures. A source's own components override them by name.
 */
export const standardFigures = {
  ArchitectureMap,
  Badge,
  Band,
  Box,
  Chart,
  Drawing,
  Figure,
  FileTree,
  Label,
  Link,
  Note,
  Schema,
  System,
  Walkthrough,
};
export type {
  ArchitectureLink,
  ArchitectureMapProps,
  ArchitectureNode,
  ArchitectureTier,
} from "./figures/architecture-map-model.ts";

export { Icon } from "./icons/docs-icon.tsx";
export { Callout, Tab, Tabs, Term } from "./authoring/components.tsx";
export type { DocsIconName } from "./icons/catalog.ts";
