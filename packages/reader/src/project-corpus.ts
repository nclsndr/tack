import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { ReaderConfigurationError } from "./config.ts";
import { checkBrowserBuild, resolveModule, scanImports } from "./host.ts";
import { keepTreesUsedBy } from "./parsed-source.ts";
import { loadResourceConfig } from "./resource-config.ts";
import { loadCorpusReport, type CorpusDocumentFailure } from "./source.ts";
import type {
  DocsResourceReference,
  ReaderConfig,
  ReaderDocument,
  ReaderProjectCorpus,
  ReaderProjectInput,
  ReaderResource,
  ReaderResourceIssue,
  ReaderResourceLoadResult,
} from "./types.ts";

function inside(directory: string, path: string) {
  const difference = relative(directory, path);
  return (
    difference !== ".." &&
    difference.startsWith(`..${sep}`) === false &&
    isAbsolute(difference) === false
  );
}

function resourceReference(resource: ReaderResource): DocsResourceReference {
  return {
    sourceRegistrationId: resource.sourceRegistrationId,
    name: resource.name,
  };
}

const moduleExtensions = [".ts", ".tsx", ".js", ".jsx", ".json"];
const assetExtensions = [".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp"];

async function resolveLocalModule(path: string, specifier: string, sourceRoot: string) {
  if (isAbsolute(specifier) === true || specifier.startsWith("file:") === true)
    throw new ReaderConfigurationError(
      `${path}: imported source ${specifier} must stay relative to the registered source checkout.`,
    );
  if (specifier.startsWith(".") === false) return undefined;
  const candidate = resolve(dirname(path), specifier);
  const possibilities =
    extname(candidate) === ""
      ? [
          candidate,
          ...moduleExtensions.map((extension) => `${candidate}${extension}`),
          ...assetExtensions.map((extension) => `${candidate}${extension}`),
          ...moduleExtensions.map((extension) => resolve(candidate, `index${extension}`)),
        ]
      : [candidate];
  for (const possibility of possibilities) {
    try {
      const actual = await realpath(possibility);
      if (inside(sourceRoot, actual) === false) {
        throw new ReaderConfigurationError(
          `${path}: imported source ${specifier} resolves outside the registered source checkout.`,
        );
      }
      return actual;
    } catch (error) {
      if (error instanceof ReaderConfigurationError) throw error;
    }
  }
  throw new ReaderConfigurationError(`${path}: imported source ${specifier} cannot be read.`);
}

/** Transpiler loaders by module extension; any other module is plain JavaScript. */
const transpilerLoaders: Readonly<Record<string, "ts" | "tsx" | "jsx">> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
};

function importedSpecifiers(path: string, source: string) {
  const loader = transpilerLoaders[extname(path)] ?? "js";
  return scanImports(source, loader);
}

function cssSpecifiers(source: string) {
  const imports = [...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
  const assets = [...source.matchAll(/url\(\s*["']?([^\s)'";]+)["']?\s*\)/g)].map(
    (match) => match[1] ?? "",
  );
  return [...imports, ...assets].filter((specifier) => specifier.startsWith(".") === true);
}

async function moduleTree(path: string, sourceRoot: string, seen: Set<string>): Promise<string[]> {
  if (seen.has(path) === true) return [];
  const extension = extname(path);
  const unsupportedExtension = moduleExtensions.includes(extension) === false;
  if ((unsupportedExtension || extension === ".json") && extension !== ".css") return [path];
  const source = await readFile(path, "utf8");
  const visited = new Set([...seen, path]);
  const children = await Promise.all(
    (extension === ".css" ? cssSpecifiers(source) : importedSpecifiers(path, source)).map(
      async (specifier) => {
        const imported = await resolveLocalModule(path, specifier, sourceRoot);
        return imported === undefined ? [] : moduleTree(imported, sourceRoot, visited);
      },
    ),
  );
  return [path, ...children.flat()];
}

/** Transpiles source-defined React modules without evaluating them before a resource joins the corpus. */
/**
 * Packages the reader provides to source modules, so a source never brings a second copy. React DOM
 * is among them so a source component can use a portal.
 */
const providedPackages = ["react", "react-dom", "@tackup/reader", "@rspress/core"] as const;
const providedExternals = providedPackages.flatMap((name) => [name, `${name}/*`]);

async function preflightCustomModules(
  sourceRoot: string,
  config: ReaderConfig,
  documents: ReaderDocument[],
) {
  const configured = [
    config.navigation.module,
    config.layouts.module,
    config.components.module,
  ].flatMap((path) => (path === undefined ? [] : [path]));
  const documentImports = await Promise.all(
    documents.flatMap((document) =>
      document.imports.map((entry) =>
        resolveLocalModule(document.path, entry.specifier, sourceRoot),
      ),
    ),
  );
  const entries = [
    ...configured,
    ...documentImports.flatMap((entry) => (entry === undefined ? [] : [entry])),
  ].filter((path) => [".md", ".mdx"].includes(extname(path)) === false);
  const roots = entries.filter((entry, index, all) => all.indexOf(entry) === index);
  await Promise.all(roots.map((entry) => moduleTree(entry, sourceRoot, new Set<string>())));
  const documentPackages = await Promise.all(
    documents.flatMap((document) =>
      document.imports
        .map((entry) => entry.specifier)
        .filter(
          (specifier) =>
            specifier.startsWith(".") === false &&
            providedPackages.some(
              (external) => specifier === external || specifier.startsWith(`${external}/`),
            ) === false,
        )
        .map(async (specifier) => {
          try {
            return await resolveModule(specifier, document.path);
          } catch {
            throw new ReaderConfigurationError(
              `${document.path}: imported package ${specifier} cannot be resolved from its source checkout.`,
            );
          }
        }),
    ),
  );
  const packageRoots = documentPackages.filter((entry, index, all) => all.indexOf(entry) === index);
  const results = await Promise.all([
    ...roots.map((entry) => checkBrowserBuild(entry, providedExternals)),
    ...packageRoots.map((entry) => checkBrowserBuild(entry, providedExternals)),
  ]);
  const messages = results.flatMap((result) => result.messages);
  if (results.some((result) => result.success === false)) {
    throw new ReaderConfigurationError(
      messages.join("\n") || "Source component compilation failed.",
    );
  }
}

/** Options for one project corpus load. */
export type ProjectCorpusOptions = {
  /**
   * Whether to compile a resource's custom render modules before it joins the corpus. Serving
   * needs them; search reads plain Markdown and does not, so a broken component never hides a hit.
   */
  readonly renderModules?: "check" | "skip";
};

const causeMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Names the document and its cause once, without repeating a path the cause already carries. */
function documentIssue(
  resource: ReaderResource,
  sourcePath: string,
  failure: CorpusDocumentFailure,
): ReaderResourceIssue {
  const message = causeMessage(failure.cause);
  return {
    resource: resourceReference(resource),
    sourcePath,
    code: "document-load",
    path: failure.path,
    message: message.includes(failure.path) ? message : `${failure.path}: ${message}`,
  };
}

async function loadResourceCorpus(
  resource: ReaderResource,
  options: ProjectCorpusOptions,
): Promise<ReaderResourceLoadResult> {
  const sourceRoot = await realpath(resource.sourcePath);
  const directoryPath = await realpath(resource.directoryPath);
  if (inside(sourceRoot, directoryPath) === false) {
    throw new ReaderConfigurationError(
      `${resource.name}: docs directory must stay inside the registered source checkout.`,
    );
  }
  const { config, validateMetadata } = await loadResourceConfig(
    resource,
    sourceRoot,
    directoryPath,
  );
  if (config.content.some((entry) => inside(directoryPath, entry.root) === false)) {
    throw new ReaderConfigurationError(
      `${resource.name}: reader configuration content must stay inside declared docs resource ${directoryPath}.`,
    );
  }
  if (
    config.navigation.archive?.some((folder) => inside(directoryPath, folder) === false) === true
  ) {
    throw new ReaderConfigurationError(
      `${resource.name}: reader configuration archive folders must stay inside declared docs resource ${directoryPath}.`,
    );
  }
  const loaded = { ...resource, sourcePath: sourceRoot, directoryPath };
  const { documents, failures } = await loadCorpusReport(config, {
    extensions: [".md", ".mdx"],
    relativeRoot: directoryPath,
    routePrefix: `/docs/${loaded.sourceRegistrationId}/${loaded.name}`,
    resource: { ...resourceReference(loaded), sourcePath: sourceRoot },
    requireTitle: false,
    validateMetadata,
  });
  if (options.renderModules !== "skip") await preflightCustomModules(sourceRoot, config, documents);
  return {
    resource: loaded,
    documents,
    issues: failures.map((failure) => documentIssue(loaded, sourceRoot, failure)),
    config,
  };
}

/**
 * Loads every selected docs resource independently so one saved-source error leaves healthy docs
 * usable. Inside a resource each selected document is also independent: a bad document yields its
 * own issue, and a bad resource-level configuration makes only that resource unavailable. A
 * document parsed by an earlier load is parsed again only when its saved text changed.
 */
export async function loadProjectCorpus(
  input: ReaderProjectInput,
  options: ProjectCorpusOptions = {},
): Promise<ReaderProjectCorpus> {
  const resources = await keepTreesUsedBy(() =>
    Promise.all(
      input.resources.map(async (resource): Promise<ReaderResourceLoadResult> => {
        try {
          return await loadResourceCorpus(resource, options);
        } catch (error) {
          const issue: ReaderResourceIssue = {
            resource: resourceReference(resource),
            sourcePath: resource.sourcePath,
            code: "resource-load",
            message: causeMessage(error),
          };
          return { resource, documents: [], issues: [issue] };
        }
      }),
    ),
  );
  const issues = [...input.issues, ...resources.flatMap((resource) => resource.issues)];
  return {
    documents: resources.flatMap((resource) => resource.documents),
    resources,
    issues,
    complete: issues.length === 0,
  };
}
