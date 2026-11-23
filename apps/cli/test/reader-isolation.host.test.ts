import { writeUnder } from "./support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import {
  partialEnvelope,
  hostTack,
  successfulEnvelope,
  withTackWorld,
} from "./fixtures/tack-world.ts";

const SearchResult = Schema.Struct({
  complete: Schema.Boolean,
  total: Schema.Number,
  hits: Schema.Array(Schema.Struct({ document: Schema.Struct({ relativePath: Schema.String }) })),
  issues: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      path: Schema.optionalKey(Schema.String),
      resource: Schema.Struct({ name: Schema.String }),
    }),
  ),
  setup: Schema.optionalKey(Schema.Struct({ code: Schema.String, next: Schema.String })),
});
const decodeSearch = Schema.decodeUnknownSync(SearchResult);

const readerConfig = (content: string, components?: string) =>
  [
    "version: 1",
    "content:",
    `  - root: ${content}`,
    '    include: ["**/*.md", "**/*.mdx"]',
    "    exclude: []",
    "navigation:",
    "  preset: folders",
    "layouts:",
    "  preset: reader",
    "components:",
    ...(components === undefined ? ["  preset: standard"] : [`  module: ${components}`]),
    "metadata:",
    "  preset: working-docs",
    "",
  ].join("\n");

it.layer(LiveTestLayer)("reader isolation through the CLI host", (readerIt) => {
  readerIt.effect(
    "keeps healthy documents and resources searchable beside broken siblings and render modules",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const source = fixture.sourceDirectory;
          const write = writeUnder(source);
          yield* write(
            "tack.yaml",
            [
              "version: 1",
              "skills:",
              "  - path: skills",
              "docs:",
              "  - name: guides",
              "    path: guides",
              "    reader: guides.reader.yaml",
              "  - name: broken",
              "    path: broken",
              "    reader: broken.reader.yaml",
              "  - name: healthy",
              "    path: healthy",
              "",
            ].join("\n"),
          );
          // A render-only module failure must not hide plain Markdown hits.
          yield* write("guides.reader.yaml", readerConfig("guides", "components.tsx"));
          yield* write("components.tsx", "export const components = {{{ not valid\n");
          yield* write("guides/one.md", "# One\n\nuniqueneedle in one\n");
          yield* write("guides/two.md", "# Two\n\nuniqueneedle in two\n");
          yield* write("guides/three.mdx", "# Three\n\nuniqueneedle in three\n");
          yield* write("guides/bad-one.mdx", "# Bad\n\n<Unclosed>\n");
          yield* write("guides/bad-two.mdx", 'import Gone from "./missing.mdx"\n\n<Gone />\n');
          // One broken reader configuration leaves only that resource unavailable.
          yield* write("broken.reader.yaml", "version: 1\ncontent: [unterminated\n");
          yield* write("broken/hidden.md", "# Hidden\n\nuniqueneedle hidden\n");
          yield* write("healthy/visible.md", "# Visible\n\nuniqueneedle visible\n");
          for (const name of ["guides", "broken", "healthy"]) {
            successfulEnvelope(
              yield* hostTack(fixture, ["docs", "attach", name, "--project", "workspace"]),
            );
          }

          const search = partialEnvelope(
            yield* hostTack(fixture, [
              "docs",
              "search",
              "uniqueneedle",
              "--project",
              "workspace",
              "--limit",
              "20",
            ]),
          );
          const result = decodeSearch(search.result);
          expect(result.complete).toBe(false);
          expect(result.hits.map((hit) => hit.document.relativePath).sort()).toEqual([
            "one.md",
            "three.mdx",
            "two.md",
            "visible.md",
          ]);
          const documentIssues = result.issues.filter((issue) => issue.code === "document-load");
          expect(documentIssues.map((issue) => path.basename(issue.path ?? "")).sort()).toEqual([
            "bad-one.mdx",
            "bad-two.mdx",
          ]);
          for (const issue of documentIssues) expect(issue.message).toContain(issue.path);
          const resourceIssues = result.issues.filter((issue) => issue.code === "resource-load");
          expect(resourceIssues.map((issue) => issue.resource.name)).toEqual(["broken"]);
          expect(resourceIssues[0]?.message).not.toContain("at line");

          const listed = partialEnvelope(
            yield* hostTack(fixture, ["docs", "list", "--project", "workspace"]),
          );
          expect(listed.result).toMatchObject({ complete: false, documents: 4 });
        }),
      ),
  );

  readerIt.effect("reports an empty setup as incomplete with a valid attach step", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "notes"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(fixture.sourceDirectory, "tack.yaml"),
          "version: 1\nskills:\n  - path: skills\ndocs:\n  - name: notes\n    path: notes\n",
        );
        const search = partialEnvelope(
          yield* hostTack(fixture, ["docs", "search", "anything", "--project", "workspace"]),
        );
        const result = decodeSearch(search.result);
        expect(result).toMatchObject({ complete: false, total: 0, hits: [] });
        expect(result.setup?.code).toBe("no-docs-attached");
        const next = result.setup?.next ?? "";
        expect(next).toBe("tack docs attach notes --project workspace");
        // The suggested step is valid as written.
        const [, ...args] = next.split(" ");
        successfulEnvelope(yield* hostTack(fixture, args));
        const attached = successfulEnvelope(
          yield* hostTack(fixture, ["docs", "list", "--project", "workspace"]),
        );
        expect(attached.result).toMatchObject({ complete: true, documents: 0 });
        expect(attached.result).not.toHaveProperty("setup");
      }),
    ),
  );
});
