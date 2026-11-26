import { Effect, FileSystem, Path } from "effect";
import { marksSourceEdge } from "@tackup/reader/source-edges";
import { isStrictlyInside } from "../../domain/identity/path-containment.ts";
import { sourceFolderPath } from "../../domain/sources/source-schema.ts";

/**
 * Explains why a declared path breaks the syntax rules, or returns undefined when it follows
 * them: `.` alone, which names the source folder, or a relative, `/`-separated path with no `.`,
 * `..` or empty segment and no backslash.
 */
export const declaredPathSyntaxIssue = (value: string): string | undefined =>
  value === sourceFolderPath ||
  (value.length > 0 &&
    value.startsWith("/") === false &&
    value.includes("\\") === false &&
    value.split("/").every((part) => part.length > 0 && part !== ".." && part !== "."))
    ? undefined
    : "A declared path must be . for the source folder, or a source-relative, /-separated path without ., .. or empty segments.";

/**
 * The first folder from below the source root down to `resolved` that is the root of another
 * source, or undefined when none is. The search stops at a skill folder, whose content is never
 * another source. For a file, the folders that hold it are searched.
 */
const sourceEdgeOnPath = Effect.fnUntraced(function* (
  sourceRoot: string,
  resolved: string,
  type: FileSystem.File.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const relative = path.relative(sourceRoot, resolved);
  // The source folder itself is the root of this source, never of another one.
  const parts = relative === "" ? [] : relative.split(path.sep);
  const folders = (type === "Directory" ? parts : parts.slice(0, -1)).map((_, index) =>
    path.join(sourceRoot, ...parts.slice(0, index + 1)),
  );
  for (const folder of folders) {
    // A folder that cannot be listed is reported by the walk that reads it, never here.
    const names = yield* fs
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    if (marksSourceEdge(names) === true) return folder;
    if (names.includes("SKILL.md") === true) return undefined;
  }
  return undefined;
});

/**
 * Resolves a syntactically valid declared path against its source: the target must exist, must
 * lie strictly inside the source after symlinks, or be the source folder that `.` names, must not
 * be or lie inside another source, and must be readable. The caller checks the type.
 */
export const resolveDeclaredPath = Effect.fnUntraced(function* (
  sourceRoot: string,
  declared: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    const resolved = yield* fs.realPath(path.join(sourceRoot, declared));
    if (
      isStrictlyInside(sourceRoot, resolved) === false &&
      (declared !== sourceFolderPath || resolved !== sourceRoot)
    )
      return {
        ok: false as const,
        code: "declaration-path-outside-source" as const,
        message: "The declared path resolves outside its source.",
      };
    const info = yield* fs.stat(resolved);
    yield* fs.access(resolved, { readable: true });
    const edge = yield* sourceEdgeOnPath(sourceRoot, resolved, info.type);
    if (edge !== undefined) {
      const nested = path.relative(sourceRoot, edge);
      return {
        ok: false as const,
        code: "declaration-reaches-source" as const,
        message: `The declared path ${edge === resolved ? "is" : "lies inside"} ${nested}, which holds its own tack.yaml and is another source. Declare these resources in ${nested}/tack.yaml, or delete ${nested}/tack.yaml to keep them in this source.`,
      };
    }
    return { ok: true as const, resolved, type: info.type };
  }).pipe(
    Effect.catch((error) => {
      const missing = error.reason._tag === "NotFound";
      return Effect.succeed({
        ok: false as const,
        code: missing ? ("declaration-path-missing" as const) : ("resource-unreadable" as const),
        message: missing ? "The declared path does not exist." : error.message,
      });
    }),
  );
});
