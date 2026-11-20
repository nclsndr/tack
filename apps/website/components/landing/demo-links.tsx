import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { nextLinkField, type LinkField } from "../../demo/link-field.ts";
import type { LinkEdge } from "../../demo/machine-view.ts";

/**
 * The demo machine's links as the hero draws them, and how many commands have made links so far.
 * Each one replays the travel of the links it made.
 */
type LinkState = { readonly field: LinkField; readonly changes: number };

const LinksContext = createContext<{
  readonly state: LinkState | undefined;
  readonly publish: (state: LinkState) => void;
}>({ state: undefined, publish: () => undefined });

/** Shares the demo window's links with the drawings on the hero's sheet. */
export function DemoLinksProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<LinkState>();
  const value = useMemo(() => ({ state, publish: setState }), [state]);
  return <LinksContext.Provider value={value}>{children}</LinksContext.Provider>;
}

/** The demo machine's links, once the machine has loaded. */
export function useDemoLinks() {
  return useContext(LinksContext).state;
}

/**
 * Hands the links the window read to the hero once the machine has loaded (`ready`) and after each
 * command (`revision`), so both always draw the same reading. `fresh` is a new set exactly when a
 * command made links.
 */
export function usePublishLinks(
  edges: ReadonlyArray<LinkEdge>,
  fresh: ReadonlySet<string>,
  home: string,
  revision: number,
  ready: boolean,
) {
  const { publish } = useContext(LinksContext);
  const previous = useRef<{ readonly state: LinkState; readonly fresh: ReadonlySet<string> }>(
    undefined,
  );
  useEffect(() => {
    if (ready === false) return;
    const before = previous.current;
    const made = fresh.size > 0 && fresh !== before?.fresh;
    const state = {
      field: nextLinkField(before?.state.field, edges, fresh, home),
      changes: (before?.state.changes ?? 0) + (made ? 1 : 0),
    };
    previous.current = { state, fresh };
    publish(state);
    // A new reading comes with each command, and once the machine loads.
  }, [revision, ready, publish]);
}
