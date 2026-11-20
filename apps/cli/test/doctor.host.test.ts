import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { runDoctor } from "../src/features/doctor/doctor.ts";
import type { DoctorReport } from "../src/domain/doctor/doctor-schema.ts";
import { ReaderCorpus, ReaderSearchError } from "../src/services/reader-corpus.ts";
import { ExecutionPlatformLive } from "../src/platform/execution/execution-platform.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { GitLive } from "../src/platform/git/git.ts";
import {
  partialEnvelope,
  runTack,
  successfulEnvelope,
  withTackWorld,
  type TackWorld,
} from "./fixtures/tack-world.ts";

const outcomeOf = (report: DoctorReport, id: string) =>
  report.checks.find((check) => check.id === id);

it.layer(LiveTestLayer)("doctor in process", (doctorIt) => {
  const attachNotes = Effect.fnUntraced(function* (fixture: TackWorld) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "notes"), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(path.join(fixture.sourceDirectory, "notes", "a.md"), "# A\n");
    yield* fileSystem.writeFileString(
      path.join(fixture.sourceDirectory, "tack.yaml"),
      "version: 1\nskills:\n  - path: skills\ndocs:\n  - name: notes\n    path: notes\n",
    );
    successfulEnvelope(
      yield* runTack(fixture, ["docs", "--project", "workspace", "attach", "notes"]),
    );
  });
  // The fixture's project is a real repository, so doctor asks the real Git where it runs.
  const doctorIn = (fixture: TackWorld) =>
    runDoctor(fixture.options, fixture.homeDirectory).pipe(
      Effect.provide(ExecutionPlatformLive),
      Effect.provide(GitLive),
    );

  doctorIt.effect("fails the docs check when attached docs cannot be observed", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        yield* attachNotes(fixture);
        const healthy = yield* doctorIn(fixture);
        // Attached but not yet mounted is only a warning; the fault below must be worse.
        expect(outcomeOf(healthy, "docs")).toMatchObject({ outcome: "warning" });

        // The state read succeeds and the observation after it fails: that is not "all loading".
        const report = yield* doctorIn(fixture).pipe(
          Effect.provideService(ReaderCorpus, {
            checkFigures: () => Effect.die("the figure check is not used here"),
            loadProject: () =>
              Effect.fail(new ReaderSearchError({ kind: "read", message: "corpus exploded" })),
          }),
        );
        expect(outcomeOf(report, "docs")).toMatchObject({
          outcome: "failed",
          subjects: ["workspace"],
          next: ["tack", "docs", "--project", "workspace", "--state-dir", fixture.stateDirectory],
        });
        expect(outcomeOf(report, "docs")?.message).toContain("corpus exploded");
        expect(report.summary.failed).toBeGreaterThan(0);
      }),
    ),
  );

  doctorIt.effect(
    "warns on a hand-made skill folder a sync left in place, and links the rest",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const own = path.join(fixture.primaryRoot, ".claude", "skills", "valid");
          yield* fileSystem.makeDirectory(own, { recursive: true });
          yield* fileSystem.writeFileString(path.join(own, "SKILL.md"), "mine\n");
          successfulEnvelope(yield* runTack(fixture, ["adapter", "enable", "claude", "codex"]));
          yield* runTack(fixture, ["sync", "--project", "workspace", "--apply"]);

          const status = partialEnvelope(
            yield* runTack(fixture, ["status", "--project", "workspace"]),
          );
          expect(status.result).toMatchObject({
            destinations: [
              { _tag: "matching", adapter: "codex" },
              { _tag: "hand-made", adapter: "claude", destinationPath: own },
            ],
          });
          const report = yield* doctorIn(fixture);
          expect(outcomeOf(report, "links")).toEqual({
            id: "links",
            outcome: "warning",
            message:
              "Hand-made workspace:.claude/skills/valid is kept; Tack's valid is not linked there. Exclude Tack's valid from workspace to keep yours on purpose, or move yours away and sync.",
            subjects: ["workspace"],
            next: [
              "tack",
              "pick",
              "exclude",
              "source:valid",
              "--kind",
              "skill",
              "--project",
              "workspace",
              "--state-dir",
              fixture.stateDirectory,
            ],
          });
          expect(report.summary.failed).toBe(0);
          expect(yield* fileSystem.readFileString(path.join(own, "SKILL.md"))).toBe("mine\n");
        }),
      ),
  );

  doctorIt.effect("leaves a project whose root cannot be used to the projects check", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* attachNotes(fixture);
        yield* fileSystem.remove(fixture.primaryRoot, { recursive: true });
        const report = yield* doctorIn(fixture);
        expect(outcomeOf(report, "projects")?.outcome).toBe("failed");
        expect(outcomeOf(report, "docs")?.message ?? "").not.toContain("could not be observed");
      }),
    ),
  );
});
