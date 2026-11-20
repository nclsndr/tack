import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { ReaderConfig } from "./types.ts";

const names = z.array(z.string().trim().min(1));
const customization = <Preset extends string>(preset: Preset) =>
  z
    .strictObject({ preset: z.literal(preset).optional(), module: z.string().min(1).optional() })
    .refine(
      (value) => value.preset !== undefined || value.module !== undefined,
      "Select an explicit preset or module",
    );
const metadata = z
  .strictObject({
    preset: z.literal("working-docs").optional(),
    types: names.optional(),
    statuses: names.optional(),
    tags: names.optional(),
  })
  .refine(
    (value) =>
      value.preset !== undefined || (value.types !== undefined && value.statuses !== undefined),
    "Select a metadata preset or explicitly declare types and statuses",
  );
const navigation = z
  .strictObject({
    preset: z.literal("folders").optional(),
    module: z.string().min(1).optional(),
    archive: names.min(1).optional(),
  })
  .refine(
    (value) => value.preset !== undefined || value.module !== undefined,
    "Select an explicit preset or module",
  )
  .refine(
    (value) => value.archive === undefined || value.preset !== undefined,
    "Archive folders require the folders navigation preset",
  );
const schema = z.strictObject({
  version: z.literal(1),
  content: z
    .array(z.strictObject({ root: z.string().min(1), include: names.min(1), exclude: names }))
    .min(1),
  navigation,
  layouts: customization("reader"),
  components: customization("standard"),
  metadata,
});

const workingDocs = {
  types: ["walkthrough", "explanation", "reference", "decision", "spec", "note"],
  statuses: ["draft", "review", "accepted", "active", "complete", "superseded"],
  tags: [],
};

/** A repository must fix configuration before a reader session can start. */
export class ReaderConfigurationError extends Error {
  override name = "ReaderConfigurationError";
}

function inside(worktree: string, path: string) {
  const difference = relative(worktree, path);
  return (
    difference !== ".." &&
    difference.startsWith("../") === false &&
    isAbsolute(difference) === false
  );
}

function absent(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Resolves a path that may not exist yet below its nearest existing ancestor, so a later-created
 * directory is still checked against the worktree boundary. Returns undefined when the path itself
 * exists, a dangling link, or a non-directory ancestor must be reported instead.
 */
async function absentLocation(
  absolute: string,
): Promise<{ ancestor: string; location: string } | undefined> {
  try {
    await lstat(absolute);
    return undefined;
  } catch (error) {
    if (absent(error) === false) return undefined;
  }
  const parent = dirname(absolute);
  if (parent === absolute) return undefined;
  try {
    const actual = await realpath(parent);
    return (await stat(actual)).isDirectory() === true
      ? { ancestor: actual, location: join(actual, relative(parent, absolute)) }
      : undefined;
  } catch (error) {
    if (absent(error) === false) return undefined;
    const outer = await absentLocation(parent);
    return outer === undefined
      ? undefined
      : { ancestor: outer.ancestor, location: join(outer.location, relative(parent, absolute)) };
  }
}

/**
 * Resolves one declared location inside the worktree. An `optional` directory that does not exist
 * yet resolves to where it will appear; a path that exists but has the wrong kind, a dangling link,
 * an unreadable path and any escape from the worktree still fail.
 */
async function declaredPath(worktree: string, path: string, directory: boolean, optional = false) {
  const absolute = resolve(worktree, path);
  if (inside(worktree, absolute) === false) {
    throw new ReaderConfigurationError(
      `Reader path ${path} must stay inside the selected worktree ${worktree}.`,
    );
  }
  try {
    const actual = await realpath(absolute);
    if (inside(worktree, actual) === false) {
      throw new ReaderConfigurationError(
        `Reader path ${path} resolves outside the selected worktree.`,
      );
    }
    const status = await stat(actual);
    if (directory === true ? status.isDirectory() === false : status.isFile() === false) {
      throw new ReaderConfigurationError(
        `Reader path ${path} must be a ${directory === true ? "directory" : "file"}.`,
      );
    }
    return actual;
  } catch (error) {
    if (error instanceof ReaderConfigurationError) throw error;
    if (optional === true && absent(error) === true) {
      const pending = await absentLocation(absolute);
      if (pending !== undefined) {
        if (inside(worktree, pending.ancestor) === false) {
          throw new ReaderConfigurationError(
            `Reader path ${path} resolves outside the selected worktree.`,
          );
        }
        return pending.location;
      }
    }
    throw new ReaderConfigurationError(
      `Reader path ${path} does not exist or cannot be read. Declare an existing ${directory === true ? "content directory" : "customization module"}.`,
    );
  }
}

/** Reads YAML configuration; a file with another extension is refused. */
export async function readReaderYaml(configPath: string): Promise<unknown> {
  if ([".yaml", ".yml"].includes(extname(configPath)) === false) {
    throw new ReaderConfigurationError(
      `${configPath}: reader configuration must use a .yaml or .yml file.`,
    );
  }
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch {
    throw new ReaderConfigurationError(`${configPath} is required and must be readable.`);
  }
  try {
    return parse(source);
  } catch {
    throw new ReaderConfigurationError(`${configPath} must contain valid YAML.`);
  }
}

/** Loads a complete reader contract from an explicitly selected YAML file. */
export async function loadReaderConfig(
  worktree: string,
  configPath = "tack.reader.yaml",
): Promise<ReaderConfig> {
  const absoluteConfig = resolve(worktree, configPath);
  return resolveReaderConfig(worktree, await readReaderYaml(absoluteConfig), absoluteConfig);
}

/** Validates settings and resolves all declared locations against the owning source. */
export async function resolveReaderConfig(
  worktree: string,
  input: unknown,
  configPath: string,
): Promise<ReaderConfig> {
  const root = await realpath(resolve(worktree));
  const parsed = schema.safeParse(input);
  if (parsed.success === false) {
    throw new ReaderConfigurationError(
      `${configPath}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  const value = parsed.data;
  const resolveCustomization = async <Preset extends string>(entry: {
    preset?: Preset | undefined;
    module?: string | undefined;
  }) => ({
    ...(entry.preset === undefined ? {} : { preset: entry.preset }),
    ...(entry.module === undefined
      ? {}
      : { module: await declaredPath(root, entry.module, false) }),
  });
  return {
    version: value.version,
    worktree: root,
    configPath,
    content: await Promise.all(
      value.content.map(async (entry) => ({
        ...entry,
        root: await declaredPath(root, entry.root, true, true),
      })),
    ),
    navigation: {
      ...(await resolveCustomization(value.navigation)),
      ...(value.navigation.archive === undefined
        ? {}
        : {
            archive: await Promise.all(
              value.navigation.archive.map((folder) => declaredPath(root, folder, true, true)),
            ),
          }),
    },
    layouts: await resolveCustomization(value.layouts),
    components: await resolveCustomization(value.components),
    metadata: {
      ...(value.metadata.preset === undefined ? {} : { preset: value.metadata.preset }),
      types: [
        ...new Set([
          ...(value.metadata.preset === undefined ? [] : workingDocs.types),
          ...(value.metadata.types ?? []),
        ]),
      ],
      statuses: [
        ...new Set([
          ...(value.metadata.preset === undefined ? [] : workingDocs.statuses),
          ...(value.metadata.statuses ?? []),
        ]),
      ],
      tags: [
        ...new Set([
          ...(value.metadata.preset === undefined ? [] : workingDocs.tags),
          ...(value.metadata.tags ?? []),
        ]),
      ],
    },
  };
}

/** Supplies ordinary Markdown defaults for one registered docs directory. */
export function defaultReaderConfig(worktree: string, directory: string): ReaderConfig {
  return {
    version: 1,
    worktree,
    configPath: `${directory}/(reader defaults)`,
    content: [{ root: directory, include: ["*.md", "*.mdx", "**/*.md", "**/*.mdx"], exclude: [] }],
    navigation: { preset: "folders" },
    layouts: { preset: "reader" },
    components: { preset: "standard" },
    metadata: { preset: "working-docs", ...workingDocs },
  };
}
