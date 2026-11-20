/**
 * Components authors use in MDX beside the figures: a callout, tabs and a defined term. Each keeps
 * its whole text in readable copy and search, and `tack check` checks its props.
 */
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import { Flag, Info, Lightbulb, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  Children,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ReaderPortalContainer } from "../menu.tsx";
import type { DocsIconName } from "../icons/catalog.ts";
import { DocsIconSet } from "../icons/docs-icon.tsx";
import { calloutLabels, type CalloutKind } from "./kinds.ts";

/** The kinds of callout, each with its own name and icon. */
const calloutKinds = {
  note: { label: calloutLabels.note, icon: Info },
  tip: { label: calloutLabels.tip, icon: Lightbulb },
  warning: { label: calloutLabels.warning, icon: TriangleAlert },
  decision: { label: calloutLabels.decision, icon: Flag },
} as const satisfies Record<CalloutKind, { label: string; icon: LucideIcon }>;

/** The text of `element` with runs of blank space folded, for readable copy. */
const textOf = (element: Element | null) =>
  (element?.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

/**
 * A note set apart from the text: a kind (note, tip, warning or decision) marked by its icon and
 * name, an optional title and the content. Copy carries the kind, the title and the text.
 *
 * @param icon - A docs icon in place of the kind's own.
 */
export function Callout({
  kind = "note",
  title,
  icon,
  children,
}: {
  kind?: CalloutKind;
  title?: string;
  icon?: DocsIconName;
  children?: ReactNode;
}): ReactNode {
  const { label, icon: KindIcon } = calloutKinds[kind];
  const set = useContext(DocsIconSet);
  const custom = icon === undefined ? undefined : set[icon];
  const Drawn = custom ?? KindIcon;
  const heading = title === undefined ? label : `${label}: ${title}`;
  const body = useRef<HTMLDivElement>(null);
  const [readable, setReadable] = useState(heading);
  useEffect(() => {
    const text = textOf(body.current);
    setReadable(text === "" ? heading : `${heading}\n${text}`);
  }, [heading, children]);
  return (
    <aside
      className="tack-callout"
      data-kind={kind}
      aria-label={heading}
      data-reader-readable={readable}
    >
      <p className="tack-callout-head">
        <Drawn className="tack-icon" size="1em" strokeWidth={2} aria-hidden="true" />
        <span className="tack-callout-kind">{label}</span>
        {title === undefined ? null : <span className="tack-callout-title">{title}</span>}
      </p>
      <div ref={body} className="tack-callout-body">
        {children}
      </div>
    </aside>
  );
}

/** One tab of `Tabs`: its label and content. Outside `Tabs` it shows its content alone. */
export function Tab({ children }: { label: string; children?: ReactNode }): ReactNode {
  return <div>{children}</div>;
}

type TabElement = ReactElement<{ label: string; children?: ReactNode }>;

const isTab = (child: ReactNode): child is TabElement =>
  isValidElement(child) && child.type === Tab;

/** The `Tab`s among `children`, also those MDX wrapped in a paragraph. */
const tabsIn = (children: ReactNode): readonly TabElement[] =>
  Children.toArray(children).flatMap((child): readonly TabElement[] =>
    isTab(child)
      ? [child]
      : isValidElement<{ children?: ReactNode }>(child)
        ? Children.toArray(child.props.children).filter(isTab)
        : [],
  );

/**
 * The same content in alternatives, one shown at a time: install steps per platform, a call per
 * language. Each `<Tab label>` is a choice; arrow keys move between them. Copy carries every tab,
 * each under its label, whichever is shown.
 */
export function Tabs({ children }: { children?: ReactNode }): ReactNode {
  const tabs = tabsIn(children);
  const root = useRef<HTMLDivElement>(null);
  const [readable, setReadable] = useState("");
  const labels = tabs.map((tab) => tab.props.label).join("\n");
  useEffect(() => {
    const panels = Array.from(root.current?.querySelectorAll('[role="tabpanel"]') ?? []);
    setReadable(
      tabs.map((tab, index) => `${tab.props.label}\n${textOf(panels[index] ?? null)}`).join("\n\n"),
    );
    // Labels and children identify what the panels hold.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `tabs` is rebuilt every render.
  }, [labels, children]);
  return (
    <BaseTabs.Root
      ref={root}
      className="tack-tabs"
      defaultValue={0}
      data-reader-readable={readable}
    >
      <BaseTabs.List className="tack-tabs-list">
        {tabs.map((tab, index) => (
          <BaseTabs.Tab key={index} value={index} className="tack-tabs-tab">
            {tab.props.label}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {tabs.map((tab, index) => (
        <BaseTabs.Panel key={index} value={index} keepMounted className="tack-tabs-panel">
          {tab.props.children}
        </BaseTabs.Panel>
      ))}
    </BaseTabs.Root>
  );
}

/**
 * A word with its definition: shown in a tooltip on hover or keyboard focus, and kept in the text
 * after the word for screen readers and copy.
 *
 * @param title - The definition.
 */
export function Term({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  const container = useContext(ReaderPortalContainer);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<dfn className="tack-term" tabIndex={0} />}>
        {children}
        <span className="sr-only"> ({title})</span>
      </Tooltip.Trigger>
      <Tooltip.Portal container={container}>
        <Tooltip.Positioner className="z-80" sideOffset={6}>
          <Tooltip.Popup className="max-w-72 rounded-sm bg-ink px-2.5 py-1.5 font-sans text-xs leading-snug text-paper shadow-lg">
            {title}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** The author components the reader gives every MDX document. */
export const authoringComponents = { Callout, Tabs, Tab, Term };
