import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { bundleDigest, makeBundleManifest } from "../src/domain/bundles/bundle-codec.ts";
import type { BundleManifest } from "../src/domain/bundles/bundle-schema.ts";
import type { ArchiveEntry } from "../src/domain/bundles/tar.ts";
import { checkBundleProjection } from "../src/features/profiles/bundle-check.ts";
import { bundleFixture } from "./support/bundle-fixture.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";

type Archive = { readonly manifest: BundleManifest; readonly entries: ReadonlyArray<ArchiveEntry> };

/**
 * Replaces or adds regular files of the defining source and reissues a manifest whose digests
 * match, the way a sender could, so only the projection check can refuse it.
 */
const tamper = (archive: Archive, files: Readonly<Record<string, string>>): Archive => {
  const prefix = "sources/source-0/";
  const changed = Object.entries(files).map(([relative, text]): ArchiveEntry => ({
    path: `${prefix}${relative}`,
    kind: "file",
    mode: 0o644,
    bytes: new TextEncoder().encode(text),
  }));
  const replaced = new Set(changed.map((entry) => entry.path));
  const directories = [
    ...new Set(
      changed.flatMap((entry) =>
        entry.path
          .split("/")
          .slice(0, -1)
          .map((_, index, parts) => parts.slice(0, index + 1).join("/"))
          .filter((path) => path.startsWith(prefix)),
      ),
    ),
  ]
    .filter((path) => archive.entries.every((entry) => entry.path !== path))
    .map((path): ArchiveEntry => ({
      path,
      kind: "directory",
      mode: 0o755,
      bytes: new Uint8Array(),
    }));
  const entries = [
    ...archive.entries.filter((entry) => replaced.has(entry.path) === false),
    ...directories,
    ...changed,
  ];
  const { identity: _identity, ...content } = archive.manifest;
  return {
    entries,
    manifest: makeBundleManifest({
      ...content,
      files: entries
        .filter((entry) => entry.path !== "manifest.json")
        .map((entry) => ({
          path: entry.path,
          kind: entry.kind,
          size: entry.bytes.length,
          mode: entry.mode,
          sha256: bundleDigest(entry.bytes),
        }))
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    }),
  };
};

const refusal = (archive: Archive) => checkBundleProjection(archive).pipe(Effect.flip);

it.layer(LiveTestLayer)("bundle projection check", (test) => {
  test.effect("a projected profile naming a member the bundle lacks is incomplete", () =>
    Effect.gen(function* () {
      const { archive } = yield* bundleFixture;
      const error = yield* refusal(
        tamper(archive, { "ci.yaml": "version: 1\nname: ci\nmembers: [review, ghost]\n" }),
      );
      expect(error).toMatchObject({ code: "profile-bundle-incomplete" });
      expect(error.message).toMatch(/^Projected profile is incomplete: .*ghost/);
    }),
  );

  test.effect("a quarantined projected resource refuses the bundle", () =>
    Effect.gen(function* () {
      const { archive } = yield* bundleFixture;
      const error = yield* refusal(
        tamper(archive, {
          "tack.yaml":
            "version: 2\nname: tools\nskills: [{path: skills/review}, {path: skills/style}, {path: skills/broken}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
          "skills/broken/SKILL.md": "---\nname: [broken\n---\n",
        }),
      );
      expect(error).toMatchObject({
        code: "profile-bundle-incomplete",
        message:
          "A projected source resource is quarantined. Repair its declaration/content before export.",
      });
    }),
  );

  test.effect("a projected resource outside the published inventory refuses the bundle", () =>
    Effect.gen(function* () {
      const { archive } = yield* bundleFixture;
      const error = yield* refusal(
        tamper(archive, {
          "tack.yaml":
            "version: 2\nname: tools\nskills: [{path: skills/review}, {path: skills/style}, {path: skills/extra}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
          "skills/extra/SKILL.md": "---\nname: extra\ndescription: Extra\n---\n",
        }),
      );
      expect(error).toMatchObject({
        code: "profile-bundle-invalid",
        message: expect.stringContaining("declares resources outside its exact inventory"),
      });
    }),
  );
});
