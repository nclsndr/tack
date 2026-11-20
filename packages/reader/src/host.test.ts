import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBrowserBuild,
  globMatcher,
  readerProcesses,
  resolveModule,
  scanImports,
  transpile,
} from "./host.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (files: Readonly<Record<string, string>>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tack-reader-host-")));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }),
  );
  return root;
};
const text = (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

describe("reader processes", () => {
  it("runs a child process with piped output and a JSON message channel", async () => {
    const messages: unknown[] = [];
    const child = readerProcesses.spawn({
      cmd: [
        process.execPath,
        "-e",
        'process.send({ type: "ready" }); console.log("out"); console.error("err");',
      ],
      ipc: (message) => messages.push(message),
    });

    expect(await child.exited).toBe(0);
    expect(await text(child.stdout)).toBe("out\n");
    expect(await text(child.stderr)).toBe("err\n");
    expect(messages).toEqual([{ type: "ready" }]);
  });

  it("reports a signal as exit 128 and a missing program as exit 127, with empty ignored output", async () => {
    const running = readerProcesses.spawn({
      cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      stdout: "ignore",
    });
    running.kill("SIGTERM");

    expect(await running.exited).toBe(128);
    expect(await text(running.stdout)).toBe("");
    expect(await readerProcesses.spawn({ cmd: ["/nonexistent/tack-reader-program"] }).exited).toBe(
      127,
    );
  });
});

describe("module tools", () => {
  it("removes types and JSX while keeping the module's imports", () => {
    const javascript = transpile(
      'import { label } from "./label.ts";\nconst size: number = 1;\nexport default () => <b>{label}{size}</b>;\n',
      "tsx",
    );

    expect(javascript).toContain('from "./label.ts"');
    expect(javascript).not.toContain(": number");
    expect(javascript).toContain("react/jsx-runtime");
  });

  it("scans static, re-exported and literal dynamic imports, but not type-only ones", () => {
    expect(
      scanImports(
        [
          'import type { Shape } from "./types.ts";',
          'import data from "./data.json";',
          'export * from "./all.ts";',
          'export { named } from "./named.ts";',
          'const lazy = () => import("./lazy.ts");',
          "const local: Shape = data;",
          "export default { lazy, local };",
        ].join("\n"),
        "ts",
      ),
    ).toEqual(["./data.json", "./all.ts", "./named.ts", "./lazy.ts"]);
    expect(scanImports('import "./side-effect.js";\n', "js")).toEqual(["./side-effect.js"]);
    expect(
      scanImports('import Card from "./card.jsx";\nexport default <Card />;\n', "jsx"),
    ).toEqual(["react/jsx-runtime", "./card.jsx"]);
  });

  it("resolves a package for the browser from the importing file, and names one it cannot find", async () => {
    const root = await fixture({
      "node_modules/widget/package.json": JSON.stringify({
        name: "widget",
        exports: { browser: "./browser.js", default: "./node.js" },
      }),
      "node_modules/widget/browser.js": "export default 1;\n",
      "docs/page.mdx": "# Page\n",
    });

    expect(await resolveModule("widget", join(root, "docs/page.mdx"))).toBe(
      join(root, "node_modules/widget/browser.js"),
    );
    await expect(resolveModule("missing-widget", join(root, "docs/page.mdx"))).rejects.toThrow();
  });

  it("compiles a browser entry with its stylesheets and assets, and reports what fails to resolve", async () => {
    const root = await fixture({
      "card.tsx":
        'import "./style.css";\nimport { label } from "./label.ts";\nexport default () => <b>{label}</b>;\n',
      "label.ts": 'export const label = "Card";\n',
      "style.css": '.card { background: url("./icon.svg"); }\n',
      "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      "broken.tsx": 'import { missing } from "./missing.ts";\nexport default missing;\n',
    });

    expect(await checkBrowserBuild(join(root, "card.tsx"), ["react", "react/*"])).toEqual({
      success: true,
      messages: [],
    });
    expect(await checkBrowserBuild(join(root, "broken.tsx"), [])).toEqual({
      success: false,
      messages: ['broken.tsx:1: Could not resolve "./missing.ts"'],
    });
  });
});

describe("glob matching", () => {
  it("matches dotfiles like any other name", () => {
    expect(globMatcher("**/*.mdx")(".drafts/page.mdx")).toBe(true);
    expect(globMatcher("*.mdx")("nested/page.mdx")).toBe(false);
  });
});
