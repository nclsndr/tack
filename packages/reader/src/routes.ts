import { createHash } from "node:crypto";
import { z } from "zod";
import { copyFromCorpus, corpusRevision, editorUrl } from "./api.ts";
import type { ReaderCheckout, ReaderProjectCorpus } from "./types.ts";

/** The largest reader action body the server reads before refusing the request. */
const requestLimit = 1_000_000;
const editorTarget = z.object({ path: z.string(), line: z.number().optional() });

/** The reader's `/__tack/` API, kept apart from the dev server so it can be driven in process. */
export type ReaderRoutes = {
  /**
   * Makes a compiled reader generation the one `/__tack/status` reports. Call it only once that
   * generation's output is ready, so a browser never reloads into an older build.
   * @returns The revision the browser boots with for that generation.
   */
  publish: (corpus: ReaderProjectCorpus, generation: string) => string;
  /**
   * Reports a failed rebuild on the status of the generation still being served. The issues of a
   * published generation are not status errors: they reach the browser in its boot payload.
   */
  fail: (message: string) => void;
  /** Answers one `/__tack/` request. */
  handle: (request: Request) => Promise<Response>;
};

/** The revision a browser boots with, and the one status checks compare it against. */
export function readerRevision(corpus: ReaderProjectCorpus, generation: string): string {
  return `${corpusRevision(corpus.documents, corpus.issues)}:${generation}`;
}

/** The small answer to every idle status check, with its HTTP validator. */
type Status = { body: string; validator: string };

function statusOf(revision: string, error: string, checkout: ReaderCheckout | null): Status {
  const body = JSON.stringify({ revision, error, checkout });
  return { body, validator: `"${createHash("sha256").update(body).digest("base64url")}"` };
}

/** Joins the corpus's resource and document issues into the notice the reader shows. */
const issueMessage = (corpus: ReaderProjectCorpus) =>
  corpus.issues.map((issue) => issue.message).join("\n");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}

/** Reads a request body while refusing anything larger than the reader action limit. */
async function readBody(request: Request): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early cancels the stream, so an oversized body is never read to its end.
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > requestLimit) throw new Error("Copy request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Serves the reader API for one session.
 * @param options.token - The session token that reader actions must carry.
 * @param options.load - Rebuilds the project corpus from saved files.
 * @param options.checkout - Reads what the project root has checked out. Every status check calls
 * it, so a branch switch reaches the reader without a rebuild; it defaults to no checkout.
 */
export function readerRoutes(options: {
  token: string;
  load: () => Promise<ReaderProjectCorpus>;
  checkout?: () => Promise<ReaderCheckout | null>;
}): ReaderRoutes {
  const checkout = options.checkout ?? (async () => null);
  let generation = "";
  /** The served generation's state, or `undefined` before the first generation is published. */
  let current: { revision: string; error: string } | undefined;
  const revisionOf = (corpus: ReaderProjectCorpus) => readerRevision(corpus, generation);
  const route = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/__tack/status") {
      if (current === undefined) return json({ error: "The reader is still compiling." }, 503);
      const status = statusOf(current.revision, current.error, await checkout());
      const headers = {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
        ETag: status.validator,
      };
      return request.headers.get("if-none-match") === status.validator
        ? new Response(null, { status: 304, headers })
        : new Response(status.body, { headers });
    }
    if (pathname === "/__tack/corpus") {
      const corpus = await options.load();
      return json({
        documents: corpus.documents,
        issues: corpus.issues,
        complete: corpus.complete,
        revision: revisionOf(corpus),
        token: options.token,
        error: issueMessage(corpus),
      });
    }
    if (request.method !== "POST" || request.headers.get("x-tack-token") !== options.token)
      return json({ error: "A reader session token is required." }, 403);
    const input = await readBody(request);
    const corpus = await options.load();
    if (pathname === "/__tack/copy")
      return json({
        text: await copyFromCorpus(corpus.documents, input),
        revision: revisionOf(corpus),
      });
    if (pathname === "/__tack/editor") {
      const target = editorTarget.parse(input);
      return json({ url: editorUrl(corpus.documents, target.path, target.line) });
    }
    return json({ error: "Unknown reader action." }, 404);
  };
  return {
    publish(corpus, next) {
      generation = next;
      current = { revision: revisionOf(corpus), error: "" };
      return current.revision;
    },
    fail(message) {
      current = { revision: current?.revision ?? "", error: message };
    },
    async handle(request) {
      try {
        return await route(request);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    },
  };
}
