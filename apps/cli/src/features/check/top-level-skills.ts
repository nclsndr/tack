import { Effect, FileSystem, Path } from "effect";
import { ResourceKindSchema, resourceKinds } from "../../domain/resources/kinds.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { isStrictlyInside } from "../../domain/identity/path-containment.ts";

/** The conventional kind folders, `skills` to `docs`, which hold resources rather than being one. */
const kindFolderNames: ReadonlySet<string> = new Set(
  ResourceKindSchema.literals.map((kind) => resourceKinds[kind].declarationKey),
);

/**
 * The folders at the top of a folder that hold `SKILL.md` directly, in code-unit order. Dot and
 * underscore folders, the kind folders and folders that resolve outside it are not candidates.
 */
export const topLevelSkillFolders = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = [...(yield* fs.readDirectory(root))].sort(compareCodeUnits);
  const holdsSkill = yield* Effect.forEach(names, (name) =>
    name.startsWith(".") === true || name.startsWith("_") === true || kindFolderNames.has(name)
      ? Effect.succeed(false)
      : Effect.gen(function* () {
          const folder = yield* fs.realPath(path.join(root, name));
          if (isStrictlyInside(root, folder) === false) return false;
          return (yield* fs.stat(path.join(folder, "SKILL.md"))).type === "File";
        }).pipe(Effect.orElseSucceed(() => false)),
  );
  return names.filter((_, index) => holdsSkill[index] === true);
});
