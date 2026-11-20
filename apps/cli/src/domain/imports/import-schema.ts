import { Schema } from "effect";
import { dependencyTargetKinds } from "../resources/kinds.ts";
import {
  RegisteredProviderSchema as RegisteredProvider,
  TransportSchema as Transport,
} from "./providers/provider-schema.ts";

const Count = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0));

/** Why a candidate cannot be imported: the catalog's own reason, or an import rule. */
const CandidateVerdictSchema = Schema.Union([
  Schema.Struct({ importable: Schema.Literal(true) }),
  Schema.Struct({
    importable: Schema.Literal(false),
    code: Schema.String,
    message: Schema.String,
  }),
]);

/** The activation an upstream `metadata.tack` block asks for; the copy follows it unchanged. */
const UpstreamTackSchema = Schema.Struct({
  activation: Schema.Literals(["default", "opt-in"]),
  userActivation: Schema.Literals(["default", "opt-in"]),
  projects: Schema.Array(Schema.String),
  dependencies: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(dependencyTargetKinds),
      name: Schema.String,
      source: Schema.optionalKey(Schema.String),
      optional: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
});

/** One skill folder found in a location, with its verdict and the facts an operator decides on. */
const ImportCandidateSchema = Schema.Struct({
  /** The skill name from its frontmatter; the folder name when the frontmatter has none. */
  name: Schema.String,
  /** The folder in the repository, empty for a skill at the repository root. */
  folder: Schema.String,
  /** The documented place it was found in. */
  place: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** An importable skill marked `metadata.internal`, listed only when it is named. */
  hidden: Schema.Boolean,
  verdict: CandidateVerdictSchema,
  files: Count,
  bytes: Count,
  executables: Count,
  nonText: Count,
  symlinks: Count,
  submodules: Count,
  /** Folders of nested `SKILL.md` files, relative to the skill: content under the leaf rule. */
  nestedSkills: Schema.Array(Schema.String),
  /** Present when the upstream `SKILL.md` carries Tack metadata. */
  upstreamTack: Schema.optionalKey(UpstreamTackSchema),
});

export type ImportCandidate = typeof ImportCandidateSchema.Type;

/** How a ref request was understood. A default or branch request is tracking. */
const ImportRefSchema = Schema.Struct({
  kind: Schema.Literals(["default", "branch", "tag", "commit"]),
  request: Schema.optionalKey(Schema.String),
  tracking: Schema.Boolean,
});

/** A registered source and the skills folders an import could use in it. */
const DestinationChoiceSchema = Schema.Struct({
  name: Schema.String,
  registrationId: Schema.String,
  folders: Schema.Array(Schema.String),
});

/** The destination an import writes into. */
const ImportDestinationSchema = Schema.Struct({
  source: Schema.String,
  registrationId: Schema.String,
  root: Schema.String,
  /** Where skills are written, relative to the source root. */
  folder: Schema.String,
  /** The declared skills folder that covers it. */
  declaredFolder: Schema.String,
  /** Group folders import creates, outermost first. */
  newFolders: Schema.Array(Schema.String),
});

/** What one selected skill writes. */
const ImportWriteSchema = Schema.Struct({
  name: Schema.String,
  /** The skill folder relative to the source root. */
  path: Schema.String,
  upstreamPath: Schema.String,
  files: Count,
  bytes: Count,
});

const ReachProjectSchema = Schema.Struct({
  project: Schema.String,
  receives: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});

const ReachClashSchema = Schema.Struct({
  namespace: Schema.String,
  /** The address of the other skill with the same name. */
  with: Schema.String,
});

/** Where one imported skill will be delivered at the next `sync`; information, never a verdict. */
const ImportReachSchema = Schema.Struct({
  name: Schema.String,
  projects: Schema.Array(ReachProjectSchema),
  user: Schema.Struct({ receives: Schema.Boolean, reason: Schema.String }),
  collisions: Schema.Array(ReachClashSchema),
  /** Dependencies on other sources that the destination does not declare in `depends-on`. */
  undeclaredDependencies: Schema.Array(Schema.String),
});

export type ImportReach = typeof ImportReachSchema.Type;

/** What `import add` would do, and what the location offers. Nothing here is stored. */
export const ImportPlanSchema = Schema.Struct({
  kind: Schema.Literal("import-plan"),
  /** The canonical location text, including a typed ref. */
  location: Schema.String,
  /** A provider this release registers. */
  provider: RegisteredProvider,
  /** How the location was reached; its values belong to the provider. */
  transport: Transport,
  /** Present when the operator typed a URL instead of the shorthand, and which form. */
  urlForm: Schema.optionalKey(Schema.Literals(["https", "ssh"])),
  ref: ImportRefSchema,
  /** For a tree or blob URL, where the remote split the ref from the folder. */
  split: Schema.optionalKey(
    Schema.Struct({
      ref: Schema.String,
      scope: Schema.optionalKey(Schema.String),
      /** The same location in the explicit `<provider>:<text>#ref` form. */
      explicit: Schema.String,
    }),
  ),
  /** The commit the ref request resolved to. */
  revision: Schema.String,
  candidates: Schema.Array(ImportCandidateSchema),
  /** How many importable internal skills are not listed. */
  hiddenInternal: Count,
  /** The skills an apply would import now, by name. */
  selected: Schema.Array(Schema.String),
  /** Present with `--into`, and the destination resolved. */
  destination: Schema.optionalKey(ImportDestinationSchema),
  /** Without `--into`: the registered sources that can receive imports. */
  destinations: Schema.optionalKey(Schema.Array(DestinationChoiceSchema)),
  /** With `--into` that cannot be used: why, and the fix. */
  refusal: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
  writes: Schema.Array(ImportWriteSchema),
  reach: Schema.Array(ImportReachSchema),
  outcome: Schema.Literals([
    "needs-selection",
    "needs-destination",
    "refused",
    "ready",
    "nothing-importable",
  ]),
});

export type ImportPlan = typeof ImportPlanSchema.Type;

/** What `import add --apply` did. Nothing is delivered. */
export const ImportApplicationSchema = Schema.Struct({
  kind: Schema.Literal("import-application"),
  location: Schema.String,
  ref: ImportRefSchema,
  revision: Schema.String,
  destination: ImportDestinationSchema,
  imported: Schema.Array(ImportWriteSchema),
  /** Candidates that were skipped, each with the reason it cannot be imported. */
  rejected: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      folder: Schema.String,
      code: Schema.String,
      message: Schema.String,
    }),
  ),
  /** Paths written, relative to the source root. */
  written: Schema.Array(Schema.String),
  /** An interrupted earlier write that this command finished or rolled back first. */
  recovered: Schema.Array(Schema.String),
});

export type ImportApplication = typeof ImportApplicationSchema.Type;

/** How an imported skill folder compares with its record. */
const ImportStateSchema = Schema.Struct({
  state: Schema.Literals(["unchanged", "changed", "missing"]),
  added: Schema.Array(Schema.String),
  removed: Schema.Array(Schema.String),
  changed: Schema.Array(Schema.String),
  executable: Schema.Array(Schema.String),
  special: Schema.Array(Schema.String),
});

export type ImportState = typeof ImportStateSchema.Type;

/** A condition found offline about an imported skill, each with its next command. */
const ImportConditionSchema = Schema.Struct({
  code: Schema.Literals([
    "import-folder-missing",
    "import-folder-not-cataloged",
    "import-locally-changed",
  ]),
  message: Schema.String,
});

/** One imported skill as `import`, `source` and `catalog` show it. */
const ImportSummarySchema = Schema.Struct({
  /** `source:name`, the reference `import remove` accepts. */
  reference: Schema.String,
  name: Schema.String,
  source: Schema.String,
  registrationId: Schema.String,
  path: Schema.String,
  location: Schema.String,
  transport: Transport,
  ref: ImportRefSchema,
  revision: Schema.String,
  upstreamPath: Schema.String,
  importedAt: Schema.String,
  local: ImportStateSchema,
  conditions: Schema.Array(ImportConditionSchema),
});

export type ImportSummary = typeof ImportSummarySchema.Type;

/** A source whose imports cannot be read, or whose staging folder holds an interrupted write. */
const ImportProblemSchema = Schema.Struct({
  source: Schema.String,
  registrationId: Schema.String,
  code: Schema.Literals(["imports-invalid", "staging-left-over"]),
  message: Schema.String,
});

export type ImportProblem = typeof ImportProblemSchema.Type;

/** The `import` result: every imported skill in every registered source, and the offline facts. */
export const ImportListSchema = Schema.Struct({
  kind: Schema.Literal("import-list"),
  imports: Schema.Array(ImportSummarySchema),
  problems: Schema.Array(ImportProblemSchema),
});

export type ImportList = typeof ImportListSchema.Type;

const PickSchema = Schema.Struct({ namespace: Schema.String, address: Schema.String });

/** What `import remove` would delete, or deleted. */
export const ImportRemovalPlanSchema = Schema.Struct({
  kind: Schema.Literal("import-removal-plan"),
  reference: Schema.String,
  source: Schema.String,
  registrationId: Schema.String,
  name: Schema.String,
  path: Schema.String,
  location: Schema.String,
  revision: Schema.String,
  /** Whether the folder exists; without it only the record goes. */
  folderPresent: Schema.Boolean,
  files: Count,
  local: ImportStateSchema,
  /** Namespaces where the skill is delivered now, from link records. */
  delivered: Schema.Array(Schema.String),
  /** Picks that name the skill; they stay as unresolved picks until `pick remove`. */
  picks: Schema.Array(PickSchema),
  /** Whether `--force` was given, which overrides every local change. */
  force: Schema.Boolean,
});

export type ImportRemovalPlan = typeof ImportRemovalPlanSchema.Type;

export const ImportRemovalApplicationSchema = Schema.Struct({
  kind: Schema.Literal("import-removal-application"),
  reference: Schema.String,
  /** Paths removed, relative to the source root. */
  removed: Schema.Array(Schema.String),
  recovered: Schema.Array(Schema.String),
});

export type ImportRemovalApplication = typeof ImportRemovalApplicationSchema.Type;
