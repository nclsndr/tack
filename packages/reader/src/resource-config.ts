import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  defaultReaderConfig,
  readReaderYaml,
  ReaderConfigurationError,
  resolveReaderConfig,
} from "./config.ts";
import type { ReaderResource } from "./types.ts";

const partialConfig = z.strictObject({
  version: z.literal(1).optional(),
  content: z
    .array(
      z.strictObject({
        root: z.string(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  navigation: z
    .strictObject({
      preset: z.literal("folders").optional(),
      module: z.string().optional(),
      archive: z.array(z.string()).optional(),
    })
    .optional(),
  layouts: z
    .strictObject({ preset: z.literal("reader").optional(), module: z.string().optional() })
    .optional(),
  components: z
    .strictObject({ preset: z.literal("standard").optional(), module: z.string().optional() })
    .optional(),
  metadata: z
    .strictObject({
      preset: z.literal("working-docs").optional(),
      types: z.array(z.string()).optional(),
      statuses: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .optional(),
});

const sourceDeclaration = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  docs: z.array(z.unknown()),
});
const docsDeclaration = z.object({ name: z.string(), reader: z.unknown().optional() });
/** A docs collection: the whole source folder is one docs resource, with its settings on top. */
const docsCollection = z.object({
  version: z.literal(1),
  kind: z.literal("docs"),
  name: z.string(),
  reader: z.unknown().optional(),
});
const yamlLink = z
  .string()
  .min(1)
  .refine(
    (value) =>
      isAbsolute(value) === false &&
      value.includes("\\") === false &&
      value.split("/").every((part) => part.length > 0 && part !== ".." && part !== ".") &&
      /\.ya?ml$/.test(value),
    "Reader links must be source-relative .yaml or .yml paths without traversal.",
  );

async function sourcePath(source: string, path: string) {
  const absolute = resolve(source, path);
  const actual = await realpath(absolute);
  const difference = relative(source, actual);
  if (
    difference === ".." ||
    difference.startsWith(`..${sep}`) === true ||
    isAbsolute(difference) === true
  ) {
    throw new ReaderConfigurationError(`${path} resolves outside the registered source checkout.`);
  }
  return actual;
}

/** The docs entries of a list-form declaration, each with its name and reader settings. */
function docsEntries(value: unknown, path: string) {
  const declaration = sourceDeclaration.safeParse(value);
  if (declaration.success === false) {
    throw new ReaderConfigurationError(`${path}: ${declaration.error.message}`);
  }
  return declaration.data.docs.flatMap((item) => {
    const parsed = docsDeclaration.safeParse(item);
    return parsed.success === true ? [parsed.data] : [];
  });
}

async function readSettings(resource: ReaderResource, source: string) {
  const reference = resource.readerConfig;
  if (reference === undefined) return undefined;
  // Check the declared extension before resolving symlinks as well as the final target.
  if (/\.ya?ml$/.test(reference.path) === false) {
    throw new ReaderConfigurationError(
      `${reference.path}: reader configuration must use a .yaml or .yml file.`,
    );
  }
  const path = await sourcePath(source, reference.path);
  const value = await readReaderYaml(path);
  if (reference.kind === "file") return { value, path };
  const collection = docsCollection.safeParse(value);
  const entries = collection.success === true ? [collection.data] : docsEntries(value, path);
  const entry = entries.find((item) => item.name === resource.name);
  if (entry === undefined) {
    throw new ReaderConfigurationError(
      `${path}: docs resource ${resource.name} is no longer declared.`,
    );
  }
  if (entry.reader === undefined) return undefined;
  if (typeof entry.reader !== "string") return { value: entry.reader, path };
  const link = yamlLink.safeParse(entry.reader);
  if (link.success === false) {
    throw new ReaderConfigurationError(`${path}: ${link.error.message}`);
  }
  const linked = await sourcePath(source, link.data);
  return { value: await readReaderYaml(linked), path: linked };
}

/** Resolves inline or linked YAML settings with defaults for one docs resource. */
export async function loadResourceConfig(
  resource: ReaderResource,
  source: string,
  directory: string,
) {
  const defaults = defaultReaderConfig(source, directory);
  const settings = await readSettings(resource, source);
  if (settings === undefined) return { config: defaults, validateMetadata: false };
  const parsed = partialConfig.safeParse(settings.value);
  if (parsed.success === false) {
    throw new ReaderConfigurationError(`${settings.path}: ${parsed.error.message}`);
  }
  const custom = parsed.data;
  const customize = <Preset extends string>(
    entry: { preset?: Preset | undefined; module?: string | undefined } | undefined,
    preset: Preset,
  ) => (entry?.module === undefined ? { ...entry, preset: entry?.preset ?? preset } : entry);
  const config = await resolveReaderConfig(
    source,
    {
      version: 1,
      content:
        custom.content?.map((entry) => ({
          ...entry,
          include: entry.include ?? defaults.content.flatMap((item) => item.include),
          exclude: entry.exclude ?? [],
        })) ?? defaults.content,
      navigation: customize(custom.navigation, "folders"),
      layouts: customize(custom.layouts, "reader"),
      components: customize(custom.components, "standard"),
      metadata: {
        ...custom.metadata,
        types: custom.metadata?.types ?? defaults.metadata.types,
        statuses: custom.metadata?.statuses ?? defaults.metadata.statuses,
        tags: custom.metadata?.tags ?? defaults.metadata.tags,
      },
    },
    settings.path,
  );
  return {
    config,
    validateMetadata:
      custom.metadata?.preset !== undefined ||
      custom.metadata?.types !== undefined ||
      custom.metadata?.statuses !== undefined,
  };
}
