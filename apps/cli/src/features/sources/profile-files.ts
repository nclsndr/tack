import { Yaml } from "../../domain/runtime-neutral.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  ProfileSchema,
  type ProfilePublication,
  type ProfileFinding,
} from "../../domain/profiles/profile-schema.ts";
import type { SourceDeclaration } from "../../domain/sources/source-schema.ts";
import { profilePublications, profileStructureFinding } from "./profile-publications.ts";
import { profileOverlap } from "./resource-declarations.ts";
import { declaredPathSyntaxIssue, resolveDeclaredPath } from "./declared-path.ts";
import { checkDeclarationVersion, declarationFileName } from "./declaration-file.ts";

/**
 * Reads a published file without importing any source content. A file that a skills, commands,
 * context or scripts entry also owns is refused, like any two overlapping entries.
 */
export const readProfileFile = Effect.fnUntraced(function* (
  sourcePath: string,
  declaration: SourceDeclaration,
  publication: ProfilePublication,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(sourcePath, publication.path);
  const fail = (code: string, message: string, remedy: string) => ({
    profile: undefined,
    file,
    findings: [profileStructureFinding(file, code, message, remedy)],
  });
  const syntax = declaredPathSyntaxIssue(publication.path);
  if (syntax !== undefined || publication.path === declarationFileName)
    return fail(
      "profile-path-invalid",
      syntax ?? "A profile cannot be tack.yaml.",
      "Choose a source-relative profile file without . or .. segments.",
    );
  const resolved = yield* resolveDeclaredPath(sourcePath, publication.path);
  if (resolved.ok === false)
    return fail(
      `profile-${resolved.code}`,
      resolved.message,
      "Create the profile file inside its source, or repair its publication path.",
    );
  if (resolved.type !== "File")
    return fail(
      "profile-path-wrong-type",
      "A profile must be a regular file.",
      "Publish a YAML file.",
    );
  const overlap = yield* profileOverlap(sourcePath, declaration, publication.path);
  if (overlap !== undefined)
    return fail(
      "declaration-path-overlap",
      overlap,
      "Exclude the profile file from the entry that holds it, or keep one of them.",
    );
  return yield* Effect.gen(function* () {
    const content = yield* fs.readFileString(resolved.resolved);
    const raw: unknown = yield* Effect.try({
      try: () => Yaml.parse(content),
      catch: (cause) => String(cause),
    });
    if (checkDeclarationVersion(raw, [1]) === false)
      return fail(
        "profile-version-unsupported",
        "This profile file version is unsupported.",
        "Use profile version 1 with this release.",
      );
    const profile = yield* Schema.decodeUnknownEffect(ProfileSchema, { onExcessProperty: "error" })(
      raw,
    ).pipe(Effect.mapError((error) => error.message));
    if (profile.name !== publication.name)
      return fail(
        "profile-publication-mismatch",
        `The file names ${profile.name}, but tack.yaml publishes ${publication.name}.`,
        "Make the file name field and publication name agree.",
      );
    return {
      profile,
      file,
      findings: [] as ReadonlyArray<ProfileFinding>,
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        fail(
          "profile-schema-invalid",
          typeof error === "string" ? error : error.message,
          "Repair the profile file using version, name, depends-on and members only.",
        ),
      ),
    ),
  );
});

/** Checks all published files, with no recipient state or external source resolution. */
export const checkProfilePublications = Effect.fnUntraced(function* (
  sourcePath: string,
  declaration: SourceDeclaration,
) {
  const publications = profilePublications(sourcePath, declaration);
  const files = yield* Effect.forEach(publications.publications, (publication) =>
    readProfileFile(sourcePath, declaration, publication),
  );
  return [...publications.findings, ...files.flatMap((file) => file.findings)];
});
