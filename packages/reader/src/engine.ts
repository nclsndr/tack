import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { dev } from "@rspress/core";
import type { PostCSSLoaderOptions, RsbuildPluginAPI } from "@rsbuild/core";
import tailwindcss from "@tailwindcss/postcss";
import { z } from "zod";
import { readerProcesses, type ReaderProcess } from "./host.ts";
import { readerEntry, readerFile } from "./reader-files.ts";
import { isolateReaderStylesheet } from "./postcss.ts";
import { loadProjectCorpus } from "./project-corpus.ts";
import { remarkSourceBlocks } from "./source.ts";
import { corpusRevision } from "./api.ts";
import { readerRoutes } from "./routes.ts";
import { readerBoot } from "./boot.ts";
import { readCheckout } from "./checkout.ts";
import { resourceIdentity } from "./resource.ts";
import { writePageProxies } from "./page-proxy.ts";
import { lucideIconsDirectory } from "./icons/catalog-builder.ts";
import { corpusIconNames, iconModuleSource } from "./icons/collect.ts";
import type { ReaderDocument, ReaderProjectInput } from "./types.ts";
import type { WatcherMessage } from "./watcher.ts";
import { ReaderConfigurationError } from "./config.ts";
import { ReaderPortInUseError, readerStartupError } from "./startup-error.ts";

// Coverage skip: this module only runs as the CLI's reader child process; importing it parses argv, starts the dev server and exits the process.
/* v8 ignore start -- @preserve */
const projectInput = z.object({
  project: z.object({ name: z.string(), root: z.string() }),
  resources: z.array(
    z.object({
      sourceRegistrationId: z.string(),
      name: z.string(),
      sourcePath: z.string(),
      directoryPath: z.string(),
      readerConfig: z.object({ kind: z.enum(["source", "file"]), path: z.string() }).optional(),
    }),
  ),
  issues: z.array(
    z.object({
      resource: z.object({
        sourceRegistrationId: z.string(),
        name: z.string(),
      }),
      sourcePath: z.string(),
      code: z.string(),
      message: z.string(),
      path: z.string().optional(),
    }),
  ),
  defaultWritingResource: z
    .object({
      sourceRegistrationId: z.string(),
      name: z.string(),
    })
    .optional(),
}) satisfies z.ZodType<ReaderProjectInput>;
const options = z
  .object({
    input: projectInput,
    port: z.number().int().min(0).max(65535),
    version: z.string().optional(),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const token = randomUUID();
const checkout = () => readCheckout(options.input.project.root);
const routes = readerRoutes({ token, load: () => loadProjectCorpus(options.input), checkout });
const theme = await mkdtemp(join(tmpdir(), "tack-reader-theme-"));
let server: Awaited<ReturnType<typeof dev>> | undefined;
let documents: ReaderDocument[] = [];
let generation = randomUUID();
let stopping = false;
let restarting = false;
let changedAgain = false;
let debounce: ReturnType<typeof setTimeout> | undefined;
let port = options.port;
if (port === 0) {
  const reservation = createServer();
  await new Promise<void>((resolvePort, reject) => {
    reservation.on("error", reject);
    reservation.listen(0, "127.0.0.1", () => resolvePort());
  });
  const address = reservation.address();
  if (address !== null && typeof address !== "string") port = address.port;
  await new Promise<void>((resolvePort) => reservation.close(() => resolvePort()));
}
const url = `http://127.0.0.1:${port}`;
const engineOptions = { host: "127.0.0.1", port, strictPort: true, printUrls: false };
const runtime = readerFile("runtime.tsx");
const stylesheet = readerFile("reader.css");
const readerTailwind = tailwindcss();
/** Hands a dev-server request to the reader API as a standard request, streaming any body. */
function apiRequest(req: IncomingMessage): Request {
  const headers = new Headers(
    Object.entries(req.headers).flatMap(([name, value]) =>
      value === undefined
        ? []
        : (Array.isArray(value) ? value : [value]).map((item) => [name, item]),
    ),
  );
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", url), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: bodyStream(req), duplex: "half" }),
  });
}
/** Streams a request body on demand, so the reader API can stop reading an oversized request. */
function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  const chunks: AsyncIterator<Buffer> = req[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}
async function start() {
  const corpus = await loadProjectCorpus(options.input);
  documents = corpus.documents;
  const issues = corpus.issues;
  generation = randomUUID();
  const loadedResources = corpus.resources.filter((resource) => resource.config !== undefined);
  const customizationLoaders = loadedResources
    .map((resource) => {
      const module = (path: string | undefined) =>
        path === undefined ? "Promise.resolve({})" : `import(${JSON.stringify(path)})`;
      return `${JSON.stringify(resourceIdentity(resource.resource))}:async()=>{const [navigation,layouts,components]=await Promise.all([${module(resource.config?.navigation.module)},${module(resource.config?.layouts.module)},${module(resource.config?.components.module)}]);return {Navigation:navigation.Navigation??navigation.default,layouts:layouts.layouts??layouts.default,components:components.components??components.default};}`;
    })
    .join(",");
  const themeSource = `
export * from ${JSON.stringify(import.meta.resolve("@rspress/core/theme-original"))};
import { useEffect, useState } from "react";
import { ReaderLayout } from ${JSON.stringify(runtime)};
import { icons } from "./icons.tsx";

const loaders = { ${customizationLoaders} };

export function Layout() {
  const [customization, setCustomization] = useState({
    customizations: {},
    pendingResources: Object.keys(loaders),
    resourceErrors: {},
  });

  useEffect(() => {
    let mounted = true;
    void Promise.all(
      Object.entries(loaders).map(async ([resource, load]) => {
        try {
          const value = await load();
          if (mounted === true) {
            setCustomization((previous) => ({
              ...previous,
              customizations: { ...previous.customizations, [resource]: value },
              pendingResources: previous.pendingResources.filter((key) => key !== resource),
            }));
          }
        } catch (error) {
          if (mounted === true) {
            setCustomization((previous) => ({
              ...previous,
              pendingResources: previous.pendingResources.filter((key) => key !== resource),
              resourceErrors: {
                ...previous.resourceErrors,
                [resource]: error instanceof Error ? error.message : String(error),
              },
            }));
          }
        }
      }),
    );
    return () => {
      mounted = false;
    };
  }, []);

  return <ReaderLayout customization={customization} icons={icons} />;
}
`;
  await mkdir(theme, { recursive: true });
  await writeFile(join(theme, "index.tsx"), themeSource);
  // Only the docs icons this corpus names are bundled, each from its own Lucide module.
  await writeFile(
    join(theme, "icons.tsx"),
    iconModuleSource(await corpusIconNames(corpus), lucideIconsDirectory()),
  );
  const compiled = Promise.withResolvers<void>();
  const boot = readerBoot({
    input: options.input,
    corpus,
    generation,
    token,
    checkout: await checkout(),
    version: options.version,
  });
  server = await dev({
    docDirectory: options.input.project.root,
    config: {
      root: options.input.project.root,
      title: "Tack reader",
      themeDir: theme,
      globalStyles: stylesheet,
      ssg: false,
      // The reader is a local dev server: no llms.txt, Markdown twins or browser WebMCP tools.
      llms: false,
      webMcp: false,
      themeConfig: { nav: [], sidebar: {} },
      search: { mode: "local" },
      mediumZoom: false,
      route: { extensions: [], cleanUrls: true, excludeConvention: [] },
      plugins: [
        {
          name: "tack-explicit-pages",
          addPages: () => writePageProxies(join(theme, "pages"), documents),
        },
      ],
      markdown: {
        remarkPlugins: [
          [
            remarkSourceBlocks,
            {
              worktree: (path: string) =>
                documents.find((document) => document.path === path)?.resource?.sourcePath ??
                options.input.resources.find((resource) => {
                  const withinSource = relative(resource.sourcePath, path);
                  return (
                    withinSource !== ".." &&
                    !withinSource.startsWith(`..${sep}`) &&
                    !isAbsolute(withinSource)
                  );
                })?.sourcePath ??
                options.input.project.root,
              pages: documents.map(({ path, route }) => ({ path, route })),
            },
          ],
        ],
        link: { checkDeadLinks: false },
        image: { checkDeadImages: false },
      },
      builderConfig: {
        // Compilation depends on the source plugin implementation and saved contributor files.
        performance: {
          buildCache: {
            buildDependencies: [fileURLToPath(import.meta.url), readerFile("source.ts")],
            cacheDigest: [corpusRevision(documents, issues)],
          },
        },
        source: { define: { tackReaderBoot: JSON.stringify(boot) } },
        tools: {
          // Rsbuild loads the PostCSS config of the worktree, which is the Rspress root, and merges
          // it into every stylesheet. The function form keeps the PostCSS loader in place; the chain
          // then hands reader.css to Tailwind alone, after Rsbuild has finished that merge.
          postcss: (loaderOptions) => {
            loaderOptions.postcssOptions = () => ({});
          },
          bundlerChain: (chain, { CHAIN_ID }) => {
            chain.module
              .rule(CHAIN_ID.RULE.CSS)
              .oneOf(CHAIN_ID.ONE_OF.CSS_MAIN)
              .use(CHAIN_ID.USE.POSTCSS)
              .tap((loaderOptions) => {
                if (typeof loaderOptions === "string") return loaderOptions;
                const worktree: PostCSSLoaderOptions["postcssOptions"] =
                  loaderOptions["postcssOptions"];
                return {
                  ...loaderOptions,
                  postcssOptions: isolateReaderStylesheet(worktree, stylesheet, [readerTailwind]),
                };
              });
          },
        },
        resolve: {
          alias: { "@tackup/reader": readerFile("visuals.tsx") },
        },
        server: {
          ...engineOptions,
          setup({ server: instance }) {
            instance.middlewares.use((req, res, next) => {
              if (req.url?.startsWith("/__tack/") !== true) {
                next();
                return;
              }
              void (async () => {
                const response = await routes.handle(apiRequest(req));
                res.statusCode = response.status;
                response.headers.forEach((value, name) => res.setHeader(name, value));
                res.end(Buffer.from(await response.arrayBuffer()));
              })().catch(next);
            });
          },
        },
        dev: { lazyCompilation: false, hmr: false, liveReload: false, cliShortcuts: false },
        plugins: [
          {
            name: "tack-readiness",
            setup(api: RsbuildPluginAPI) {
              api.onAfterDevCompile(({ stats }) => {
                if (stats.hasErrors() === true)
                  compiled.reject(new Error(stats.toString({ all: false, errors: true })));
                else compiled.resolve();
              });
            },
          },
        ],
      },
    },
  });
  await compiled.promise;
  routes.publish(corpus, generation);
}
async function restart() {
  if (stopping === true) return;
  if (restarting === true) {
    changedAgain = true;
    return;
  }
  restarting = true;
  try {
    await loadProjectCorpus(options.input);
    await server?.close();
    server = undefined;
    await start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    routes.fail(message);
    console.error(message);
  } finally {
    restarting = false;
    rebuildQueued();
  }
}
/** Starts the rebuild that a save made during the previous build queued. */
function rebuildQueued() {
  if (changedAgain === true) {
    changedAgain = false;
    void restart();
  }
}
function relevant(path: string) {
  const relativePath = relative(options.input.project.root, path).split(sep).join("/");
  if (
    relativePath
      .split("/")
      .some((part) => ["node_modules", ".git", ".cache", ".effect-source"].includes(part)) === true
  )
    return false;
  return (
    options.input.resources.some((resource) => {
      const rel = relative(resource.sourcePath, path);
      return rel.startsWith("..") === false && isAbsolute(rel) === false;
    }) ||
    documents.some((document) =>
      document.blocks.some((block) =>
        [...block.contributors, ...(block.implementations ?? [])].some(
          (reference) => reference.path === path,
        ),
      ),
    )
  );
}
const watcherMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("watching") }),
  z.object({ type: z.literal("change"), path: z.string() }),
  z.object({ type: z.literal("unavailable"), root: z.string(), message: z.string() }),
]) satisfies z.ZodType<WatcherMessage>;
let watcher: ReaderProcess | undefined;
/**
 * Watches every root from a separate process, which the dev server's own watchers cannot disturb
 * (see `watcher.ts`). Resolves once saved changes are reported, or once the watcher has stopped.
 */
async function watchRoots() {
  const roots = new Set([
    options.input.project.root,
    ...options.input.resources.map((resource) => resource.sourcePath),
  ]);
  const watching = Promise.withResolvers<void>();
  watcher = readerProcesses.spawn({
    cmd: [
      process.execPath,
      readerEntry("watcher"),
      JSON.stringify({ roots: [...roots], sentinel: join(theme, "watching") }),
    ],
    env: process.env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    ipc(raw) {
      const parsed = watcherMessage.safeParse(raw);
      if (parsed.success === false) return;
      const message = parsed.data;
      if (message.type === "watching") watching.resolve();
      else if (message.type === "unavailable")
        console.error(`Reader watcher for ${message.root} is unavailable: ${message.message}`);
      else if (relevant(message.path) === true) {
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
          void restart();
        }, 150);
      }
    },
  });
  void watcher.exited.then((code) => {
    if (stopping === false)
      console.error(`Reader watcher stopped (exit ${code}); saved changes no longer reload.`);
    watching.resolve();
  });
  await watching.promise;
}
async function close(exitCode = 0) {
  if (stopping === true) return;
  stopping = true;
  watcher?.kill();
  if (debounce !== undefined) clearTimeout(debounce);
  await server?.close();
  await rm(theme, { recursive: true, force: true });
  process.exit(exitCode);
}
process.on("SIGTERM", () => {
  void close();
});
process.on("SIGINT", () => {
  void close();
});
try {
  // Saves are watched before the first corpus load, so one made while the reader builds still
  // reaches a rebuild: it runs once the reader is ready.
  await watchRoots();
  restarting = true;
  try {
    await start();
  } finally {
    restarting = false;
  }
  process.send?.({ type: "ready", url });
  rebuildQueued();
} catch (error) {
  const failure = readerStartupError(error, port);
  process.send?.({
    type: "error",
    name: failure instanceof Error ? failure.name : "Error",
    message: failure instanceof Error ? failure.message : String(failure),
    ...(failure instanceof ReaderPortInUseError ? { port: failure.port } : {}),
  });
  if (
    !(failure instanceof ReaderPortInUseError) &&
    !(failure instanceof ReaderConfigurationError)
  ) {
    console.error(failure);
  }
  await close(1);
}
/* v8 ignore stop -- @preserve */
