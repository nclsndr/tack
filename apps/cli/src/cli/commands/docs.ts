import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { docsRoot, docsSelection } from "./docs-root.ts";
import { docsIconsCommand, docsSearchCommand, docsServeCommand } from "./docs-reader.ts";
import { listAlias } from "./list-alias.ts";
import { booleanFlag, optionalStringFlag } from "./flag-utils.ts";
import { handle, invalid, receive } from "./invocation-receiver.ts";
import { immediate, readOnly } from "./operation-contract.ts";

const requested = (reference: string) => ({ reference });
const named = (operation: "attach" | "detach") =>
  Command.make(
    operation,
    {
      name: Argument.String("reference"),
    },
    Effect.fnUntraced(function* ({ name }) {
      const { projectName, cwd } = yield* docsRoot;
      yield* receive({
        _tag: operation === "attach" ? "docs-attach" : "docs-detach",
        ...docsSelection(projectName, cwd),
        resource: requested(name),
      });
    }),
  );
const listDocs = ({
  projectName,
  cwd,
}: {
  readonly projectName: string | undefined;
  readonly cwd: string | undefined;
}) => receive({ _tag: "docs-list", ...docsSelection(projectName, cwd) });
const configure = Command.make(
  "configure",
  {
    destination: optionalStringFlag("destination", "Set the relative docs mount directory"),
    defaultName: optionalStringFlag("default", "Set the default writing resource name"),
    clearDefault: booleanFlag("clear-default", "Clear the default writing resource"),
  },
  handle(
    "docs-configure",
    Effect.fnUntraced(function* ({ destination, defaultName, clearDefault }) {
      const { projectName, cwd } = yield* docsRoot;
      if (clearDefault === true && defaultName !== undefined)
        return yield* invalid(
          "invalid-flag",
          "--clear-default and --default cannot be used together.",
        );
      return {
        _tag: "docs-configure",
        ...docsSelection(projectName, cwd),
        clearDefault,
        ...(destination === undefined ? {} : { destination }),
        ...(defaultName === undefined ? {} : { defaultWritingResource: requested(defaultName) }),
      };
    }),
  ),
);
const target = Command.make(
  "target",
  {
    name: optionalStringFlag("name", "Select an attached docs resource by name"),
  },
  handle(
    "docs-target",
    Effect.fnUntraced(function* ({ name }) {
      const { projectName, cwd } = yield* docsRoot;
      return {
        _tag: "docs-target",
        ...docsSelection(projectName, cwd),
        ...(name === undefined ? {} : { resource: requested(name) }),
      };
    }),
  ),
);
const sourceId = "00000000-0000-4000-8000-000000000001";
const projectRule =
  "The project is --project, or the registered project containing --cwd or the current directory.";

/** Commands for local docs intent, managed directory links, and verified writing targets. */
export const docsCommand = docsRoot.pipe(
  Command.withHandler(listDocs),
  Command.withSubcommands([
    named("attach").pipe(
      Command.withDescription(
        `Attach a source-owned docs resource to a project; run sync to mount it. ${projectRule}`,
      ),
      Command.withExamples([
        { command: "tack docs attach handbook" },
        { command: `tack docs attach ${sourceId}:handbook --project demo` },
      ]),
      immediate,
    ),
    named("detach").pipe(
      Command.withDescription(
        `Detach a docs resource from a project, clearing it as the writing default; run sync to unmount it. ${projectRule}`,
      ),
      Command.withExamples([
        { command: "tack docs detach handbook --project demo" },
        { command: `tack docs detach ${sourceId}:handbook --project demo` },
      ]),
      immediate,
    ),
    listAlias(docsRoot.pipe(Effect.flatMap(listDocs))),
    docsSearchCommand,
    docsIconsCommand,
    docsServeCommand,
    configure.pipe(
      Command.withDescription(
        `Set a project's docs mount directory or default writing resource. ${projectRule}`,
      ),
      Command.withExamples([
        { command: "tack docs configure --project demo --destination knowledge" },
        { command: "tack docs configure --default handbook" },
        { command: `tack docs configure --project demo --default ${sourceId}:handbook` },
        { command: "tack docs configure --project demo --clear-default" },
      ]),
      immediate,
    ),
    target.pipe(
      Command.withDescription(
        `Resolve the verified writing target of the default or a named attached docs resource. ${projectRule}`,
      ),
      Command.withExamples([
        { command: "tack docs target --project demo" },
        { command: "tack docs target --name handbook" },
        { command: `tack docs target --project demo --name ${sourceId}:handbook` },
      ]),
      readOnly,
    ),
  ]),
  Command.withDescription(
    `Attach source-owned docs, mount them, search and serve them, and resolve writing targets; bare \`docs\` lists a project's attachments. ${projectRule}`,
  ),
  Command.withExamples([
    { command: "tack docs --project demo" },
    { command: "tack docs --cwd /path/to/worktree" },
  ]),
  readOnly,
);
