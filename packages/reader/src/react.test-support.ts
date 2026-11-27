import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vitest";

/** One test's React root and the container it renders into. */
export type TestRoot = {
  /** The element the root renders into, attached to the document for the length of the test. */
  readonly container: HTMLDivElement;
  /** Renders `node` inside act, so React has committed it and run its effects on return. */
  readonly render: (node: ReactNode) => Promise<void>;
  /** Unmounts inside act; safe to call twice, and a later `render` starts a new root. */
  readonly unmount: () => Promise<void>;
};

/**
 * Gives every test of the calling file a React root in a fresh container. Before each test it
 * declares the act environment and attaches the container. After each test it unmounts inside
 * act, removes the container, restores the globals the test stubbed, and fails the test when
 * React reported an update outside act.
 */
export function testRoot(): TestRoot {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  const unwrapped: string[] = [];
  const current = (): HTMLDivElement => {
    if (container === undefined) throw new Error("No test is running");
    return container;
  };
  const unmount = async (): Promise<void> => {
    const mounted = root;
    root = undefined;
    if (mounted !== undefined) await act(async () => mounted.unmount());
  };
  beforeEach(() => {
    unwrapped.length = 0;
    const original = console;
    // React only prints an update that ran outside act. Such an update lands on a later turn, so
    // the branches it reaches are covered on one run and missed on the next: fail the test instead.
    vi.stubGlobal("console", {
      ...console,
      error: (...values: unknown[]) => {
        if (typeof values[0] === "string" && values[0].includes("not wrapped in act(")) {
          unwrapped.push(values.map(String).join(" ").split("\n")[0] ?? "");
        }
        original.error(...values);
      },
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
  });
  afterEach(async () => {
    await unmount();
    container?.remove();
    container = undefined;
    vi.unstubAllGlobals();
    expect(unwrapped, "React updates outside act").toEqual([]);
  });
  return {
    get container() {
      return current();
    },
    render: async (node) => {
      root ??= createRoot(current());
      const mounted = root;
      await act(async () => mounted.render(node));
    },
    unmount,
  };
}

/** Waits for a synchronous React assertion, covering every elapsed wait with act. */
export async function waitForReact(
  assertion: () => void,
  options: { timeout?: number } = {},
): Promise<void> {
  const deadline = performance.now() + (options.timeout ?? 1_000);
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
    }
    // Exit act between attempts so React commits before the next DOM assertion.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}
