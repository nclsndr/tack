import { Effect, Option } from "effect";
import { booleanFlag, optionalFlag, optionalStringFlag } from "./flag-utils.ts";
import { handle } from "./invocation-receiver.ts";
import { applyFlag, operationContract } from "./operation-contract.ts";
import { namespaceFrom, projectFlag, userFlag } from "./target-selector.ts";
import { Argument, Command, Flag } from "effect/cli";
import { PortableNameSchema } from "../../domain/identity/identity-schema.ts";
import { receive } from "./invocation-receiver.ts";
import { readOnly } from "./operation-contract.ts";

const explicitTargetFlags = {
  projectName: projectFlag,
  user: userFlag,
  targetRoots: Flag.String("target-root").pipe(
    Flag.atLeast(0),
    Flag.optional,
    Flag.map((value) => Option.getOrUndefined(value) ?? []),
  ),
  targetHome: optionalStringFlag(
    "target-home",
    "Bind an isolated user HOME and its contained state directory",
  ),
  force: booleanFlag(
    "force",
    "Replace existing target intent; preserve isolation and foreign content",
  ),
  apply: applyFlag,
};

const apply = Command.make(
  "apply",
  {
    reference: Argument.String("profile"),
    ...explicitTargetFlags,
  },
  handle(
    "profile-apply",
    Effect.fnUntraced(function* ({ projectName, user, ...request }) {
      return {
        _tag: "profile-apply",
        ...request,
        namespace: yield* namespaceFrom({ projectName, user }, true),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Preview a registered SOURCE:PROFILE's exact inventory at one complete explicit target. List every project root with --target-root, or bind --user --target-home to an isolated HOME/context. --apply writes; --force replaces existing intent only.",
  ),
  Command.withExamples([
    { command: "tack profile apply tools:ci --project ci --target-root /work/repo" },
    { command: "tack profile apply tools:ci --user --target-home /isolated/home" },
  ]),
  operationContract({
    mutation: "preview-apply",
    slots: ["plan", "applied"],
    applySlots: ["plan", "applied"],
  }),
);

const save = Command.make(
  "save",
  {
    sourcePath: Argument.String("source-path"),
    name: Argument.String("profile-name").pipe(Argument.withSchema(PortableNameSchema)),
    input: optionalFlag(
      Flag.Literals("input", ["user+project", "user", "project"]),
      "Choose user+project (default), user or project; never every project",
    ),
    projectName: projectFlag,
    edit: booleanFlag(
      "edit",
      "Explicitly edit an existing profile after reviewing its membership diff",
    ),
    apply: applyFlag,
  },
  ({ input, projectName, ...request }) =>
    receive({
      _tag: "profile-save",
      ...request,
      input: input ?? "user+project",
      ...(projectName === undefined ? {} : { projectName }),
    }),
).pipe(
  Command.withDescription(
    "Copy effective daily membership into a source profile. Defaults to user + one named/containing project; preview file/publication changes. --apply saves only the profile. Use tack explore to adjust membership before source/name choice.",
  ),
  Command.withExamples([
    { command: "tack profile save /path/to/source ci --project demo" },
    { command: "tack profile save /path/to/source toolbox --input user --apply" },
  ]),
  operationContract({
    mutation: "preview-apply",
    slots: ["plan", "applied"],
    applySlots: ["plan", "applied"],
  }),
);
const adopt = Command.make(
  "adopt",
  {
    reference: Argument.String("profile"),
    projectName: projectFlag,
    user: userFlag,
    apply: applyFlag,
  },
  handle(
    "profile-adopt",
    Effect.fnUntraced(function* ({ projectName, user, ...request }) {
      return {
        _tag: "profile-adopt",
        ...request,
        namespace: yield* namespaceFrom({ projectName, user }, true),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Copy a registered profile into ordinary positive picks and project docs attachments. Preview only by default; --apply writes choices without sync. Unrelated picks and organic defaults remain. Fixed contexts refuse.",
  ),
  Command.withExamples([
    { command: "tack profile adopt tools:ci --project demo" },
    { command: "tack profile adopt tools:toolbox --user --apply" },
  ]),
  operationContract({
    mutation: "preview-apply",
    slots: ["plan", "applied"],
    applySlots: ["plan", "applied"],
  }),
);

const exportBundle = Command.make(
  "export",
  { reference: Argument.String("profile"), output: Argument.String("output"), apply: applyFlag },
  (request) => receive({ _tag: "profile-export", ...request }),
).pipe(
  Command.withDescription(
    "Preview exact direct/required content, support, prerequisites and sensitive-path findings. --apply writes a new tar.gz artifact. No code, hook or installer runs.",
  ),
  Command.withExamples([{ command: "tack profile export tools:ci /artifacts/ci.tar.gz" }]),
  operationContract({
    mutation: "preview-apply",
    slots: ["plan", "applied"],
    applySlots: ["plan", "applied"],
  }),
);
const inspectBundle = Command.make("inspect-bundle", { file: Argument.String("file") }, (request) =>
  receive({ _tag: "profile-inspect-bundle", ...request }),
).pipe(
  Command.withDescription(
    "Read a content bundle's manifest, files, inventory and setup requirements offline. Run tack check FILE for complete validation. No state, original source, fetch or execution.",
  ),
  Command.withExamples([{ command: "tack profile inspect-bundle /artifacts/ci.tar.gz" }]),
  readOnly,
);
const applyBundle = Command.make(
  "apply-bundle",
  { file: Argument.String("file"), ...explicitTargetFlags },
  handle(
    "profile-apply-bundle",
    Effect.fnUntraced(function* ({ projectName, user, targetHome, ...request }) {
      return {
        _tag: "profile-apply-bundle",
        ...request,
        ...(targetHome === undefined ? {} : { targetHome }),
        namespace: yield* namespaceFrom({ projectName, user }, true),
      };
    }),
  ),
).pipe(
  Command.withDescription(
    "Preview verified content at one complete dedicated target. --apply retains payloads, registers fresh bundle-provided sources and applies fixed inventory; originals remain independent. --force replaces existing intent only.",
  ),
  Command.withExamples([
    {
      command:
        "tack profile apply-bundle /artifacts/ci.tar.gz --project ci --target-root /work/repo",
    },
  ]),
  operationContract({
    mutation: "preview-apply",
    slots: ["plan", "applied"],
    applySlots: ["plan", "applied"],
  }),
);

/** Authoring and explicit target operations for fixed profiles. */
export const profileCommand = Command.make("profile").pipe(
  Command.withSubcommands([apply, save, adopt, exportBundle, inspectBundle, applyBundle]),
  Command.withDescription(
    "Author, copy, inspect and apply fixed profiles; use tack check for validation",
  ),
);
