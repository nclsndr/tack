/**
 * The layout engine that places the boxes of `System` and `Schema` figures. It computes positions
 * only; the kit draws every link. It is loaded on demand: nothing imports `elkjs` statically, so a
 * page without such a figure never downloads it, and the bundler keeps it in its own chunk.
 */
import type { ElkNode } from "elkjs/lib/elk-api";

export type { ElkNode } from "elkjs/lib/elk-api";

/** Lays out one graph: the engine fills in the position and size of every node. */
export type LayoutEngine = { readonly layout: (graph: ElkNode) => Promise<ElkNode> };

let loading: Promise<LayoutEngine> | undefined;

/** Whether this page has asked for the engine. A page without `System` or `Schema` never does. */
export function layoutEngineRequested(): boolean {
  return loading !== undefined;
}

/** The engine, loaded the first time a figure asks for it and shared afterwards. */
export function loadLayoutEngine(): Promise<LayoutEngine> {
  loading ??= import("elkjs/lib/elk.bundled.js").then(({ default: Elk }) => {
    const host = globalThis as { onmessage?: unknown };
    const before = host.onmessage;
    const elk = new Elk();
    // Bun defines `self` without `document`, so the engine's in-process worker takes the process
    // for a web worker and installs `onmessage`, which would keep `tack check` from exiting.
    if (host.onmessage !== before) host.onmessage = before ?? null;
    return { layout: (graph) => elk.layout(graph) };
  });
  return loading;
}
