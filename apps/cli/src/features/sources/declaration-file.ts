import { Effect, FileSystem, Path, Predicate } from "effect";
import { decodeSourceDeclaration } from "../../domain/sources/source-schema.ts";
import { declarationFileName } from "@tackup/reader/source-edges";

export { declarationFileName };

/** Reads the raw text of the declaration file at a source root. */
export const readDeclarationText = Effect.fnUntraced(function* (root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(root, declarationFileName));
});

/** Decodes a parsed declaration, refusing keys its shape does not name. */
export const decodeDeclaration = decodeSourceDeclaration;

/**
 * Whether a parsed YAML document names a supported version. A document without a `version` key
 * passes, so the schema decode reports the missing field with its own code.
 */
export const checkDeclarationVersion = (
  parsed: unknown,
  supported: ReadonlyArray<unknown>,
): boolean =>
  Predicate.hasProperty(parsed, "version") === false || supported.includes(parsed.version);
