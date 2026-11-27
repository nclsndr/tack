import { enableAdapters } from "../src/features/reconciliation/agent.ts";
import { disableAdapter } from "../src/features/removal/adapter-disablement.ts";
import { ExecutionPlatformLive } from "../src/platform/execution/execution-platform.ts";
import { checkPaths } from "../src/features/check/check-paths.ts";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { profileFixture } from "./support/profile-fixture.ts";
import { mutateStateFixture } from "./support/state-fixture.ts";
import { readState } from "../src/services/state-store.ts";
import { runProfileApply } from "../src/features/profiles/profile-apply.ts";
import { runBundleApply } from "../src/features/profiles/bundle-apply.ts";
import { runBundleExport } from "../src/features/profiles/bundle-export.ts";
import { inspectDocs, resolveDocsTarget, attachDocs } from "../src/features/docs/docs.ts";
import { searchReader } from "../src/features/reader/search.ts";
import { runDoctor } from "../src/features/doctor/doctor.ts";
import { runStatus, statusPartialCauses } from "../src/features/status/status.ts";
import { runSyncCommand } from "../src/features/reconciliation/sync-command.ts";
import { doctorOutcome } from "../src/cli/envelope/outcomes.ts";

it.layer(LiveTestLayer)("profile workflow agreements", (test) => {
  for (const input of ["source", "bundle"] as const) {
    test.effect(
      `${input} apply exposes the same mounted docs to list, search, target and doctor`,
      () =>
        Effect.gen(function* () {
          const f = yield* profileFixture;
          yield* f.fs.makeDirectory(f.path.join(f.root, "git"));
          yield* f.write(
            "source/tack.yaml",
            "version: 1\nname: tools\nskills: []\ndocs: [{name: guide, path: docs}]\nprofiles: [{name: ci, path: ci.yaml}]\nbundle-support: [{kind: docs, name: guide, complete: true, files: [], prerequisites: []}]\n",
          );
          yield* f.write(
            "source/ci.yaml",
            "version: 1\nname: ci\nmembers: [{kind: docs, name: guide}]\n",
          );
          yield* f.write(
            "source/docs/index.md",
            "# Guide\n\nConstellation is the search sentinel.\n",
          );
          const checked = yield* checkPaths([f.source]);
          expect(checked.summary.errors, JSON.stringify(checked.findings)).toBe(0);
          if (input === "bundle") {
            const file = f.path.join(f.root, "ci.tar.gz");
            const exported = yield* runBundleExport(f.options, {
              reference: "tools:ci",
              output: file,
              apply: true,
            });
            expect(exported.exported, JSON.stringify(exported.plan.findings)).toBe(true);
            yield* f.fs.rename(f.source, f.source + "-unavailable");
            yield* mutateStateFixture(f.options, (state) => ({
              ...state,
              data: { ...state.data, sources: [] },
            }));
            expect(
              (yield* f.run(runBundleApply(f.options, { ...f.request, file }))).plan.refused,
            ).toBe(false);
          } else {
            const applied = yield* f.run(runProfileApply(f.options, f.request));
            expect(applied.plan.refused, JSON.stringify(applied.plan.findings)).toBe(false);
          }
          const before = yield* readState(f.options);
          const selector = { projectName: "ci", cwd: f.project };
          const inspected = yield* f.run(inspectDocs(f.options, selector));
          expect(inspected.complete).toBe(true);
          expect(inspected.resources.map((resource) => resource.name)).toEqual(["guide"]);
          expect(inspected.documents).toBe(1);
          expect(inspected.mounts.map((mount) => mount.resource.name)).toEqual(["guide"]);
          expect(inspected.mounts[0]?.state).toBe("mounted");
          const found = yield* f.run(
            searchReader(f.options, { ...selector, query: "Constellation" }),
          );
          expect(found.complete).toBe(true);
          expect(found.total).toBe(1);
          expect(found.hits[0]?.document.resource?.name).toBe("guide");
          const target = yield* f.run(
            resolveDocsTarget(f.options, { ...selector, resource: { reference: "guide" } }),
          );
          expect(target.destinationPath).toBe(inspected.mounts[0]?.destinationPath);
          expect(target.sourceDirectoryPath).toBe(inspected.resources[0]?.directoryPath);
          expect(yield* f.run(resolveDocsTarget(f.options, selector))).toEqual(target);
          const doctor = yield* f.run(
            runDoctor(f.options, f.home).pipe(Effect.provide(ExecutionPlatformLive)),
          );
          expect(doctor.checks.find((check) => check.id === "docs")?.outcome).toBe("ok");
          expect(doctor.checks.find((check) => check.id === "profiles")?.outcome).toBe("ok");
          expect(
            (yield* Effect.result(f.run(attachDocs(f.options, selector, { reference: "guide" }))))[
              "_tag"
            ],
          ).toBe("Failure");
          expect(yield* readState(f.options)).toEqual(before);
          expect(before.data.projects[0]?.docs?.attachments ?? []).toEqual([]);
        }),
    );
  }
  test.effect(
    "apply, retry, status and doctor agree that a member an enabled agent cannot take is skipped, not incomplete",
    () =>
      Effect.gen(function* () {
        const f = yield* profileFixture;
        yield* f.fs.makeDirectory(f.path.join(f.root, "git"));
        yield* f.write(
          "source/tack.yaml",
          "version: 1\nname: tools\nskills: [{path: skills}]\ncommands: [{path: audit.md}]\nprofiles: [{name: ci, path: ci.yaml}]\n",
        );
        yield* f.write("source/audit.md", "Audit\n");
        yield* f.write(
          "source/ci.yaml",
          "version: 1\nname: ci\nmembers: [review, {kind: command, name: audit}]\n",
        );
        const applied = yield* f.run(runProfileApply(f.options, f.request));
        const skip = `command ${f.sourceId}:audit: Tack does not link commands for codex`;
        expect(applied.plan.delivery).toMatchObject({
          incomplete: false,
          skipped: [{ member: `command ${f.sourceId}:audit`, adapter: "codex" }],
        });
        for (const adapters of [["codex"], ["codex", "cursor"], ["cursor"]] as const) {
          const skipped = adapters.some((adapter) => adapter === "codex");
          if (skipped === false) yield* f.run(disableAdapter(f.options, "codex", { apply: true }));
          else yield* enableAdapters(f.options, adapters);
          const synced = yield* f.run(
            runSyncCommand(f.options, {
              apply: true,
              cwd: f.project,
              selector: f.request.namespace,
              includeOptional: false,
              noDocs: false,
            }),
          );
          expect(
            synced.plan.resources?.causes.some(
              (cause) => cause.code === "profile-delivery-incomplete",
            ),
          ).toBe(false);
          const status = yield* f.run(
            runStatus(f.options, { cwd: f.project, selector: f.request.namespace }),
          );
          expect(
            statusPartialCauses(status).some(
              (cause) => cause.code === "profile-delivery-incomplete",
            ),
          ).toBe(false);
          yield* f.run(
            runSyncCommand(f.options, {
              apply: true,
              cwd: f.project,
              selector: { _tag: "user" },
              includeOptional: false,
              noDocs: false,
            }),
          );
          const doctor = yield* f.run(
            runDoctor(f.options, f.home).pipe(Effect.provide(ExecutionPlatformLive)),
          );
          // The check passes, and names each skipped member as a note.
          expect(doctor.checks.find((check) => check.id === "profiles")).toMatchObject({
            outcome: "ok",
            message:
              skipped === true
                ? `Retained profile inventories are resolved. Skipped where an agent cannot take them: ${skip}.`
                : "Retained profile inventories are resolved.",
          });
          expect(
            doctorOutcome(doctor).classification,
            JSON.stringify(doctor.checks.filter((check) => check.outcome === "failed")),
          ).toBe("success");
          expect(
            yield* f.fs.exists(
              f.path.join(
                f.project,
                skipped === true ? ".agents/skills/review" : ".cursor/skills/review",
              ),
            ),
          ).toBe(true);
        }
        // With no agent left, no member can land anywhere: delivery is incomplete everywhere.
        yield* f.run(disableAdapter(f.options, "cursor", { apply: true }));
        const synced = yield* f.run(
          runSyncCommand(f.options, {
            apply: false,
            cwd: f.project,
            selector: f.request.namespace,
            includeOptional: false,
            noDocs: false,
          }),
        );
        expect(
          synced.plan.resources?.causes.some(
            (cause) => cause.code === "profile-delivery-incomplete",
          ),
        ).toBe(true);
        const status = yield* f.run(
          runStatus(f.options, { cwd: f.project, selector: f.request.namespace }),
        );
        expect(
          statusPartialCauses(status).some((cause) => cause.code === "profile-delivery-incomplete"),
        ).toBe(true);
        const doctor = yield* f.run(
          runDoctor(f.options, f.home).pipe(Effect.provide(ExecutionPlatformLive)),
        );
        expect(doctor.checks.find((check) => check.id === "profiles")).toMatchObject({
          outcome: "failed",
          message: expect.stringContaining("no enabled adapter"),
        });
      }),
  );
});
