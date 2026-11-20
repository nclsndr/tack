import { GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { Glyph } from "./glyph.tsx";
import { menuPanel, ReaderPopover } from "./menu.tsx";
import {
  attachedDocs,
  firstClause,
  issueEntry,
  issueLabel,
  projectMonogram,
  rootLabel,
  rootName,
  type AttachedResource,
  type IssueEntry,
} from "./project-summary.ts";
import type { ComponentFinding } from "./authoring/check.ts";
import type { DocumentIconIssue } from "./icons/collect.ts";
import type { ReaderCheckout, ReaderDocument, ReaderResourceIssue } from "./types.ts";

/** The reader's live connection as the footer and the project popover state it. */
export type LiveIndicator = { state: "live" | "refreshing" | "error"; label: string };

const docs = (count: number) => `${count} ${count === 1 ? "doc" : "docs"}`;

/**
 * The sidebar header: the project's monogram and name over its checked-out branch, or its root
 * folder outside git. It opens a popover with where the reader reads from: the branch, the root,
 * every attached docs resource with its document count and folder, the live state and the release.
 *
 * @param checkout - The fresh checkout from the latest status check, not the one at compile time.
 * @param attention - The issue count the header marks with a small red indicator, `""` for none.
 */
export function ProjectHeader({
  boot,
  checkout,
  live,
  attention,
}: {
  boot: {
    worktree: string;
    project: { name: string };
    resources: readonly AttachedResource[];
    documents: readonly ReaderDocument[];
    version?: string | undefined;
  };
  checkout: ReaderCheckout | null;
  live: LiveIndicator;
  attention: string;
}): ReactNode {
  const place =
    checkout === null
      ? { text: rootName(boot.worktree), title: boot.worktree }
      : checkout.kind === "branch"
        ? { text: checkout.name, title: `Branch ${checkout.name}` }
        : { text: checkout.commit, title: `Detached at ${checkout.commit}` };
  const rows = attachedDocs(boot.resources, boot.documents);
  return (
    <ReaderPopover
      align="start"
      summaryClassName="group/project -ml-1 flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-sm border border-transparent bg-transparent px-1 py-0.5 text-left hover:border-rule-strong hover:bg-hover data-popup-open:border-rule-strong data-popup-open:bg-hover"
      panelClassName={`${menuPanel} w-[min(20rem,calc(100vw-2rem))] gap-3 p-3.5`}
      summary={
        <>
          <span className="relative shrink-0">
            <span
              className="tack-monogram grid size-6 place-items-center rounded-[3px] bg-ink text-[10px] leading-none font-bold tracking-wide text-paper"
              aria-hidden="true"
            >
              {projectMonogram(boot.project.name)}
            </span>
            {attention === "" ? null : (
              <span
                className="tack-project-attention absolute -top-1 -right-1 size-2.5 rounded-full border-2 border-index bg-red"
                title={attention}
              />
            )}
          </span>
          <span className="grid min-w-0 leading-tight">
            <span className="flex min-w-0 items-center gap-1.5 after:chevron after:-translate-y-0.5 after:rotate-45 after:text-muted group-data-popup-open/project:after:translate-y-px group-data-popup-open/project:after:rotate-225">
              <strong className="tack-project-name truncate text-base font-semibold text-ink">
                {boot.project.name}
              </strong>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
              {checkout === null ? null : (
                <span className="inline-flex shrink-0 [&>svg]:size-3">
                  <Glyph icon={GitBranch} />
                </span>
              )}
              <span
                className="tack-project-place truncate font-mono leading-snug"
                title={place.title}
              >
                {place.text}
              </span>
              {attention === "" ? null : (
                <span className="tack-project-attention-label sr-only"> · {attention}</span>
              )}
            </span>
          </span>
        </>
      }
    >
      <dl className="tack-project-facts grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        {checkout === null ? null : (
          <>
            <dt className="font-semibold tracking-widest text-print uppercase">Branch</dt>
            <dd className="truncate font-mono text-ink">
              {checkout.kind === "branch" ? checkout.name : `detached at ${checkout.commit}`}
            </dd>
          </>
        )}
        <dt className="font-semibold tracking-widest text-print uppercase">Root</dt>
        <dd className="truncate font-mono text-ink" title={boot.worktree}>
          {rootLabel(boot.worktree)}
        </dd>
      </dl>
      <section aria-label="Attached docs" className="grid gap-2 border-t border-rule pt-3">
        <p className="flex items-baseline justify-between text-xs font-semibold tracking-widest text-print uppercase">
          Attached docs
          <span className="tack-project-docs-total font-medium tracking-normal text-muted normal-case tabular-nums">
            {docs(boot.documents.length)}
          </span>
        </p>
        {rows.length === 0 ? (
          <p className="text-xs text-muted">No docs resource is attached.</p>
        ) : (
          <ul className="tack-project-docs grid gap-2">
            {rows.map((row) => (
              <li
                key={row.identity}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2"
              >
                <span className="tack-project-docs-label truncate text-ink" title={row.label}>
                  {row.label}
                </span>
                <span className="tack-project-docs-count text-xs text-muted tabular-nums">
                  {row.count}
                </span>
                <span
                  className="tack-project-docs-directory col-span-2 truncate font-mono text-xs text-muted"
                  title={row.directory}
                >
                  {row.directory}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="tack-project-footer flex items-center justify-between gap-2 border-t border-rule pt-2.5 text-xs text-muted">
        <span
          className="inline-flex items-center gap-1.5 before:size-1.5 before:shrink-0 before:rounded-full before:bg-print data-[live=error]:text-red data-[live=error]:before:bg-red data-[live=refreshing]:before:bg-muted"
          data-live={live.state}
        >
          {live.label}
        </span>
        {boot.version === undefined ? null : <span className="font-mono">tack {boot.version}</span>}
      </p>
    </ReaderPopover>
  );
}

/**
 * The one home of reader issues, in the bottom-right corner: a red count that opens a list of the
 * skipped documents and unavailable resources, each by file or resource and the first clause of its
 * cause, with the full message on hover. A failed rebuild of the served generation joins the list.
 *
 * @param failure - The status route's rebuild failure, `""` when the last rebuild succeeded.
 * @param icons - `<Icon>` uses of served documents the reader cannot draw, each by file and line.
 * @param components - Misused author components of served documents, each by file and line.
 */
export function IssueNotice({
  issues,
  failure,
  icons = [],
  components = [],
}: {
  issues: readonly ReaderResourceIssue[];
  failure: string;
  icons?: readonly DocumentIconIssue[];
  components?: readonly ComponentFinding[];
}): ReactNode {
  const entries: IssueEntry[] = [
    ...issues.map(issueEntry),
    ...icons.map((icon) => ({
      name: `${icon.path.split("/").at(-1) ?? icon.path}:${icon.line}`,
      summary: icon.message,
      message: `${icon.path}:${icon.line}: ${icon.message}`,
    })),
    ...components.map((part) => ({
      name: `${part.path.split("/").at(-1) ?? part.path}:${part.line}`,
      summary: part.message,
      message: `${part.path}:${part.line}: ${part.message}`,
    })),
    ...(failure === ""
      ? []
      : [{ name: "Last save", summary: firstClause(failure), message: failure }]),
  ];
  if (entries.length === 0) return null;
  return (
    <ReaderPopover
      side="top"
      summaryClassName="tack-issue-count pointer-events-auto flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-red/35 bg-red-wash px-3 py-1.5 text-sm text-red shadow-lg before:size-2 before:shrink-0 before:rounded-full before:bg-red after:chevron after:ml-0.5 after:translate-y-px after:rotate-225 hover:border-red/35 hover:bg-red-wash data-popup-open:after:-translate-y-0.5 data-popup-open:after:rotate-45"
      panelClassName={`${menuPanel} w-[min(24rem,calc(100vw-2.5rem))] gap-2.5 p-3.5`}
      summary={issueLabel(issues, failure, icons, components)}
    >
      <ul className="tack-issues grid max-h-[50vh] gap-2 overflow-auto">
        {entries.map((entry, index) => (
          <li key={`${index}:${entry.name}`} className="grid min-w-0" title={entry.message}>
            <span className="tack-issue-name truncate font-mono text-xs text-red">
              {entry.name}
            </span>
            <span className="tack-issue-summary text-muted">{entry.summary}</span>
          </li>
        ))}
      </ul>
      <p className="border-t border-rule pt-2 text-xs text-muted">
        Fix the source and save; the reader reloads it.
      </p>
    </ReaderPopover>
  );
}
