import { Effect, Stdio, Stream } from "effect";
import { resolveProjectDocs } from "../../../features/docs/docs.ts";
import { searchReader } from "../../../features/reader/search.ts";
import { Reader } from "../../../services/reader.ts";
import { resolveStateDirectory } from "../../../services/state-store.ts";
import { holdReaderCache } from "../../../features/reader/reader-cache.ts";
import { interactiveAllowed, TerminalContext } from "../human/terminal-context.ts";
import { lookUpDocsIcons } from "../../../features/reader/icon-lookup.ts";
import { ReaderSessionPayloadSchema } from "../../../features/reader/session.ts";
import { docsIconsOutcome, docsSearchOutcome, resultAs } from "../outcomes.ts";
import { type ForegroundSession, PublicExit, type RoutesFor } from "./route.ts";

/** Reports why a started reader stopped on stderr, then ends the process as a domain failure. */
const stopped = Effect.fnUntraced(function* (message: string) {
  const stdio = yield* Stdio.Stdio;
  yield* Stream.succeed(`${message}\n`).pipe(Stream.run(stdio.stderr()));
  return yield* new PublicExit({ exitCode: 1 });
});

/** The local docs reader, one-shot docs search, the docs icon lookup. */
export const docsReaderRoutes: RoutesFor<"docs-icons" | "docs-search" | "docs-serve"> = {
  "docs-icons": {
    needsHome: false,
    stateless: true,
    run: (invocation) => Effect.sync(() => docsIconsOutcome(lookUpDocsIcons(invocation.word))),
  },
  "docs-serve": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      Effect.gen(function* () {
        const input = yield* resolveProjectDocs(stateOptions, invocation);
        // Held before the reader starts, so it is released only once the reader has stopped.
        const cacheDirectory = yield* holdReaderCache(
          yield* resolveStateDirectory(stateOptions),
          input.project,
        );
        const reader = yield* Reader;
        const terminal = yield* TerminalContext;
        const session = yield* Effect.acquireRelease(
          reader.start({
            input,
            ...(cacheDirectory === undefined ? {} : { cacheDirectory }),
            open: invocation.open ?? interactiveAllowed(terminal),
            ...(invocation.port === undefined ? {} : { port: invocation.port }),
          }),
          (started) => started.close,
          { interruptible: true },
        );
        return {
          outcome: resultAs(ReaderSessionPayloadSchema)({
            url: session.url,
            project: input.project,
          }),
          // Startup success reports readiness; a later engine failure uses stderr and the exit.
          serve: (session.closed ?? Effect.never).pipe(
            Effect.matchEffect({
              onFailure: (error) => stopped(error.message),
              onSuccess: () => stopped("The reader engine stopped unexpectedly."),
            }),
          ),
        } satisfies ForegroundSession;
      }),
  },
  "docs-search": {
    needsHome: false,
    run: (invocation, stateOptions) =>
      searchReader(stateOptions, invocation).pipe(Effect.map(docsSearchOutcome)),
  },
};
