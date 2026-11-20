import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  documentAge,
  documentDate,
  folderAncestors,
  folderOf,
  isArchived,
  navigationTree,
  sharedFolder,
  type NavigationNode,
} from "./navigation.ts";
import type { ReaderDocument } from "./types.ts";
import { ReaderLink } from "./link.tsx";
import { resourceIdentity, resourceLabel } from "./resource.ts";

type IndexState = z.infer<typeof storedState>;

const storedState = z.object({ open: z.array(z.string()), archive: z.boolean() });
const closedState: IndexState = { open: [], archive: false };
const folderCount = "font-mono text-xs leading-5 font-medium text-muted tabular-nums";

function readState(key: string): IndexState {
  try {
    const parsed = storedState.safeParse(JSON.parse(window.localStorage.getItem(key) ?? "null"));
    return parsed.success === true ? parsed.data : closedState;
  } catch {
    return closedState;
  }
}

function toggled(items: string[], item: string): string[] {
  return items.includes(item) === true ? items.filter((value) => value !== item) : [...items, item];
}

/**
 * Lists the corpus as a folder tree with declared archive folders on a closed shelf. Folder and
 * shelf choices survive the reloads that follow saved edits; the current document's folders open.
 */
export function DocumentIndex({
  documents,
  visible,
  current,
  archive,
  worktree,
  filterKey,
  onNavigate,
}: {
  /** The whole corpus, which fixes the tree roots while filters change. */
  documents: ReaderDocument[];
  visible: ReaderDocument[];
  current: ReaderDocument | undefined;
  /** Worktree-relative archive folders. */
  archive: string[];
  worktree: string;
  /** Identifies the active search and filters; `""` when none applies. */
  filterKey: string;
  onNavigate: () => void;
}): ReactNode {
  const storageKey = `tack-reader:navigation:${worktree}`;
  const archiveFor = (document: ReaderDocument) => {
    const prefix =
      document.resource === undefined ? "local:" : `${resourceIdentity(document.resource)}:`;
    const scoped = archive.flatMap((entry) =>
      entry.startsWith(prefix) ? [entry.slice(prefix.length)] : [],
    );
    return scoped.length === 0 ? archive : scoped;
  };
  const root = sharedFolder(documents.map(folderOf));
  const archiveRoot = archive.some((entry) => entry.includes(":")) ? "" : sharedFolder(archive);
  const container = useRef<HTMLDivElement>(null);
  const reveal = (state: IndexState): IndexState => {
    if (current === undefined) return state;
    const archived = isArchived(current, archiveFor(current));
    const folders = folderAncestors(current.relativePath, archived === true ? archiveRoot : root);
    return {
      open: [
        ...new Set([
          ...state.open,
          ...folders.map((folder) =>
            current.resource === undefined
              ? folder
              : `${resourceIdentity(current.resource)}:${folder}`,
          ),
        ]),
      ],
      archive: state.archive === true || archived === true,
    };
  };
  const [state, setState] = useState(() =>
    reveal(typeof window === "undefined" ? closedState : readState(storageKey)),
  );
  const [closedInResults, setClosedInResults] = useState<{ filterKey: string; folders: string[] }>({
    filterKey,
    folders: [],
  });
  const filtering = filterKey !== "";
  const closedResults = closedInResults.filterKey === filterKey ? closedInResults.folders : [];
  useEffect(() => {
    setState(reveal);
    container.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView?.({ block: "nearest" });
    // The current document alone decides which folders to reveal.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `reveal` is rebuilt every render.
  }, [current?.id]);
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Storage can be unavailable; folders then reopen from the current document only.
    }
  }, [storageKey, state]);

  const isOpen = (path: string) =>
    filtering === true ? closedResults.includes(path) === false : state.open.includes(path);
  const toggle = (path: string) =>
    filtering === true
      ? setClosedInResults({ filterKey, folders: toggled(closedResults, path) })
      : setState((previous) => ({ ...previous, open: toggled(previous.open, path) }));
  const setShelf = (open: boolean) => setState((previous) => ({ ...previous, archive: open }));

  const href = (document: ReaderDocument) =>
    `${document.route}${typeof window === "undefined" ? "" : window.location.search}`;
  const today = new Date();
  /** Renders tree rows; archived rows are set in pencil. */
  const renderNodes = (nodes: NavigationNode[], archived: boolean, prefix = ""): ReactNode =>
    nodes.map((node) => {
      if (node.kind === "document") {
        const document = node.document;
        const date = documentDate(document.relativePath);
        const age = documentAge(document.relativePath, today);
        const selected = current?.id === document.id;
        return (
          <li key={document.id}>
            <ReaderLink
              className={`grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-start gap-2 rounded-sm py-1.5 pr-1.5 pl-2 text-body transition-colors ${
                selected === true ? "bg-pen-wash" : "hover:bg-hover"
              }`}
              aria-current={selected === true ? "page" : undefined}
              title={[document.title, document.metadata.type, document.metadata.status, date]
                .filter((value) => value !== undefined)
                .join(" · ")}
              onClick={onNavigate}
              href={href(document)}
            >
              <span
                className="mt-1.5 size-2 shrink-0 rounded-xs border border-ink not-data-[status]:invisible data-[status=accepted]:bg-ink data-[status=active]:bg-ink data-[status=complete]:bg-ink data-[status=draft]:border-dashed data-[status=draft]:border-muted data-[status=review]:border-pen data-[status=superseded]:border-red data-[status=superseded]:bg-struck"
                data-status={document.metadata.status}
                aria-hidden="true"
              />
              <span
                className={`tack-entry-title line-clamp-2 min-w-0 text-sm leading-snug text-pretty ${
                  selected === true
                    ? "font-semibold text-pen-strong"
                    : archived === true
                      ? "text-muted"
                      : ""
                }`}
              >
                {document.title}
              </span>
              {age === undefined ? null : (
                <time
                  className={`tack-entry-age font-mono text-xs leading-5 tabular-nums ${
                    selected === true ? "text-pen-strong" : "text-muted"
                  }`}
                  dateTime={date}
                >
                  {age}
                </time>
              )}
            </ReaderLink>
          </li>
        );
      }
      const storagePath = prefix === "" ? node.path : `${prefix}:${node.path}`;
      const open = isOpen(storagePath);
      return (
        <li key={node.path}>
          <button
            type="button"
            className={`flex min-h-7 w-full items-start gap-2 border-0 bg-transparent px-1.5 py-1.5 text-left text-sm font-medium before:mt-2 before:mr-px before:-rotate-45 before:text-print before:chevron hover:bg-hover aria-expanded:before:-translate-y-0.5 aria-expanded:before:rotate-45 ${
              archived === true ? "text-muted" : "text-ink"
            }`}
            data-folder={storagePath}
            aria-expanded={open}
            title={node.path}
            onClick={() => toggle(storagePath)}
          >
            <span className="line-clamp-2 min-w-0 leading-snug text-pretty">{node.label}</span>
            <span className={`ml-auto ${folderCount}`}>{node.count}</span>
          </button>
          {open === true ? (
            <ul className="ml-3 space-y-px border-l border-rule pl-1.5">
              {renderNodes(node.children, archived, prefix)}
            </ul>
          ) : null}
        </li>
      );
    });

  const archived = visible.filter((document) => isArchived(document, archiveFor(document)));
  const active = visible.filter((document) => archived.includes(document) === false);
  const pointToArchive =
    filtering === true && active.length === 0 && archived.length > 0 && state.archive === false;
  return (
    <div ref={container} className="flex shrink-0 grow flex-col">
      <ul className="tack-tree-active space-y-3">
        {Object.entries(
          Object.groupBy(active, (document) =>
            document.resource === undefined ? "local" : resourceIdentity(document.resource),
          ),
        ).map(([identity, group]) => {
          const resource = group?.[0]?.resource;
          const allGroup = documents.filter(
            (document) =>
              (document.resource === undefined ? "local" : resourceIdentity(document.resource)) ===
              identity,
          );
          return (
            <li key={identity} className="border-t border-rule pt-2 first:border-t-0 first:pt-0">
              <p
                className="truncate px-1.5 text-xs font-semibold text-print"
                title={resource === undefined ? identity : `${identity} · ${resource.sourcePath}`}
              >
                {resource === undefined ? "Project documents" : resourceLabel(resource)}
              </p>
              <ul className="mt-1 space-y-px">
                {renderNodes(
                  navigationTree(group ?? [], sharedFolder(allGroup.map(folderOf))),
                  false,
                  resource === undefined ? "" : identity,
                )}
              </ul>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 ? (
        <p className="tack-empty px-1.5 py-2.5 text-sm text-muted">No documents match.</p>
      ) : null}
      {pointToArchive === true ? (
        <button
          type="button"
          className="tack-archive-hint mx-1.5 my-2 min-h-0 self-start border-0 bg-transparent p-0 text-sm text-pen hover:underline"
          onClick={() => setShelf(true)}
        >
          {archived.length === 1
            ? "Show 1 archived match"
            : `Show ${archived.length} archived matches`}
        </button>
      ) : null}
      {archived.length === 0 ? null : (
        <section
          className="tack-archive mt-auto pt-4.5 data-[open=false]:sticky data-[open=false]:bottom-0 data-[open=false]:bg-linear-to-b data-[open=false]:from-transparent data-[open=false]:to-index data-[open=false]:to-40%"
          aria-label="Archive"
          data-open={state.archive}
        >
          <button
            type="button"
            className="tack-archive-toggle flex min-h-8 w-full items-center gap-2 border-0 bg-transparent px-1.5 py-1 text-xs font-medium text-muted before:order-1 before:h-px before:flex-1 before:bg-rule after:order-2 after:mx-0.5 after:-translate-y-0.5 after:rotate-45 after:chevron hover:text-ink aria-expanded:after:translate-y-px aria-expanded:after:rotate-225"
            aria-expanded={state.archive}
            aria-controls="reader-archive"
            onClick={() => setShelf(state.archive === false)}
          >
            <span>Archive</span>
            <span className={folderCount}>{archived.length}</span>
          </button>
          {state.archive === true ? (
            <ul id="reader-archive" className="space-y-px pb-2">
              {renderNodes(navigationTree(archived, archiveRoot), true)}
            </ul>
          ) : null}
        </section>
      )}
    </div>
  );
}
