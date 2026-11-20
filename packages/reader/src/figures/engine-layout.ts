/**
 * The React side of the layout engine: lays a figure out once its model is known, at column width
 * and at the Expand overlay's width, and keeps the result for the page so a re-render never lays
 * out twice. `System` and `Schema` share it.
 */
import { useEffect, useMemo, useState } from "react";
import { columnWidth, expandedWidth } from "./architecture-map-layout.ts";
import { type LayoutEngine, loadLayoutEngine } from "./layout-engine.ts";

/** A figure's layouts, or why the engine could not produce them. */
export type EngineLaid<T> = { readonly key: string } & (
  | { readonly layouts: { readonly column: T; readonly expanded: T } }
  | { readonly failure: string }
);

/** Layouts already computed on this page, by figure kind and model. */
const laidOut = new Map<string, Promise<EngineLaid<unknown>>>();
const settled = new Map<string, EngineLaid<unknown>>();

function layOut<T>(
  key: string,
  lay: (engine: LayoutEngine, room: number) => Promise<T>,
): Promise<EngineLaid<T>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Each key is only ever stored with the layout type of its own figure kind, which prefixes it.
  const known = laidOut.get(key) as Promise<EngineLaid<T>> | undefined;
  if (known !== undefined) return known;
  const pending = loadLayoutEngine()
    .then(async (engine) => ({
      column: await lay(engine, columnWidth),
      expanded: await lay(engine, expandedWidth),
    }))
    .then(
      (layouts): EngineLaid<T> => ({ key, layouts }),
      (error: unknown): EngineLaid<T> => ({
        key,
        failure: error instanceof Error ? error.message : String(error),
      }),
    )
    .then((laid) => {
      settled.set(key, laid);
      return laid;
    });
  laidOut.set(key, pending);
  return pending;
}

/**
 * The layouts of a figure of `kind` whose model is `model`, once the engine has placed its parts.
 * `undefined` until then.
 */
export function useEngineLayout<M, T>(
  kind: string,
  model: M,
  lay: (model: M, engine: LayoutEngine, room: number) => Promise<T>,
): EngineLaid<T> | undefined {
  const key = useMemo(() => `${kind}:${JSON.stringify(model)}`, [kind, model]);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Each key is only ever stored with the layout type of its own figure kind, which prefixes it.
  const stored = (): EngineLaid<T> | undefined => settled.get(key) as EngineLaid<T> | undefined;
  const [laid, setLaid] = useState<EngineLaid<T> | undefined>(stored);
  useEffect(() => {
    let live = true;
    void layOut(key, (engine, room) => lay(model, engine, room)).then((result) => {
      if (live === true) setLaid(result);
    });
    return () => {
      live = false;
    };
  }, [key, model, lay]);
  return laid?.key === key ? laid : stored();
}
