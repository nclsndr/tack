/** A session tab: the coding agent's, or the terminal's. */
type Session = "agent" | "terminal";

/**
 * What the demo window's main pane shows: a session, the explorer alone (narrow), or one entry.
 */
type View =
  | { readonly kind: Session }
  | { readonly kind: "files" }
  | { readonly kind: "entry"; readonly path: string };

/**
 * The demo window's focus, in one place so its parts cannot disagree: the pane in front, the
 * session tab a closed entry returns to, the tabs open, and the explorer's active row. When a file
 * or folder tab is in front, it is the active row.
 */
export type WorkspaceFocus = {
  readonly view: View;
  readonly session: Session;
  readonly opened: ReadonlyArray<string>;
  readonly selected: string | undefined;
};

/** What changes the focus. */
export type FocusEvent =
  /** A row clicked in the explorer; a file or link `opens` a tab, a folder does not. */
  | { readonly kind: "pick"; readonly path: string; readonly opens: boolean }
  /** An entry opened in its tab from anywhere: a link's target, a folder's listing. */
  | { readonly kind: "open"; readonly path: string }
  /** A tab brought to the front. */
  | { readonly kind: "show"; readonly view: View }
  /** A tab closed. */
  | { readonly kind: "close"; readonly path: string }
  /** A command ran, so the explorer reads the machine again. */
  | { readonly kind: "reading" };

/** The window as it first shows: the agent session in front, no tabs, nothing selected. */
export const initialFocus: WorkspaceFocus = {
  view: { kind: "agent" },
  session: "agent",
  opened: [],
  selected: undefined,
};

const opening = (focus: WorkspaceFocus, path: string): WorkspaceFocus => ({
  ...focus,
  view: { kind: "entry", path },
  opened: focus.opened.includes(path) === true ? focus.opened : [...focus.opened, path],
  selected: path,
});

/** The focus after `event`. */
export const focusAfter = (focus: WorkspaceFocus, event: FocusEvent): WorkspaceFocus => {
  switch (event.kind) {
    case "pick":
      return event.opens === true ? opening(focus, event.path) : { ...focus, selected: event.path };
    case "open":
      return opening(focus, event.path);
    case "show":
      return {
        ...focus,
        view: event.view,
        session:
          event.view.kind === "agent" || event.view.kind === "terminal"
            ? event.view.kind
            : focus.session,
        selected: event.view.kind === "entry" ? event.view.path : focus.selected,
      };
    case "close": {
      const opened = focus.opened.filter((path) => path !== event.path);
      if (focus.view.kind !== "entry" || focus.view.path !== event.path)
        return { ...focus, opened };
      return { ...focus, view: { kind: focus.session }, opened, selected: undefined };
    }
    case "reading":
      return {
        ...focus,
        selected: focus.view.kind === "entry" ? focus.view.path : undefined,
      };
    // Coverage skip: the compiler proves no other event reaches here.
    /* v8 ignore next 4 -- @preserve */
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};
