import { Option, Schema } from "effect";
import {
  ProfilePublicationSchema,
  type ProfilePublication,
  type ProfileFinding,
} from "../../domain/profiles/profile-schema.ts";
import { isCollection, type SourceDeclaration } from "../../domain/sources/source-schema.ts";

/** Creates a structural finding at the authored file or publication field. */
export const profileStructureFinding = (
  file: string,
  code: string,
  message: string,
  remedy: string,
  field?: string,
): ProfileFinding => ({
  code,
  category: "structure",
  severity: "error",
  file,
  message,
  remedy,
  ...(field === undefined ? {} : { field }),
});

/** Decodes publications independently, retaining valid entries beside broken ones. */
export const profilePublications = (
  sourcePath: string,
  declaration: SourceDeclaration,
): {
  readonly publications: ReadonlyArray<ProfilePublication>;
  readonly findings: ReadonlyArray<ProfileFinding>;
} => {
  if (isCollection(declaration) || declaration.profiles === undefined)
    return { publications: [], findings: [] };
  const file = `${sourcePath}/tack.yaml`;
  if (Array.isArray(declaration.profiles) === false)
    return {
      publications: [],
      findings: [
        profileStructureFinding(
          file,
          "profile-publication-invalid",
          "profiles must be a list.",
          "Use profiles: [{ name: ci, path: profiles/ci.yaml }].",
          "profiles",
        ),
      ],
    };
  const decoded = declaration.profiles.map((value: unknown, index: number) => {
    const result = Schema.decodeUnknownOption(ProfilePublicationSchema, {
      onExcessProperty: "error",
    })(value);
    return Option.isSome(result)
      ? { publication: result.value }
      : {
          finding: profileStructureFinding(
            file,
            "profile-publication-invalid",
            "A profile publication needs a portable name and source-relative path.",
            "Use only name and path on each publication.",
            `profiles[${index}]`,
          ),
        };
  });
  const publications = decoded.flatMap((entry) =>
    entry.publication === undefined ? [] : [entry.publication],
  );
  const duplicates = publications.filter((entry, index) =>
    publications.some(
      (other, otherIndex) =>
        index !== otherIndex && (other.name === entry.name || other.path === entry.path),
    ),
  );
  return {
    publications: publications.filter((entry) => duplicates.includes(entry) === false),
    findings: [
      ...decoded.flatMap((entry) => (entry.finding === undefined ? [] : [entry.finding])),
      ...duplicates.map((entry) =>
        profileStructureFinding(
          file,
          "profile-publication-duplicate",
          `Profile ${entry.name} has a duplicate name or path.`,
          "Give every profile a distinct name and file.",
          "profiles",
        ),
      ),
    ],
  };
};
