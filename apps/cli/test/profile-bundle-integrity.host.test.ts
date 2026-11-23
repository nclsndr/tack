import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { bundleFixture } from "./support/bundle-fixture.ts";
import { runBundleApply } from "../src/features/profiles/bundle-apply.ts";
import { bundleIntegrityIssue } from "../src/features/sources/bundle-integrity.ts";
import { readState } from "../src/services/state-store.ts";
import { mutateStateFixture } from "./support/state-fixture.ts";

it.layer(LiveTestLayer)("retained bundle integrity", (test) => {
  for (const alteration of [
    "source-link",
    "source-file",
    "manifest-link",
    "manifest-mode",
    "manifest-json",
    "manifest-identity",
    "member-link",
    "member-mode",
    "member-missing",
    "unsafe-name",
    "foreign-file",
    "unavailable",
  ] as const)
    test.effect(`reports ${alteration} as a repairable source finding`, () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run, file } = yield* bundleFixture;
        yield* run(runBundleApply(options, { ...request, file }));
        const state = yield* readState(options);
        const source = state.data.sources.find((registration) => registration.bundle !== undefined);
        if (source === undefined) throw new Error("Missing projection");
        const manifest = path.join(
          path.dirname(path.dirname(source.canonicalPath)),
          "manifest.json",
        );
        const member = path.join(source.canonicalPath, "skills/review/SKILL.md");
        if (
          alteration === "source-link" ||
          alteration === "source-file" ||
          alteration === "unavailable"
        ) {
          yield* fs.rename(source.canonicalPath, path.join(root, "moved-source"));
          if (alteration === "source-link")
            yield* fs.symlink(path.join(root, "moved-source"), source.canonicalPath);
          if (alteration === "source-file")
            yield* fs.writeFileString(source.canonicalPath, "foreign");
        } else if (alteration === "manifest-link") {
          yield* fs.rename(manifest, path.join(root, "moved-manifest"));
          yield* fs.symlink(path.join(root, "moved-manifest"), manifest);
        } else if (alteration === "manifest-mode") yield* fs.chmod(manifest, 0o600);
        else if (alteration === "manifest-json")
          yield* fs.writeFileString(manifest, "invalid JSON");
        else if (alteration === "manifest-identity") {
          const bytes = yield* fs.readFileString(manifest);
          const parsed: unknown = JSON.parse(bytes);
          if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid fixture");
          yield* fs.writeFileString(
            manifest,
            JSON.stringify({ ...parsed, identity: "0".repeat(64) }),
          );
        } else if (alteration === "member-link") {
          yield* fs.rename(member, path.join(root, "moved-member"));
          yield* fs.symlink(path.join(root, "moved-member"), member);
        } else if (alteration === "member-mode") yield* fs.chmod(member, 0o600);
        else if (alteration === "member-missing")
          yield* fs.rename(member, path.join(root, "moved-member"));
        else if (alteration === "unsafe-name")
          yield* fs.writeFileString(path.join(source.canonicalPath, "unsafe\\name"), "foreign");
        else yield* fs.writeFileString(path.join(source.canonicalPath, "foreign"), "foreign");
        expect(yield* bundleIntegrityIssue(source, state.data.sources)).toBeDefined();
        expect(yield* readState(options)).toEqual(state);
      }),
    );
  test.effect(
    "refuses duplicate retained keys and stale foreign registration paths before writes",
    () =>
      Effect.gen(function* () {
        const { fs, path, root, options, request, run, file, archive } = yield* bundleFixture;
        const payload = path.join(
          options.environment.TACK_STATE_DIR,
          "bundles",
          archive.manifest.identity,
        );
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            sources: [
              ...state.data.sources,
              {
                id: "00000000-0000-4000-8000-0000000000f1",
                canonicalPath: path.join(payload, "sources/source-0"),
              },
            ],
          },
        }));
        const before = yield* readState(options);
        expect(
          (yield* run(runBundleApply(options, { ...request, file, force: true }))).plan.findings[0]
            ?.code,
        ).toBe("profile-bundle-identity");
        expect(yield* readState(options)).toEqual(before);
        expect(yield* fs.exists(payload)).toBe(false);
        yield* mutateStateFixture(options, (state) => ({
          ...state,
          data: {
            ...state.data,
            sources: state.data.sources.filter(
              (source) => source.id !== "00000000-0000-4000-8000-0000000000f1",
            ),
          },
        }));
        yield* run(runBundleApply(options, { ...request, file }));
        yield* mutateStateFixture(options, (state) => {
          const source = state.data.sources.find(
            (registration) => registration.bundle !== undefined,
          );
          if (source === undefined) throw new Error("Missing projection");
          return {
            ...state,
            data: {
              ...state.data,
              sources: [
                ...state.data.sources,
                {
                  ...source,
                  id: "00000000-0000-4000-8000-0000000000f2",
                  canonicalPath: path.join(root, "conflicting-key"),
                },
              ],
            },
          };
        });
        const duplicate = yield* readState(options);
        expect(
          (yield* run(runBundleApply(options, { ...request, file, force: true }))).plan.findings[0]
            ?.code,
        ).toBe("profile-bundle-identity");
        expect(yield* readState(options)).toEqual(duplicate);
      }),
  );
});
