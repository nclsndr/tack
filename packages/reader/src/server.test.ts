import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { startReader as startProjectReader } from "./server.ts";
import type { ReaderProjectInput } from "./types.ts";
const configuration = {
  version: 1,
  content: [{ root: "pages", include: ["*.mdx"], exclude: [] }],
  navigation: { preset: "folders" },
  layouts: { preset: "reader" },
  components: { preset: "standard" },
  metadata: { preset: "working-docs" },
};
const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tack-reader-server-"));
  fixtures.push(root);
  await mkdir(join(root, "pages"));
  await writeFile(
    join(root, "pages", "index.mdx"),
    "---\ntitle: Local reader\n---\n# Local reader\n\nSaved content.\n",
  );
  await writeFile(join(root, "tack.reader.yaml"), stringify(configuration));
  return root;
}
function readerInput(root: string): ReaderProjectInput {
  return {
    project: { name: "Reader fixture", root },
    resources: [
      {
        sourceRegistrationId: "reader-fixture",

        name: "docs",
        sourcePath: root,
        directoryPath: root,
        readerConfig: { kind: "file", path: "tack.reader.yaml" },
      },
    ],
    issues: [],
  };
}
/** Reads the small status the browser checks for saved changes. */
async function status(url: string): Promise<{ revision: string; error: string }> {
  const response = await fetch(url + "/__tack/status");
  if (response.ok === false) throw new Error(`Reader status ${response.status}`);
  return response.json();
}
type Corpus = {
  documents: { title: string }[];
  issues: unknown[];
  complete: boolean;
  revision: string;
};
const titles = (corpus: Corpus) => corpus.documents.map((doc) => doc.title);
/**
 * Waits for the reader to serve a generation built from the saved files: the status revision it
 * published is the one the corpus, rebuilt from those files on request, reports. A rebuild restarts
 * the dev server, so requests fail while it is down, as the browser's own status checks do.
 * @returns One corpus and status pair read from that generation.
 */
function published(url: string): Promise<{ corpus: Corpus; status: { error: string } }> {
  return vi.waitFor(
    async () => {
      const [corpus, live] = await Promise.all([
        fetch(url + "/__tack/corpus").then((response): Promise<Corpus> => response.json()),
        status(url),
      ]);
      if (live.revision !== corpus.revision)
        throw new Error(`The reader still serves ${live.revision}, not ${corpus.revision}.`);
      return { corpus, status: live };
    },
    { timeout: 12000, interval: 200 },
  );
}
function startReader(options: {
  worktree: string;
  port?: number;
  open?: boolean;
  diagnostic?: (message: string) => void;
  signal?: AbortSignal;
}) {
  const { worktree, ...rest } = options;
  return startProjectReader({ input: readerInput(worktree), ...rest });
}
describe("foreground reader server", () => {
  it("reports a real occupied port with a recovery hint and no vendor stack", async () => {
    const root = await fixture();
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = listener.address();
      if (address === null || typeof address === "string")
        throw new Error("Expected a TCP address");
      const diagnostics: string[] = [];
      await expect(
        startReader({
          worktree: root,
          port: address.port,
          open: false,
          diagnostic: (text) => diagnostics.push(text),
        }),
      ).rejects.toMatchObject({
        name: "ReaderPortInUseError",
        port: address.port,
        message: expect.stringContaining(`Reader port ${address.port} is already in use.`),
      });
      expect(diagnostics.join("")).not.toMatch(/\[rsbuild:server\]|at getPort|error:|Error:/);
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("reloads inline settings, switches to linked YAML, and recovers from invalid saved settings", async () => {
    const root = await fixture();
    const path = join(root, "tack.yaml");
    const save = (reader: unknown) =>
      writeFile(path, stringify({ version: 1, docs: [{ name: "docs", path: "pages", reader }] }));
    await save({ content: [{ root: "pages", exclude: ["hidden.md"] }] });
    await writeFile(join(root, "pages", "hidden.md"), "# Hidden\n");
    const input = readerInput(root);
    const resource = input.resources[0];
    if (resource === undefined) throw new Error("Expected the fixture docs resource");
    resource.directoryPath = join(root, "pages");
    resource.readerConfig = { kind: "source", path };
    const server = await startProjectReader({
      input,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const healthy = await published(server.url);
      expect(titles(healthy.corpus)).toEqual(["Local reader"]);
      expect(healthy.status.error).toBe("");
      await save({ components: { module: "missing.tsx" } });
      // The rebuilt generation is published with the unavailable resource in its boot payload, so
      // the status only moves to its revision and reports no rebuild failure.
      const broken = await published(server.url);
      expect(broken.corpus.revision).not.toBe(healthy.corpus.revision);
      expect(broken.corpus.issues).toHaveLength(1);
      expect(broken.status.error).toBe("");
      await writeFile(
        join(root, "reader.yaml"),
        "content:\n  - root: pages\n    exclude: [index.mdx]\n",
      );
      await save("reader.yaml");
      expect(titles((await published(server.url)).corpus)).toEqual(["Hidden"]);
      await writeFile(
        join(root, "reader.yaml"),
        "content:\n  - root: pages\n    exclude: [hidden.md]\n",
      );
      const recovered = await published(server.url);
      expect(titles(recovered.corpus)).toEqual(["Local reader"]);
      expect(recovered.corpus.complete).toBe(true);
      expect(recovered.status.error).toBe("");
    } finally {
      await server.close();
    }
  }, 45000);

  it("rebuilds for each save made as soon as the previous rebuild is served", async () => {
    const root = await fixture();
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      // Each rebuild restarts the dev server, whose own watchers open and close around the save.
      for (const title of ["First save", "Second save", "Third save", "Fourth save"]) {
        await writeFile(
          join(root, "pages", "index.mdx"),
          `---\ntitle: ${title}\n---\n# ${title}\n`,
        );
        expect(titles((await published(server.url)).corpus)).toEqual([title]);
      }
    } finally {
      await server.close();
    }
  }, 60000);
  it("recompiles source annotations after an imported data file changes", async () => {
    const root = await fixture();
    const dataPath = join(root, "pages", "data.ts");
    await writeFile(dataPath, 'export const data = [{ label: "Before", value: 1 }];\n');
    await writeFile(
      join(root, "pages", "index.mdx"),
      '---\ntitle: Imported data\n---\nimport { data } from "./data.ts";\n\n<Chart id="chart" title="Data" data={data} />\n',
    );
    let server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    const corpus = async () => (await fetch(server.url + "/__tack/corpus")).json();
    const compiledPage = async () => {
      const entry = await (await fetch(server.url + "/static/js/index.js")).text();
      const chunks = [...new Set(entry.match(/(?:route-[a-f0-9]+|tack-document-\d+)/g) ?? [])];
      return (
        await Promise.all(
          chunks.map(async (chunk) =>
            (await fetch(`${server.url}/static/js/async/${chunk}.js`)).text(),
          ),
        )
      ).join("\n");
    };
    try {
      const initial = await corpus();
      const first = initial.documents[0].blocks[0];
      expect(await compiledPage()).toContain(`version: "${first.version}"`);
      await server.close();
      await writeFile(dataPath, 'export const data = [{ label: "After", value: 2 }];\n');
      server = await startReader({
        worktree: root,
        port: 0,
        open: false,
        diagnostic: () => undefined,
      });
      await expect
        .poll(
          async () => {
            try {
              const current = await corpus();
              const block = current.documents[0].blocks[0];
              if (block.version === first.version) return false;
              return (await compiledPage()).includes(`version: "${block.version}"`);
            } catch {
              return false;
            }
          },
          { timeout: 12000, interval: 200 },
        )
        .toBe(true);
    } finally {
      await server.close();
    }
  }, 30000);

  it("publishes healthy resources when one document has invalid MDX", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "pages", "index.mdx"),
      "---\ntitle: Invalid MDX\n---\n\n<Unclosed>\n",
    );
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const corpus = await (await fetch(server.url + "/__tack/corpus")).json();
      expect(corpus.documents).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("serves plain Markdown as Markdown while retaining authored literal text", async () => {
    const root = await fixture();
    const configPath = join(root, "tack.reader.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.content[0].include = ["*.md", "*.mdx"];
    await Promise.all([
      writeFile(configPath, stringify(config)),
      writeFile(
        join(root, "pages", "literal.md"),
        '---\ndescription: Ordinary Markdown metadata\n---\n# Literal Markdown\n\nLiteral {name}, <placeholder>, and a < b.\n\n`{code}` and `<tag>` stay code.\n\n<div data-note="plain-html">Ordinary HTML</div>\n',
      ),
    ]);
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const corpus = await (await fetch(server.url + "/__tack/corpus")).json();
      const literal = corpus.documents.find(
        (document: { relativePath: string }) => document.relativePath === "pages/literal.md",
      );
      expect(literal).toMatchObject({ title: "Literal Markdown", metadata: { tags: [] } });
      const entry = await (await fetch(server.url + "/static/js/index.js")).text();
      const chunks = [...new Set(entry.match(/(?:route-[a-f0-9]+|tack-document-\d+)/g) ?? [])];
      const compiled = (
        await Promise.all(
          chunks.map(async (chunk) =>
            (await fetch(`${server.url}/static/js/async/${chunk}.js`)).text(),
          ),
        )
      ).join("\n");
      expect(compiled).toContain('"Literal {name}, "');
      expect(compiled).toContain('placeholder: "placeholder"');
      expect(compiled).toContain('", and a < b."');
      expect(compiled).toContain("{code}");
      expect(compiled).toContain("plain-html");
    } finally {
      await server.close();
    }
  }, 30000);

  it("bundles an MDX component with source-local data and assets from its owning resource", async () => {
    const alpha = await fixture();
    const beta = await fixture();
    await Promise.all([
      writeFile(join(beta, "pages", "label.ts"), 'export const label = "Beta source component";\n'),
      writeFile(join(beta, "pages", "badge.css"), ".badge { color: rebeccapurple; }\n"),
      writeFile(
        join(beta, "pages", "badge.tsx"),
        'import "./badge.css";\nimport { label } from "./label.ts";\nexport default () => <strong className="badge" data-source-beta>{label}</strong>;\n',
      ),
      writeFile(
        join(beta, "pages", "index.mdx"),
        '---\ntitle: Beta document\n---\nimport Badge from "./badge.tsx"\n\n<Badge />\n',
      ),
    ]);
    const server = await startProjectReader({
      input: {
        project: { name: "Reader fixture", root: alpha },
        resources: [
          {
            sourceRegistrationId: "alpha-source",

            name: "docs",
            sourcePath: alpha,
            directoryPath: alpha,
            readerConfig: { kind: "file", path: "tack.reader.yaml" },
          },
          {
            sourceRegistrationId: "beta-source",

            name: "docs",
            sourcePath: beta,
            directoryPath: beta,
            readerConfig: { kind: "file", path: "tack.reader.yaml" },
          },
        ],
        issues: [],
      },
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const corpus = await (await fetch(server.url + "/__tack/corpus")).json();
      expect(corpus.documents).toMatchObject([
        { resource: { sourceRegistrationId: "alpha-source", name: "docs" } },
        { resource: { sourceRegistrationId: "beta-source", name: "docs" } },
      ]);
      const entry = await (await fetch(server.url + "/static/js/index.js")).text();
      const chunks = [...new Set(entry.match(/(?:route-[a-f0-9]+|tack-document-\d+)/g) ?? [])];
      const compiled = (
        await Promise.all(
          chunks.map(async (chunk) =>
            (await fetch(`${server.url}/static/js/async/${chunk}.js`)).text(),
          ),
        )
      ).join("\n");
      expect(compiled).toContain("Beta source component");
      expect(compiled).toContain("data-source-beta");
    } finally {
      await server.close();
    }
  }, 30000);

  it("keeps a healthy resource available when another declared source root is missing", async () => {
    const root = await fixture();
    const missing = join(root, "missing-source");
    const server = await startProjectReader({
      input: {
        project: { name: "Reader fixture", root },
        resources: [
          {
            sourceRegistrationId: "healthy-source",

            name: "docs",
            sourcePath: root,
            directoryPath: root,
            readerConfig: { kind: "file", path: "tack.reader.yaml" },
          },
          {
            sourceRegistrationId: "missing-source",

            name: "docs",
            sourcePath: missing,
            directoryPath: join(missing, "docs"),
          },
        ],
        issues: [],
      },
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const corpus = await (await fetch(server.url + "/__tack/corpus")).json();
      expect(corpus.documents).toHaveLength(1);
      expect(corpus.issues).toMatchObject([
        { resource: { sourceRegistrationId: "missing-source", name: "docs" } },
      ]);
      expect(corpus.complete).toBe(false);
    } finally {
      await server.close();
    }
  }, 30000);

  it("carries backend-provided unavailable resources into the browser corpus and boot payload", async () => {
    const root = await fixture();
    const server = await startProjectReader({
      input: {
        ...readerInput(root),
        issues: [
          {
            resource: {
              sourceRegistrationId: "unattached-source",

              name: "notes",
            },
            sourcePath: "/sources/unattached",
            code: "attachment-missing",
            message: "The attached notes resource is unavailable.",
          },
        ],
      },
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const corpus = await (await fetch(server.url + "/__tack/corpus")).json();
      expect(corpus.documents).toHaveLength(1);
      expect(corpus.complete).toBe(false);
      expect(corpus.issues).toMatchObject([
        {
          resource: { sourceRegistrationId: "unattached-source", name: "notes" },
          code: "attachment-missing",
        },
      ]);
      const index = await (await fetch(server.url + "/static/js/index.js")).text();
      expect(index).toContain("The attached notes resource is unavailable.");
    } finally {
      await server.close();
    }
  }, 30000);

  it("reports a missing repository customization dependency as a resource issue", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "custom.tsx"),
      'import Missing from "tack-reader-fixture-missing-library";\nexport const components = { Missing };\n',
    );
    await writeFile(
      join(root, "tack.reader.yaml"),
      stringify({
        ...configuration,
        components: { preset: "standard", module: "custom.tsx" },
      }),
    );
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const corpus = await (await fetch(server.url + "/__tack/corpus")).json();
      expect(corpus.error).toContain('Could not resolve "tack-reader-fixture-missing-library"');
    } finally {
      await server.close();
    }
  }, 30000);

  it("starts the healthy project shell when a source customization throws during browser initialization", async () => {
    const root = await fixture();
    await Promise.all([
      writeFile(
        join(root, "custom.tsx"),
        'throw new Error("Source module initialization failed");\n',
      ),
      writeFile(
        join(root, "tack.reader.yaml"),
        stringify({
          ...configuration,
          components: { preset: "standard", module: "custom.tsx" },
        }),
      ),
    ]);
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const corpus = await (await fetch(server.url + "/__tack/corpus")).json();
      expect(corpus.documents).toHaveLength(1);
      expect(corpus.issues).toEqual([]);
      const index = await (await fetch(server.url + "/static/js/index.js")).text();
      expect(index).toContain("const loaders");
      expect(index).toContain("pendingResources");
    } finally {
      await server.close();
    }
  }, 30000);

  it("rejects unknown actions, invalid copy requests, stale blocks and undeclared editor paths", async () => {
    const root = await fixture();
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const initial = await (await fetch(server.url + "/__tack/corpus")).json();
      const post = (action: string, body: unknown) =>
        fetch(server.url + "/__tack/" + action, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Tack-Token": initial.token },
          body: JSON.stringify(body),
        });
      expect((await post("unknown", {})).status).toBe(404);
      expect((await post("copy", { blocks: [] })).status).toBe(409);
      const block = initial.documents[0].blocks[1];
      const stale = await post("copy", { blocks: [{ id: block.id, version: "outdated" }] });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: expect.stringContaining("Source changed"),
      });
      expect((await post("editor", { path: "/outside/undeclared.mdx" })).status).toBe(409);
      const editor = await post("editor", { path: initial.documents[0].path, line: 6 });
      expect(await editor.json()).toMatchObject({
        url: expect.stringMatching(/^vscode:\/\/file.*index\.mdx:6$/),
      });
    } finally {
      await server.close();
    }
  }, 30000);

  it("reports invalid saved metadata and restores the resource after repair", async () => {
    const root = await fixture();
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    const corpus = async () => {
      try {
        return await (await fetch(server.url + "/__tack/corpus")).json();
      } catch {
        return undefined;
      }
    };
    try {
      await writeFile(
        join(root, "pages", "index.mdx"),
        "---\ntags: invalid-shape\n---\n# Invalid metadata\n",
      );
      // One poll observes one response: a separate read after the issue appears can land
      // while the dev server restarts, when the fetch fails and the corpus is undefined.
      await expect
        .poll(
          async () => {
            const value = await corpus();
            return { issue: value?.issues?.[0]?.message ?? "", documents: value?.documents };
          },
          { timeout: 15000, interval: 150 },
        )
        .toMatchObject({ issue: expect.stringContaining("tags"), documents: [] });
      await writeFile(
        join(root, "pages", "index.mdx"),
        "---\ntitle: Recovered reader\n---\n# Recovered reader\n",
      );
      await expect
        .poll(
          async () => {
            const value = await corpus();
            return value?.error === "" ? value.documents[0].title : undefined;
          },
          { timeout: 15000, interval: 150 },
        )
        .toBe("Recovered reader");
      await writeFile(
        join(root, "pages", "second.mdx"),
        "---\ntitle: Added page\n---\n# Added page\n",
      );
      await expect
        .poll(
          async () =>
            (await corpus())?.documents.map((document: { route: string }) => document.route),
          { timeout: 15000, interval: 150 },
        )
        .toContain("/docs/reader-fixture/docs/pages/second");
      await rm(join(root, "pages", "second.mdx"));
      await expect
        .poll(async () => (await corpus())?.documents.length, { timeout: 15000, interval: 150 })
        .toBe(1);
    } finally {
      await server.close();
    }
  }, 30000);
  it.each(["before startup", "during setup"])(
    "honors an abort %s without spawning an engine",
    async (timing) => {
      const root = await fixture();
      const controller = new AbortController();
      const spawn = vi.spyOn(Bun, "spawn");
      if (timing === "before startup") controller.abort();
      const pending = startReader({
        worktree: root,
        port: 0,
        open: false,
        signal: controller.signal,
        diagnostic: () => undefined,
      });
      if (timing === "during setup") controller.abort();
      try {
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        await (await pending.catch(() => undefined))?.close();
        spawn.mockRestore();
      }
    },
    30000,
  );
  it("waits for complete shutdown on every concurrent close call", async () => {
    const root = await fixture();
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    let exited = false;
    void server.closed.then(() => {
      exited = true;
    });
    const first = server.close();
    try {
      await server.close();
      expect(exited).toBe(true);
      await expect(fetch(server.url)).rejects.toThrow();
    } finally {
      await first;
    }
  }, 30000);
  it("reports a missing source configuration without rejecting healthy server startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tack-reader-missing-"));
    fixtures.push(root);
    const server = await startReader({ worktree: root, port: 0, open: false });
    try {
      expect((await (await fetch(server.url + "/__tack/corpus")).json()).error).toContain(
        "tack.reader.yaml",
      );
    } finally {
      await server.close();
    }
  });
  it("serves explicit MDX, validates copying, reloads saved edits, and releases its port", async () => {
    const root = await fixture();
    const diagnostics: string[] = [];
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: (message) => diagnostics.push(message),
    });
    try {
      const response = await fetch(server.url + "/__tack/corpus");
      expect(response.status).toBe(200);
      const initial = await response.json();
      expect(initial.documents).toHaveLength(1);
      expect(initial.documents[0].title).toBe("Local reader");
      const html = await fetch(server.url);
      expect(await html.text()).toContain("__rspress_root");
      const block = initial.documents[0].blocks[1];
      const copied = await fetch(server.url + "/__tack/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tack-Token": initial.token },
        body: JSON.stringify({
          blocks: [{ id: block.id, version: block.version }],
          mode: "reference",
        }),
      });
      expect(await copied.json()).toMatchObject({ text: expect.stringContaining("index.mdx:6-6") });
      const denied = await fetch(server.url + "/__tack/copy", { method: "POST", body: "{}" });
      expect(denied.status).toBe(403);
      const before = await status(server.url);
      // The fixture root is outside any git repository, so the status names no checkout.
      expect(before).toEqual({ revision: initial.revision, error: "", checkout: null });
      await writeFile(
        join(root, "pages", "index.mdx"),
        "---\ntitle: Edited reader\n---\n# Edited reader\n\nNew saved content.\n",
      );
      await expect
        .poll(
          async () => {
            try {
              const live = await fetch(server.url + "/__tack/corpus");
              return (await live.json()).documents[0].title;
            } catch {
              return "";
            }
          },
          { timeout: 15000, interval: 150 },
        )
        .toBe("Edited reader");
      // The browser learns of the edit from the status check once the rebuilt page is served.
      await expect
        .poll(async () => (await status(server.url).catch(() => before)).revision, {
          timeout: 15000,
          interval: 150,
        })
        .not.toBe(before.revision);
    } finally {
      await server.close();
    }
    await expect(fetch(server.url)).rejects.toThrow();
  }, 30000);
});

describe("reader render changes", () => {
  it("changes the browser revision when an opaque repository layout changes", async () => {
    const root = await fixture();
    const module = join(root, "custom.tsx");
    await writeFile(
      module,
      'export const layouts={default:({children})=><div data-example="before">{children}</div>};',
    );
    const configPath = join(root, "tack.reader.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.layouts.module = "custom.tsx";
    await writeFile(configPath, stringify(config));
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const initial = await status(server.url);
      await writeFile(
        module,
        'export const layouts={default:({children})=><div data-example="after">{children}</div>};',
      );
      await expect
        .poll(
          async () => {
            try {
              return (await status(server.url)).revision;
            } catch {
              return initial.revision;
            }
          },
          { timeout: 12000, interval: 200 },
        )
        .not.toBe(initial.revision);
    } finally {
      await server.close();
    }
  }, 20000);
  it("renders a reader route for a valid empty corpus", async () => {
    const root = await fixture();
    await rm(join(root, "pages", "index.mdx"));
    const server = await startReader({
      worktree: root,
      port: 0,
      open: false,
      diagnostic: () => undefined,
    });
    try {
      const index = await (await fetch(server.url + "/static/js/index.js")).text();
      expect(/"title":\s*"No declared documents"/.test(index)).toBe(true);
      expect((await (await fetch(server.url + "/__tack/corpus")).json()).documents).toEqual([]);
    } finally {
      await server.close();
    }
  }, 20000);
});
