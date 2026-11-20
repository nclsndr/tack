import { Check, Copy, Menu, PanelLeft, Search, X, type LucideIcon } from "lucide-react";
import { Drawer } from "@base-ui/react/drawer";
import { MDXProvider } from "@mdx-js/react";
import { Content, NavigationType, useLocation, useNavigationType } from "@rspress/core/runtime";
import {
  Component,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { z } from "zod";
import {
  collectSelection,
  filterDocuments,
  interactionContext,
  sectionIds,
  type RenderedBlock,
} from "./browser.ts";
import { DocumentIndex } from "./document-index.tsx";
import { EditorControl } from "./editor.tsx";
import { ReaderLink } from "./link.tsx";
import { CopyControl } from "./copy-control.tsx";
import { ReaderPortalContainer } from "./menu.tsx";
import { documentDate, folderOf } from "./navigation.ts";
import { AppearanceControl } from "./appearance.tsx";
import { Glyph } from "./glyph.tsx";
import { ReaderTooltip } from "./tooltip.tsx";
import { IssueNotice, ProjectHeader } from "./project-header.tsx";
import { issueLabel } from "./project-summary.ts";
import type { DocumentIconIssue } from "./icons/collect.ts";
import type { ComponentFinding } from "./authoring/check.ts";
import { authoringComponents } from "./authoring/components.tsx";
import { documentAt } from "./document-route.ts";
import { DocsIconSet, Icon } from "./icons/docs-icon.tsx";
import {
  clampSidebarWidth,
  initialSidebar,
  keyedSidebarWidth,
  loadSidebarLayout,
  saveSidebarLayout,
  sidebarWidths,
} from "./sidebar.ts";
import { standardFigures } from "./visuals.tsx";
import { resourceIdentity, resourceLabel } from "./resource.ts";
import type { AttachedResource } from "./project-summary.ts";
import type {
  ReaderCheckout,
  ReaderDocument,
  ReaderResourceIssue,
  CopyMode,
  SourceBlock as AuthoredBlock,
  SourceReference,
} from "./types.ts";

export type ReaderBoot = {
  /** The project root this reader serves. */
  worktree: string;
  project: { name: string };
  /** Every attached docs resource, including one that could not load. */
  resources: AttachedResource[];
  /** What the project root had checked out at compile time; `null` outside git. */
  checkout: ReaderCheckout | null;
  /** The Tack release stamp the CLI passed, absent when none was passed. */
  version?: string | undefined;
  documents: ReaderDocument[];
  revision: string;
  token: string;
  metadata: { types: string[]; statuses: string[]; tags: string[] };
  presets: {
    navigation?: string | undefined;
    layouts?: string | undefined;
    components?: string | undefined;
  };
  /** Worktree-relative folders whose documents sit on the archive shelf. */
  archive: string[];
  issues?: ReaderResourceIssue[];
  /** `<Icon>` uses of served documents the reader cannot draw; they join the issue popover. */
  iconIssues?: DocumentIconIssue[];
  /** Author components of served documents used so they cannot work; they join the popover. */
  componentIssues?: ComponentFinding[];
  complete?: boolean;
};
export type ReaderCustomization = {
  pendingResources?: readonly string[];
  resourceErrors?: Readonly<Record<string, string>>;
  Navigation?: ComponentType<{
    documents: ReaderDocument[];
    current: ReaderDocument | undefined;
    children: ReactNode;
  }>;
  layouts?: Record<string, ComponentType<{ document: ReaderDocument; children: ReactNode }>>;
  components?: Record<string, ComponentType<Record<string, unknown>>>;
  customizations?: Record<string, ReaderCustomization>;
};
type PresentationBoundaryProps = {
  children: ReactNode;
  label: string;
  fallback?: ReactNode;
};

function PresentationError({ label, message }: { label: string; message: string }) {
  return (
    <div role="alert" className="border border-rule bg-paper p-4 text-sm text-muted">
      <p className="font-semibold text-ink">Source presentation unavailable: {label}</p>
      <p>{message}</p>
      <p>Other documentation remains available. Fix the source and save to retry.</p>
    </div>
  );
}

/** Keeps source rendering exceptions inside their presentation slot, preserving the reader shell. */
class PresentationBoundary extends Component<PresentationBoundaryProps, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <>
        <PresentationError label={this.props.label} message={this.state.error} />
        {this.props.fallback}
      </>
    );
  }
}

declare const tackReaderBoot: ReaderBoot;
declare module "react" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Only an interface can augment React's style properties.
  interface CSSProperties {
    "--tack-sidebar-width"?: string;
  }
}
type SourceTools = {
  copy: (id: string, section: boolean) => Promise<boolean>;
  preview: (id: string, section: boolean, active: boolean) => void;
  lines: (id: string) => SourceReference | undefined;
};
const SourceContext = createContext<SourceTools>({
  copy: async () => false,
  preview: () => undefined,
  lines: () => undefined,
});
const copiedNotice = "Copied with physical source references.";
const refreshingNotice = "Refreshing the local reader…";
const liveStatus = {
  live: { label: "Live", detail: "Live from saved files" },
  refreshing: { label: "Reconnecting", detail: "Reconnecting to the local reader" },
  error: { label: "Source error", detail: "Saved source has an error" },
} as const;
/** The documents' sheet, shared by the page sidebar and the narrow-viewport drawer. */
const sidebarSheet =
  "tack-sidebar flex h-dvh min-h-0 flex-col gap-3 border-r border-rule bg-index px-3.5 pt-4 pb-3";
const sidebarToggle =
  "w-8 justify-center border-transparent bg-transparent p-0 text-muted hover:border-rule-strong hover:bg-hover hover:text-ink";
const metaItem =
  "grid gap-1 border-rule max-md:border-b max-md:pt-2 max-md:pr-2.5 max-md:pb-2 md:mr-4.5 md:border-r md:pt-2 md:pr-4.5 md:pb-2.5 md:last:mr-0 md:last:border-r-0 md:last:pr-0";
const metaLabel = "text-xs font-semibold tracking-widest text-print uppercase";
const metaValue = "flex min-h-5 items-center text-ink";

/** Names the modifier keys held during a key press, joined with `+`, or `""` when none is held. */
function heldModifiers(event: KeyboardEvent): string {
  return (["metaKey", "ctrlKey", "altKey", "shiftKey"] as const)
    .filter((modifier) => event[modifier])
    .join("+");
}

/** The viewport width below which the documents leave the page for a drawer, as Tailwind's `max-md`. */
const narrowViewport = "(width < 48rem)";

/** Follows whether the viewport is narrow; a page without `matchMedia` counts as wide. */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(narrowViewport).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(narrowViewport);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

function lineRange(reference: SourceReference): string {
  return reference.startLine === reference.endLine
    ? `${reference.startLine}`
    : `${reference.startLine}–${reference.endLine}`;
}
const responseSchema = z.object({
  text: z.string().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
});
const checkoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), name: z.string() }),
  z.object({ kind: z.literal("detached"), commit: z.string() }),
]);
const liveSchema = z.object({
  revision: z.string(),
  error: z.string().optional(),
  checkout: checkoutSchema.nullable().optional(),
});
/** The small status the reader checks for saved changes; the corpus itself is never refetched. */
const statusPath = "/__tack/status";

/** Gives each authored semantic block a copy control and physical source identity. */
export function SourceBlock({
  id,
  file,
  version,
  children,
}: {
  id: string;
  file: string;
  version: string;
  children?: ReactNode;
}) {
  const tools = useContext(SourceContext);
  const ref = useRef<HTMLDivElement>(null);
  const [heading, setHeading] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setHeading(
      ref.current !== null &&
        ref.current.querySelector(
          ":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6",
        ) !== null,
    );
  }, []);
  useEffect(() => {
    if (copied === false) return undefined;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const lines = tools.lines(id);
  const range = lines === undefined ? undefined : lineRange(lines);
  const linesWord = lines?.startLine === lines?.endLine ? "line" : "lines";
  const copy = (section: boolean) => {
    void tools.copy(id, section).then((succeeded) => setCopied(succeeded));
  };
  const previewHandlers = (section: boolean) => ({
    onMouseEnter: () => tools.preview(id, section, true),
    onMouseLeave: () => tools.preview(id, section, false),
    onFocus: (event: { currentTarget: HTMLElement }) => {
      if (event.currentTarget.matches(":focus-visible") === true) tools.preview(id, section, true);
    },
    onBlur: () => tools.preview(id, section, false),
  });
  const sectionControl =
    heading === true ? (
      <button
        className="tack-cite-section"
        title="Copy this section"
        aria-label="Copy section"
        onClick={() => copy(true)}
        {...previewHandlers(true)}
      >
        §
      </button>
    ) : null;
  return (
    <div
      ref={ref}
      className="tack-source"
      data-source-id={id}
      data-source-file={file}
      data-source-version={version}
      data-copied={copied}
    >
      <div className="tack-block-tools" data-reader-controls="true">
        <button
          className="tack-cite"
          title={
            lines === undefined
              ? "Copy this block"
              : `Copy ${linesWord} ${range} of ${lines.path.split("/").at(-1)}`
          }
          aria-label={range === undefined ? "Copy block" : `Copy block, ${linesWord} ${range}`}
          onClick={() => copy(false)}
          {...previewHandlers(false)}
        >
          {copied === true ? (
            <Glyph icon={Check} />
          ) : lines === undefined ? (
            <Glyph icon={Copy} />
          ) : (
            <>
              <span className="tack-cite-start">{lines.startLine}</span>
              {lines.endLine === lines.startLine ? null : (
                <span className="tack-cite-end">–{lines.endLine}</span>
              )}
            </>
          )}
        </button>
        {sectionControl}
      </div>
      {children}
    </div>
  );
}

function renderedRefs(root: Element, ids: string[]): RenderedBlock[] {
  return ids.flatMap((id) => {
    const element = Array.from(root.querySelectorAll<HTMLElement>("[data-source-id]")).find(
      (block) => block.dataset["sourceId"] === id,
    );
    return element === undefined
      ? []
      : [
          {
            id,
            file: element.dataset["sourceFile"] ?? "",
            version: element.dataset["sourceVersion"] ?? "",
          },
        ];
  });
}
function readableBlock(element: Element, authored: AuthoredBlock | undefined): string {
  const integrated = interactionContext(element).readable;
  if (integrated.length > 0) return integrated;
  // Custom React without a readable export falls back to its authored invocation references.
  if (
    authored?.kind === "mdxJsxFlowElement" ||
    element.querySelector("figure,svg,canvas,[data-reader-custom]") !== null
  )
    return "";
  const clone = element.ownerDocument.createElement("div");
  clone.append(element.cloneNode(true));
  clone
    .querySelectorAll("[data-reader-controls],[hidden],button")
    .forEach((control) => control.remove());
  return clone.textContent?.trim() ?? "";
}

/** Renders the configured worktree reader while Rspress owns MDX compilation and routing. */
export function ReaderLayout({
  boot = tackReaderBoot,
  customization,
  icons = {},
}: {
  boot?: ReaderBoot;
  customization: ReaderCustomization;
  /** The docs icons this generation bundled, by name, for the MDX `Icon`. */
  icons?: Readonly<Record<string, LucideIcon>>;
}) {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const current = documentAt(boot.documents, pathname);
  const article = useRef<HTMLElement>(null);
  const readerRoot = useRef<HTMLDivElement>(null);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const narrow = useNarrowViewport();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sidebar, setSidebar] = useState(() =>
    typeof window === "undefined" ? initialSidebar : loadSidebarLayout(() => window.localStorage),
  );
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | undefined>(undefined);
  const sidebarElement = useRef<HTMLElement>(null);
  const sidebarHide = useRef<HTMLButtonElement>(null);
  const sidebarShow = useRef<HTMLButtonElement>(null);
  const sidebarFocus = useRef<RefObject<HTMLElement | null> | undefined>(undefined);
  useEffect(() => {
    if (resizing === false) saveSidebarLayout(() => window.localStorage, sidebar);
  }, [sidebar, resizing]);
  useEffect(() => {
    sidebarFocus.current?.current?.focus();
    sidebarFocus.current = undefined;
  }, [sidebar.hidden]);
  /** Shows or hides the sidebar, then moves focus to `focus` once the layout changes. */
  const setSidebarHidden = (hidden: boolean, focus: RefObject<HTMLElement | null>) => {
    sidebarFocus.current = focus;
    setSidebar((previous) => ({ ...previous, hidden }));
  };
  /** Flips the sidebar, keeping focus on a control that stays visible. */
  const toggleSidebar = () => {
    const active = document.activeElement;
    sidebarFocus.current =
      sidebarElement.current?.contains(active) === true
        ? sidebarShow
        : active === sidebarShow.current
          ? sidebarHide
          : undefined;
    setSidebar((previous) => ({ ...previous, hidden: previous.hidden === false }));
  };
  const resizeSidebar = (width: number) => setSidebar((previous) => ({ ...previous, width }));
  const endResize = () => {
    resizeStart.current = undefined;
    setResizing(false);
  };
  const [mode, setMode] = useState<CopyMode>("readable");
  const [includeImplementations, setIncludeImplementations] = useState(false);
  const [announcement, setAnnouncement] = useState({ notice: "", at: 0 });
  const notice = announcement.notice;
  const setNotice = (text: string) => setAnnouncement({ notice: text, at: Date.now() });
  useEffect(() => {
    if (announcement.notice === "") return undefined;
    const timer = setTimeout(
      () => setAnnouncement({ notice: "", at: 0 }),
      announcement.notice === copiedNotice ? 4000 : 8000,
    );
    return () => clearTimeout(timer);
  }, [announcement]);
  const [liveNotice, setLiveNotice] = useState("");
  const [checkout, setCheckout] = useState(boot.checkout);
  const [copied, setCopied] = useState("");
  const [selectedBlocks, setSelectedBlocks] = useState(0);
  const [outline, setOutline] = useState<{ id: string; text: string; level: number }[]>([]);
  const [activeHeading, setActiveHeading] = useState("");
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input,textarea,select,[contenteditable]") !== null
      )
        return;
      if (event.key.toLowerCase() === "b" && heldModifiers(event) === "metaKey") {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      setNavigationOpen(true);
      setSidebarHidden(false, searchInput);
      searchInput.current?.focus();
    };
    const trackSelection = () => {
      const root = article.current;
      setSelectedBlocks(
        root === null ? 0 : (collectSelection(window.getSelection(), root)?.blocks.length ?? 0),
      );
    };
    document.addEventListener("keydown", shortcuts);
    document.addEventListener("selectionchange", trackSelection);
    return () => {
      document.removeEventListener("keydown", shortcuts);
      document.removeEventListener("selectionchange", trackSelection);
    };
  }, []);
  useEffect(() => {
    let frame = 0;
    const track = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const passed = outline.filter(
          (item) => (document.getElementById(item.id)?.getBoundingClientRect().top ?? 0) < 120,
        );
        setActiveHeading(passed.at(-1)?.id ?? outline[0]?.id ?? "");
      });
    };
    track();
    window.addEventListener("scroll", track, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", track);
    };
  }, [outline]);
  const [filters, setFilters] = useState(() => {
    const params =
      typeof window === "undefined"
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search);
    return {
      query: params.get("q") ?? "",
      type: params.get("type") ?? "",
      status: params.get("status") ?? "",
      tag: params.get("tag") ?? "",
    };
  });
  useEffect(() => {
    const pop = () => {
      const params = new URLSearchParams(window.location.search);
      setFilters({
        query: params.get("q") ?? "",
        type: params.get("type") ?? "",
        status: params.get("status") ?? "",
        tag: params.get("tag") ?? "",
      });
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    // One check at a time: the next starts a second after the previous settles, so a slow answer
    // never stacks requests, and leaving the reader aborts the one in flight.
    const controller = new AbortController();
    const { signal } = controller;
    let validator: string | null = null;
    let savedNotice = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const response = await fetch(statusPath, {
          cache: "no-store",
          signal,
          headers: validator === null ? {} : { "If-None-Match": validator },
        });
        if (signal.aborted === true) return;
        if (response.status !== 304) {
          if (response.ok === false) throw new Error("Reader refresh failed.");
          const live = liveSchema.parse(await response.json());
          if (live.revision !== boot.revision) {
            window.location.reload();
            return;
          }
          validator = response.headers.get("etag");
          savedNotice = live.error ?? "";
          if (live.checkout !== undefined) setCheckout(live.checkout);
        }
        setLiveNotice(savedNotice);
      } catch {
        if (signal.aborted === true) return;
        setLiveNotice(refreshingNotice);
      }
      timer = setTimeout(() => void check(), 1000);
    };
    timer = setTimeout(() => void check(), 1000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [boot.revision]);
  useEffect(() => {
    const update = () =>
      setOutline(
        Array.from(article.current?.querySelectorAll("h2,h3,h4,h5,h6") ?? [])
          .filter(
            (heading) => heading.closest("[hidden]") === null && heading.closest("figure") === null,
          )
          .map((heading, index) => {
            if (heading.id === "") heading.id = `reader-heading-${index}`;
            return {
              id: heading.id,
              text: heading.textContent?.replace(/^#/, "") ?? "",
              level: Number(heading.tagName.slice(1)),
            };
          }),
      );
    update();
    const observer = new MutationObserver(update);
    // Coverage skip: the effect runs after the article mounts; cleanup disconnects before reuse.
    /* v8 ignore next -- @preserve */
    if (article.current !== null)
      observer.observe(article.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
    return () => observer.disconnect();
  }, [pathname]);
  useEffect(() => {
    // A page opened through the client router starts at its top, or at its fragment, as a loaded
    // document would; Back and Forward leave scroll restoration to the browser.
    if (navigationType !== NavigationType.Push) return;
    const fragment = decodeURIComponent(window.location.hash.slice(1));
    const target = fragment === "" ? null : window.document.getElementById(fragment);
    if (target === null) window.scrollTo(0, 0);
    else target.scrollIntoView();
  }, [pathname, navigationType]);
  const updateFilters = (changes: Partial<typeof filters>) => {
    const next = { ...filters, ...changes };
    setFilters(next);
    const url = new URL(window.location.href);
    Object.entries(next).forEach(([name, item]) => {
      const param = name === "query" ? "q" : name;
      if (item === "") url.searchParams.delete(param);
      else url.searchParams.set(param, item);
    });
    window.history.pushState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const updateFilter = (key: keyof typeof filters, value: string) =>
    updateFilters({ [key]: value });
  const activeFilters = [filters.type, filters.status, filters.tag].filter(
    (value) => value !== "",
  ).length;
  const api = async (action: string, input: unknown) => {
    const response = await fetch(`/__tack/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tack-Token": boot.token },
      body: JSON.stringify(input),
    });
    const output = responseSchema.parse(await response.json());
    if (response.ok === false || output.error !== undefined)
      throw new Error(output.error ?? "Reader action failed.");
    return output;
  };
  const doCopy = async (
    refs: RenderedBlock[],
    readable: string,
    state: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const result = await api("copy", {
        blocks: refs.map(({ id, version }) => ({ id, version })),
        ...(readable.length === 0 ? {} : { readable }),
        state: { ...state, url: window.location.href },
        mode,
        includeImplementations,
        ...(current?.resource === undefined ? {} : { resource: current.resource }),
      });
      setCopied(result.text ?? "");
      await navigator.clipboard.writeText(result.text ?? "");
      setNotice(copiedNotice);
      return true;
    } catch (error) {
      setNotice(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "The browser denied clipboard access. Focus the reader window, then copy again."
          : error instanceof Error
            ? error.message
            : String(error),
      );
      return false;
    }
  };
  const blockElements = (root: Element, ids: string[]) =>
    Array.from(root.querySelectorAll<HTMLElement>("[data-source-id]")).filter((element) =>
      ids.includes(element.dataset["sourceId"] ?? ""),
    );
  const previewBlock = (id: string, section: boolean, active: boolean) => {
    const root = article.current;
    // Coverage skip: mounted copy controls always have an article; unmount removes these handlers.
    /* v8 ignore next -- @preserve */
    if (root === null) return;
    blockElements(root, section === true ? sectionIds(root, id) : [id]).forEach((element) => {
      if (active === true) element.dataset["preview"] = "true";
      else delete element.dataset["preview"];
    });
  };
  const copyBlock = async (id: string, section: boolean): Promise<boolean> => {
    const root = article.current;
    // Coverage skip: mounted copy controls always have an article; unmount removes these handlers.
    /* v8 ignore next -- @preserve */
    if (root === null) return false;
    const ids = section === true ? sectionIds(root, id) : [id];
    const refs = renderedRefs(root, ids);
    const elements = refs.flatMap((reference) =>
      Array.from(root.querySelectorAll<HTMLElement>("[data-source-id]")).filter(
        (element) => element.dataset["sourceId"] === reference.id,
      ),
    );
    const readable = elements
      .map((element) =>
        readableBlock(
          element,
          current?.blocks.find((block) => block.id === element.dataset["sourceId"]),
        ),
      )
      .filter((text) => text.length > 0)
      .join("\n\n");
    const state = elements.reduce<Record<string, unknown>>(
      (result, element) => ({ ...result, ...interactionContext(element).state }),
      {},
    );
    return doCopy(refs, readable, state);
  };
  const copySelection = () => {
    const root = article.current;
    // Coverage skip: mounted copy controls always have an article; unmount removes these handlers.
    /* v8 ignore next -- @preserve */
    if (root === null) return;
    const selection = collectSelection(window.getSelection(), root);
    if (selection === null) {
      setNotice("Select rendered document text first.");
      return;
    }
    const state = selection.blocks.reduce<Record<string, unknown>>((context, reference) => {
      const element = Array.from(root.querySelectorAll<HTMLElement>("[data-source-id]")).find(
        (block) => block.dataset["sourceId"] === reference.id,
      );
      // Coverage skip: selection identities come from this same synchronous DOM scan.
      /* v8 ignore next -- @preserve */
      return element === undefined ? context : { ...context, ...interactionContext(element).state };
    }, {});
    void doCopy(selection.blocks, selection.readable, state);
  };
  const visible = filterDocuments(boot.documents, filters);
  const filterKey =
    filters.query === "" && activeFilters === 0 ? "" : new URLSearchParams(filters).toString();
  const folderNavigation = (
    <DocumentIndex
      documents={boot.documents}
      visible={visible}
      current={current}
      archive={boot.archive}
      worktree={boot.worktree}
      filterKey={filterKey}
      onNavigate={() => setNavigationOpen(false)}
    />
  );
  const dated = current === undefined ? undefined : documentDate(current.relativePath);
  const sourceLines = current === undefined ? 0 : current.source.trimEnd().split("\n").length;
  const folderPath = current === undefined ? "" : folderOf(current);
  const fileName = current?.relativePath.split("/").at(-1) ?? "";
  const currentResourceLabel =
    current?.resource === undefined ? "" : resourceLabel(current.resource);
  const issues = boot.issues ?? [];
  /** A failed rebuild of the served generation; its issues arrive with the boot payload instead. */
  const failure = liveNotice === refreshingNotice ? "" : liveNotice;
  const iconIssues = boot.iconIssues ?? [];
  const componentIssues = boot.componentIssues ?? [];
  const attention = issueLabel(issues, failure, iconIssues, componentIssues);
  const liveState =
    liveNotice === refreshingNotice ? "refreshing" : attention === "" ? "live" : "error";
  const message = liveNotice === refreshingNotice ? liveNotice : notice;
  const navigation = boot.presets.navigation === "folders" ? folderNavigation : null;
  const resourceCustomization =
    current?.resource === undefined
      ? undefined
      : customization.customizations?.[resourceIdentity(current.resource)];
  const resourceKey =
    current?.resource === undefined ? "project" : resourceIdentity(current.resource);
  const presentationKey = `${resourceKey}:${boot.revision}`;
  const presentationLabel =
    currentResourceLabel === "" ? "Project documentation" : currentResourceLabel;
  const pendingPresentation = customization.pendingResources?.includes(resourceKey) ?? false;
  const presentationError = customization.resourceErrors?.[resourceKey];
  const activeCustomization =
    pendingPresentation === true || presentationError !== undefined
      ? {}
      : (resourceCustomization ?? customization);
  const Navigation = activeCustomization.Navigation;
  const components = {
    a: ReaderLink,
    Icon,
    ...authoringComponents,
    ...(boot.presets.components === "standard" ? standardFigures : {}),
    ...activeCustomization.components,
    SourceBlock,
  };
  const content = (
    <MDXProvider components={components}>
      <Content />
    </MDXProvider>
  );
  const PageLayout =
    current?.metadata.layout === undefined
      ? activeCustomization.layouts?.["default"]
      : activeCustomization.layouts?.[current.metadata.layout];
  /** The documents: in the page's sidebar on a wide viewport, in a drawer on a narrow one. */
  const sidebarContent = (
    <>
      <header className="flex shrink-0 items-center gap-2.5 px-1 pt-0.5 pb-1">
        <ProjectHeader
          boot={boot}
          checkout={checkout}
          live={{ state: liveState, label: liveStatus[liveState].label }}
          attention={attention}
        />
        <ReaderTooltip label="Hide documents (⌘B)">
          <button
            ref={sidebarHide}
            type="button"
            className={`tack-sidebar-hide ml-auto max-md:hidden ${sidebarToggle}`}
            aria-label="Hide documents"
            aria-controls="reader-documents"
            onClick={() => setSidebarHidden(true, sidebarShow)}
          >
            <Glyph icon={PanelLeft} />
          </button>
        </ReaderTooltip>
        {narrow === true ? (
          <Drawer.Close
            className="tack-navigation-close ml-auto min-w-8 justify-center p-1"
            aria-label="Close document navigation"
          >
            <Glyph icon={X} />
          </Drawer.Close>
        ) : null}
      </header>
      <div className="group/search relative flex shrink-0 items-center text-muted">
        <Glyph icon={Search} className="pointer-events-none absolute left-2.5" />
        <input
          ref={searchInput}
          className="h-9 w-full min-w-0 border-rule-strong py-2 pr-8.5 pl-8 text-sm hover:border-control"
          type="search"
          aria-label="Search documents"
          placeholder="Search documents"
          value={filters.query}
          onChange={(event) => updateFilter("query", event.target.value)}
        />
        <kbd
          className="pointer-events-none absolute right-2 rounded-xs border border-rule-strong px-1.5 py-0.5 font-mono text-xs leading-none text-muted group-focus-within/search:opacity-0 max-md:hidden"
          aria-hidden="true"
        >
          /
        </kbd>
      </div>
      <div className="flex items-center justify-between pr-1 pl-1.5 text-xs font-semibold tracking-widest text-print uppercase">
        <span>
          Index{" "}
          <span className="tack-file-count ml-1 font-medium tracking-normal text-muted tabular-nums">
            {visible.length}
            {visible.length === boot.documents.length ? "" : ` / ${boot.documents.length}`}
          </span>
        </span>
        <button
          type="button"
          className="tack-filter-toggle min-h-7 border-transparent bg-transparent px-2 py-0.5 text-xs font-medium tracking-normal text-body normal-case after:ml-0.5 after:-translate-y-0.5 after:rotate-45 after:chevron hover:border-rule-strong hover:bg-hover aria-expanded:border-rule-strong aria-expanded:bg-hover aria-expanded:after:translate-y-px aria-expanded:after:rotate-225"
          aria-expanded={filtersOpen}
          aria-controls="reader-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          {activeFilters === 0 ? "Filters" : `Filters · ${activeFilters}`}
        </button>
      </div>
      <div
        id="reader-filters"
        className="shrink-0 rounded-sm border border-rule bg-sheet p-2.5 text-xs text-muted"
        hidden={!filtersOpen}
      >
        <div className="grid gap-2">
          {(["type", "status", "tag"] as const).map((key) => (
            <label
              key={key}
              className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 capitalize"
            >
              {key}
              <select
                className="w-full min-w-0"
                aria-label={`Filter by ${key}`}
                value={filters[key]}
                onChange={(event) => updateFilter(key, event.target.value)}
              >
                <option value="">
                  All {key === "type" ? "types" : key === "status" ? "statuses" : "tags"}
                </option>
                {(key === "type"
                  ? boot.metadata.types
                  : key === "status"
                    ? boot.metadata.statuses
                    : [...new Set(boot.documents.flatMap((document) => document.metadata.tags))]
                ).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <button
          className="mt-2.5 ml-auto flex min-h-7 px-2 py-0.5 text-xs"
          disabled={activeFilters === 0}
          onClick={() => updateFilters({ type: "", status: "", tag: "" })}
        >
          Clear filters
        </button>
      </div>
      <nav
        aria-label="Folders"
        className="-mx-1.5 flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain px-1.5"
      >
        {Navigation === undefined ? (
          navigation
        ) : (
          <PresentationBoundary
            key={presentationKey}
            label={presentationLabel}
            fallback={navigation}
          >
            <Navigation documents={visible} current={current}>
              {navigation}
            </Navigation>
          </PresentationBoundary>
        )}
      </nav>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-rule px-0.5 pt-2">
        <AppearanceControl />
        <span
          className="tack-live inline-flex min-w-0 items-center gap-1.5 text-xs text-muted before:size-1.5 before:shrink-0 before:rounded-full before:bg-print data-[live=error]:text-red data-[live=error]:before:bg-red data-[live=refreshing]:before:bg-muted"
          data-live={liveState}
          title={liveStatus[liveState].detail}
        >
          <span className="truncate">{liveStatus[liveState].label}</span>
        </span>
      </footer>
      <div
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none after:absolute after:inset-0 after:mx-auto after:w-0.5 after:transition-colors hover:after:bg-pen focus-visible:outline-none focus-visible:after:bg-pen group-data-[sidebar-resizing=true]/reader:after:bg-pen max-md:hidden"
        role="separator"
        aria-label="Resize documents"
        aria-controls="reader-documents"
        aria-orientation="vertical"
        aria-valuemin={sidebarWidths.min}
        aria-valuemax={sidebarWidths.max}
        aria-valuenow={sidebar.width}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          resizeStart.current = { x: event.clientX, width: sidebar.width };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const start = resizeStart.current;
          if (start === undefined) return;
          resizeSidebar(clampSidebarWidth(start.width + event.clientX - start.x));
        }}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={() => resizeSidebar(sidebarWidths.initial)}
        onKeyDown={(event) => {
          const width = keyedSidebarWidth(sidebar.width, event.key);
          if (width === undefined) return;
          event.preventDefault();
          resizeSidebar(width);
        }}
      />
    </>
  );
  return (
    <SourceContext.Provider
      value={{
        copy: copyBlock,
        preview: previewBlock,
        lines: (id) => current?.blocks.find((block) => block.id === id)?.source,
      }}
    >
      <ReaderPortalContainer.Provider value={readerRoot}>
        <DocsIconSet.Provider value={icons}>
          <div
            ref={readerRoot}
            className="tack-reader group/reader grid min-h-screen grid-cols-[var(--tack-sidebar-width)_minmax(0,1fr)] bg-paper font-sans text-body data-[sidebar-resizing=true]:cursor-col-resize data-[sidebar-resizing=true]:select-none max-md:block md:data-[sidebar-hidden=true]:grid-cols-1"
            data-sidebar-hidden={sidebar.hidden}
            data-sidebar-resizing={resizing}
            style={{ "--tack-sidebar-width": `${sidebar.width}px` }}
          >
            {narrow === true ? (
              <Drawer.Root
                open={navigationOpen}
                onOpenChange={setNavigationOpen}
                swipeDirection="left"
              >
                <Drawer.Portal container={readerRoot}>
                  <Drawer.Backdrop className="tack-navigation-backdrop fixed inset-0 z-50 bg-backdrop" />
                  <Drawer.Viewport className="pointer-events-none fixed inset-0 z-60">
                    <Drawer.Popup
                      ref={(node) => {
                        sidebarElement.current = node;
                      }}
                      initialFocus={searchInput}
                      finalFocus={navigationToggle}
                      className={`${sidebarSheet} pointer-events-auto fixed inset-y-0 left-0 w-80 max-w-[88vw] translate-x-(--drawer-swipe-movement-x) animate-drawer-in shadow-lg outline-none`}
                      render={<aside id="reader-documents" aria-label="Documents" />}
                    >
                      {sidebarContent}
                    </Drawer.Popup>
                  </Drawer.Viewport>
                </Drawer.Portal>
              </Drawer.Root>
            ) : (
              <aside
                ref={sidebarElement}
                className={`${sidebarSheet} sticky top-0 z-30 md:group-data-[sidebar-hidden=true]/reader:hidden`}
                id="reader-documents"
                aria-label="Documents"
              >
                {sidebarContent}
              </aside>
            )}
            <main className="min-w-0">
              <div className="sticky top-0 z-20 flex min-h-13 items-center gap-4 border-b border-rule bg-paper/90 py-2 pr-5 pl-7 text-sm text-muted backdrop-blur-sm max-lg:flex-wrap max-lg:gap-2 max-lg:px-4 max-md:px-3">
                <ReaderTooltip label="Show documents (⌘B)">
                  <button
                    ref={sidebarShow}
                    type="button"
                    className={`tack-sidebar-show -ml-2.5 hidden md:group-data-[sidebar-hidden=true]/reader:inline-flex ${sidebarToggle}`}
                    aria-label="Show documents"
                    aria-controls="reader-documents"
                    aria-expanded={sidebar.hidden === false}
                    onClick={() => setSidebarHidden(false, sidebarHide)}
                  >
                    <Glyph icon={PanelLeft} />
                  </button>
                </ReaderTooltip>
                <button
                  ref={navigationToggle}
                  className="tack-navigation-toggle hidden max-md:inline-flex"
                  aria-controls="reader-documents"
                  aria-expanded={navigationOpen}
                  onClick={() => setNavigationOpen((open) => open === false)}
                >
                  <Glyph icon={Menu} />
                  Files
                </button>
                <span
                  className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1 font-mono text-xs leading-snug max-lg:basis-full max-md:basis-0"
                  title={current?.path}
                >
                  {current === undefined ? (
                    "Choose a document"
                  ) : (
                    <>
                      {folderPath === "" ? null : (
                        <span className="min-w-4 shrink-100 truncate text-muted">
                          {folderPath}/
                        </span>
                      )}
                      <span className="min-w-0 truncate text-ink">{fileName}</span>
                      {currentResourceLabel === "" ? null : (
                        <span
                          className="ml-2 shrink-0 truncate text-muted"
                          title={`${current.resource?.sourceRegistrationId ?? ""}\n${current.resource?.sourcePath ?? ""}`}
                        >
                          {currentResourceLabel}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <div className="flex shrink-0 items-center gap-1.5 max-lg:ml-auto max-md:w-full max-md:justify-between">
                  <EditorControl path={current?.path} />
                  <div className="tack-copybar flex shrink-0 items-center gap-1.5 border-l border-rule pl-2.5 max-md:border-0 max-md:pl-0">
                    <CopyControl
                      selectedBlocks={selectedBlocks}
                      onCopy={copySelection}
                      mode={mode}
                      onModeChange={setMode}
                      includeImplementations={includeImplementations}
                      onIncludeImplementationsChange={setIncludeImplementations}
                    />
                  </div>
                </div>
              </div>
              {/* The bottom-right corner: a transient notice above the issue popover, the one home of issues. */}
              <div className="pointer-events-none fixed right-5 bottom-5 z-45 flex max-w-110 flex-col items-end gap-2 max-md:left-5">
                {message.length > 0 ? (
                  <div
                    role="status"
                    className="flex animate-notice-in items-center gap-2.5 rounded-md bg-ink px-4 py-3 text-sm leading-normal wrap-anywhere text-paper shadow-lg before:size-2 before:shrink-0 before:rounded-full before:bg-pen-wash max-md:self-stretch data-[tone=attention]:border data-[tone=attention]:border-red/35 data-[tone=attention]:bg-red-wash data-[tone=attention]:text-red data-[tone=attention]:before:bg-red"
                    data-tone={message === copiedNotice ? "success" : "attention"}
                  >
                    {message}
                  </div>
                ) : null}
                <IssueNotice
                  issues={issues}
                  failure={failure}
                  icons={iconIssues}
                  components={componentIssues}
                />
              </div>
              <div className="grid grid-cols-[minmax(0,calc(var(--tack-gutter)+728px))_12rem] justify-center gap-14 pt-9 pr-8 pb-28 pl-2 max-xl:grid-cols-[minmax(0,calc(var(--tack-gutter)+728px))] max-lg:pt-7 max-lg:pr-6 max-lg:pb-24 max-lg:pl-0 max-md:pt-5.5 max-md:pr-4">
                <article
                  ref={article}
                  className="tack-article min-w-0"
                  onCopy={(event) => {
                    const selected = collectSelection(window.getSelection(), event.currentTarget);
                    if (selected !== null) {
                      event.preventDefault();
                      copySelection();
                    }
                  }}
                >
                  {current === undefined ? (
                    <h1 className="ml-(--tack-gutter)">
                      {boot.documents.length === 0
                        ? "No declared documents"
                        : pathname.startsWith("/docs/")
                          ? "Docs route not found. Open a current document from the list."
                          : "Choose an available document"}
                    </h1>
                  ) : (
                    <>
                      <dl
                        className="mb-7.5 ml-(--tack-gutter) flex flex-wrap border-y border-t-rule-strong border-b-rule font-sans max-md:grid max-md:grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] max-md:border-b-0"
                        aria-label="Document metadata"
                      >
                        {current.metadata.type === undefined ? null : (
                          <div className={metaItem}>
                            <dt className={metaLabel}>Type</dt>
                            <dd className={`${metaValue} gap-2 text-sm capitalize`}>
                              {current.metadata.type}
                            </dd>
                          </div>
                        )}
                        {current.metadata.status === undefined ? null : (
                          <div className={metaItem}>
                            <dt className={metaLabel}>Status</dt>
                            <dd className={`${metaValue} gap-2 text-sm`}>
                              <span
                                className="inline-flex items-center rounded-xs border border-ink px-2 pt-px pb-0.5 text-xs font-semibold tracking-wider text-ink uppercase data-[status=draft]:border-dashed data-[status=draft]:border-muted data-[status=draft]:text-muted data-[status=review]:border-pen data-[status=review]:text-pen data-[status=superseded]:border-red data-[status=superseded]:text-red data-[status=superseded]:line-through"
                                data-status={current.metadata.status}
                              >
                                {current.metadata.status}
                              </span>
                            </dd>
                          </div>
                        )}
                        {dated === undefined ? null : (
                          <div className={metaItem}>
                            <dt className={metaLabel}>Dated</dt>
                            <dd className={`${metaValue} gap-2 text-sm`}>
                              <time
                                className="font-mono text-xs leading-snug tabular-nums"
                                dateTime={dated}
                              >
                                {dated}
                              </time>
                            </dd>
                          </div>
                        )}
                        {current.metadata.tags.length === 0 ? null : (
                          <div className={`${metaItem} max-md:col-span-2`}>
                            <dt className={metaLabel}>Tags</dt>
                            <dd className={`${metaValue} flex-wrap gap-x-3 gap-y-0.5 text-sm`}>
                              {current.metadata.tags.map((tag) => (
                                <span key={tag}>{tag}</span>
                              ))}
                            </dd>
                          </div>
                        )}
                        <div
                          className={`${metaItem} flex-1 justify-items-end text-right max-md:justify-items-start max-md:text-left`}
                        >
                          <dt className={metaLabel}>Source</dt>
                          <dd
                            className={`${metaValue} gap-2 font-mono text-xs leading-snug tabular-nums`}
                            title={current.path}
                          >
                            {sourceLines} {sourceLines === 1 ? "line" : "lines"}
                          </dd>
                        </div>
                      </dl>
                      <div className="tack-sheet">
                        {pendingPresentation === true ? (
                          <p role="status" className="p-4 text-sm text-muted">
                            Loading source presentation…
                          </p>
                        ) : presentationError !== undefined ? (
                          <PresentationError
                            label={presentationLabel}
                            message={presentationError}
                          />
                        ) : (
                          <PresentationBoundary key={presentationKey} label={presentationLabel}>
                            {PageLayout === undefined ? (
                              content
                            ) : (
                              <PageLayout document={current}>{content}</PageLayout>
                            )}
                          </PresentationBoundary>
                        )}
                      </div>
                    </>
                  )}
                </article>
                <aside
                  className="tack-outline sticky top-21 mt-2 grid max-h-[calc(100dvh-7.5rem)] self-start overflow-auto text-sm max-xl:hidden"
                  aria-label="Contents"
                >
                  <strong className="mb-2.5 border-b border-rule-strong pb-1.5 text-xs font-semibold tracking-widest text-print uppercase">
                    Contents
                  </strong>
                  {outline.length === 0 ? (
                    <span className="tack-empty block text-sm text-muted">No sections</span>
                  ) : null}
                  {outline.map((item) => (
                    <a
                      key={item.id}
                      className="border-l border-rule py-1 pl-3 leading-snug text-pretty text-muted transition-colors hover:text-ink data-[level=3]:pl-6 data-[level=3]:text-xs data-[level=4]:pl-8.5 data-[level=4]:text-xs aria-[current=location]:border-l-pen aria-[current=location]:text-pen-strong"
                      href={`#${item.id}`}
                      data-level={Math.min(item.level, 4)}
                      aria-current={item.id === activeHeading ? "location" : undefined}
                    >
                      {item.text}
                    </a>
                  ))}
                </aside>
              </div>
              {copied.length > 0 ? (
                <details className="mx-auto -mt-16 mb-16 max-w-[calc(var(--tack-gutter)+728px+15.5rem)] pr-8 pl-[calc(0.5rem+var(--tack-gutter))] text-sm max-lg:pr-6 max-lg:pl-(--tack-gutter) max-md:pr-4">
                  <summary className="inline-flex py-1.5 text-xs font-semibold tracking-widest text-print uppercase">
                    Last copied prompt
                  </summary>
                  <textarea
                    className="mt-2 block h-60 w-full max-w-182 resize-y border-rule-strong bg-sheet p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap"
                    aria-label="Last copied prompt"
                    readOnly
                    value={copied}
                  />
                </details>
              ) : null}
            </main>
          </div>
        </DocsIconSet.Provider>
      </ReaderPortalContainer.Provider>
    </SourceContext.Provider>
  );
}
