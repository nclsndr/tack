// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generatedCorpus } from "./generated-corpus.test-support.ts";
import { loadProjectCorpus } from "./project-corpus.ts";
import { readerRoutes } from "./routes.ts";
import { ReaderLayout } from "./runtime.tsx";
import type { ReaderBoot } from "./runtime.tsx";
import type { ReaderProjectCorpus } from "./types.ts";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@rspress/core/runtime", () => ({
  Content: () => null,
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => () => undefined,
  useNavigationType: () => "POP",
  NavigationType: { Pop: "POP", Push: "PUSH", Replace: "REPLACE" },
  pathnameToRouteService: () => undefined,
}));

/** One status check as the server answered it. */
type Check = { path: string; status: number; bytes: number; validator: string | null };

/** Idle checks one reader tab makes in thirty seconds at the current one-second freshness. */
const idleChecks = 30;
/** Bytes an unchanged idle check may transfer: a status line, never document data. */
const statusBudget = 256;

let corpus: ReaderProjectCorpus;
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  corpus = await loadProjectCorpus(await generatedCorpus());
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  route.pathname = corpus.documents[0]?.route ?? "/";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Starts the real reader API on the generated corpus, publishes it the way the engine does once a
 * generation is compiled, and routes the reader's `fetch` calls to it in process.
 */
function readerSession(delay = 0, failures = new Set<number>()) {
  const load = vi.fn(async () => corpus);
  const routes = readerRoutes({ token: "session", load });
  const revision = routes.publish(corpus, "generation-one");
  const checks: Check[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const inFlight = { now: 0, most: 0 };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    if (failures.has(signals.length) === true) throw new TypeError("Failed to fetch");
    inFlight.now += 1;
    inFlight.most = Math.max(inFlight.most, inFlight.now);
    try {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const request = new Request(new URL(input, "http://127.0.0.1:4173"), init);
      const response = await routes.handle(request);
      const body = await response.arrayBuffer();
      checks.push({
        path: new URL(request.url).pathname,
        status: response.status,
        bytes: body.byteLength,
        validator: request.headers.get("if-none-match"),
      });
      return new Response(response.status === 304 ? null : body, {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      inFlight.now -= 1;
    }
  });
  const boot: ReaderBoot = {
    worktree: corpus.documents[0]?.path ?? "/",
    project: { name: "Generated notes" },
    resources: [],
    checkout: null,
    documents: corpus.documents,
    revision,
    token: "session",
    metadata: { types: [], statuses: [], tags: [] },
    presets: { navigation: "folders", layouts: "reader", components: "standard" },
    archive: [],
  };
  return { boot, load, checks, signals, inFlight };
}

async function idle(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("idle reader status checks", () => {
  it("transfer only a small status body, revalidate, and rebuild no corpus after readiness", async () => {
    const session = readerSession();
    await act(async () =>
      root.render(createElement(ReaderLayout, { boot: session.boot, customization: {} })),
    );
    await idle(idleChecks * 1000);

    // Freshness stays at about one check per second.
    expect(session.checks.length).toBeGreaterThanOrEqual(idleChecks - 1);
    // Budget: no corpus rebuild across thirty idle checks once the generation is ready.
    expect(session.load).toHaveBeenCalledTimes(0);
    // Budget: every check transfers a status line at most, never the document corpus.
    expect(
      session.checks.map((check) => check.bytes).filter((bytes) => bytes > statusBudget),
    ).toEqual([]);
    // After the first answer every check carries the validator it received, so unchanged state
    // costs an empty 304.
    expect(session.checks.slice(1).every((check) => check.validator !== null)).toBe(true);
    expect(session.checks.slice(1).every((check) => check.status === 304)).toBe(true);
    expect(container.querySelector(".tack-live")?.textContent).toBe("Live");
  });

  it("restores the live state when an unchanged check follows a failed one", async () => {
    const session = readerSession(0, new Set([2]));
    await act(async () =>
      root.render(createElement(ReaderLayout, { boot: session.boot, customization: {} })),
    );
    await idle(2000);
    expect(container.querySelector(".tack-live")?.textContent).toBe("Reconnecting");
    await idle(1000);

    expect(session.checks.at(-1)?.status).toBe(304);
    expect(container.querySelector(".tack-live")?.textContent).toBe("Live");
  });

  it("never stacks a slow check on top of the one still in flight", async () => {
    const session = readerSession(2500);
    await act(async () =>
      root.render(createElement(ReaderLayout, { boot: session.boot, customization: {} })),
    );
    await idle(10_000);

    expect(session.checks.length).toBeGreaterThanOrEqual(2);
    expect(session.inFlight.most).toBe(1);
  });

  it("cancels the outstanding check when the reader goes away", async () => {
    const session = readerSession(60_000);
    await act(async () =>
      root.render(createElement(ReaderLayout, { boot: session.boot, customization: {} })),
    );
    await idle(1000);
    await act(async () => root.unmount());

    expect(session.signals.length).toBe(1);
    expect(session.signals[0]?.aborted).toBe(true);
  });
});
