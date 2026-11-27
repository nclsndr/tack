// @vitest-environment jsdom
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { writePageProxies } from "./page-proxy.ts";
import { testRoot } from "./react.test-support.ts";
import { ReaderLayout, type ReaderBoot } from "./runtime.tsx";
const selected = vi.hoisted(() => ({ component: undefined as ComponentType | undefined }));
vi.mock("@rspress/core/runtime", () => ({
  Content: () => (selected.component === undefined ? null : createElement(selected.component)),
  useLocation: () => ({ pathname: "/page" }),
  useNavigate: () => () => undefined,
  useNavigationType: () => "POP",
  NavigationType: { Pop: "POP", Push: "PUSH", Replace: "REPLACE" },
  pathnameToRouteService: () => undefined,
}));
const ui = testRoot();
it("preloads a safe route before catching the source module evaluation failure inside the reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "tack-page-proxy-"));
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const physical = join(root, "throwing.tsx");
    await writeFile(
      physical,
      'throw new Error("Source module evaluation failed"); export default function Page(){return null;}',
    );
    const page = {
      id: physical,
      path: physical,
      relativePath: "page.mdx",
      route: "/page",
      title: "Broken page",
      metadata: { title: "Broken page", tags: [] },
      blocks: [],
      imports: [],
      searchText: "",
      source: "# Broken page",
      resource: {
        sourceRegistrationId: "source",
        sourcePath: root,

        name: "docs",
      },
    };
    const proxies = await writePageProxies(join(root, "proxies"), [page]);
    expect(proxies.map((entry) => entry.routePath)).toEqual(["/page", "/"]);
    const route = proxies[0];
    if (route === undefined || !("filepath" in route)) throw new Error("Expected safe route proxy");
    const build = await Bun.build({
      entrypoints: [route.filepath],
      target: "bun",
      packages: "external",
    });
    expect(build.success).toBe(true);
    const bundle = join(
      process.cwd(),
      `packages/reader/.tack-proxy-test-${crypto.randomUUID()}.mjs`,
    );
    const eagerBundle = `${bundle}.eager.mjs`;
    try {
      await writeFile(eagerBundle, await readFile(physical, "utf8"));
      await expect(import(eagerBundle)).rejects.toThrow("Source module evaluation failed");
      await writeFile(bundle, (await build.outputs[0]?.text()) ?? "");
      const loaded = z
        .object({
          title: z.string(),
          default: z.custom<ComponentType>((value) => typeof value === "function"),
        })
        .parse(await import(bundle));
      expect(loaded.title).toBe("Broken page");
      selected.component = loaded.default;
      const boot: ReaderBoot = {
        worktree: root,
        project: { name: "fixture" },
        resources: [],
        checkout: null,
        documents: [page],
        revision: "one",
        token: "test",
        metadata: { types: [], statuses: [], tags: [] },
        presets: { navigation: "folders" },
        archive: [],
      };
      await ui.render(createElement(ReaderLayout, { boot, customization: {} }));
      expect(ui.container.textContent).toContain("Source module evaluation failed");
      expect(ui.container.querySelector('[aria-label="Search documents"]')).not.toBeNull();
      expect(ui.container.querySelector('nav[aria-label="Folders"]')).not.toBeNull();
    } finally {
      await Promise.all([bundle, eagerBundle].map((path) => rm(path, { force: true })));
    }
  } finally {
    await ui.unmount();
    errors.mockRestore();
    selected.component = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps the no-documents route usable without loading any source modules", async () => {
  expect(await writePageProxies("/unused", [])).toEqual([
    { routePath: "/", content: "---\ntitle: No declared documents\n---\n" },
  ]);
});
