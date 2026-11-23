import { Yaml } from "../../domain/runtime-neutral.ts";
import { Effect, Predicate, Schema } from "effect";
import { checkDeclarationVersion } from "./declaration-file.ts";
import {
  SkillFrontmatterSchema,
  MetadataCarrierSchema,
  CatalogQuarantineReasonSchema,
  TackMetadataSchema,
  resourceMetadataVersion,
  type SkillCatalogEntry,
} from "../../domain/sources/catalog-schema.ts";
import { dependencyTargetKinds } from "../../domain/resources/kinds.ts";

/** The kinds a dependency can name, as a sentence lists them: `skill and command`. */
const dependencyTargetKindList = new Intl.ListFormat("en").format(dependencyTargetKinds);

type YamlMappingErrorCodes =
  | {
      readonly malformed: "skill-frontmatter-yaml-malformed";
      readonly root: "skill-frontmatter-root-not-mapping";
    }
  | {
      readonly malformed: "skill-metadata-yaml-malformed";
      readonly root: "skill-metadata-root-not-mapping";
    };

/** A stable parse failure for one discovered skill candidate. */
export class CatalogCandidateError extends Schema.TaggedError<CatalogCandidateError>()(
  "CatalogCandidateError",
  {
    code: CatalogQuarantineReasonSchema,
    field: Schema.optionalKey(Schema.String),
    message: Schema.String,
  },
) {}

/** The inputs needed to parse one `SKILL.md` document. */
export type ParseSkillDocumentInput = {
  readonly directoryName: string;
  readonly encoded: string;
};

/** Parsed skill metadata before source identity and filesystem paths are attached. */
export type ParsedSkillDocument = {
  readonly activation: SkillCatalogEntry["activation"];
  readonly userActivation?: SkillCatalogEntry["activation"];
  readonly dependencies: SkillCatalogEntry["dependencies"];
  readonly description: string;
  readonly frontmatter: SkillCatalogEntry["frontmatter"];
  readonly name: string;
  readonly projects: SkillCatalogEntry["projects"];
};

const candidateError = (code: CatalogCandidateError["code"], message: string, field?: string) =>
  new CatalogCandidateError({
    code,
    ...(field === undefined ? {} : { field }),
    message,
  });

const parseYamlMapping = Effect.fnUntraced(function* (
  encoded: string,
  codes: YamlMappingErrorCodes,
) {
  const parsed: unknown = yield* Effect.try({
    catch: (cause) => candidateError(codes.malformed, String(cause)),
    try: (): unknown => Yaml.parse(encoded),
  });

  if (Predicate.isObject(parsed) === false) {
    return yield* candidateError(codes.root, "The YAML document root must be a mapping.");
  }

  return parsed;
});

const extractFrontmatter = (encoded: string): Effect.Effect<string, CatalogCandidateError> => {
  const lines = encoded.split(/\r?\n/);
  const opening = lines[0];

  if (opening !== "---") {
    return Effect.fail(
      candidateError("skill-frontmatter-missing", "SKILL.md must begin with YAML frontmatter."),
    );
  }

  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing === -1) {
    return Effect.fail(
      candidateError("skill-frontmatter-missing", "SKILL.md frontmatter has no closing fence."),
    );
  }

  return Effect.succeed(lines.slice(1, closing).join("\n"));
};

const decodeFrontmatter = Schema.decodeUnknownEffect(SkillFrontmatterSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const decodeMetadataCarrier = Schema.decodeUnknownEffect(MetadataCarrierSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const decodeTackMetadata = Schema.decodeUnknownEffect(TackMetadataSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const validateMetadataActivation = (metadata: Record<string, unknown>) => {
  if (
    Predicate.hasProperty(metadata, "activation") === true &&
    metadata.activation !== "default" &&
    metadata.activation !== "opt-in"
  ) {
    return Effect.fail(
      candidateError(
        "skill-metadata-activation-invalid",
        "Tack metadata activation must be default or opt-in.",
        "activation",
      ),
    );
  }

  return Effect.succeed(undefined);
};

const validateMetadataProjects = (metadata: Record<string, unknown>) => {
  if (
    Predicate.hasProperty(metadata, "projects") === true &&
    Array.isArray(metadata.projects) === false
  ) {
    return Effect.fail(
      candidateError(
        "skill-metadata-projects-invalid",
        "Tack metadata projects must be an array of project names.",
        "projects",
      ),
    );
  }

  return Effect.succeed(undefined);
};

const validateMetadataDependencies = (metadata: Record<string, unknown>) => {
  if (
    Predicate.hasProperty(metadata, "dependencies") === true &&
    Array.isArray(metadata["dependencies"]) === false
  ) {
    return Effect.fail(
      candidateError(
        "skill-metadata-dependency-invalid",
        "Tack metadata dependencies must be an array.",
        "dependencies",
      ),
    );
  }

  if (Array.isArray(metadata["dependencies"])) {
    for (const dependency of metadata["dependencies"]) {
      if (Predicate.isObject(dependency) === false) {
        return Effect.fail(
          candidateError(
            "skill-metadata-dependency-invalid",
            "Each Tack dependency must be a mapping.",
            "dependencies",
          ),
        );
      }

      if (
        Predicate.hasProperty(dependency, "kind") === true &&
        dependencyTargetKinds.some((kind) => kind === dependency.kind) === false
      ) {
        return Effect.fail(
          candidateError(
            "skill-metadata-dependency-kind-unsupported",
            `Only ${dependencyTargetKindList} dependency kinds are supported.`,
            "dependencies.kind",
          ),
        );
      }
    }
  }

  return Effect.succeed(undefined);
};

const duplicateDependency = (
  dependencies: ReadonlyArray<{
    readonly source?: string;
    readonly kind: string;
    readonly name: string;
  }>,
) => {
  const addresses = new Set<string>();

  for (const dependency of dependencies) {
    const address = `${dependency.source ?? ""}\u0000${dependency.kind}\u0000${dependency.name}`;
    if (addresses.has(address)) {
      return true;
    }
    addresses.add(address);
  }

  return false;
};

/** Parses one skill's frontmatter and nested Tack metadata without reading any other files. */
export const parseSkillDocument = Effect.fnUntraced(function* ({
  directoryName,
  encoded,
}: ParseSkillDocumentInput): Effect.fn.Return<ParsedSkillDocument, CatalogCandidateError> {
  const frontmatterEncoded = yield* extractFrontmatter(encoded);
  const parsedFrontmatter = yield* parseYamlMapping(frontmatterEncoded, {
    malformed: "skill-frontmatter-yaml-malformed",
    root: "skill-frontmatter-root-not-mapping",
  });
  const frontmatter = yield* decodeFrontmatter(parsedFrontmatter).pipe(
    Effect.mapError((cause) => candidateError("skill-frontmatter-schema-invalid", cause.message)),
  );

  if (frontmatter.name !== directoryName) {
    return yield* candidateError(
      "skill-name-mismatch",
      "The SKILL.md name must match its directory basename.",
      "name",
    );
  }

  const metadata = yield* parseResourceMetadata(frontmatter);

  return {
    ...metadata,
    description: frontmatter.description,
    frontmatter,
    name: frontmatter.name,
  };
});

/** Parses the shared metadata carrier used by skills and commands. */
export const parseResourceMetadata = Effect.fnUntraced(function* (
  frontmatter: Record<string, unknown>,
) {
  let tackMetadata: typeof TackMetadataSchema.Type | undefined;
  if (Predicate.hasProperty(frontmatter, "metadata") === true) {
    const rawMetadata = frontmatter.metadata;
    if (Predicate.isObject(rawMetadata) === false) {
      return yield* candidateError(
        "skill-metadata-not-mapping",
        "SKILL.md metadata must be a mapping.",
        "metadata",
      );
    }

    if (
      Predicate.hasProperty(rawMetadata, "tack") === true &&
      typeof rawMetadata.tack !== "string"
    ) {
      return yield* candidateError(
        "skill-metadata-not-string",
        "SKILL.md metadata.tack must be a string.",
        "metadata.tack",
      );
    }

    const metadata = yield* decodeMetadataCarrier(rawMetadata).pipe(
      Effect.mapError((cause) =>
        candidateError("skill-metadata-schema-invalid", cause.message, "metadata"),
      ),
    );

    if (metadata.tack !== undefined) {
      const parsedTackMetadata = yield* parseYamlMapping(metadata.tack, {
        malformed: "skill-metadata-yaml-malformed",
        root: "skill-metadata-root-not-mapping",
      });

      yield* validateMetadataActivation(parsedTackMetadata);
      yield* validateMetadataProjects(parsedTackMetadata);
      yield* validateMetadataDependencies(parsedTackMetadata);

      if (checkDeclarationVersion(parsedTackMetadata, [resourceMetadataVersion]) === false) {
        return yield* candidateError(
          "skill-metadata-version-unsupported",
          "The Tack metadata version is not supported.",
          "version",
        );
      }

      tackMetadata = yield* decodeTackMetadata(parsedTackMetadata).pipe(
        Effect.mapError((cause) => candidateError("skill-metadata-schema-invalid", cause.message)),
      );

      if (duplicateDependency(tackMetadata.dependencies ?? [])) {
        return yield* candidateError(
          "skill-metadata-dependency-duplicate",
          "Tack metadata declares the same dependency address more than once.",
          "dependencies",
        );
      }
    }
  }

  return {
    activation: tackMetadata?.activation ?? "default",
    ...(tackMetadata?.["user-activation"] === undefined
      ? {}
      : { userActivation: tackMetadata["user-activation"] }),
    dependencies: tackMetadata?.dependencies ?? [],
    projects: tackMetadata?.projects ?? [],
  };
});

/** Reads optional command frontmatter without requiring skill-specific fields. */
export const parseCommandDocument = Effect.fnUntraced(function* (encoded: string) {
  const frontmatter =
    encoded.split(/\r?\n/)[0] === "---"
      ? yield* extractFrontmatter(encoded).pipe(
          Effect.flatMap((yaml) =>
            parseYamlMapping(yaml, {
              malformed: "skill-frontmatter-yaml-malformed",
              root: "skill-frontmatter-root-not-mapping",
            }),
          ),
          Effect.mapError((error) => candidateError("command-frontmatter-invalid", error.message)),
        )
      : {};
  const metadata = yield* parseResourceMetadata(frontmatter).pipe(
    Effect.mapError((error) =>
      candidateError("command-metadata-invalid", error.message, error.field),
    ),
  );
  return { ...metadata, frontmatter };
});
