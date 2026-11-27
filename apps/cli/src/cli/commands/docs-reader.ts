import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  defaultSearchLimit,
  maximumSearchLimit,
  maximumSearchQueryLength,
} from "@tackup/reader/search-core";
import { docsRoot, docsSelection } from "./docs-root.ts";
import { booleanFlag, optionalFlag, optionalIntegerFlag } from "./flag-utils.ts";
import { handle, invalid, receive } from "./invocation-receiver.ts";

const portFlag = optionalIntegerFlag(
  "port",
  { minimum: 0, maximum: 65535 },
  "Serve the reader on this port; 0 selects an available port",
);

const metadataFlag = (name: string) =>
  optionalFlag(
    Flag.String(name).pipe(Flag.withSchema(Schema.Trim.check(Schema.isMinLength(1)))),
    `Match documents whose ${name} metadata equals this value`,
  );

/** Searches one registered project's attached documents without a server or a mount. */
export const docsSearchCommand = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(
      Argument.withSchema(Schema.Trim.check(Schema.isMaxLength(maximumSearchQueryLength))),
      Argument.withDescription(
        `Search terms, matched case-insensitively together; at most ${maximumSearchQueryLength} characters`,
      ),
    ),
    type: metadataFlag("type"),
    status: metadataFlag("status"),
    tag: metadataFlag("tag"),
    limit: optionalIntegerFlag(
      "limit",
      { minimum: 1, maximum: maximumSearchLimit },
      `Return at most this many hits; defaults to ${defaultSearchLimit}, at most ${maximumSearchLimit}`,
    ).pipe(Flag.map((limit) => limit ?? defaultSearchLimit)),
  },
  handle(
    "docs-search",
    Effect.fnUntraced(function* ({ query, type, status, tag, limit }) {
      const { projectName, cwd } = yield* docsRoot;
      if (query.length === 0)
        return yield* invalid(
          "missing-argument",
          "Give at least one search term: the docs search query is empty.",
        );
      return {
        _tag: "docs-search",
        query,
        limit,
        ...docsSelection(projectName, cwd),
        ...(type === undefined ? {} : { type }),
        ...(status === undefined ? {} : { status }),
        ...(tag === undefined ? {} : { tag }),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Search the project's attached documents with physical source citations, without starting a server or needing a mount",
  ),
  Command.withExamples([
    { command: "tack docs search ownership --project demo --limit 5" },
    { command: "tack docs search selection --cwd /path/to/worktree --type spec --tag skills" },
  ]),
);

/** Looks up the Lucide icons docs may use, without a project or registered state. */
export const docsIconsCommand = Command.make(
  "icons",
  {
    word: Argument.String("word").pipe(
      Argument.withSchema(Schema.Trim.check(Schema.isMinLength(1))),
      Argument.withDescription(
        "A word to find in icon names, categories and old Lucide names; omit it to list every icon",
      ),
      Argument.optional,
    ),
  },
  Effect.fnUntraced(function* ({ word }) {
    yield* receive({
      _tag: "docs-icons",
      ...(Option.isSome(word) ? { word: word.value } : {}),
    });
  }),
).pipe(
  Command.withDescription(
    "List the Lucide icons a document may draw with <Icon name>, by category, with the Lucide version they come from. Use it to pick a name instead of recalling one",
  ),
  Command.withExamples([{ command: "tack docs icons database" }, { command: "tack docs icons" }]),
);

/** Serves one registered project's attached documents in the foreground. */
export const docsServeCommand = Command.make(
  "serve",
  {
    open: booleanFlag(
      "open",
      "Open the local reader in a browser, even outside an interactive terminal",
    ),
    noOpen: booleanFlag("no-open", "Do not open the local reader in a browser"),
    port: portFlag,
  },
  handle(
    "docs-serve",
    Effect.fnUntraced(function* ({ open, noOpen, port }) {
      const { projectName, cwd } = yield* docsRoot;
      if (open === true && noOpen === true)
        return yield* invalid("invalid-flag", "--open and --no-open cannot be used together.");
      return {
        _tag: "docs-serve",
        ...docsSelection(projectName, cwd),
        // Without either flag the host opens a browser only at an interactive terminal.
        ...(open === true ? { open: true } : noOpen === true ? { open: false } : {}),
        ...(port === undefined ? {} : { port }),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Serve the attached documents of --project, or of the project containing --cwd, in the foreground until interrupted; the result reports the reader URL. A browser opens by default only in an interactive terminal; --open and --no-open override that",
  ),
  Command.withExamples([
    { command: "tack docs serve --project demo" },
    { command: "tack docs serve --cwd /path/to/worktree --no-open --port 0" },
    { command: "tack docs serve --project demo --open" },
  ]),
);
