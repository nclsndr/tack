import { Effect, FileSystem, Path } from "effect";
import type { CheckFinding, CheckItem } from "../../domain/check/check-schema.ts";
import { docsWalkSkips, marksSourceEdge } from "@tackup/reader/source-edges";
import { declarationFileName } from "../sources/declaration-file.ts";
import { topLevelSkillFolders } from "./top-level-skills.ts";
import { oneSkillMessage } from "../sources/source.ts";
import { layoutCommands } from "../sources/source-scaffold.ts";

export type CheckInput = {
  readonly kind: CheckItem["kind"];
  readonly path: string;
  readonly owner?: string;
  readonly findings: ReadonlyArray<CheckFinding>;
};

/** Finds the nearest explicit source declaration for a profile file, without registration. */
const sourceAbove = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let directory = path.dirname(file);
  while (true) {
    if ((yield* fs.exists(path.join(directory, declarationFileName))) === true) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
});

/**
 * How a folder holds skills the way a source does: `one` with a `SKILL.md` at its root, `top`
 * with skill folders at its top, `skills` with them in its `skills` folder, or undefined. A folder
 * it cannot read holds none, so the docs check that follows reports why it cannot be read.
 */
const skillsLayout = (folder: string) =>
  skillsLayoutOrFails(folder).pipe(Effect.orElseSucceed(() => undefined));

const skillsLayoutOrFails = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if ((yield* fs.exists(path.join(folder, "SKILL.md"))) === true) return "one" as const;
  if ((yield* topLevelSkillFolders(folder)).length > 0) return "top" as const;
  const skills = path.join(folder, "skills");
  return (yield* fs.exists(skills)) === true && (yield* topLevelSkillFolders(skills)).length > 0
    ? ("skills" as const)
    : undefined;
});

/**
 * What a folder of skills without `tack.yaml` needs, as a remedy and the commands it names: the
 * previews a bare `source add` on the same folder suggests.
 */
const sourceAddRemedy = Effect.fnUntraced(function* (
  folder: string,
  layout: "one" | "top" | "skills",
) {
  if (layout === "one") return { remedy: oneSkillMessage(folder) } satisfies Partial<CheckFinding>;
  const next = yield* layoutCommands(folder);
  const [first] = next;
  return {
    remedy: `Run ${first?.join(" ")} to preview ${layout === "top" ? "a skills collection" : "its tack.yaml"}, then apply it.`,
    next,
  } satisfies Partial<CheckFinding>;
});

/** Detects paths independently, so one unreadable input cannot suppress the remaining checks. */
export const discoverCheckInput = Effect.fnUntraced(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(input);
  return yield* Effect.gen(function* (): Effect.fn.Return<
    CheckInput,
    import("effect").PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const canonical = yield* fs.realPath(absolute);
    const info = yield* fs.stat(canonical);
    if (info.type === "Directory") {
      if ((yield* fs.exists(path.join(canonical, declarationFileName))) === true)
        return { kind: "source", path: canonical, findings: [] };
      // A folder of skills is a source that lacks its declaration, not a folder of docs.
      const layout = yield* skillsLayout(canonical);
      return layout === undefined
        ? { kind: "docs", path: canonical, findings: [] }
        : {
            kind: "source",
            path: canonical,
            findings: [
              {
                code: "check-not-a-source",
                severity: "warning",
                file: canonical,
                line: 1,
                message: "No tack.yaml: this folder is not a Tack source yet.",
                ...(yield* sourceAddRemedy(canonical, layout)),
              },
            ],
          };
    }
    if (info.type !== "File")
      return {
        kind: "path",
        path: canonical,
        findings: [
          {
            code: "check-path-unsupported",
            severity: "error",
            file: canonical,
            line: 1,
            message: "Check supports regular source/profile/bundle/docs paths.",
          },
        ],
      };
    if (path.basename(canonical) === declarationFileName)
      return { kind: "source", path: path.dirname(canonical), findings: [] };
    if (canonical.endsWith(".tar.gz") === true)
      return { kind: "bundle", path: canonical, findings: [] };
    if (/\.mdx?$/.test(canonical) === true) return { kind: "docs", path: canonical, findings: [] };
    if (/\.ya?ml$/.test(canonical) === true) {
      const owner = yield* sourceAbove(canonical);
      return {
        kind: "profile",
        path: canonical,
        ...(owner === undefined ? {} : { owner }),
        findings: [],
      };
    }
    return {
      kind: "path",
      path: canonical,
      findings: [
        {
          code: "check-path-unsupported",
          severity: "error",
          file: canonical,
          line: 1,
          message:
            "Use a source folder/tack.yaml, a profile YAML file, a .tar.gz bundle, or Markdown docs.",
        },
      ],
    };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<CheckInput>({
        kind: "path",
        path: absolute,
        findings: [
          {
            code: "check-path-unavailable",
            severity: "error",
            file: absolute,
            line: 1,
            message: error.message,
          },
        ],
      }),
    ),
  );
});

/**
 * Enumerates docs once, avoiding the entries the reader's docs walk skips, the folders of another
 * source below the input, and symbolic directory cycles.
 */
export const documentationFiles = Effect.fnUntraced(function* (input: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const visited = new Set<string>();
  const walk = Effect.fnUntraced(function* (
    file: string,
  ): Effect.fn.Return<
    ReadonlyArray<string>,
    import("effect").PlatformError.PlatformError,
    FileSystem.FileSystem
  > {
    const canonical = yield* fs.realPath(file);
    if (visited.has(canonical) === true) return [];
    const top = visited.size === 0;
    visited.add(canonical);
    const info = yield* fs.stat(canonical);
    if (info.type === "File") return /\.mdx?$/.test(canonical) === true ? [canonical] : [];
    if (info.type !== "Directory") return [];
    const entries = yield* fs.readDirectory(canonical);
    if (top === false && marksSourceEdge(entries) === true) return [];
    const names = entries.filter((name) => docsWalkSkips(name) === false).sort();
    return (yield* Effect.forEach(names, (name) => walk(path.join(canonical, name)))).flat();
  });
  return yield* walk(input);
});
