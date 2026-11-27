/**
 * `System` as data: the author's contract, the lenient reading that turns props into a model plus
 * input issues, the focus rule and the text equivalent. Pure functions only, so the figure check
 * runs them without a browser and gets the same answers as the page.
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
import { oneOf } from "./authored-model.ts";
import { type FigureCase, readCases } from "./cases.ts";

/** What a node is. Each kind has its shape. */
export const systemNodeKinds = [
  "service",
  "store",
  "queue",
  "external",
  "actor",
  "artifact",
] as const;
export type SystemNodeKind = (typeof systemNodeKinds)[number];
/** How a link moves. The kind sets the line style in every state of the figure. */
export const systemLinkKinds = ["call", "async", "reply"] as const;
export type SystemLinkKind = (typeof systemLinkKinds)[number];

/** One part that runs, or that the running parts touch. */
export type SystemNodeInput = {
  readonly id: string;
  readonly label: string;
  readonly kind: SystemNodeKind;
  /** One short line under the label. */
  readonly detail?: string;
  /** Up to six mono lines inside the box: table names, sub-parts, settings. */
  readonly lines?: readonly string[];
  /** Shown in the panel when the node is pinned. */
  readonly about?: string;
  readonly group?: string;
};
/** A boundary: a host, a network, a trust zone, a process. */
export type SystemGroupInput = {
  readonly id: string;
  readonly label: string;
  /** The one group this group sits inside. */
  readonly parent?: string;
};
/** What moves from one node to another, in the direction it moves. */
export type SystemLinkInput = {
  /** Lets a replay step or a lens name the link. */
  readonly id?: string;
  readonly from: string;
  readonly to: string;
  /** What moves or what is done. */
  readonly label: string;
  readonly kind?: SystemLinkKind;
};
export type SystemProps = {
  readonly id: string;
  /** The claim, as a sentence. */
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  /** Node ids offered as entry points. */
  readonly startWith?: readonly string[];
  readonly nodes: readonly SystemNodeInput[];
  readonly groups?: readonly SystemGroupInput[];
  readonly links: readonly SystemLinkInput[];
  /** Ordered cases. A step names nodes and links, and may mark some broken. */
  readonly replays?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly steps: readonly {
      readonly at: string | readonly string[];
      readonly note: string;
      readonly broken?: readonly string[];
    }[];
  }[];
  /** Unordered cases: a failure, a role, a moment. */
  readonly lenses?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly note: string;
    readonly focus: readonly string[];
    readonly broken?: readonly string[];
  }[];
};

/** The limits a `System` is checked against. */
export const systemBudget = { nodes: 12, lines: 6, steps: 12 } as const;

export type SystemNode = {
  readonly id: string;
  readonly label: string;
  readonly kind: SystemNodeKind;
  readonly detail?: string;
  readonly lines: readonly string[];
  readonly about?: string;
  readonly group?: string;
};
type SystemGroup = {
  readonly id: string;
  readonly label: string;
  readonly parent?: string;
  /** Index among the groups, which picks the tint. */
  readonly tint: number;
};
type SystemLink = {
  /** The author's id, or one made from the ends. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly kind: SystemLinkKind;
};
type SystemStep = {
  readonly at: readonly string[];
  readonly note: string;
  readonly broken: readonly string[];
};
export type SystemCase = FigureCase<
  SystemStep,
  { readonly focus: readonly string[]; readonly broken: readonly string[] }
>;
export type SystemModel = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  readonly startWith: readonly string[];
  readonly nodes: readonly SystemNode[];
  readonly groups: readonly SystemGroup[];
  readonly links: readonly SystemLink[];
  readonly cases: readonly SystemCase[];
};

const tintCount = 6;

/** Reads groups in order. A group nested two deep is drawn inside its outer group. */
function readGroups(entries: readonly unknown[], issues: FigureIssue[]): readonly SystemGroup[] {
  const raw = entries.flatMap((value, index) => {
    const group = record(value);
    const id = text(group?.["id"]);
    if (group === undefined || id === undefined) {
      issues.push(inputIssue(`group ${index + 1} has no id; it is left out`));
      return [];
    }
    return [{ id, label: text(group["label"]), parent: text(group["parent"]) }];
  });
  const seen = new Set<string>();
  const unique = raw.filter((group) => {
    if (seen.has(group.id) === true) {
      issues.push(inputIssue(`duplicate group id "${group.id}": the second one is left out`));
      return false;
    }
    seen.add(group.id);
    return true;
  });
  const byId = new Map(unique.map((group) => [group.id, group]));
  return unique.map((group, index): SystemGroup => {
    if (group.label === undefined) issues.push(inputIssue(`group "${group.id}" has no label`));
    const base = { id: group.id, label: group.label ?? group.id, tint: index % tintCount };
    if (group.parent === undefined) return base;
    const parent = byId.get(group.parent);
    if (parent === undefined || parent.id === group.id) {
      issues.push(
        inputIssue(
          `group "${group.id}" sits inside an unknown group "${group.parent}"; drawn on its own`,
        ),
      );
      return base;
    }
    if (parent.parent === undefined || byId.has(parent.parent) === false)
      return { ...base, parent: parent.id };
    const outer = parent.parent;
    if (outer === group.id) {
      issues.push(
        inputIssue(
          `groups "${group.id}" and "${parent.id}" sit inside each other; drawn on its own`,
        ),
      );
      return base;
    }
    issues.push(
      inputIssue(
        `group "${group.id}" sits inside "${parent.id}", which sits inside another group; a group sits inside at most one other group. Drawn inside "${outer}"`,
      ),
    );
    return { ...base, parent: outer };
  });
}

/** Reads nodes in order, dropping what cannot be drawn and repairing what can. */
function readNodes(
  entries: readonly unknown[],
  groups: ReadonlyMap<string, SystemGroup>,
  issues: FigureIssue[],
): readonly SystemNode[] {
  const seen = new Set<string>();
  return entries.flatMap((value, index): SystemNode[] => {
    const node = record(value);
    const id = text(node?.["id"]);
    if (node === undefined || id === undefined) {
      issues.push(inputIssue(`node ${index + 1} has no id; it is left out`));
      return [];
    }
    const label = text(node["label"]);
    if (seen.has(id) === true) {
      issues.push(inputIssue(`duplicate id "${id}": node "${label ?? id}" is left out`));
      return [];
    }
    seen.add(id);
    if (label === undefined) issues.push(inputIssue(`node "${id}" has no label`));
    const authoredKind = text(node["kind"]);
    const kind = oneOf(systemNodeKinds, authoredKind) === true ? authoredKind : "service";
    if (authoredKind === undefined)
      issues.push(
        inputIssue(
          `node "${id}" has no kind; drawn as a service. Use ${systemNodeKinds.join(", ")}`,
        ),
      );
    else if (authoredKind !== kind)
      issues.push(
        inputIssue(`node "${id}" has unknown kind "${authoredKind}"; drawn as a service`),
      );
    const lines = list(node["lines"]).flatMap((line) => {
      const shown = text(line);
      return shown === undefined ? [] : [shown];
    });
    if (lines.length > systemBudget.lines)
      issues.push(
        inputIssue(
          `node "${id}" has ${lines.length} lines; at most ${systemBudget.lines} are drawn`,
        ),
      );
    const authoredGroup = text(node["group"]);
    const group = authoredGroup === undefined ? undefined : groups.get(authoredGroup);
    if (authoredGroup !== undefined && group === undefined)
      issues.push(
        inputIssue(
          `node "${id}" is in an unknown group "${authoredGroup}"; drawn outside any group`,
        ),
      );
    const detail = text(node["detail"]);
    const about = text(node["about"]);
    return [
      {
        id,
        label: label ?? id,
        kind,
        ...(detail === undefined ? {} : { detail }),
        lines: lines.slice(0, systemBudget.lines),
        ...(about === undefined ? {} : { about }),
        ...(group === undefined ? {} : { group: group.id }),
      },
    ];
  });
}

/** Reads links in order. A link to an unknown node is left out; a missing label is reported. */
function readLinks(
  entries: readonly unknown[],
  nodeIds: ReadonlySet<string>,
  issues: FigureIssue[],
): readonly SystemLink[] {
  const seen = new Set<string>(nodeIds);
  return entries.flatMap((value, index): SystemLink[] => {
    const link = record(value);
    const from = text(link?.["from"]);
    const to = text(link?.["to"]);
    if (link === undefined || from === undefined || to === undefined) {
      issues.push(inputIssue(`link ${index + 1} needs from and to; it is left out`));
      return [];
    }
    const unknown = [from, to].find((id) => nodeIds.has(id) === false);
    if (unknown !== undefined) {
      issues.push(inputIssue(`link ${from} -> ${to} names an unknown id "${unknown}"`));
      return [];
    }
    const label = text(link["label"]);
    const authoredId = text(link["id"]);
    if (authoredId !== undefined && seen.has(authoredId) === true) {
      issues.push(
        inputIssue(
          `duplicate link id "${authoredId}": link ${from} -> ${to}${label === undefined ? "" : ` "${label}"`} is left out`,
        ),
      );
      return [];
    }
    if (authoredId !== undefined) seen.add(authoredId);
    if (label === undefined)
      issues.push(
        inputIssue(
          from === to
            ? `link ${from} -> ${to} starts and ends on "${from}"; give it a label that explains why`
            : `link ${from} -> ${to} has no label; say what moves or what is done`,
        ),
      );
    const authoredKind = text(link["kind"]);
    const kind = oneOf(systemLinkKinds, authoredKind) === true ? authoredKind : "call";
    if (authoredKind !== undefined && authoredKind !== kind)
      issues.push(
        inputIssue(`link ${from} -> ${to} has unknown kind "${authoredKind}"; drawn as a call`),
      );
    return [
      {
        id: authoredId ?? `${from}->${to}#${index + 1}`,
        from,
        to,
        label: label ?? "",
        kind,
      },
    ];
  });
}

/** Builds the model of a `System` from whatever the author passed, with every input issue. */
export function readSystem(props: unknown): {
  readonly model: SystemModel;
  readonly issues: readonly FigureIssue[];
} {
  const raw = record(props) ?? {};
  const groupIssues: FigureIssue[] = [];
  const groups = readGroups(list(raw["groups"]), groupIssues);
  const nodeIssues: FigureIssue[] = [];
  const nodes = readNodes(
    list(raw["nodes"]),
    new Map(groups.map((group) => [group.id, group])),
    nodeIssues,
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  const linkIssues: FigureIssue[] = [];
  const links = readLinks(list(raw["links"]), nodeIds, linkIssues);
  const linked = new Set(links.flatMap((link) => [link.from, link.to]));
  const lonely = nodes
    .filter((node) => linked.has(node.id) === false && links.length > 0)
    .map((node) => inputIssue(`node "${node.id}" is in no link; link it or leave it out`));
  const linkIds = new Set(links.map((link) => link.id));
  const known = (id: string): boolean => nodeIds.has(id) === true || linkIds.has(id) === true;

  const caseIssues: FigureIssue[] = [];
  const startWith = list(raw["startWith"]).flatMap((value) => {
    const id = text(value) ?? "?";
    if (nodeIds.has(id) === true) return [id];
    caseIssues.push(inputIssue(`startWith names an unknown id "${id}"`));
    return [];
  });
  /** The known ids among `value`, a string or a list of strings, reporting the others. */
  const ids = (value: unknown, name: string): readonly string[] =>
    (typeof value === "string" ? [value] : list(value)).flatMap((entry) => {
      const id = text(entry) ?? "?";
      if (known(id) === true) return [id];
      caseIssues.push(inputIssue(`${name} names an unknown id "${id}"`));
      return [];
    });
  const cases = readCases(raw, {
    steps: systemBudget.steps,
    issues: caseIssues,
    step: (fields, where): SystemStep | undefined => {
      const at = ids(fields["at"], where);
      const broken = ids(fields["broken"], where);
      return at.length === 0 && broken.length === 0
        ? undefined
        : { at, note: text(fields["note"]) ?? "", broken };
    },
    lens: (lens, name) => ({ focus: ids(lens["focus"], name), broken: ids(lens["broken"], name) }),
  });

  const rule = record(raw["rule"]);
  const ruleTitle = text(rule?.["title"]);
  const ruleText = text(rule?.["text"]);
  const summary = text(raw["summary"]);
  return {
    model: {
      id: text(raw["id"]) ?? "system",
      title: text(raw["title"]) ?? "",
      ...(summary === undefined ? {} : { summary }),
      ...(ruleTitle === undefined || ruleText === undefined
        ? {}
        : { rule: { title: ruleTitle, text: ruleText } }),
      startWith,
      nodes,
      groups,
      links,
      cases,
    },
    issues: [
      ...idIssues(raw["id"]),
      ...claimIssues(raw["title"]),
      ...(list(raw["nodes"]).length === 0
        ? [inputIssue("nodes is empty; give the parts that run")]
        : []),
      ...(list(raw["links"]).length === 0
        ? [inputIssue("links is empty; give what the parts send each other")]
        : []),
      ...groupIssues,
      ...nodeIssues,
      ...linkIssues,
      ...lonely,
      ...caseIssues,
      ...(nodes.length > systemBudget.nodes
        ? [
            inputIssue(
              `${nodes.length} nodes; the budget is ${systemBudget.nodes}. Split the figure or raise its level`,
            ),
          ]
        : []),
    ],
  };
}

export type SystemFocus = {
  /** Links that leave the focus: what it sends. */
  readonly out: readonly SystemLink[];
  /** Links that enter the focus: what it receives. */
  readonly incoming: readonly SystemLink[];
  /** The focus and its direct neighbours. */
  readonly near: ReadonlySet<string>;
};

/** What stays inked around the node `id`. A small drawing needs no further hop. */
export function systemFocus(model: SystemModel, id: string): SystemFocus {
  if (model.nodes.some((node) => node.id === id) === false)
    return { out: [], incoming: [], near: new Set() };
  const out = model.links.filter((link) => link.from === id);
  const incoming = model.links.filter((link) => link.to === id && link.from !== id);
  return {
    out,
    incoming,
    near: new Set([id, ...out.map((link) => link.to), ...incoming.map((link) => link.from)]),
  };
}

/** The label of a node or a link id, for text. */
export function systemLabel(model: SystemModel, id: string): string {
  return (
    model.nodes.find((node) => node.id === id)?.label ??
    model.links.find((link) => link.id === id)?.label ??
    id
  );
}

/** The plain text of a `System`, used by copy and search. */
export function systemReadable(model: SystemModel): string {
  const name = (id: string): string => systemLabel(model, id);
  const described = (node: SystemNode): string => {
    const parts = [
      ...(node.kind === "service" ? [] : [node.kind]),
      ...(node.detail === undefined ? [] : [node.detail]),
      ...node.lines,
    ];
    return parts.length === 0 ? node.label : `${node.label} (${parts.join("; ")})`;
  };
  const loose = model.nodes.filter((node) => node.group === undefined);
  return [
    model.title,
    model.summary ?? "",
    model.rule === undefined ? "" : `How to read this: ${model.rule.title}. ${model.rule.text}`,
    model.startWith.length === 0 ? "" : `Start with: ${model.startWith.map(name).join(", ")}`,
    ...model.groups.map((group) => {
      const parent = model.groups.find((other) => other.id === group.parent);
      const members = model.nodes.filter((node) => node.group === group.id).map(described);
      return `${group.label}${parent === undefined ? "" : ` (in ${parent.label})`}: ${members.join(", ")}`;
    }),
    loose.length === 0 || model.groups.length === 0
      ? loose.length === 0
        ? ""
        : `Parts: ${loose.map(described).join(", ")}`
      : `Outside any group: ${loose.map(described).join(", ")}`,
    ...model.links.map(
      (link) =>
        `${name(link.from)} -> ${name(link.to)}: ${link.label}${link.kind === "call" ? "" : ` (${link.kind})`}`,
    ),
    ...model.cases.map((item) =>
      item.kind === "replay"
        ? `Replay ${item.label}: ${item.steps
            .map((step, index) => {
              const parts = [
                step.at.map(name).join(", "),
                step.broken.length === 0 ? "" : `broken: ${step.broken.map(name).join(", ")}`,
              ].filter((part) => part !== "");
              return `${index + 1}. ${parts.join("; ")}: ${step.note}`;
            })
            .join(" ")}`
        : `Lens ${item.label}: ${item.focus.map(name).join(", ")}.${item.broken.length === 0 ? "" : ` Broken: ${item.broken.map(name).join(", ")}.`} ${item.note}`,
    ),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
