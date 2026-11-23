import { Yaml } from "../../domain/runtime-neutral.ts";
import { BundleScanner } from "../../services/bundle-scanner.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { Effect, FileSystem, Option, Path, type PlatformError, Result, Schema } from "effect";
import { resourceKinds, type ResourceKind } from "../../domain/resources/kinds.ts";
import type { Profile } from "../../domain/profiles/profile-schema.ts";
import type { DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import {
  byEntryKind,
  entryRootPath,
  resourceAddressIdentity,
  type Catalog,
} from "../../domain/sources/catalog-schema.ts";
import { isCollection, type SourceDeclaration } from "../../domain/sources/source-schema.ts";
import { marksSourceEdge } from "@tackup/reader/source-edges";
import type { BundleContent } from "../../domain/bundles/bundle-schema.ts";
import { bundleDigest } from "../../domain/bundles/bundle-codec.ts";
import type { ProfilePlanFinding } from "../../domain/profiles/profile-schema.ts";
import { makeBundleFileCollector, type BundleBudget } from "./bundle-files.ts";
import { decodeImportRecord } from "../../domain/imports/import-record.ts";
import { docsEntrySchema } from "../sources/docs-discovery.ts";
import { declarationFileName } from "../sources/declaration-file.ts";

/** What bundling needs from one kind beyond the resource's own path. */
type KindBundling = {
  /** Its own path does not show everything it needs, so `bundle-support` must declare that. */
  readonly needsSupport: boolean;
  /** What a person needs to run it, when Tack runs it; its package files must then travel too. */
  readonly runtime?: string;
};

const kindBundling: Readonly<Record<ResourceKind, KindBundling>> = {
  skill: { needsSupport: false },
  command: { needsSupport: false },
  context: { needsSupport: false },
  script: {
    needsSupport: true,
    runtime:
      "Bun runtime; run scripts explicitly with Tack. No code or package installer runs during bundle operations.",
  },
  docs: { needsSupport: true },
};

/** Projects one source's exact resources/support and keeps current-byte provenance inspectable. */
export const collectBundleSource = Effect.fnUntraced(function* (request: {
  readonly source: Extract<DeclaredSourceInspection, { readonly status: "healthy" }>;
  readonly key: string;
  readonly selected: Catalog["entries"];
  readonly direct: ReadonlySet<string>;
  readonly bindings: Readonly<Record<string, string>>;
  readonly budget: BundleBudget;
  readonly ambientSources: ReadonlySet<string>;
  readonly defining?: { readonly profile: Profile; readonly file: string };
}) {
  const { BundleSupportSchema, inspectBundleSupport, inspectReaderBundleSupport } =
    yield* Effect.promise(() => import("./bundle-support.ts"));
  const { source, key, selected, direct, bindings, budget, defining, ambientSources } = request;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = source.registration.canonicalPath;
  const authored = source.declaration;
  /** A docs collection is its whole folder, so its own folder is its complete support closure. */
  const docsCollection = isCollection(authored) && authored.kind === "docs" ? authored : undefined;
  const prefix = `sources/${key}/`;
  const findings: ProfilePlanFinding[] = [];
  const collector = yield* makeBundleFileCollector(root, prefix, findings, budget);
  const { entries: sourceEntries, add, include, checkDeclaredPath } = collector;
  /**
   * Includes a docs collection's folder: every entry at its top but its own `tack.yaml`, which the
   * projection writes, tool state and dependencies, and the folders of another source.
   */
  const includeCollectionFolder = Effect.fnUntraced(function* () {
    for (const name of [...(yield* fs.readDirectory(root))].sort(compareCodeUnits)) {
      if (name === declarationFileName || name.startsWith(".") || name === "node_modules") continue;
      const names = yield* fs
        .readDirectory(path.join(root, name))
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      if (marksSourceEdge(names) === false) yield* include(name);
    }
  });
  const supportDecoded = yield* Schema.decodeUnknownEffect(BundleSupportSchema, {
    onExcessProperty: "error",
  })((isCollection(authored) ? undefined : authored["bundle-support"]) ?? []).pipe(Effect.option);
  const support = Option.getOrUndefined(supportDecoded) ?? [];
  if (Option.isNone(supportDecoded))
    findings.push({
      code: "profile-bundle-incomplete",
      message: `${source.label ?? key}: repair bundle-support entries (kind/name, complete: true, files, prerequisites, optional package: none).`,
    });
  const resources: BundleContent["sources"][number]["resources"][number][] = [];
  const prerequisites = new Set<string>();
  const declarations: {
    skills: Array<{ path: string }>;
    commands: Array<{ path: string }>;
    context: Array<{ path: string; include?: string[] }>;
    scripts: Array<{ name: string; path: string; description: string }>;
    docs: Array<typeof docsEntrySchema.Type>;
  } = { skills: [], commands: [], context: [], scripts: [], docs: [] };
  /** Adds one resource, at its path relative to the source, to the projected `tack.yaml`. */
  const declare = byEntryKind<
    [relative: string],
    Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>
  >({
    skill: (_entry, relative) =>
      Effect.sync(() => {
        declarations.skills.push({ path: relative });
      }),
    command: (_entry, relative) =>
      Effect.sync(() => {
        declarations.commands.push({ path: relative });
      }),
    context: (entry, relative) =>
      Effect.gen(function* () {
        const declared = entry.declaredPath;
        if (
          declared !== undefined &&
          (yield* fs.stat(path.join(root, declared))).type === "Directory"
        ) {
          const literal = path
            .relative(path.join(root, declared), entry.filePath)
            .split(path.sep)
            .join("/")
            .replace(/[\\*?[\]{}()!]/g, "\\$&");
          const existing = declarations.context.find((item) => item.path === declared);
          if (existing === undefined)
            declarations.context.push({ path: declared, include: [literal] });
          else existing.include?.push(literal);
        } else declarations.context.push({ path: relative });
      }),
    script: (entry, relative) =>
      Effect.sync(() => {
        declarations.scripts.push({
          name: entry.address.name,
          path: relative,
          description: entry.description,
        });
      }),
    docs: (entry, relative) =>
      Effect.gen(function* () {
        const declared =
          docsCollection ??
          Schema.decodeUnknownSync(Schema.Array(docsEntrySchema))(
            isCollection(authored) ? [] : authored.docs,
          ).find((item) => item.name === entry.address.name);
        declarations.docs.push({
          name: entry.address.name,
          path: relative,
          ...(declared?.reader === undefined ? {} : { reader: declared.reader }),
        });
        if (typeof declared?.reader === "string") {
          yield* include(declared.reader);
          const config = sourceEntries.get(prefix + declared.reader);
          if (config !== undefined) {
            try {
              findings.push(
                ...inspectReaderBundleSupport(
                  Yaml.parse(new TextDecoder().decode(config.bytes)),
                  prefix,
                  [...sourceEntries.values()],
                ),
              );
            } catch {
              findings.push({
                code: "profile-bundle-incomplete",
                message: `Repair data-only reader settings at ${declared.reader}.`,
              });
            }
          }
        } else if (declared?.reader !== undefined)
          findings.push(
            ...inspectReaderBundleSupport(declared.reader, prefix, [...sourceEntries.values()]),
          );
      }),
  });
  for (const entry of selected) {
    const relative = path.relative(root, entryRootPath(entry)).split(path.sep).join("/");
    const extra = support.find(
      (item) => item.kind === entry.address.kind && item.name === entry.address.name,
    );
    const bundling = kindBundling[entry.address.kind];
    if (bundling.needsSupport === true && extra === undefined && docsCollection === undefined)
      findings.push({
        code: "profile-bundle-incomplete",
        message: `${entry.address.kind} ${entry.address.name} has unknown support closure. Declare bundle-support with complete: true, files and non-secret prerequisites before export.`,
      });
    for (const requirement of extra?.prerequisites ?? []) {
      if (/(?:password|secret|token|api[_-]?key)\s*[:=]/i.test(requirement))
        findings.push({
          code: "profile-bundle-sensitive",
          message: `${entry.address.name}: prerequisites must describe setup without secret values.`,
        });
      prerequisites.add(requirement);
    }
    if (bundling.runtime !== undefined) {
      prerequisites.add(bundling.runtime);
      if (
        extra !== undefined &&
        extra.package !== "none" &&
        extra.files.includes("package.json") === false
      )
        findings.push({
          code: "profile-bundle-incomplete",
          message: `${entry.address.name}: include package.json and lock information, or explicitly declare package: none for a self-contained script.`,
        });
    }
    if (
      "dependencies" in entry &&
      entry.dependencies.some(
        (dependency) =>
          dependency.source !== undefined && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(dependency.source),
      )
    )
      findings.push({
        code: "profile-bundle-incomplete",
        message: `${entry.address.name}: replace machine-local dependency UUIDs with portable source names before export.`,
      });
    if (entry.declaredPath !== undefined) yield* checkDeclaredPath(entry.declaredPath);
    if (docsCollection === undefined) yield* include(relative);
    else yield* includeCollectionFolder();
    for (const file of extra?.files ?? []) yield* include(file);
    let provenance: BundleContent["sources"][number]["resources"][number]["provenance"];
    if (
      resourceKinds[entry.address.kind].importable === true &&
      "imports" in authored &&
      Array.isArray(authored.imports)
    ) {
      for (const value of authored.imports) {
        const record = decodeImportRecord(value);
        if (Result.isSuccess(record) && record.success.path === relative) {
          const current = [...sourceEntries.values()]
            .filter((file) => file.kind === "file" && file.path.startsWith(prefix + relative + "/"))
            .map(
              (file) =>
                [file.path.slice(prefix.length), bundleDigest(file.bytes), file.mode] as const,
            )
            .sort((left, right) => compareCodeUnits(left[0], right[0]));
          provenance = {
            location: record.success.location,
            revision: record.success.revision,
            upstreamPath: record.success["upstream-path"],
            importedDigest: record.success.digest,
            currentDigest: bundleDigest(JSON.stringify(current)),
          };
        }
      }
    }
    resources.push({
      kind: entry.address.kind,
      name: entry.address.name,
      path: relative,
      direct: direct.has(resourceAddressIdentity(entry.address)),
      ...(provenance === undefined ? {} : { provenance }),
    });
    yield* declare(entry, relative);
  }
  const dependsOn = ("depends-on" in authored ? authored["depends-on"] : undefined) ?? [];
  // A docs collection projects as itself; every other source projects as the list form.
  const declaration: SourceDeclaration =
    docsCollection === undefined
      ? {
          version: 2,
          name: authored.name,
          "depends-on": dependsOn.filter(
            (name) => bindings[name] !== undefined || ambientSources.has(name) === true,
          ),
          ...Object.fromEntries(
            Object.entries(declarations).filter(([, values]) => values.length > 0),
          ),
          ...(defining !== undefined
            ? {
                profiles: [
                  {
                    name: defining.profile.name,
                    path: path.relative(root, defining.file).split(path.sep).join("/"),
                  },
                ],
              }
            : {}),
        }
      : {
          version: 1,
          kind: "docs",
          name: docsCollection.name,
          ...(docsCollection.reader === undefined ? {} : { reader: docsCollection.reader }),
        };
  if (defining !== undefined)
    yield* include(path.relative(root, defining.file).split(path.sep).join("/"));
  add({
    path: prefix + declarationFileName,
    kind: "file",
    mode: 0o644,
    bytes: new TextEncoder().encode(Yaml.stringify(declaration)),
  });
  findings.push(
    ...inspectBundleSupport(yield* BundleScanner, [...sourceEntries.values()], [...prerequisites]),
  );

  const projection: BundleContent["sources"][number] = {
    key,
    ...(source.label === undefined ? {} : { name: source.label }),
    bindings,
    resources,
    prerequisites: [...prerequisites],
  };
  return { projection, entries: [...sourceEntries.values()], findings };
});
