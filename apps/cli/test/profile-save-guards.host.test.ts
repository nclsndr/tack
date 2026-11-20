import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runBundleApply } from "../src/features/profiles/bundle-apply.ts";
import { checkProfileInContext, profileContext } from "../src/features/profiles/profile-check.ts";
import { runProfileSaveSelection } from "../src/features/profiles/profile-copy.ts";
import { saveProfile } from "../src/features/profiles/profile-save.ts";
import { readState } from "../src/services/state-store.ts";
import { bundleFixture } from "./support/bundle-fixture.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";

it.layer(LiveTestLayer)("profile save guards", (test) => {
  test.effect("a lock record that names no live owner still refuses the save as busy", () =>
    Effect.gen(function* () {
      const { fs, path, source, options } = yield* profileFixture;
      const lock = path.join(source, ".tack-profile-save.lock");
      const before = yield* fs.readFileString(path.join(source, "tack.yaml"));
      for (const record of ["not a lock record\n", `${"9".repeat(20)}:abc\n`]) {
        yield* fs.writeFileString(lock, record);
        const result = yield* saveProfile(options, {
          sourcePath: source,
          profile: { version: 1, name: "fresh", members: [] },
        });
        expect(result.saved).toBe(false);
        expect(result.report.findings).toContainEqual(
          expect.objectContaining({
            code: "profile-save-conflict",
            message: "The source is locked by another save. Reload and retry after it finishes.",
          }),
        );
      }
      expect(yield* fs.exists(path.join(source, "profiles/fresh.yaml"))).toBe(false);
      expect(yield* fs.readFileString(path.join(source, "tack.yaml"))).toBe(before);
    }),
  );

  test.effect("a profile the source does not publish checks as invalid and unlinked", () =>
    Effect.gen(function* () {
      const { source, options } = yield* profileFixture;
      const context = yield* profileContext(options, source);
      const report = yield* checkProfileInContext(context, "missing");
      expect(report).toMatchObject({
        profileName: "missing",
        structural: "invalid",
        linkage: "unchecked",
        direct: [],
        required: [],
      });
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          code: "profile-unpublished",
          message: "Profile missing is not published by this source.",
        }),
      );
    }),
  );

  test.effect("saving a selection into a bundle projection is refused before any write", () =>
    Effect.gen(function* () {
      const { fs, path, options, request, run, file } = yield* bundleFixture;
      yield* run(runBundleApply(options, { ...request, file }));
      const projection = (yield* readState(options)).data.sources.find(
        (registration) => registration.bundle !== undefined,
      );
      if (projection === undefined) throw new Error("The bundle was not applied.");
      const result = yield* runProfileSaveSelection(options, {
        input: { user: true },
        sourcePath: projection.canonicalPath,
        name: "copy",
        edit: false,
        apply: true,
      });
      expect(result.saved).toBe(false);
      expect(result.plan.findings).toContainEqual(
        expect.objectContaining({ code: "profile-bundle-immutable" }),
      );
      expect(yield* fs.exists(path.join(projection.canonicalPath, "profiles/copy.yaml"))).toBe(
        false,
      );
    }),
  );

  test.effect("an explicit edit of a published profile replaces its members in place", () =>
    Effect.gen(function* () {
      const { fs, path, source, options } = yield* profileFixture;
      const request = { input: { user: true }, sourcePath: source, name: "ci", apply: true };
      const refused = yield* runProfileSaveSelection(options, { ...request, edit: false });
      expect(refused.saved).toBe(false);
      expect(refused.plan.findings.map((finding) => finding.code)).toEqual([
        "profile-copy-edit-required",
      ]);
      const edited = yield* runProfileSaveSelection(options, { ...request, edit: true });
      expect(edited.saved).toBe(true);
      expect(edited.plan.removed.map((address) => address.name)).toEqual(["review"]);
      expect(Bun.YAML.parse(yield* fs.readFileString(path.join(source, "ci.yaml")))).toMatchObject({
        name: "ci",
        members: [],
      });
    }),
  );
});
