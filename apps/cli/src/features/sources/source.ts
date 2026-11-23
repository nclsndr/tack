import { Yaml } from "../../domain/runtime-neutral.ts";
import { bundleSourceLabel } from "../../domain/bundles/bundle-registration.ts";
import { bundleIntegrityIssue } from "./bundle-integrity.ts";
import { fileAccessFailure } from "../file-access.ts";
import { constFalse } from "effect/Function";
import { Context, Effect, FileSystem, Path, PlatformError, Predicate, Schema } from "effect";
import type { SecureRandom } from "effect/crypto";
import {
  SourceHealthErrorCodeSchema,
  SourceStorageErrorCodeSchema,
  SourceValidationErrorCodeSchema,
  SourceLabelSchema,
  SourceRegistrationSchema,
  declarationResourceKeys,
  isCollection,
  type SourceDeclaration,
  type SourceRegistration,
  sourceDeclarationVersion,
  profileSourceDeclarationVersion,
} from "../../domain/sources/source-schema.ts";
import type {
  DeclaredSourceInspection,
  SourceInspection,
  SourceIssue,
  SourceWarning,
} from "../../domain/sources/source-inspection.ts";
import { SourceCheckReportSchema } from "../../domain/sources/source-check.ts";
import { mutateState, type StateMutation, type StateOptions } from "../../services/state-store.ts";
import { type State } from "../../domain/state/state-schema.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { discoverDocs } from "./docs-discovery.ts";
import { kindFoldersAt, undeclaredFoldersMessage } from "./undeclared-folders.ts";
import {
  checkDeclarationVersion,
  declarationFileName,
  decodeDeclaration,
  readDeclarationText,
} from "./declaration-file.ts";

/** Reports a stable validation classification for an unusable source path or declaration. */
export class SourceValidationError extends Schema.TaggedError<SourceValidationError>()(
  "SourceValidationError",
  {
    code: SourceValidationErrorCodeSchema,
    message: Schema.String,
    sourcePath: Schema.String,
  },
) {}

/** Reports an unexpected platform failure while observing or registering a source. */
export class SourceStorageError extends Schema.TaggedError<SourceStorageError>()(
  "SourceStorageError",
  {
    code: SourceStorageErrorCodeSchema,
    message: Schema.String,
    operation: Schema.String,
    path: Schema.String,
  },
) {}

/** Reports an explicit relocation for an unknown registration identity. */
export class SourceRegistrationNotFoundError extends Schema.TaggedError<SourceRegistrationNotFoundError>()(
  "SourceRegistrationNotFoundError",
  {
    code: Schema.Literal("registration-not-found"),
    registrationId: Schema.String,
  },
) {}

/** Reports an explicit relocation onto another registration's canonical path. */
export class SourcePathConflictError extends Schema.TaggedError<SourcePathConflictError>()(
  "SourcePathConflictError",
  {
    code: Schema.Literal("source-path-already-registered"),
    conflictingRegistrationId: Schema.String,
    registrationId: Schema.String,
    sourcePath: Schema.String,
  },
) {}

/** Reports an unhealthy registration whose currently observed identity or location changed. */
class SourceHealthError extends Schema.TaggedError<SourceHealthError>()("SourceHealthError", {
  code: SourceHealthErrorCodeSchema,
  message: Schema.String,
  sourcePath: Schema.String,
}) {}

export type RegisterSourceOptions = {
  readonly sourcePath: string;
};

export type RelocateSourceOptions = RegisterSourceOptions & {
  readonly registrationId: string;
};

/** The response family both `source add` and `source relocate` report. */
const SourceRegistrationKindSchema = Schema.Literal("source-registration");

/**
 * The `source add` payload: the registration, the healthy docs resources the source declares, its
 * check, and the declaration file it created when there was none.
 */
export const SourceRegistrationPayloadSchema = Schema.Struct({
  kind: SourceRegistrationKindSchema,
  alreadyRegistered: Schema.Boolean,
  docs: Schema.Array(Schema.Struct({ name: Schema.String })),
  registration: SourceRegistrationSchema,
  /** What a `SOURCE:NAME` reference types for the source: its label, or its registration ID. */
  name: Schema.String,
  inspection: Schema.optionalKey(SourceCheckReportSchema),
  scaffolded: Schema.optionalKey(Schema.String),
});

/**
 * The `source add` preview for a source that has its tack.yaml: where it is, the name a
 * `SOURCE:NAME` reference would type (absent when it would need the registration ID), whether it is
 * registered already, and its check. Nothing is written until `--apply`.
 */
export const SourceRegistrationPlanSchema = Schema.Struct({
  kind: Schema.Literal("source-registration-plan"),
  sourcePath: Schema.String,
  name: Schema.optionalKey(Schema.String),
  alreadyRegistered: Schema.Boolean,
  inspection: SourceCheckReportSchema,
});

/** What registering one source reports, before its name, check and scaffold are added. */
export type SourceMutationResult = Omit<
  typeof SourceRegistrationPayloadSchema.Type,
  "kind" | "name" | "inspection" | "scaffolded"
>;

/** Lists the healthy docs a validated declaration provides. */
const declaredDocs = (registration: SourceRegistration, declaration: SourceDeclaration) =>
  discoverDocs(registration, declaration).pipe(
    Effect.map(({ entries }) =>
      entries
        .map((entry) => ({ name: entry.address.name }))
        .sort((left, right) => compareCodeUnits(left.name, right.name)),
    ),
  );

/** The `source relocate` payload: the registration and whether its path changed. */
export const SourceRelocationPayloadSchema = Schema.Struct({
  kind: SourceRegistrationKindSchema,
  registration: SourceRegistrationSchema,
  relocated: Schema.Boolean,
});

/** What relocating one source reports. */
export type SourceRelocationResult = Omit<typeof SourceRelocationPayloadSchema.Type, "kind">;

const sourceIssueDetails = (
  issue: SourceHealthError | SourceStorageError | SourceValidationError,
): SourceIssue => ({
  code: issue.code,
  message: issue.message,
  ...("operation" in issue ? { operation: issue.operation } : {}),
  ...("path" in issue ? { path: issue.path } : {}),
  ...("sourcePath" in issue ? { sourcePath: issue.sourcePath } : {}),
});

type ValidatedSource = Omit<SourceRegistration, "id"> & {
  readonly declaration: SourceDeclaration;
  /** Heads-ups that leave a healthy source healthy. */
  readonly warnings?: ReadonlyArray<SourceWarning>;
};

const noResourcesWarning: SourceWarning = {
  code: "source-declares-no-resources",
  message:
    "This source declares no resources, so nothing from it is cataloged. Use the manage-tack-sources skill, or add skills, commands, context, scripts or docs entries to its tack.yaml.",
};

/** How many declarations a resource key holds; a value that is not a list counts as declared. */
const declaredCount = (value: unknown) =>
  value === undefined ? 0 : Array.isArray(value) ? value.length : 1;

const registrationsFrom = (state: {
  readonly data: { readonly sources: ReadonlyArray<SourceRegistration> };
}) => state.data.sources;

const isPlatformReason = (error: PlatformError.PlatformError, reason: string) => {
  return error.reason._tag === reason;
};

const platformError = (
  code: "declaration-access-failed" | "source-access-failed",
  operation: string,
  path: string,
  error: PlatformError.PlatformError,
) =>
  new SourceStorageError({
    code,
    message: error.message,
    operation,
    path,
  });

/**
 * A file a command reads or writes in a source folder cannot be accessed. The diagnostic names the
 * path the failed call touched, and the message gives the reason.
 */
export const sourceFileFailure =
  (operation: string, fallbackPath: string) => (error: PlatformError.PlatformError) => {
    const failure = fileAccessFailure(error, fallbackPath);
    return new SourceStorageError({
      code: "source-access-failed",
      message: `Tack could not access ${failure.path}: ${failure.explanation}.`,
      operation,
      path: failure.path,
    });
  };

/** Why a folder that holds `SKILL.md` cannot be a skills collection, and what to do instead. */
export const oneSkillMessage = (folder: string) =>
  `${folder} holds SKILL.md, so it is one skill, not a folder of skills. Register the folder that holds it, or import it into a source with tack import add.`;

const validateSource = Effect.fnUntraced(function* (
  sourcePath: string,
): Effect.fn.Return<
  ValidatedSource,
  SourceStorageError | SourceValidationError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedPath = path.resolve(sourcePath);
  const canonicalPath = yield* fileSystem.realPath(resolvedPath).pipe(
    Effect.mapError((error) =>
      isPlatformReason(error, "NotFound")
        ? new SourceValidationError({
            code: "source-missing",
            message: "The source does not exist.",
            sourcePath: resolvedPath,
          })
        : platformError("source-access-failed", "resolve source path", resolvedPath, error),
    ),
  );
  const sourceInfo = yield* fileSystem.stat(canonicalPath).pipe(
    Effect.mapError((error) =>
      isPlatformReason(error, "NotFound")
        ? new SourceValidationError({
            code: "source-missing",
            message: "The source does not exist.",
            sourcePath: canonicalPath,
          })
        : platformError("source-access-failed", "inspect source path", canonicalPath, error),
    ),
  );

  if (sourceInfo.type !== "Directory") {
    return yield* new SourceValidationError({
      code: "source-not-directory",
      message: "The source path is not a directory.",
      sourcePath: canonicalPath,
    });
  }

  const declarationPath = path.join(canonicalPath, declarationFileName);
  const encodedDeclaration = yield* readDeclarationText(canonicalPath).pipe(
    Effect.mapError((error) =>
      isPlatformReason(error, "NotFound")
        ? new SourceValidationError({
            code: "declaration-missing",
            message: "The source does not contain tack.yaml.",
            sourcePath: canonicalPath,
          })
        : platformError(
            "declaration-access-failed",
            "read source declaration",
            declarationPath,
            error,
          ),
    ),
  );
  const parsedDeclaration: unknown = yield* Effect.try({
    catch: (cause) =>
      new SourceValidationError({
        code: "declaration-malformed",
        message: String(cause),
        sourcePath: canonicalPath,
      }),
    try: (): unknown => Yaml.parse(encodedDeclaration),
  });

  if (Predicate.isObject(parsedDeclaration) === false) {
    return yield* new SourceValidationError({
      code: "declaration-root-not-mapping",
      message: "The source declaration root must be a mapping.",
      sourcePath: canonicalPath,
    });
  }

  if (
    checkDeclarationVersion(parsedDeclaration, [
      sourceDeclarationVersion,
      profileSourceDeclarationVersion,
    ]) === false
  ) {
    return yield* new SourceValidationError({
      code: "declaration-version-unsupported",
      message: "The source declaration version is not supported.",
      sourcePath: canonicalPath,
    });
  }

  const declaration = yield* decodeDeclaration(parsedDeclaration).pipe(
    Effect.mapError(
      (cause) =>
        new SourceValidationError({
          code: "declaration-schema-invalid",
          message: cause.message,
          sourcePath: canonicalPath,
        }),
    ),
  );

  if (isCollection(declaration)) {
    if (
      declaration.kind === "skills" &&
      (yield* fileSystem
        .exists(path.join(canonicalPath, "SKILL.md"))
        .pipe(Effect.orElseSucceed(constFalse))) === true
    )
      return yield* new SourceValidationError({
        code: "source-is-one-skill",
        message: oneSkillMessage(canonicalPath),
        sourcePath: canonicalPath,
      });
    // A collection names no folder, so the list form's layout warnings never apply to it.
    return { canonicalPath, declaration };
  }

  const hasResourceKey = (["skills", "commands", "context", "scripts"] as const).some(
    (key) => declaration[key] !== undefined,
  );
  const declaresNothing = declarationResourceKeys.every(
    (key) => declaredCount(declaration[key]) === 0,
  );
  // Only a declaration with no resource key, or no entry at all, needs to look at the layout.
  const kindFolders =
    hasResourceKey === false || declaresNothing ? yield* kindFoldersAt(canonicalPath) : [];
  if (hasResourceKey === false && kindFolders.length > 0)
    return yield* new SourceValidationError({
      code: "declaration-resources-undeclared",
      message: undeclaredFoldersMessage(kindFolders),
      sourcePath: canonicalPath,
    });

  return {
    canonicalPath,
    declaration,
    ...(declaresNothing && kindFolders.length === 0 ? { warnings: [noResourcesWarning] } : {}),
  };
});

type SourceService = {
  readonly builtInSources?: ReadonlyArray<SourceRegistration>;
  readonly nextRegistrationId: Effect.Effect<string>;
  readonly validate: (
    sourcePath: string,
  ) => Effect.Effect<ValidatedSource, SourceStorageError | SourceValidationError>;
};

/** External source inspection and identity operations used by source workflows. */
export class Source extends Context.Service<Source, SourceService>()(
  "tack/cli/features/sources/source/Source",
) {}

/** Builds source operations over explicit platform services. */
export const makeSourceService = (
  random: SecureRandom.SecureRandom["Service"],
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  builtInSources: ReadonlyArray<SourceRegistration> = [],
): Source["Service"] =>
  Source.of({
    builtInSources,
    nextRegistrationId: random.uuidV4(),
    validate: (sourcePath) =>
      validateSource(sourcePath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
  });

/** The registration, built-in or registered, that already holds `canonicalPath`, if any. */
const registrationAt = (
  sourceService: Source["Service"],
  registrations: ReadonlyArray<SourceRegistration>,
  canonicalPath: string,
) =>
  [...(sourceService.builtInSources ?? []), ...registrations].find(
    (registration) => registration.canonicalPath === canonicalPath,
  );

/**
 * What registering a declared source would do, without writing: the validated source, and the
 * registration that already holds it in `state`.
 */
export const planSourceRegistration = Effect.fnUntraced(function* (
  state: State,
  sourcePath: string,
) {
  const sourceService = yield* Source;
  const source = yield* sourceService.validate(sourcePath);
  return {
    source,
    existing: registrationAt(sourceService, registrationsFrom(state), source.canonicalPath),
  };
});

/** Registers a declared source by canonical path, returning the existing identity on repeats. */
export const registerSource = Effect.fn("sources.registerSource")(function* (
  stateOptions: StateOptions,
  options: RegisterSourceOptions,
) {
  const sourceService = yield* Source;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listDocs = (registration: SourceRegistration, declaration: SourceDeclaration) =>
    declaredDocs(registration, declaration).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  return yield* mutateState(stateOptions, (state) =>
    Effect.gen(function* (): Effect.fn.Return<
      StateMutation<SourceMutationResult>,
      SourceStorageError | SourceValidationError
    > {
      const source = yield* sourceService.validate(options.sourcePath);
      const registrations = registrationsFrom(state);
      const existing = registrationAt(sourceService, registrations, source.canonicalPath);

      if (existing !== undefined) {
        return {
          state,
          value: {
            alreadyRegistered: true,
            docs: yield* listDocs(existing, source.declaration),
            registration: existing,
          },
        } satisfies StateMutation<SourceMutationResult>;
      }

      const id = yield* sourceService.nextRegistrationId;
      const registration = { id, canonicalPath: source.canonicalPath } satisfies SourceRegistration;

      return {
        state: {
          ...state,
          data: {
            ...state.data,
            sources: [...registrations, registration],
          },
        },
        value: {
          alreadyRegistered: false,
          docs: yield* listDocs(registration, source.declaration),
          registration,
        },
      } satisfies StateMutation<SourceMutationResult>;
    }),
  );
});

/** Moves an existing registration to a validated canonical path while preserving its identity. */
export const relocateSource = Effect.fn("sources.relocateSource")(function* (
  stateOptions: StateOptions,
  options: RelocateSourceOptions,
) {
  const sourceService = yield* Source;
  return yield* mutateState(stateOptions, (state) =>
    Effect.gen(function* (): Effect.fn.Return<
      StateMutation<SourceRelocationResult>,
      | SourcePathConflictError
      | SourceRegistrationNotFoundError
      | SourceStorageError
      | SourceValidationError
    > {
      const registrations = registrationsFrom(state);
      const existing = registrations.find(
        (registration) => registration.id === options.registrationId,
      );

      if (existing === undefined) {
        return yield* new SourceRegistrationNotFoundError({
          code: "registration-not-found",
          registrationId: options.registrationId,
        });
      }

      if (existing.bundle !== undefined)
        return yield* new SourceValidationError({
          code: "source-missing",
          sourcePath: options.sourcePath,
          message:
            "Bundle-provided sources retain verified payload identity and cannot be relocated. Reapply the artifact in its dedicated context.",
        });
      const source = yield* sourceService.validate(options.sourcePath);
      const conflicting = [...(sourceService.builtInSources ?? []), ...registrations].find(
        (registration) =>
          registration.id !== existing.id && registration.canonicalPath === source.canonicalPath,
      );

      if (conflicting !== undefined) {
        return yield* new SourcePathConflictError({
          code: "source-path-already-registered",
          conflictingRegistrationId: conflicting.id,
          registrationId: existing.id,
          sourcePath: source.canonicalPath,
        });
      }

      const relocated = existing.canonicalPath !== source.canonicalPath;
      const registration = {
        ...existing,
        canonicalPath: source.canonicalPath,
      } satisfies SourceRegistration;
      const nextState =
        relocated === true
          ? {
              ...state,
              data: {
                ...state.data,
                sources: registrations.map((candidate) =>
                  candidate.id === registration.id ? registration : candidate,
                ),
              },
            }
          : state;

      return {
        state: nextState,
        value: { registration, relocated },
      } satisfies StateMutation<SourceRelocationResult>;
    }),
  );
});

const inspectSource = (registration: SourceRegistration, sourceService: Source["Service"]) =>
  sourceService.validate(registration.canonicalPath).pipe(
    Effect.map((source): DeclaredSourceInspection => {
      if (source.canonicalPath !== registration.canonicalPath) {
        return {
          issue: sourceIssueDetails(
            new SourceHealthError({
              code: "source-location-changed",
              message: "The registered path now resolves to a different canonical location.",
              sourcePath: registration.canonicalPath,
            }),
          ),
          registration,
          status: "unhealthy",
        };
      }

      return {
        declaration: source.declaration,
        registration,
        status: "healthy",
        ...(source.warnings === undefined ? {} : { warnings: source.warnings }),
      };
    }),
    Effect.catch((issue) =>
      Effect.succeed({
        issue: sourceIssueDetails(issue),
        registration,
        status: "unhealthy",
      } satisfies DeclaredSourceInspection),
    ),
  );

/** Adds local labels and reports clashes without changing source health or registration identity. */
export const resolveSourceLabels = (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
  basename: (sourcePath: string) => string,
): ReadonlyArray<DeclaredSourceInspection> => {
  const candidates = inspections.map((inspection) => {
    if (inspection.status === "unhealthy") return undefined;
    if (inspection.origin === "builtin") return { label: "tack", origin: "declared" as const };
    if (inspection.registration.bundle !== undefined)
      return {
        label: bundleSourceLabel(inspection.registration.bundle),
        origin: "declared" as const,
      };
    if (inspection.declaration.name !== undefined)
      return { label: inspection.declaration.name, origin: "declared" as const };
    const directoryName = basename(inspection.registration.canonicalPath);
    return Schema.is(SourceLabelSchema)(directoryName)
      ? { label: directoryName, origin: "derived" as const }
      : undefined;
  });
  return inspections.map((inspection, index): DeclaredSourceInspection => {
    if (inspection.status === "unhealthy") return inspection;
    const candidate = candidates[index];
    const label = candidate?.label;
    const others =
      label === undefined || label === "tack"
        ? []
        : inspections.filter(
            (_other, otherIndex) => otherIndex !== index && candidates[otherIndex]?.label === label,
          );
    const reserved =
      (inspection.origin !== "builtin" && label === "tack") ||
      (inspection.registration.bundle === undefined && label?.startsWith("bundle-") === true);
    const labelIssues = reserved
      ? [
          {
            code: "source-label-reserved" as const,
            message:
              label === "tack"
                ? "The source label tack is reserved for the built-in source. Use its registration ID or choose another name."
                : "Source labels beginning bundle- are reserved for verified artifact projections. Choose another declared name for an ordinary source.",
          },
        ]
      : others.length > 0
        ? [
            {
              code: "source-label-clash" as const,
              message: `The source label ${label} also belongs to registration ${others.map((other) => other.registration.id).join(", ")}. Use registration IDs or choose distinct names.`,
            },
          ]
        : [];
    return {
      ...inspection,
      ...(label === undefined || reserved ? {} : { label }),
      labelOrigin:
        reserved || label === undefined
          ? "none"
          : others.length > 0
            ? "clashing"
            : (candidate?.origin ?? "none"),
      maintainers: inspection.declaration.maintainers ?? [],
      dependsOn:
        ("depends-on" in inspection.declaration ? inspection.declaration["depends-on"] : []) ?? [],
      ...(labelIssues.length === 0 ? {} : { labelIssues }),
    };
  });
};

/**
 * The label a source not yet registered would take beside `inspections`, resolved as
 * `resolveSourceLabels` resolves the registered ones. Undefined when it would have none, or one
 * that is reserved or shared, so a `SOURCE:NAME` reference would need its registration ID.
 */
export const prospectiveSourceLabel = (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
  source: { readonly canonicalPath: string; readonly declaration: SourceDeclaration },
  basename: (sourcePath: string) => string,
) => {
  const resolved = resolveSourceLabels(
    [
      ...inspections,
      {
        status: "healthy",
        declaration: source.declaration,
        // Not registered yet, so it has no ID; only the other sources' discarded results name it.
        registration: { id: "", canonicalPath: source.canonicalPath },
      },
    ],
    basename,
  ).at(-1);
  return resolved?.labelOrigin === "clashing" ? undefined : resolved?.label;
};

/** Inspects sources retained by one validated state snapshot, keeping healthy declarations. */
export const inspectSources = Effect.fnUntraced(function* (state: State) {
  const sourceService = yield* Source;
  const path = yield* Path.Path;
  const builtInSources = sourceService.builtInSources ?? [];
  const registeredSources = registrationsFrom(state).filter((registration) =>
    builtInSources.every((builtin) => builtin.canonicalPath !== registration.canonicalPath),
  );
  const inspections = yield* Effect.forEach(
    [...builtInSources, ...registeredSources],
    (registration) =>
      Effect.gen(function* () {
        const issue = yield* bundleIntegrityIssue(registration, state.data.sources);
        if (issue !== undefined)
          return {
            status: "unhealthy" as const,
            registration,
            issue: { code: "source-bundle-changed" as const, message: issue },
          };
        const inspected = yield* inspectSource(registration, sourceService);
        return registration.bundle === undefined
          ? inspected
          : { ...inspected, origin: "bundle" as const };
      }).pipe(
        Effect.map((inspection): DeclaredSourceInspection =>
          builtInSources.find((builtin) => builtin.canonicalPath === registration.canonicalPath) !==
          undefined
            ? { ...inspection, origin: "builtin" }
            : inspection,
        ),
      ),
  );
  return resolveSourceLabels(inspections, (sourcePath) => path.basename(sourcePath));
});

/** Removes authored declaration data from an inspected source's public facts. */
export const publicSourceInspection = (inspection: DeclaredSourceInspection): SourceInspection => {
  if (inspection.status === "unhealthy") return inspection;
  const { declaration: _declaration, ...health } = inspection;
  return health;
};
