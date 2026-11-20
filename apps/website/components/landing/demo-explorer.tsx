import { useEffect, useRef, useState } from "react";
import type { DemoSession } from "../../demo/demo-shell.ts";
import {
  homeRelative,
  isWithin,
  linkEdges,
  nextFreshLinks,
  opensByDefault,
  treeOf,
  type FreshLinks,
  type LinkEdge,
  type TreeNode,
} from "../../demo/machine-view.ts";

export type Volume = ReturnType<DemoSession["machine"]>["volume"];

/** The explorer's sections and the folders each one opens on. */
const explorerSections = [
  {
    title: "Sources",
    roots: [
      { label: "~/skills", path: "/home/you/skills" },
      { label: "~/team-docs", path: "/home/you/team-docs" },
    ],
  },
  {
    title: "Projects",
    roots: [
      { label: "~/code/app", path: "/home/you/code/app" },
      { label: "~/code/api", path: "/home/you/code/api" },
    ],
  },
  {
    title: "Your agents",
    roots: [
      { label: "~/.claude", path: "/home/you/.claude" },
      { label: "~/.agents", path: "/home/you/.agents" },
      { label: "~/.cursor", path: "/home/you/.cursor" },
    ],
  },
] as const;

/** The trees of every explorer root that exists, by section. */
export const readSections = (volume: Volume | undefined) =>
  explorerSections.map((section) => ({
    title: section.title,
    roots: section.roots.flatMap((root) =>
      volume !== undefined && volume.exists(root.path)
        ? [{ ...root, tree: treeOf(volume, root.path, root.label) }]
        : [],
    ),
  }));

/** The explorer's sections, as `readSections` reads them. */
export type Sections = ReturnType<typeof readSections>;

/** Every link in the explorer, with what it reaches. */
export const sectionEdges = (sections: Sections) =>
  sections.flatMap((section) => section.roots.flatMap((root) => linkEdges(root.tree)));

/** The links that count as new after the command of `revision`, as `nextFreshLinks` decides. */
export function useFreshLinks(edges: ReadonlyArray<LinkEdge>, revision: number) {
  const seen = useRef<(FreshLinks & { readonly revision: number }) | undefined>(undefined);
  const current = seen.current;
  if (current !== undefined && current.revision === revision) return current.fresh;
  const next = { ...nextFreshLinks(current, edges), revision };
  seen.current = next;
  return next.fresh;
}

/** Small line icons drawn on the brand's 16-unit grid. */
export function Icon({
  name,
}: {
  readonly name: "folder" | "open" | "file" | "link" | "chevron" | "terminal";
}) {
  const paths = {
    folder: "M1.5 4.5h4l1.5 1.5h7.5v7.5h-13z",
    open: "M1.5 4.5h4l1.5 1.5h7.5v2M1.5 13.5l2-5.5h12l-2 5.5z",
    file: "M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3",
    link: "M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8",
    chevron: "M6 4l4 4-4 4",
    terminal: "M1.5 2.5h13v11h-13zM4 6l2.5 2L4 10M8 10.5h4",
  } as const;
  return (
    <svg className={`demo-icon demo-icon-${name}`} viewBox="0 0 16 16" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

type RowContext = {
  readonly home: string;
  readonly fresh: ReadonlySet<string>;
  readonly selected: string | undefined;
  readonly targeted: ReadonlySet<string>;
  readonly lit: ReadonlySet<string>;
  readonly toggled: ReadonlyMap<string, boolean>;
  readonly toggle: (path: string, open: boolean) => void;
  /** Makes a row the active one; a file or link also `opens` in its own read-only tab. */
  readonly pick: (path: string, opens: boolean) => void;
};

const rowClasses = (names: ReadonlyArray<string | false>) =>
  names.filter((name) => name !== false).join(" ");

function Row({
  node,
  depth,
  context,
}: {
  readonly node: TreeNode;
  readonly depth: number;
  readonly context: RowContext;
}) {
  const indent = { paddingInlineStart: `${depth * 14 + 10}px` };
  const selected = context.selected === node.path;
  if (node.kind !== "directory") {
    const fresh = context.fresh.has(node.path);
    return (
      <li role="treeitem" aria-selected={selected}>
        <button
          type="button"
          className={rowClasses([
            "demo-tree-row",
            node.kind === "link" && "demo-tree-link",
            fresh && "demo-tree-fresh",
            selected && "demo-tree-selected",
            context.targeted.has(node.path) && "demo-tree-target",
          ])}
          style={indent}
          title={node.kind === "link" ? `${node.name} -> ${node.target}` : node.name}
          onClick={() => context.pick(node.path, true)}
        >
          <span className="demo-tree-spacer" />
          <Icon name={node.kind === "link" ? "link" : "file"} />
          <span className="demo-tree-name">{node.name}</span>
          {node.kind === "link" ? (
            node.resolved === undefined ? (
              <span className="demo-tree-dangling">dangling</span>
            ) : (
              <span className="demo-tree-reach">{homeRelative(node.resolved, context.home)}</span>
            )
          ) : null}
          {fresh === true ? <span className="demo-tree-badge">new</span> : null}
        </button>
      </li>
    );
  }
  const open = context.toggled.get(node.path) ?? opensByDefault(node.path, depth, context.lit);
  const links = open === true ? 0 : linkEdges(node).length;
  return (
    <li role="treeitem" aria-expanded={open} aria-selected={selected}>
      <button
        type="button"
        className={rowClasses([
          "demo-tree-row",
          "demo-tree-folder",
          context.targeted.has(node.path) && "demo-tree-target",
          selected && "demo-tree-selected",
        ])}
        style={indent}
        title={node.name}
        onClick={() => {
          context.toggle(node.path, open === false);
          context.pick(node.path, false);
        }}
      >
        <span className={`demo-tree-chevron${open === true ? " demo-tree-chevron-open" : ""}`}>
          <Icon name="chevron" />
        </span>
        <Icon name={open === true ? "open" : "folder"} />
        <span className="demo-tree-name">{node.name}</span>
        {links > 0 ? (
          <span className="demo-tree-count" aria-label={`${links} links inside`}>
            <Icon name="link" />
            {links}
          </span>
        ) : null}
      </button>
      {open === true && node.children.length > 0 ? (
        <ul role="group">
          {node.children.map((child) => (
            <Row key={child.path} node={child} depth={depth + 1} context={context} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A file explorer over the demo machine. A new link is marked until the links change again;
 * a file or link opens read-only in its own tab and lights the entry it reaches, and selecting a
 * source folder lights every link that reaches it. Folders open on what is lit, and the explorer scrolls the first new link into view.
 */
export function DemoExplorer({
  sections,
  edges,
  fresh,
  home,
  revision,
  selected,
  onPick,
}: {
  readonly sections: Sections;
  readonly edges: ReadonlyArray<LinkEdge>;
  readonly fresh: ReadonlySet<string>;
  readonly home: string;
  readonly revision: number;
  /** The active row, which the window keeps in step with the tab in front. */
  readonly selected: string | undefined;
  readonly onPick: (path: string, opens: boolean) => void;
}) {
  const pane = useRef<HTMLElement>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const targeted = new Set(
    edges.flatMap((edge) => {
      if (selected === undefined) return fresh.has(edge.from) ? [edge.to] : [];
      if (edge.from === selected) return [edge.to];
      return isWithin(edge.to, selected) ? [edge.from] : [];
    }),
  );
  const lit = new Set([...fresh, ...targeted, ...(selected === undefined ? [] : [selected])]);

  // A command starts a new reading: what the visitor unfolded gives way to the change.
  useEffect(() => {
    setToggled(new Map());
  }, [revision]);

  // Brings the first new link into view inside the pane, never scrolling the page.
  useEffect(() => {
    const element = pane.current;
    const row = element?.querySelector<HTMLElement>(".demo-tree-fresh");
    if (element === null || row === null || row === undefined) return;
    const top =
      row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    const visible =
      top >= element.scrollTop && top <= element.scrollTop + element.clientHeight - 32;
    if (visible === false) element.scrollTo({ top: Math.max(0, top - element.clientHeight / 3) });
  }, [revision]);

  const context: RowContext = {
    home,
    fresh,
    selected,
    targeted,
    lit,
    toggled,
    toggle: (path, open) => setToggled((current) => new Map([...current, [path, open]])),
    pick: onPick,
  };

  return (
    <nav ref={pane} className="demo-explorer" aria-label="Files on the demo machine">
      {sections.map((section) => (
        <section key={section.title}>
          <h3 className="demo-explorer-title">{section.title}</h3>
          {section.roots.length === 0 ? (
            <p className="demo-explorer-empty">Nothing linked yet</p>
          ) : (
            <ul role="tree" aria-label={section.title}>
              {section.roots.map((root) => (
                <Row key={root.path} node={root.tree} depth={0} context={context} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </nav>
  );
}
