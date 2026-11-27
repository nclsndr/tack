/**
 * `ArchitectureMap` as data: the author's contract, the lenient reading that turns props into a
 * model plus input issues, the focus rules and the text equivalent. Pure functions only, so the
 * figure check runs them without a browser and gets the same answers as the page.
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
import { type FigureCase, readCases } from "./cases.ts";

/** One box: usually one folder or module. */
export type ArchitectureNode = {
  readonly id: string;
  readonly label: string;
  /** One short line under the label: a path, a role. */
  readonly detail?: string;
  /** Shown in the panel when the box is pinned. */
  readonly about?: string;
};
/** One horizontal band. `path` and `note` show in its margin. */
export type ArchitectureTier = {
  readonly id: string;
  readonly label: string;
  readonly path?: string;
  readonly note?: string;
  readonly nodes: readonly ArchitectureNode[];
};
/** `from` uses `to`. Each end is a node id or a tier id. */
export type ArchitectureLink = {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
};
export type ArchitectureMapProps = {
  readonly id: string;
  /** The claim, as a sentence. */
  readonly title: string;
  readonly summary?: string;
  /** The one rule that position encodes. */
  readonly rule: { readonly title: string; readonly text: string };
  /** Top to bottom. An entry is a tier, or a row of two sibling tiers that share one band. */
  readonly tiers: readonly (ArchitectureTier | readonly ArchitectureTier[])[];
  readonly links: readonly ArchitectureLink[];
  /** Two sibling tiers that must not use each other, drawn as a wall between them. */
  readonly barriers?: readonly {
    readonly between: readonly [string, string];
    readonly label: string;
  }[];
  /** Node ids offered as entry points. */
  readonly startWith?: readonly string[];
  readonly replays?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly steps: readonly { readonly at: string; readonly note: string }[];
  }[];
  readonly lenses?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly note: string;
    readonly focus: readonly string[];
    readonly blocked?: readonly string[];
  }[];
};

/** The limits a map is checked against, and the thresholds of its focus rules. */
export const architectureBudget = {
  boxes: 60,
  rows: 8,
  steps: 12,
  /** A focus with more links than this in one direction draws one bundle per target tier. */
  bundleAbove: 24,
  /** The second hop is drawn only when the focus uses at most this many boxes. */
  onwardWhenAtMost: 6,
  onwardPerNeighbour: 2,
  /** The text equivalent lists links one by one up to this many, and counts them above. */
  listedLinks: 50,
} as const;

type MapNode = ArchitectureNode & { readonly tier: string };
export type MapTier = Omit<ArchitectureTier, "nodes"> & {
  readonly nodes: readonly MapNode[];
  /** Index of the band, top to bottom. Sibling tiers share it. */
  readonly row: number;
  /** Index among all tiers, which picks the tint. */
  readonly order: number;
};
export type MapLink = ArchitectureLink & {
  readonly fromTier: string;
  readonly toTier: string;
  readonly level: "node" | "tier";
  /** An exception to the reading rule, drawn in the warning style. */
  readonly warning?: "up" | "barrier";
};
type MapBarrier = { readonly between: readonly [string, string]; readonly label: string };
export type MapCase = FigureCase<
  { readonly at: string; readonly note: string },
  { readonly focus: readonly string[]; readonly blocked: readonly string[] }
>;
export type ArchitectureModel = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  readonly rows: readonly (readonly MapTier[])[];
  readonly tiers: readonly MapTier[];
  readonly nodes: readonly MapNode[];
  readonly links: readonly MapLink[];
  readonly barriers: readonly MapBarrier[];
  readonly startWith: readonly string[];
  readonly cases: readonly MapCase[];
};

/** Reads authored tiers in order, dropping what cannot be drawn and naming why. */
function readTiers(entries: readonly unknown[]): {
  readonly rows: readonly (readonly MapTier[])[];
  readonly issues: readonly FigureIssue[];
} {
  // Tier ids and node ids are separate names: a one-box tier may share its box's id.
  const seenTiers = new Set<string>();
  const seenNodes = new Set<string>();
  const state = entries.reduce<{
    rows: (readonly MapTier[])[];
    issues: FigureIssue[];
    order: number;
    position: number;
  }>(
    (acc, entry, entryIndex) => {
      const members = Array.isArray(entry) === true ? list(entry) : [entry];
      const tiers = members.flatMap((member) => {
        acc.position += 1;
        const raw = record(member);
        const id = text(raw?.["id"]);
        if (raw === undefined || id === undefined) {
          acc.issues.push(inputIssue(`tier ${acc.position} has no id; it is left out`));
          return [];
        }
        const label = text(raw["label"]);
        if (seenTiers.has(id) === true) {
          acc.issues.push(inputIssue(`duplicate id "${id}": tier "${label ?? id}" is left out`));
          return [];
        }
        seenTiers.add(id);
        if (label === undefined) acc.issues.push(inputIssue(`tier "${id}" has no label`));
        const nodes = list(raw["nodes"]).flatMap((value) => {
          const node = record(value);
          if (node === undefined) {
            acc.issues.push(inputIssue(`a node in tier "${id}" is not an object; it is left out`));
            return [];
          }
          const nodeId = text(node["id"]);
          if (nodeId === undefined) {
            acc.issues.push(inputIssue(`a node in tier "${id}" has no id; it is left out`));
            return [];
          }
          const nodeLabel = text(node["label"]);
          if (seenNodes.has(nodeId) === true) {
            acc.issues.push(
              inputIssue(`duplicate id "${nodeId}": node "${nodeLabel ?? nodeId}" is left out`),
            );
            return [];
          }
          seenNodes.add(nodeId);
          if (nodeLabel === undefined) acc.issues.push(inputIssue(`node "${nodeId}" has no label`));
          const detail = text(node["detail"]);
          const about = text(node["about"]);
          return [
            {
              id: nodeId,
              label: nodeLabel ?? nodeId,
              tier: id,
              ...(detail === undefined ? {} : { detail }),
              ...(about === undefined ? {} : { about }),
            },
          ];
        });
        const path = text(raw["path"]);
        const note = text(raw["note"]);
        return [
          {
            id,
            label: label ?? id,
            ...(path === undefined ? {} : { path }),
            ...(note === undefined ? {} : { note }),
            nodes,
            row: acc.rows.length,
            order: acc.order++,
          },
        ];
      });
      if (members.length > 2)
        acc.issues.push(
          inputIssue(
            `row ${entryIndex + 1} has ${members.length} tiers; a row holds at most two sibling tiers`,
          ),
        );
      if (tiers.length > 0) acc.rows.push(tiers);
      return acc;
    },
    { rows: [], issues: [], order: 0, position: 0 },
  );
  return { rows: state.rows, issues: state.issues };
}

/** Builds the model of a map from whatever the author passed, with every input issue. */
export function readArchitectureMap(props: unknown): {
  readonly model: ArchitectureModel;
  readonly issues: readonly FigureIssue[];
} {
  const raw = record(props) ?? {};
  const rule = record(raw["rule"]);
  const ruleTitle = text(rule?.["title"]);
  const ruleText = text(rule?.["text"]);
  const { rows, issues: tierIssues } = readTiers(list(raw["tiers"]));
  const tiers = rows.flat();
  const nodes = tiers.flatMap((tier) => tier.nodes);
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  // A node id wins over a tier id of the same name.
  const tierOf = (id: string): MapTier | undefined => tierById.get(nodeById.get(id)?.tier ?? id);
  const known = (id: string): boolean => tierById.has(id) === true || nodeById.has(id) === true;

  const barrierIssues: FigureIssue[] = [];
  const barriers = list(raw["barriers"]).flatMap((value, index) => {
    const barrier = record(value);
    const between = list(barrier?.["between"]).map((end) => text(end) ?? "?");
    const [a, b] = between;
    const label = text(barrier?.["label"]);
    const name = label === undefined ? `barrier ${index + 1}` : `barrier "${label}"`;
    if (a === undefined || b === undefined || between.length !== 2) {
      barrierIssues.push(inputIssue(`${name} needs between: [tierId, tierId]`));
      return [];
    }
    const unknown = [a, b].find((id) => tierById.has(id) === false);
    if (unknown !== undefined) {
      barrierIssues.push(inputIssue(`${name} names an unknown tier "${unknown}"`));
      return [];
    }
    if (tierById.get(a)?.row !== tierById.get(b)?.row) {
      barrierIssues.push(
        inputIssue(`${name} is between ${a} and ${b}, which are not sibling tiers in one row`),
      );
      return [];
    }
    if (label === undefined) barrierIssues.push(inputIssue(`${name} has no label`));
    return [{ between: [a, b] as const, label: label ?? "" }];
  });
  const barrierBetween = (a: string, b: string): MapBarrier | undefined =>
    barriers.find(
      (barrier) =>
        (barrier.between[0] === a && barrier.between[1] === b) ||
        (barrier.between[0] === b && barrier.between[1] === a),
    );

  const linkIssues: FigureIssue[] = [];
  const links = list(raw["links"]).flatMap((value, index) => {
    const link = record(value);
    if (link === undefined) {
      linkIssues.push(inputIssue(`link ${index + 1} is not an object; it is left out`));
      return [];
    }
    const from = text(link["from"]);
    const to = text(link["to"]);
    if (from === undefined || to === undefined) {
      const missing = from === undefined ? "from" : "to";
      linkIssues.push(
        inputIssue(`link ${from ?? "?"} -> ${to ?? "?"} has no "${missing}"; it is left out`),
      );
      return [];
    }
    const unknown = [from, to].find((id) => known(id) === false);
    if (unknown !== undefined) {
      linkIssues.push(inputIssue(`link ${from} -> ${to} names an unknown id "${unknown}"`));
      return [];
    }
    const fromTier = tierOf(from);
    const toTier = tierOf(to);
    // Both ends are known, so both tiers exist.
    if (fromTier === undefined || toTier === undefined) return [];
    const barrier = barrierBetween(fromTier.id, toTier.id);
    const warning =
      toTier.row < fromTier.row ? "up" : barrier === undefined ? undefined : "barrier";
    if (warning === "up") linkIssues.push(inputIssue(`link ${from} -> ${to} points up`));
    if (warning === "barrier")
      linkIssues.push(
        inputIssue(`link ${from} -> ${to} crosses the barrier "${barrier?.label ?? ""}"`),
      );
    const label = text(link["label"]);
    return [
      {
        from,
        to,
        ...(label === undefined ? {} : { label }),
        fromTier: fromTier.id,
        toTier: toTier.id,
        level: nodeById.has(from) === true && nodeById.has(to) === true ? "node" : "tier",
        ...(warning === undefined ? {} : { warning }),
      } satisfies MapLink,
    ];
  });

  const startIssues: FigureIssue[] = [];
  const startWith = list(raw["startWith"]).flatMap((value) => {
    const id = text(value) ?? "?";
    if (nodeById.has(id) === true) return [id];
    startIssues.push(inputIssue(`startWith names an unknown id "${id}"`));
    return [];
  });

  const caseIssues: FigureIssue[] = [];
  const cases = readCases(raw, {
    steps: architectureBudget.steps,
    issues: caseIssues,
    step: (fields, where) => {
      const at = text(fields["at"]) ?? "?";
      if (nodeById.has(at) === true) return { at, note: text(fields["note"]) ?? "" };
      caseIssues.push(inputIssue(`${where} names an unknown id "${at}"`));
      return undefined;
    },
    lens: (lens, name) => {
      const ids = (key: string): readonly string[] =>
        list(lens[key]).flatMap((entry) => {
          const id = text(entry) ?? "?";
          if (nodeById.has(id) === true) return [id];
          const tier = tierById.get(id);
          if (tier !== undefined) return tier.nodes.map((node) => node.id);
          caseIssues.push(inputIssue(`${name} names an unknown id "${id}"`));
          return [];
        });
      return { focus: ids("focus"), blocked: ids("blocked") };
    },
  });

  const budgetIssues = [
    ...(nodes.length > architectureBudget.boxes
      ? [
          inputIssue(
            `${nodes.length} boxes; the budget is ${architectureBudget.boxes}. Split the map or raise its level`,
          ),
        ]
      : []),
    ...(rows.length > architectureBudget.rows
      ? [
          inputIssue(
            `${rows.length} tier rows; the budget is ${architectureBudget.rows}. Merge tiers or split the map`,
          ),
        ]
      : []),
  ];
  const summary = text(raw["summary"]);
  return {
    model: {
      id: text(raw["id"]) ?? "architecture-map",
      title: text(raw["title"]) ?? "",
      ...(summary === undefined ? {} : { summary }),
      ...(ruleTitle === undefined || ruleText === undefined
        ? {}
        : { rule: { title: ruleTitle, text: ruleText } }),
      rows,
      tiers,
      nodes,
      links,
      barriers,
      startWith,
      cases,
    },
    issues: [
      ...idIssues(raw["id"]),
      ...claimIssues(raw["title"]),
      ...(ruleTitle === undefined || ruleText === undefined
        ? [
            inputIssue(
              "rule is missing; give { title, text }: the one rule the map's layout encodes",
            ),
          ]
        : []),
      ...(tiers.length === 0
        ? [inputIssue("tiers is empty; give at least one tier with its nodes")]
        : []),
      ...tierIssues,
      ...linkIssues,
      ...barrierIssues,
      ...startIssues,
      ...caseIssues,
      ...budgetIssues,
    ],
  };
}

type FocusBundle = {
  readonly direction: "out" | "in";
  readonly tier: string;
  readonly count: number;
};
export type Focus = {
  /** Links that leave the focus ("uses"). Drawn solid. */
  readonly out: readonly MapLink[];
  /** Links that enter the focus ("used by"). Drawn dashed. */
  readonly incoming: readonly MapLink[];
  /** One further hop down the map from a box the focus uses. Drawn in muted ink. */
  readonly onward: readonly MapLink[];
  /** The focus and its direct neighbours: full ink. */
  readonly near: ReadonlySet<string>;
  /** The targets of onward links: medium ink. */
  readonly far: ReadonlySet<string>;
  /**
   * One per other tier, for a direction with more links than the budget allows one by one. Links
   * inside the focus's tier are still drawn one by one.
   */
  readonly bundles: readonly FocusBundle[];
};

/** What stays inked around the box `id`, by the rules of the overview. */
export function focusOf(model: ArchitectureModel, id: string): Focus {
  const node = model.nodes.find((candidate) => candidate.id === id);
  if (node === undefined)
    return { out: [], incoming: [], onward: [], near: new Set(), far: new Set(), bundles: [] };
  const nodeLinks = model.links.filter((link) => link.level === "node");
  const out = nodeLinks.filter((link) => link.from === id);
  const incoming = nodeLinks.filter((link) => link.to === id);
  const near = new Set([id, ...out.map((link) => link.to), ...incoming.map((link) => link.from)]);
  const rowOf = new Map(model.tiers.map((tier) => [tier.id, tier.row]));
  const onward =
    out.length > architectureBudget.onwardWhenAtMost
      ? []
      : out.flatMap((first) =>
          nodeLinks
            .filter(
              (link) =>
                link.from === first.to &&
                (rowOf.get(link.toTier) ?? 0) > (rowOf.get(link.fromTier) ?? 0) &&
                near.has(link.to) === false,
            )
            .slice(0, architectureBudget.onwardPerNeighbour),
        );
  // Links inside the focus's own tier stay one by one: a bundle needs another tier to point at.
  const bundle = (direction: "out" | "in", links: readonly MapLink[]): FocusBundle[] =>
    links.length <= architectureBudget.bundleAbove
      ? []
      : model.tiers.flatMap((tier) => {
          if (tier.id === node.tier) return [];
          const count = links.filter(
            (link) => (direction === "out" ? link.toTier : link.fromTier) === tier.id,
          ).length;
          return count === 0 ? [] : [{ direction, tier: tier.id, count }];
        });
  return {
    out,
    incoming,
    onward,
    near,
    far: new Set(onward.map((link) => link.to)),
    bundles: [...bundle("out", out), ...bundle("in", incoming)],
  };
}

/** The labels of the tiers that `tierId` uses, in map order: the margin's "uses" line. */
export function tierUses(model: ArchitectureModel, tierId: string): readonly string[] {
  const targets = new Set(
    model.links
      .filter((link) => link.fromTier === tierId && link.toTier !== tierId)
      .map((link) => link.toTier),
  );
  return model.tiers.filter((tier) => targets.has(tier.id) === true).map((tier) => tier.label);
}

/** The label of a node or tier id, for text. */
export function labelOf(model: ArchitectureModel, id: string): string {
  return (
    model.nodes.find((node) => node.id === id)?.label ??
    model.tiers.find((tier) => tier.id === id)?.label ??
    id
  );
}

/** The plain text of the map, used by copy and search. */
export function architectureReadable(model: ArchitectureModel): string {
  const name = (id: string): string => labelOf(model, id);
  return [
    model.title,
    model.summary ?? "",
    model.rule === undefined ? "" : `How to read this: ${model.rule.title}. ${model.rule.text}`,
    model.startWith.length === 0 ? "" : `Start with: ${model.startWith.map(name).join(", ")}`,
    ...model.tiers.map(
      (tier) =>
        `${tier.label}${tier.path === undefined ? "" : ` (${tier.path})`}: ${tier.nodes
          .map((node) =>
            node.detail === undefined ? node.label : `${node.label} (${node.detail})`,
          )
          .join(", ")}`,
    ),
    ...model.barriers.map(
      (barrier) =>
        `Barrier between ${name(barrier.between[0])} and ${name(barrier.between[1])}: ${barrier.label}`,
    ),
    ...(model.links.length > architectureBudget.listedLinks
      ? [`${model.links.length} links.`]
      : model.links.map(
          (link) =>
            `${name(link.from)} -> ${name(link.to)}${link.label === undefined ? "" : `: ${link.label}`}`,
        )),
    ...model.cases.map((item) =>
      item.kind === "replay"
        ? `Replay ${item.label}: ${item.steps
            .map((step, index) => `${index + 1}. ${name(step.at)}: ${step.note}`)
            .join(" ")}`
        : `Lens ${item.label}: ${item.focus.map(name).join(", ")}. ${item.note}`,
    ),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
