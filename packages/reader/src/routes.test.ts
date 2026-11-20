import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generatedCorpus } from "./generated-corpus.test-support.ts";
import { loadProjectCorpus } from "./project-corpus.ts";
import { readerRoutes } from "./routes.ts";
import type { ReaderCheckout, ReaderProjectCorpus, ReaderProjectInput } from "./types.ts";

let input: ReaderProjectInput;
let corpus: ReaderProjectCorpus;

beforeAll(async () => {
  input = await generatedCorpus(6);
  corpus = await loadProjectCorpus(input);
});

function session(
  current: () => ReaderProjectCorpus = () => corpus,
  checkout?: () => Promise<ReaderCheckout | null>,
) {
  const load = vi.fn(async () => current());
  return {
    load,
    routes: readerRoutes({
      token: "session",
      load,
      ...(checkout === undefined ? {} : { checkout }),
    }),
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(new URL(path, "http://127.0.0.1:4173"), init);
}

const action = (path: string, body: string, token = "session") =>
  request(path, { method: "POST", headers: { "X-Tack-Token": token }, body });

describe("reader status route", () => {
  it("answers with the published revision and a validator, without rebuilding the corpus", async () => {
    const { load, routes } = session();
    const revision = routes.publish(corpus, "generation-one");
    const response = await routes.handle(request("/__tack/status"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ revision, error: "", checkout: null });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(256);
    expect(response.headers.get("etag")).toMatch(/^".+"$/);
    expect(load).not.toHaveBeenCalled();
  });

  it("answers an unchanged check with an empty 304", async () => {
    const { routes } = session();
    routes.publish(corpus, "generation-one");
    const first = await routes.handle(request("/__tack/status"));
    const validator = first.headers.get("etag") ?? "";
    const second = await routes.handle(
      request("/__tack/status", { headers: { "If-None-Match": validator } }),
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(validator);
  });

  it("changes revision and validator when a rebuilt generation is published", async () => {
    const { routes } = session();
    routes.publish(corpus, "generation-one");
    const before = await routes.handle(request("/__tack/status"));
    const next = routes.publish(corpus, "generation-two");
    const after = await routes.handle(
      request("/__tack/status", { headers: { "If-None-Match": before.headers.get("etag") ?? "" } }),
    );

    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ revision: next, error: "", checkout: null });
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
  });

  it("leaves the issues of a published generation to its boot payload", async () => {
    const broken = await generatedCorpus(2);
    await writeFile(join(broken.project.root, "docs", "bad.mdx"), "# Bad\n\n<Broken\n");
    const unhealthy = await loadProjectCorpus({
      ...broken,
      resources: [
        ...broken.resources,
        { ...broken.resources[0]!, name: "gone", directoryPath: join(broken.project.root, "gone") },
      ],
    });
    const { routes } = session(() => unhealthy);
    routes.publish(unhealthy, "generation-one");
    const status: unknown = await (await routes.handle(request("/__tack/status"))).json();

    expect(unhealthy.issues.length).toBe(2);
    expect(status).toMatchObject({ error: "" });
  });

  it("re-reads the checkout on every check, so a branch switch reaches an idle reader", async () => {
    let checkout: ReaderCheckout | null = { kind: "branch", name: "main" };
    const { routes } = session(undefined, async () => checkout);
    const revision = routes.publish(corpus, "generation-one");
    const before = await routes.handle(request("/__tack/status"));
    const validator = before.headers.get("etag") ?? "";
    checkout = { kind: "branch", name: "feat/billing-export" };
    const after = await routes.handle(
      request("/__tack/status", { headers: { "If-None-Match": validator } }),
    );
    checkout = null;
    const outside = await routes.handle(request("/__tack/status"));

    expect(await before.json()).toEqual({
      revision,
      error: "",
      checkout: { kind: "branch", name: "main" },
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      checkout: { kind: "branch", name: "feat/billing-export" },
    });
    expect(after.headers.get("etag")).not.toBe(validator);
    expect(await outside.json()).toMatchObject({ checkout: null });
  });

  it("reports a failed rebuild on the generation still being served", async () => {
    const { routes } = session();
    const revision = routes.publish(corpus, "generation-one");
    const before = await routes.handle(request("/__tack/status"));
    routes.fail("Compilation failed: bad.mdx");
    const after = await routes.handle(
      request("/__tack/status", { headers: { "If-None-Match": before.headers.get("etag") ?? "" } }),
    );

    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      revision,
      error: "Compilation failed: bad.mdx",
      checkout: null,
    });
  });

  it("is not available before a generation is published", async () => {
    const { routes } = session();
    const response = await routes.handle(request("/__tack/status"));

    expect(response.status).toBe(503);
  });
});

describe("reader action routes", () => {
  it("reports a corpus failure that is not an Error as a conflict", async () => {
    const { routes } = session(() => {
      // oxlint-disable-next-line no-throw-literal -- Saved-source modules can throw any value.
      throw "Saved source unreadable";
    });
    const response = await routes.handle(request("/__tack/corpus"));

    expect([response.status, await response.json()]).toEqual([
      409,
      { error: "Saved source unreadable" },
    ]);
  });

  it("serves the full corpus diagnostic with the session token", async () => {
    const { routes } = session();
    const revision = routes.publish(corpus, "generation-one");
    const body: unknown = await (await routes.handle(request("/__tack/corpus"))).json();

    expect(body).toMatchObject({ revision, token: "session", complete: true, error: "" });
  });

  it("joins every resource and document issue into the corpus diagnostic, one per line", async () => {
    const resource = { sourceRegistrationId: "generated", name: "notes" };
    const issues = [
      { resource, sourcePath: "/source", code: "resource-load", message: "First problem." },
      { resource, sourcePath: "/source", code: "document-load", message: "Second problem." },
    ];
    const { routes } = session(() => ({ ...corpus, issues, complete: false }));
    const body: unknown = await (await routes.handle(request("/__tack/corpus"))).json();

    expect(body).toMatchObject({ complete: false, error: "First problem.\nSecond problem." });
  });

  it("copies and opens declared blocks for a request carrying the session token", async () => {
    const { routes } = session();
    const revision = routes.publish(corpus, "generation-one");
    const document = corpus.documents[0]!;
    const block = document.blocks[0]!;
    const copied = await routes.handle(
      action(
        "/__tack/copy",
        JSON.stringify({ blocks: [{ id: block.id, version: block.version }] }),
      ),
    );
    const opened = await routes.handle(
      action("/__tack/editor", JSON.stringify({ path: document.path, line: 2 })),
    );

    expect(await copied.json()).toMatchObject({ revision });
    expect(await opened.json()).toEqual({
      url: expect.stringMatching(/^vscode:\/\/file\/.+:2$/),
    });
  });

  it("refuses missing tokens, unknown actions, invalid input and oversized bodies", async () => {
    const { routes } = session();
    routes.publish(corpus, "generation-one");
    const statuses = await Promise.all(
      [
        request("/__tack/copy", { method: "POST", body: "{}" }),
        action("/__tack/copy", "{}", "stale"),
        request("/__tack/copy", { headers: { "X-Tack-Token": "session" } }),
        action("/__tack/unknown", "{}"),
        action("/__tack/editor", JSON.stringify({ path: "/not/declared.md" })),
        action("/__tack/copy", "x".repeat(1_000_001)),
      ].map(async (sent) => {
        const response = await routes.handle(sent);
        const body: unknown = await response.json();
        return [response.status, body];
      }),
    );

    expect(statuses).toEqual([
      [403, { error: "A reader session token is required." }],
      [403, { error: "A reader session token is required." }],
      [403, { error: "A reader session token is required." }],
      [404, { error: "Unknown reader action." }],
      [409, { error: "Editor target must be a declared document." }],
      [409, { error: "Copy request is too large." }],
    ]);
  });
});
