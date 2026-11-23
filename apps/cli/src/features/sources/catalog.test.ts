import { withStateFixture } from "../../../test/support/state-fixture.ts";
import { resolveCatalogAt } from "../../../test/support/snapshot-helpers.ts";
import type { CatalogEntry, SkillCatalogEntry } from "../../domain/sources/catalog-schema.ts";
import { LiveTestLayer, provideTestFileSystem } from "../../../test/support/live-test-layer.ts";
import { faultyFileSystem, platformTestError } from "../../../test/support/faults.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { registerSource } from "./source.ts";
import { type Catalog } from "./catalog.ts";

const declarationFileName = "tack.yaml";
const skillFileName = "SKILL.md";

const skillEntries = (catalog: { readonly entries: ReadonlyArray<CatalogEntry> }) =>
  catalog.entries.filter((entry): entry is SkillCatalogEntry => entry.address.kind === "skill");

const validDeclaration = () => "version: 1\nskills:\n  - path: skills\n";
const sourceAreas = new Map<string, string>();

const frontmatter = (name: string, body = "description: A valid skill.") =>
  `---\nname: ${name}\n${body.includes("description:") ? body : `description: A valid skill.\n${body}`}\n---\n\n# Instructions\n`;

const createSource = Effect.fnUntraced(function* (parent: string, name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(parent, name);
  yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
  yield* fileSystem.writeFileString(path.join(sourcePath, declarationFileName), validDeclaration());
  sourceAreas.set(sourcePath, path.join(sourcePath, "skills"));
  return sourcePath;
});

const createSkill = Effect.fnUntraced(function* (
  directory: string,
  name: string,
  encodedFrontmatter: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(sourceAreas.get(directory) ?? directory, name);
  yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(skillDirectory, skillFileName), encodedFrontmatter);
  return skillDirectory;
});

const names = (catalog: Catalog) => catalog.entries.map((entry) => entry.address.name);

it.layer(LiveTestLayer)("skill catalog", (sourceIt) => {
  sourceIt.effect("discovers nested group folders, and a skill folder is a leaf", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        const outsideDirectory = path.join(root, "outside");
        yield* createSkill(
          sourcePath,
          "zeta",
          frontmatter("zeta", "description: Zeta\nagent-extra: true"),
        );
        const nestedParent = yield* createSkill(sourcePath, "parent", frontmatter("parent"));
        yield* createSkill(nestedParent, "child", frontmatter("child"));
        yield* createSkill(sourcePath, "alpha", frontmatter("alpha"));
        const externalSkill = yield* createSkill(
          outsideDirectory,
          "external",
          frontmatter("external"),
        );
        yield* fileSystem.symlink(externalSkill, path.join(sourcePath, "skills", "outside-link"));
        yield* fileSystem.symlink(
          path.join(sourcePath, "skills"),
          path.join(sourcePath, "skills", "source-cycle"),
        );
        yield* registerSource(options, { sourcePath });
        const statePath = path.join(root, "state", "state.json");
        const skillPath = path.join(sourcePath, "skills", "alpha", skillFileName);
        const stateBefore = yield* fileSystem.readFileString(statePath);
        const skillBefore = yield* fileSystem.readFileString(skillPath);

        const catalog = yield* resolveCatalogAt(options);

        expect(names(catalog)).toEqual(["alpha", "parent", "zeta"]);
        expect(
          skillEntries(catalog).find((entry) => entry.address.name === "zeta")?.frontmatter,
        ).toMatchObject({
          "agent-extra": true,
        });
        expect(catalog.quarantined).toMatchObject([{ code: "resource-boundary-violation" }]);
        expect(catalog.unhealthySources).toEqual([]);
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
        expect(yield* fileSystem.readFileString(skillPath)).toBe(skillBefore);
      }),
    ),
  );

  sourceIt.effect("applies defaults and decodes activation, projects, and exact dependencies", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const sourcePath = yield* createSource(root, "source");
        yield* createSkill(sourcePath, "default-skill", frontmatter("default-skill"));
        yield* createSkill(
          sourcePath,
          "configured",
          frontmatter(
            "configured",
            `description: Configured\nallowed-tools: Bash\ncompatibility: Requires Bun.\nlicense: MIT\nmetadata:\n  author: ada\n  tack: |\n    version: 1\n    activation: opt-in\n    projects:\n      - demo-app\n    dependencies:\n      - kind: skill\n        name: default-skill\n        optional: true`,
          ),
        );
        yield* registerSource(options, { sourcePath });

        const catalog = yield* resolveCatalogAt(options);
        const defaultSkill = skillEntries(catalog).find(
          (entry) => entry.address.name === "default-skill",
        );
        const configured = skillEntries(catalog).find(
          (entry) => entry.address.name === "configured",
        );

        expect(defaultSkill).toMatchObject({
          activation: "default",
          projects: [],
          dependencies: [],
        });
        expect(configured).toMatchObject({
          activation: "opt-in",
          projects: ["demo-app"],
          dependencies: [{ kind: "skill", name: "default-skill", optional: true }],
          frontmatter: {
            "allowed-tools": "Bash",
            compatibility: "Requires Bun.",
            license: "MIT",
            metadata: { author: "ada" },
          },
        });
      }),
    ),
  );

  sourceIt.effect("quarantines invalid candidates independently with stable reasons", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const sourcePath = yield* createSource(root, "source");
        yield* createSkill(sourcePath, "valid", frontmatter("valid"));
        yield* createSkill(
          sourcePath,
          "missing-opening",
          "name: missing-opening\ndescription: no opening\n---\n",
        );
        yield* createSkill(
          sourcePath,
          "missing-fence",
          "---\nname: missing-fence\ndescription: no close\n",
        );
        yield* createSkill(sourcePath, "bad-yaml", "---\nname: bad-yaml\ndescription: [\n---\n");
        yield* createSkill(
          sourcePath,
          "bad-frontmatter-schema",
          "---\nname: bad-frontmatter-schema\ndescription: 42\n---\n",
        );
        yield* createSkill(sourcePath, "scalar-frontmatter", "---\nscalar\n---\n");
        yield* createSkill(sourcePath, "sequence-frontmatter", "---\n- scalar\n---\n");
        yield* createSkill(sourcePath, "mismatch", frontmatter("different"));
        yield* createSkill(
          sourcePath,
          "wrong-tack-type",
          frontmatter("wrong-tack-type", "description: Bad tack\nmetadata:\n  tack: false"),
        );
        yield* createSkill(
          sourcePath,
          "bad-activation",
          frontmatter(
            "bad-activation",
            "metadata:\n  tack: |\n    version: 1\n    activation: always",
          ),
        );
        yield* createSkill(
          sourcePath,
          "bad-projects-type",
          frontmatter(
            "bad-projects-type",
            "metadata:\n  tack: |\n    version: 1\n    projects: demo-app",
          ),
        );
        yield* createSkill(
          sourcePath,
          "bad-dependencies-type",
          frontmatter(
            "bad-dependencies-type",
            "metadata:\n  tack: |\n    version: 1\n    dependencies: skill",
          ),
        );
        yield* createSkill(
          sourcePath,
          "bad-dependency-item",
          frontmatter(
            "bad-dependency-item",
            "metadata:\n  tack: |\n    version: 1\n    dependencies:\n      - scalar",
          ),
        );
        yield* createSkill(
          sourcePath,
          "bad-metadata-carrier",
          frontmatter("bad-metadata-carrier", "metadata:\n  source: 42\n  tack: |\n    version: 1"),
        );
        yield* createSkill(
          sourcePath,
          "metadata-scalar",
          frontmatter("metadata-scalar", "metadata: scalar"),
        );
        yield* createSkill(
          sourcePath,
          "metadata-bad-yaml",
          frontmatter("metadata-bad-yaml", "metadata:\n  tack: |\n    version: ["),
        );
        yield* createSkill(
          sourcePath,
          "bad-tack-schema",
          frontmatter("bad-tack-schema", "metadata:\n  tack: |\n    activation: opt-in"),
        );
        yield* createSkill(
          sourcePath,
          "bad-version",
          frontmatter("bad-version", "metadata:\n  tack: |\n    version: 2"),
        );
        yield* createSkill(
          sourcePath,
          "bad-kind",
          frontmatter(
            "bad-kind",
            "metadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: context\n        name: thing",
          ),
        );
        yield* createSkill(
          sourcePath,
          "metadata-sequence",
          frontmatter("metadata-sequence", "metadata:\n  tack: |\n    - a\n    - b"),
        );
        yield* registerSource(options, { sourcePath });

        const catalog = yield* resolveCatalogAt(options);

        expect(names(catalog)).toEqual(["valid"]);
        expect(
          catalog.quarantined.find(
            (entry) => entry.code === "skill-metadata-dependency-kind-unsupported",
          )?.message,
        ).toBe("Only skill and command dependency kinds are supported.");
        expect(catalog.quarantined.map((entry) => entry.code)).toEqual([
          "skill-metadata-activation-invalid",
          "skill-metadata-dependency-invalid",
          "skill-metadata-dependency-invalid",
          "skill-frontmatter-schema-invalid",
          "skill-metadata-dependency-kind-unsupported",
          "skill-metadata-schema-invalid",
          "skill-metadata-projects-invalid",
          "skill-metadata-schema-invalid",
          "skill-metadata-version-unsupported",
          "skill-frontmatter-yaml-malformed",
          "skill-metadata-yaml-malformed",
          "skill-metadata-not-mapping",
          "skill-metadata-root-not-mapping",
          "skill-name-mismatch",
          "skill-frontmatter-missing",
          "skill-frontmatter-missing",
          "skill-frontmatter-root-not-mapping",
          "skill-frontmatter-root-not-mapping",
          "skill-metadata-not-string",
        ]);
        expect(catalog.quarantined.every((entry) => entry.address !== undefined)).toBe(true);
        expect(
          catalog.quarantined.find((entry) => entry.code === "skill-name-mismatch")?.address,
        ).toMatchObject({ kind: "skill", name: "mismatch" });
      }),
    ),
  );

  sourceIt.effect("rejects nested multi-document metadata and duplicate dependency addresses", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const sourcePath = yield* createSource(root, "source");
        yield* createSkill(
          sourcePath,
          "multi-doc",
          frontmatter("multi-doc", "metadata:\n  tack: |\n    version: 1\n    ---\n    version: 1"),
        );
        yield* createSkill(
          sourcePath,
          "duplicate-dep",
          frontmatter(
            "duplicate-dep",
            `metadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n        name: target\n      - kind: skill\n        name: target\n        optional: true`,
          ),
        );
        yield* registerSource(options, { sourcePath });

        const catalog = yield* resolveCatalogAt(options);

        expect(catalog.entries).toEqual([]);
        expect(catalog.quarantined.map((entry) => entry.code)).toEqual([
          "skill-metadata-dependency-duplicate",
          // The YAML parser refuses a second document outright.
          "skill-metadata-yaml-malformed",
        ]);
      }),
    ),
  );

  sourceIt.effect("orders quarantine records by canonical source path", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const firstSource = yield* createSource(root, "first");
        const secondSource = yield* createSource(root, "second");
        yield* createSkill(
          firstSource,
          "invalid-first",
          frontmatter("invalid-first", "description: 42"),
        );
        yield* createSkill(
          secondSource,
          "invalid-second",
          frontmatter("invalid-second", "description: 42"),
        );
        yield* registerSource(options, { sourcePath: firstSource });
        yield* registerSource(options, { sourcePath: secondSource });

        const catalog = yield* resolveCatalogAt(options);

        expect(catalog.quarantined.map((entry) => entry.code)).toEqual([
          "skill-frontmatter-schema-invalid",
          "skill-frontmatter-schema-invalid",
        ]);
        const sourcePaths = catalog.quarantined.map((entry) => entry.sourcePath);
        expect(sourcePaths).toEqual([...sourcePaths].sort());
      }),
    ),
  );

  sourceIt.effect(
    "quarantines every locally valid member of an exact-address duplicate group",
    () =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const firstSource = yield* createSource(root, "first");
          const privateSource = yield* createSource(root, "private");
          yield* createSkill(firstSource, "one/duplicate", frontmatter("duplicate"));
          yield* createSkill(firstSource, "independent", frontmatter("independent"));
          yield* createSkill(firstSource, "two/duplicate", frontmatter("duplicate"));
          yield* createSkill(privateSource, "duplicate", frontmatter("duplicate"));
          yield* registerSource(options, { sourcePath: firstSource });
          yield* registerSource(options, { sourcePath: privateSource });

          const catalog = yield* resolveCatalogAt(options);

          expect(names(catalog)).toEqual(["independent", "duplicate"]);
          expect(
            skillEntries(catalog).filter((entry) => entry.address.name === "duplicate"),
          ).toHaveLength(1);
          const duplicates = catalog.quarantined.filter(
            (entry) => entry.code === "skill-address-duplicate",
          );
          expect(duplicates).toHaveLength(2);
          expect(duplicates.map((entry) => entry.address)).toMatchObject([
            { kind: "skill", name: "duplicate" },
            { kind: "skill", name: "duplicate" },
          ]);
        }),
      ),
  );

  sourceIt.effect("keeps an unhealthy source separate from catalog quarantine", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        const secondSourcePath = yield* createSource(root, "second-source");
        yield* createSkill(sourcePath, "valid", frontmatter("valid"));
        yield* registerSource(options, { sourcePath });
        yield* registerSource(options, { sourcePath: secondSourcePath });
        const statePath = path.join(root, "state", "state.json");
        const stateBefore = yield* fileSystem.readFileString(statePath);
        yield* fileSystem.remove(sourcePath, { recursive: true });
        yield* fileSystem.remove(secondSourcePath, { recursive: true });

        const catalog = yield* resolveCatalogAt(options);

        expect(catalog.entries).toEqual([]);
        expect(catalog.quarantined).toEqual([]);
        expect(catalog.unhealthySources).toHaveLength(2);
        expect(catalog.unhealthySources).toMatchObject([
          { status: "unhealthy", issue: { code: "source-missing" } },
          { status: "unhealthy", issue: { code: "source-missing" } },
        ]);
        const sourcePaths = catalog.unhealthySources.map(
          (source) => source.registration.canonicalPath,
        );
        expect(sourcePaths).toEqual([...sourcePaths].sort());
        expect(yield* fileSystem.readFileString(statePath)).toBe(stateBefore);
      }),
    ),
  );

  sourceIt.effect("quarantines filesystem discovery and read failures independently", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        yield* createSkill(sourcePath, "normal", frontmatter("normal"));
        yield* createSkill(sourcePath, "outside", frontmatter("outside"));
        yield* createSkill(sourcePath, "read-error", frontmatter("read-error"));
        yield* createSkill(sourcePath, "unreadable-file", frontmatter("unreadable-file"));
        yield* fileSystem.makeDirectory(path.join(sourcePath, "skills", "unreadable-directory"));
        yield* fileSystem.makeDirectory(path.join(sourcePath, "skills", "unresolvable-directory"));
        yield* fileSystem.writeFileString(
          path.join(sourcePath, "skills", "stat-error"),
          "not a directory",
        );
        yield* registerSource(options, { sourcePath });

        const canonicalSourcePath = yield* fileSystem.realPath(sourcePath);
        const outsidePath = path.join(root, "outside-target", skillFileName);
        const outsideSkillPath = path.join(canonicalSourcePath, "skills", "outside", skillFileName);
        const readErrorSkillPath = path.join(
          canonicalSourcePath,
          "skills",
          "read-error",
          skillFileName,
        );
        const statErrorPath = path.join(canonicalSourcePath, "skills", "stat-error");
        const unreadableDirectoryPath = path.join(
          canonicalSourcePath,
          "skills",
          "unreadable-directory",
        );
        const unreadableSkillPath = path.join(
          canonicalSourcePath,
          "skills",
          "unreadable-file",
          skillFileName,
        );
        const unresolvableDirectoryPath = path.join(
          canonicalSourcePath,
          "skills",
          "unresolvable-directory",
        );
        const faulty = yield* faultyFileSystem({
          readDirectory: (candidate) =>
            candidate === unreadableDirectoryPath ? platformTestError("readDirectory") : undefined,
          readFileString: (candidate) =>
            candidate === readErrorSkillPath ? platformTestError("readFileString") : undefined,
          realPath: (candidate) =>
            candidate === unreadableSkillPath || candidate === unresolvableDirectoryPath
              ? platformTestError("realPath")
              : undefined,
          stat: (candidate) =>
            candidate === statErrorPath ? platformTestError("stat") : undefined,
        });
        const catalog = yield* provideTestFileSystem(resolveCatalogAt(options), {
          ...faulty,
          realPath: (candidate) =>
            candidate === outsideSkillPath
              ? Effect.succeed(outsidePath)
              : faulty.realPath(candidate),
        });

        expect(names(catalog)).toEqual(["normal"]);
        expect(catalog.quarantined.map((entry) => entry.code)).toEqual([
          "resource-boundary-violation",
          "skill-file-unreadable",
          "resource-unreadable",
          "skill-directory-unreadable",
          "resource-unreadable",
          "resource-unreadable",
        ]);
        expect(
          catalog.quarantined.find((entry) => entry.directoryPath.endsWith("outside/SKILL.md")),
        ).toMatchObject({
          address: { kind: "skill", name: "outside" },
          code: "resource-boundary-violation",
        });
        expect(
          catalog.quarantined.find((entry) => entry.directoryPath.endsWith("read-error")),
        ).toMatchObject({
          address: { kind: "skill", name: "read-error" },
        });
        expect(
          catalog.quarantined.find((entry) => entry.directoryPath.endsWith("unreadable-directory"))
            ?.address,
        ).toBeUndefined();
      }),
    ),
  );

  sourceIt.effect("quarantines an unreadable declared folder", () =>
    withStateFixture(({ options, root }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sourcePath = yield* createSource(root, "source");
        yield* fileSystem.makeDirectory(path.join(sourcePath, "skills"), { recursive: true });
        yield* registerSource(options, { sourcePath });
        const canonicalSkills = path.join(yield* fileSystem.realPath(sourcePath), "skills");

        const catalog = yield* provideTestFileSystem(
          resolveCatalogAt(options),
          yield* faultyFileSystem({
            readDirectory: (candidate) =>
              candidate === canonicalSkills ? platformTestError("readDirectory") : undefined,
          }),
        );

        expect(catalog.entries).toEqual([]);
        expect(catalog.quarantined).toMatchObject([
          { code: "skill-directory-unreadable", directoryPath: canonicalSkills },
        ]);
        expect(catalog.quarantined[0]?.address).toBeUndefined();
        expect(yield* fileSystem.readFileString(path.join(root, "state", "state.json"))).toContain(
          '"sources"',
        );
      }),
    ),
  );
});
