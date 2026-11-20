import { useCallback, useSyncExternalStore } from "react";
import { markdownPass } from "./markdown-pass.ts";

export type VisualState = Readonly<Record<string, string>>;
export type VisualStatePatch = Readonly<Record<string, string | null>>;

const stateEvent = "tack:reader-state";

function statePrefix(id: string): string {
  return `reader.${encodeURIComponent(id).replaceAll(".", "%2E")}.`;
}

/** Reads one visual's URL parameters without confusing neighboring visual identifiers. */
export function readVisualState(search: string, id: string): VisualState {
  const prefix = statePrefix(id);
  return Object.fromEntries(
    [...new URLSearchParams(search)].flatMap(([key, value]) =>
      key.startsWith(prefix) === true ? [[key.slice(prefix.length), value]] : [],
    ),
  );
}

/** Produces a local URL while retaining unrelated query parameters and the page anchor. */
export function updateVisualState(href: string, id: string, patch: VisualStatePatch): string {
  const url = new URL(href);
  const prefix = statePrefix(id);
  Object.entries(patch).forEach(([key, value]) => {
    if (value === null) url.searchParams.delete(`${prefix}${key}`);
    else url.searchParams.set(`${prefix}${key}`, value);
  });
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Validates untrusted numeric URL input and constrains it to the visual's useful range. */
export function numericState(
  value: string | undefined,
  options: {
    readonly fallback: number;
    readonly min: number;
    readonly max: number;
    readonly integer?: boolean;
  },
): number {
  if (value === undefined || value.trim() === "") return options.fallback;
  const parsed = Number(value);
  if (Number.isFinite(parsed) === false) return options.fallback;
  const number = options.integer === true ? Math.floor(parsed) : parsed;
  return Math.min(options.max, Math.max(options.min, number));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener(stateEvent, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(stateEvent, callback);
  };
}

function browserSearch(): string {
  return window.location.search;
}

function serverSearch(): string {
  return "";
}

/** The Markdown pass has no `window` and no URL that could change. */
function subscribeNothing(): () => void {
  return () => undefined;
}

/**
 * Shares reproducible interaction state through URL history, including browser back and forward.
 * The Markdown pass renders with a client reconciler but has no `window`, so it reads the server
 * snapshot: every visual in its initial state.
 */
export function useVisualState(
  id: string,
): readonly [VisualState, (patch: VisualStatePatch) => void] {
  const markdown = markdownPass();
  const search = useSyncExternalStore(
    markdown === true ? subscribeNothing : subscribe,
    markdown === true ? serverSearch : browserSearch,
    serverSearch,
  );
  const update = useCallback(
    (patch: VisualStatePatch) => {
      const url = updateVisualState(window.location.href, id, patch);
      window.history.pushState(window.history.state, "", url);
      window.dispatchEvent(new Event(stateEvent));
    },
    [id],
  );
  return [readVisualState(search, id), update];
}
