import { useEffect, useReducer, type ReactNode } from "react";
import { describeEntry } from "../../demo/machine-view.ts";
import { focusAfter, initialFocus } from "../../demo/workspace-focus.ts";
import { DemoEntry } from "./demo-entry.tsx";
import { usePublishLinks } from "./demo-links.tsx";
import {
  DemoExplorer,
  Icon,
  readSections,
  sectionEdges,
  useFreshLinks,
  type Volume,
} from "./demo-explorer.tsx";

/** What the status bar says about the run: the walkthrough's step, or the visitor at the keys. */
type RunState =
  | { readonly kind: "walkthrough"; readonly step: number; readonly total: number }
  | { readonly kind: "live" };

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A session tab's label and what its pane shows. */
type SessionPane = { readonly label: string; readonly content: ReactNode };

/**
 * The demo as one app window laid out like an IDE: the file explorer runs the full height on the
 * left, with the window lights at its top, and the tab strip sits over the main pane only. The
 * first tabs are the sessions on the machine: the coding agent's, then the terminal's once it is
 * open. A file or link picked in the explorer opens read-only in a tab of its own. The machine is
 * read once per render, so the explorer, the tabs and the status bar agree. On a narrow screen a
 * files tab shows the explorer in place of the main pane.
 */
export function DemoWorkspace({
  volume,
  home,
  prompt,
  sessions,
  front,
  revision,
  run,
  caption,
  controls,
}: {
  readonly volume: Volume | undefined;
  readonly home: string;
  /** The working directory as the prompt spells it. */
  readonly prompt: string;
  /** The session tabs; the terminal's is `undefined` until it opens. */
  readonly sessions: {
    readonly agent: SessionPane;
    readonly terminal: SessionPane | undefined;
  };
  /** The session brought to the front whenever it changes. */
  readonly front: "agent" | "terminal";
  readonly revision: number;
  readonly run: RunState;
  /** What the walkthrough step shows, or the visitor's hint; read out as it changes. */
  readonly caption: string;
  /** The run's buttons: play, pause and replay. */
  readonly controls: ReactNode;
}) {
  const [focus, dispatch] = useReducer(focusAfter, initialFocus);
  const { view, opened, selected } = focus;
  const sections = readSections(volume);
  const edges = sectionEdges(sections);
  const fresh = useFreshLinks(edges, revision);
  usePublishLinks(edges, fresh, home, revision, volume !== undefined);

  // A command reads the machine again; the tab in front stays the active row.
  useEffect(() => dispatch({ kind: "reading" }), [revision]);

  // The demo brings a session forward: the terminal when it opens, the agent on a replay.
  useEffect(() => dispatch({ kind: "show", view: { kind: front } }), [front]);

  const open = (path: string) => dispatch({ kind: "open", path });
  const entryPath = view.kind === "entry" ? view.path : undefined;

  return (
    <div className="demo-window">
      <div className="demo-window-body" data-pane={view.kind}>
        <aside className="demo-sidebar">
          <div className="demo-sidebar-top">
            <span className="demo-window-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="demo-sidebar-label">explorer</span>
          </div>
          <DemoExplorer
            sections={sections}
            edges={edges}
            fresh={fresh}
            home={home}
            revision={revision}
            selected={selected}
            onPick={(path, opens) => dispatch({ kind: "pick", path, opens })}
          />
        </aside>
        <div className="demo-window-bar">
          <div className="demo-window-tabs" role="tablist" aria-label="Demo panes">
            {(["agent", "terminal"] as const).map((kind) => {
              const pane = sessions[kind];
              return pane === undefined ? null : (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={view.kind === kind}
                  className={`demo-window-tab demo-window-tab-${kind}`}
                  onClick={() => dispatch({ kind: "show", view: { kind } })}
                >
                  <Icon name="terminal" /> {pane.label}
                </button>
              );
            })}
            <button
              type="button"
              role="tab"
              aria-selected={view.kind === "files"}
              className="demo-window-tab demo-window-tab-files"
              onClick={() => dispatch({ kind: "show", view: { kind: "files" } })}
            >
              <Icon name="open" /> files
              {fresh.size > 0 && view.kind !== "files" ? (
                <span className="demo-window-tab-badge" aria-label={`${fresh.size} new links`}>
                  {fresh.size}
                </span>
              ) : null}
            </button>
            {opened.map((path) => (
              <span
                key={path}
                className="demo-window-tab demo-window-tab-entry"
                data-active={entryPath === path}
                title={path}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={entryPath === path}
                  className="demo-window-tab-open"
                  onClick={() => dispatch({ kind: "show", view: { kind: "entry", path } })}
                >
                  <Icon
                    name={
                      volume !== undefined && describeEntry(volume, path).kind === "link"
                        ? "link"
                        : "file"
                    }
                  />
                  {nameOf(path)}
                </button>
                <button
                  type="button"
                  className="demo-window-tab-close"
                  aria-label={`Close ${nameOf(path)}`}
                  onClick={() => dispatch({ kind: "close", path })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="demo-window-controls">
            {run.kind === "walkthrough" ? (
              <span
                className="demo-step-count"
                aria-label={`Step ${Math.min(run.step + 1, run.total)} of ${run.total}`}
              >
                {`${Math.min(run.step + 1, run.total)}/${run.total}`}
              </span>
            ) : null}
            {controls}
          </div>
        </div>
        <div className="demo-pane-main">
          {(["agent", "terminal"] as const).map((kind) => (
            <div
              key={kind}
              className="demo-pane-terminal"
              hidden={entryPath !== undefined || focus.session !== kind}
            >
              {sessions[kind]?.content}
            </div>
          ))}
          {entryPath !== undefined && volume !== undefined ? (
            <DemoEntry details={describeEntry(volume, entryPath)} home={home} onOpen={open} />
          ) : null}
        </div>
      </div>
      <div className="demo-statusbar">
        <span className="demo-statusbar-mode" aria-live="polite">
          <span
            className={`demo-statusbar-light${run.kind === "live" ? " demo-statusbar-light-live" : ""}`}
            aria-hidden="true"
          />
          {caption}
        </span>
        <span>{prompt}</span>
        <span>{`${edges.length} ${edges.length === 1 ? "link" : "links"}`}</span>
        {fresh.size > 0 ? (
          <span className="demo-statusbar-fresh">{`${fresh.size} new`}</span>
        ) : null}
      </div>
    </div>
  );
}
