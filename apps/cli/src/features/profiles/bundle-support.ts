import type { BundleReference } from "../../domain/bundles/bundle-reference.ts";
import type { BundleScannerShape } from "../../services/bundle-scanner.ts";
import { Schema } from "effect";
import { posixPath } from "../../domain/identity/portable.ts";
import type { ArchiveEntry } from "../../domain/bundles/tar.ts";
import type { ProfilePlanFinding } from "../../domain/profiles/profile-schema.ts";
import { ResourceKindSchema } from "../../domain/resources/kinds.ts";

/** One resource's support: the files a bundle carries for it and its non-secret requirements. */
export const BundleSupportEntrySchema = Schema.Struct({
  kind: ResourceKindSchema,
  name: Schema.String,
  complete: Schema.Literal(true),
  files: Schema.Array(Schema.String),
  prerequisites: Schema.Array(Schema.String),
  package: Schema.optionalKey(Schema.Literal("none")),
});

/** Authors make otherwise unknown support closure and non-secret runtime requirements explicit. */
export const BundleSupportSchema = Schema.Array(BundleSupportEntrySchema);
export type BundleSupport = typeof BundleSupportSchema.Type;
const codeFile = /\.[cm]?[jt]sx?$/i;

/** Checks static local imports and package facts without importing modules or installing packages. */
export const inspectBundleSupport = (
  scanner: BundleScannerShape,
  entries: ReadonlyArray<ArchiveEntry>,
  prerequisites: ReadonlyArray<string>,
): ReadonlyArray<ProfilePlanFinding> => {
  const builtins = new Set(scanner.builtinModules);
  const files = new Map(
    entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]),
  );
  const findings: ProfilePlanFinding[] = [];
  for (const entry of files.values()) {
    const document = /\.mdx?$/i.test(entry.path);
    if (codeFile.test(entry.path) === false && document === false) continue;
    const original = new TextDecoder().decode(entry.bytes);
    let references: ReadonlyArray<BundleReference>;
    try {
      references = scanner.references(entry.path, original);
    } catch {
      findings.push({
        code: "profile-bundle-incomplete",
        message: `${entry.path} cannot be inspected statically. Repair its module/document syntax or declare materialized support.`,
      });
      continue;
    }
    for (const reference of references.filter((value) => value.kind === "asset")) {
      const url = reference.value;
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url)) continue;
      let local: string;
      try {
        local = decodeURIComponent(url.split(/[?#]/)[0] ?? "");
      } catch {
        findings.push({
          code: "profile-bundle-incomplete",
          message: `${entry.path} has an invalid support link ${url}.`,
        });
        continue;
      }
      const resolved = posixPath.normalize(posixPath.join(posixPath.dirname(entry.path), local));
      if (
        local.startsWith("/") ||
        [resolved, resolved + ".md", resolved + "/index.md", resolved + "/README.md"].every(
          (candidate) => entries.every((included) => included.path !== candidate),
        )
      )
        findings.push({
          code: "profile-bundle-incomplete",
          message: `${entry.path} requires missing support ${local}. Add this asset/document to bundle-support.files.`,
        });
    }
    findings.push(
      ...references
        .filter((reference) => reference.kind === "computed")
        .map((reference) => ({
          code: "profile-bundle-incomplete",
          message: `${entry.path} uses a computed ${reference.value}. Materialize and declare its required support closure before export.`,
        })),
    );
    const imports = references
      .filter((reference) => reference.kind === "module")
      .map((reference) => ({ path: reference.value }));
    for (const imported of imports) {
      if (builtins.has(imported.path)) continue;
      if (imported.path.startsWith(".")) {
        const resolved = posixPath.normalize(
          posixPath.join(posixPath.dirname(entry.path), imported.path),
        );
        if (
          [
            resolved,
            ...[".ts", ".tsx", ".js", ".jsx", ".json", "/index.ts", "/index.js"].map(
              (extension) => resolved + extension,
            ),
          ].some((candidate) => files.has(candidate))
        )
          continue;
        findings.push({
          code: "profile-bundle-incomplete",
          message: `${entry.path} requires missing support ${imported.path}. Add the file/directory to this resource's bundle-support.files.`,
        });
      } else {
        const name = imported.path.startsWith("@")
          ? imported.path.split("/").slice(0, 2).join("/")
          : (imported.path.split("/")[0] ?? imported.path);
        let directory = posixPath.dirname(entry.path);
        let packageFile: ArchiveEntry | undefined;
        while (directory !== "." && directory !== "/") {
          packageFile = files.get(`${directory}/package.json`);
          if (packageFile !== undefined) break;
          directory = posixPath.dirname(directory);
        }
        if (packageFile === undefined) {
          findings.push({
            code: "profile-bundle-incomplete",
            message: `${entry.path} imports ${name} without included package/lock facts. Declare package.json, its lockfile and the external runtime prerequisite; no package installation is automatic.`,
          });
          continue;
        }
        try {
          const declaration: unknown = JSON.parse(new TextDecoder().decode(packageFile.bytes));
          const decode = Schema.decodeUnknownSync(
            Schema.Struct({
              dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
              devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
              optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            }),
          );
          const manifest = decode(declaration);
          const version =
            manifest.dependencies?.[name] ??
            manifest.devDependencies?.[name] ??
            manifest.optionalDependencies?.[name];
          if (
            version === undefined ||
            /^(?:workspace:|file:|link:)/.test(version) ||
            ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"].every(
              (lock) => files.has(`${directory}/${lock}`) === false,
            ) ||
            prerequisites.every((requirement) => requirement.includes(name) === false)
          )
            findings.push({
              code: "profile-bundle-incomplete",
              message: `${entry.path} needs declared package ${name}, included lock information and an explicit non-secret setup prerequisite. Materialize workspace/file dependencies or use a published external prerequisite.`,
            });
        } catch {
          findings.push({
            code: "profile-bundle-incomplete",
            message: `Repair included package facts at ${packageFile.path}.`,
          });
        }
      }
    }
  }
  return findings;
};

/** Checks reader module/content declarations as data, without loading their implementation. */
export const inspectReaderBundleSupport = (
  settings: unknown,
  prefix: string,
  entries: ReadonlyArray<ArchiveEntry>,
): ReadonlyArray<ProfilePlanFinding> => {
  const paths = new Set(entries.map((entry) => entry.path));
  const findings: ProfilePlanFinding[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "module" || key === "root") && typeof child === "string") {
        const candidate = prefix + child;
        if (
          child.startsWith("/") ||
          child.split("/").some((part) => part === ".." || part === ".") ||
          paths.has(candidate) === false
        )
          findings.push({
            code: "profile-bundle-incomplete",
            message: `Reader ${key} ${child} is outside included support. Add its regular file/directory to bundle-support.files; never load a component to infer closure.`,
          });
      }
      visit(child);
    }
  };
  visit(settings);
  return findings;
};
