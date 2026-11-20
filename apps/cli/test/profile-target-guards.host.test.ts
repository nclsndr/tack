import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { agentLink } from "../src/domain/links/link-record-schema.ts";
import { runProfileApply } from "../src/features/profiles/profile-apply.ts";
import { readState } from "../src/services/state-store.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { mutateState } from "./support/state-fixture.ts";

it.layer(LiveTestLayer)("profile target guards", (test) => {
  test.effect("saved user picks need --force before a user profile replaces them", () =>
    Effect.gen(function* () {
      const { options, request, run, home, sourceId } = yield* profileFixture;
      yield* mutateState(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          userChoices: [
            {
              address: { kind: "skill", name: "notes", sourceRegistrationId: sourceId },
              decision: "include",
            },
          ],
        },
      }));
      const user = {
        ...request,
        namespace: { _tag: "user" } as const,
        targetRoots: [],
        targetHome: home,
        apply: false,
      };
      const unforced = yield* run(runProfileApply(options, user));
      expect(unforced.plan.findings).toContainEqual(
        expect.objectContaining({
          code: "profile-existing-selection",
          message: expect.stringContaining("saved picks or exclusions"),
        }),
      );
      const forced = yield* run(runProfileApply(options, { ...user, force: true }));
      expect(forced.plan.findings.map((finding) => finding.code)).not.toContain(
        "profile-existing-selection",
      );
    }),
  );

  test.effect("a prepared recovery of another context refuses a profile here", () =>
    Effect.gen(function* () {
      const { options, request, run, home, project, source, sourceId } = yield* profileFixture;
      yield* mutateState(options, (state) => ({
        ...state,
        data: {
          ...state.data,
          journal: [
            {
              _tag: "create",
              link: agentLink({
                adapter: "codex",
                address: { kind: "skill", name: "notes", sourceRegistrationId: sourceId },
                sourceDirectoryPath: `${source}/skills/notes`,
                sourceRegistrationId: sourceId,
                target: { _tag: "project-root", canonicalPath: project, projectName: "ci" },
              }),
            },
          ],
        },
      }));
      const before = yield* readState(options);
      const refused = yield* run(
        runProfileApply(options, {
          ...request,
          namespace: { _tag: "user" },
          targetRoots: [],
          targetHome: home,
          force: true,
        }),
      );
      expect(refused.plan.refused).toBe(true);
      expect(refused.plan.findings).toContainEqual(
        expect.objectContaining({ code: "profile-target-recovery" }),
      );
      expect(yield* readState(options)).toEqual(before);
    }),
  );

  test.effect("a user profile without --target-home is refused at the boundary", () =>
    Effect.gen(function* () {
      const { options, request, run } = yield* profileFixture;
      const before = yield* readState(options);
      const refused = yield* run(
        runProfileApply(options, {
          ...request,
          namespace: { _tag: "user" },
          targetRoots: [],
          force: true,
        }),
      );
      expect(refused.plan.refused).toBe(true);
      expect(refused.plan.findings).toContainEqual(
        expect.objectContaining({
          code: "profile-target-boundary",
          message: expect.stringContaining("Use --target-home"),
        }),
      );
      expect(yield* readState(options)).toEqual(before);
    }),
  );
});
