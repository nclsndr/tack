import { bareSkillText, declare, writeUnder } from "../../../test/support/source-tree.ts";
import { resolveCatalogAt, setSkillChoice } from "../../../test/support/snapshot-helpers.ts";

import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { CatalogQuarantineSchema } from "../../domain/sources/catalog-schema.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { initializeState, readState, type StateOptions } from "../../services/state-store.ts";
import { registerSource, inspectSources } from "./source.ts";
import { resolveCatalog } from "./catalog.ts";

const withSource = <A, E, R>(
  use: (fixture: { root: string; options: StateOptions }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "tack-unified-catalog-" });
    const root = yield* fs.realPath(temporary);
    const options = {
      environment: { TACK_STATE_DIR: path.join(root, "state") },
      homeDirectory: root,
    };
    yield* initializeState(options);
    yield* fs.writeFileString(path.join(root, "tack.yaml"), "version: 1\nname: shared\n");
    return yield* use({ root, options });
  });

/** Writes a file below `root`, with placeholder content unless told otherwise. */
const write = (root: string, relative: string, content = "content") =>
  writeUnder(root)(relative, content);
const identities = (catalog: {
  entries: ReadonlyArray<{
    address: { kind: string; name: string };
  }>;
}) => catalog.entries.map(({ address }) => `shared/${address.kind}/${address.name}`).sort();

const all = [
  "skills:\n  - path: skills",
  "commands:\n  - path: commands",
  "context:\n  - path: context",
  "scripts:\n  - { name: run, path: scripts/run.ts, description: Run }",
];

it.layer(LiveTestLayer)("unified source catalog", (test) => {
  test.effect(
    "registers a source of only a version and a name, without source-wide owner or kind",
    () =>
      withSource(({ root, options }) =>
        Effect.gen(function* () {
          const result = yield* registerSource(options, { sourcePath: root });
          expect(Object.keys(result.registration).sort()).toEqual(["canonicalPath", "id"]);
          expect((yield* readState(options)).format).toBe(1);
          expect(yield* resolveCatalogAt(options)).toMatchObject({
            entries: [],
            quarantined: [],
            unhealthySources: [],
          });
        }),
      ),
  );
  test.effect(
    "accepts docs beside every declared kind and does not read an undeclared private folder",
    () =>
      withSource(({ root, options }) =>
        Effect.gen(function* () {
          yield* write(
            root,
            "tack.yaml",
            declare("shared", ...all, "docs:", "  - name: handbook", "    path: notes"),
          );
          yield* write(root, "notes/guide.md");
          yield* write(root, "skills/valid/SKILL.md", bareSkillText("valid"));
          yield* write(root, "commands/review.md", "review");
          yield* write(root, "context/note.md");
          yield* write(root, "scripts/run.ts");
          yield* write(root, "private/skills/personal/SKILL.md", bareSkillText("personal"));
          yield* registerSource(options, { sourcePath: root });
          const catalog = yield* resolveCatalogAt(options);
          expect(identities(catalog)).toEqual([
            "shared/command/review",
            "shared/context/note.md",
            "shared/docs/handbook",
            "shared/script/run",
            "shared/skill/valid",
          ]);
          expect(catalog.quarantined).toEqual([]);
        }),
      ),
  );
  test.effect("catalogs declared resources without importing scripts or another source", () =>
    withSource(({ root, options }) =>
      Effect.gen(function* () {
        yield* write(root, "tack.yaml", declare("shared", ...all));
        yield* write(root, "skills/parent/SKILL.md", bareSkillText("parent"));
        yield* write(root, "skills/parent/child/SKILL.md", bareSkillText("child"));
        yield* write(root, "commands/nested/review.md", "# Plain command");
        yield* write(root, "commands/ignored.MD", "ignored");
        yield* write(root, "context/tack.yaml", "version: 1\nname: context\n");
        yield* write(root, "scripts/run.ts", 'throw new Error("must never import");');
        yield* write(root, "scripts/unlisted.ts", "invalid syntax");
        yield* write(root, "private/skills/parent/SKILL.md", bareSkillText("parent"));
        yield* write(root, "unknown/ignored/SKILL.md", bareSkillText("ignored"));
        yield* registerSource(options, { sourcePath: root });
        const catalog = yield* resolveCatalogAt(options);
        // context/tack.yaml makes the declared context folder another source, so it is refused.
        expect(identities(catalog)).toEqual([
          "shared/command/review",
          "shared/script/run",
          "shared/skill/parent",
        ]);
        expect(catalog.quarantined.map(({ code }) => code)).toEqual(["declaration-reaches-source"]);
      }),
    ),
  );
  test.effect(
    "keeps aliases inside one declared folder, uses canonical names, and terminates cycles",
    () =>
      withSource(({ root, options }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* write(root, "tack.yaml", declare("shared", "commands:", "  - path: commands"));
          const target = yield* write(root, "commands/real.md", "real");
          yield* fs.symlink(target, path.join(root, "commands", "alias.md"));
          yield* fs.symlink(path.join(root, "commands"), path.join(root, "commands", "cycle"));
          yield* write(root, "elsewhere/note.md");
          yield* fs.symlink(
            path.join(root, "elsewhere", "note.md"),
            path.join(root, "commands", "escape.md"),
          );
          yield* registerSource(options, { sourcePath: root });
          const catalog = yield* resolveCatalogAt(options);
          expect(identities(catalog)).toEqual(["shared/command/real"]);
          expect(catalog.quarantined.map((entry) => entry.code)).toEqual([
            "resource-boundary-violation",
          ]);
        }),
      ),
  );
  test.effect("does not discover a private folder by name", () =>
    withSource(({ root, options }) =>
      Effect.gen(function* () {
        yield* write(root, "private/private", "ordinary file");
        yield* write(root, "private/commands/review.md", "review");
        yield* registerSource(options, { sourcePath: root });
        const catalog = yield* resolveCatalogAt(options);
        expect(identities(catalog)).toEqual([]);
        expect(catalog.quarantined).toEqual([]);
      }),
    ),
  );
  test.effect("quarantines an unreadable context file while preserving independent context", () =>
    withSource(({ root, options }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* write(root, "tack.yaml", declare("shared", "context:", "  - path: context"));
        const blocked = yield* write(root, "context/blocked.md");
        yield* write(root, "context/healthy.md");
        yield* registerSource(options, { sourcePath: root });
        const catalog = yield* provideTestFileSystem(resolveCatalogAt(options), {
          ...fs,
          access: (target, accessOptions) =>
            target === blocked
              ? Effect.fail(
                  PlatformError.badArgument({ module: "unified-catalog-test", method: "access" }),
                )
              : fs.access(target, accessOptions),
        });
        expect(identities(catalog)).toEqual(["shared/context/healthy.md"]);
        expect(catalog.quarantined).toMatchObject([{ code: "resource-unreadable" }]);
      }),
    ),
  );
  test.effect(
    "quarantines only valid command duplicates and keeps order independent of registrations",
    () =>
      withSource(({ root, options }) =>
        Effect.gen(function* () {
          yield* write(root, "tack.yaml", declare("shared", "commands:", "  - path: commands"));
          yield* write(root, "commands/one/review.md", "review");
          yield* write(root, "commands/two/review.md", "review again");
          yield* write(root, "commands/valid.md", "valid");
          yield* write(root, "commands/other/valid.md", "---\nmetadata: false\n---");
          yield* write(root, "commands/Invalid.md", "invalid name");
          const other = `${root}/other-source`;
          yield* write(
            other,
            "tack.yaml",
            declare("other-source", "commands:", "  - path: commands"),
          );
          yield* write(other, "commands/valid.md", "other valid");
          yield* registerSource(options, { sourcePath: root });
          yield* registerSource(options, { sourcePath: other });
          const inspections = yield* inspectSources(yield* readState(options));
          const first = yield* resolveCatalog(inspections);
          expect(yield* resolveCatalog([...inspections].reverse())).toEqual(first);
          expect(identities(first)).toEqual(["shared/command/valid", "shared/command/valid"]);
          expect(
            first.quarantined.filter((entry) => entry.code === "resource-address-duplicate"),
          ).toHaveLength(2);
          expect(
            first.quarantined.filter((entry) => entry.code === "command-metadata-invalid"),
          ).toHaveLength(1);
          expect(
            first.quarantined.filter((entry) => entry.code === "command-name-invalid"),
          ).toHaveLength(1);
        }),
      ),
  );
  test.effect(
    "ignores a private path that is a file or a dangling link without losing resources",
    () =>
      withSource(({ root, options }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* write(root, "tack.yaml", declare("shared", "commands:", "  - path: commands"));
          yield* write(root, "private", "not an area");
          yield* write(root, "commands/review.md", "review");
          yield* registerSource(options, { sourcePath: root });
          const files = yield* resolveCatalogAt(options);
          expect(identities(files)).toEqual(["shared/command/review"]);
          expect(files.quarantined).toEqual([]);
          yield* fs.remove(path.join(root, "private"));
          yield* fs.symlink(path.join(root, "missing"), path.join(root, "private"));
          const links = yield* resolveCatalogAt(options);
          expect(identities(links)).toEqual(["shared/command/review"]);
        }),
      ),
  );
  test.effect(
    "retains source identity and choices across root declaration failure and repair",
    () =>
      withSource(({ root, options }) =>
        Effect.gen(function* () {
          yield* write(root, "tack.yaml", declare("shared", "skills:", "  - path: skills"));
          yield* write(root, "skills/valid/SKILL.md", bareSkillText("valid"));
          const registered = yield* registerSource(options, { sourcePath: root });
          yield* setSkillChoice(options, {
            address: {
              kind: "skill",
              name: "valid",
              sourceRegistrationId: registered.registration.id,
            },
            decision: "include",
            namespace: { _tag: "user" },
          });
          const before = yield* readState(options);
          yield* write(root, "tack.yaml", "version: 99");
          const failed = yield* resolveCatalogAt(options);
          expect(failed.entries).toEqual([]);
          expect(failed.unhealthySources).toMatchObject([
            {
              registration: { id: registered.registration.id },
              issue: { code: "declaration-version-unsupported" },
            },
          ]);
          expect(yield* readState(options)).toEqual(before);
          yield* write(root, "tack.yaml", declare("shared", "skills:", "  - path: skills"));
          expect(identities(yield* resolveCatalogAt(options))).toEqual(["shared/skill/valid"]);
        }),
      ),
  );
  test.effect("contains an unreadable declared folder beside independent resources", () =>
    withSource(({ root, options }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* write(root, "tack.yaml", declare("shared", ...all.slice(0, 3)));
        yield* write(root, "context/healthy.md");
        yield* write(root, "commands/review.md", "review");
        yield* write(root, "skills/valid/SKILL.md", bareSkillText("valid"));
        yield* registerSource(options, { sourcePath: root });
        const catalog = yield* provideTestFileSystem(resolveCatalogAt(options), {
          ...fs,
          readDirectory: (target) =>
            target === path.join(root, "skills")
              ? Effect.fail(
                  PlatformError.badArgument({
                    module: "unified-catalog-test",
                    method: "readDirectory",
                  }),
                )
              : fs.readDirectory(target),
        });
        expect(identities(catalog)).toEqual(["shared/command/review", "shared/context/healthy.md"]);
        expect(catalog.quarantined.map((entry) => entry.code)).toEqual([
          "skill-directory-unreadable",
        ]);
        expect(
          Schema.decodeUnknownSync(Schema.Array(CatalogQuarantineSchema), {
            onExcessProperty: "error",
          })(catalog.quarantined),
        ).toEqual(catalog.quarantined);
      }),
    ),
  );
  test.effect.each([
    "version: [",
    "version: 1\nname: shared\nextra: true",
    "version: 2\nname: shared",
    "- scalar",
    "version: 1\n---\nversion: 1",
  ])("makes a malformed root declaration unhealthy: %s", (encoded) =>
    withSource(({ root, options }) =>
      Effect.gen(function* () {
        yield* write(root, "skills/valid/SKILL.md", bareSkillText("valid"));
        yield* write(root, "tack.yaml", encoded);
        yield* registerSource(options, { sourcePath: root }).pipe(Effect.ignore);
        const catalog = yield* resolveCatalogAt(options);
        expect(identities(catalog)).toEqual([]);
        expect(catalog.entries).toEqual([]);
      }),
    ),
  );
});
