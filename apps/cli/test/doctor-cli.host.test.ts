import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { DoctorReportSchema } from "../src/domain/doctor/doctor-schema.ts";
import { PublicEnvelopeSchema } from "../src/cli/host/public-outcome.ts";
import { recordFilesOf, type SkillFile } from "../src/features/imports/import-files.ts";
import { writeImports } from "../src/features/imports/import-write.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import {
  hostTack,
  successfulEnvelope,
  withTackWorld,
  type TackWorld,
  type ProcessResult,
} from "./fixtures/tack-world.ts";

const decodeReport = Schema.decodeUnknownSync(DoctorReportSchema, { onExcessProperty: "error" });
const decodeEnvelope = Schema.decodeUnknownSync(PublicEnvelopeSchema);

const doctorOf = (result: ProcessResult) => {
  expect(result.stderr).toBe("");
  const envelope = decodeEnvelope(JSON.parse(result.stdout));
  return { envelope, report: decodeReport(envelope.result), exitCode: Number(result.exitCode) };
};

const outcomeOf = (report: ReturnType<typeof decodeReport>, id: string) =>
  report.checks.find((check) => check.id === id);

const snapshot = Effect.fnUntraced(function* (fixture: TackWorld) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* fileSystem.readDirectory(fixture.stateDirectory);
  return yield* Effect.forEach(files.toSorted(), (name) =>
    fileSystem
      .readFileString(path.join(fixture.stateDirectory, name))
      .pipe(Effect.map((text) => [name, text] as const)),
  );
});

// The doctor command's process-level smoke test is in `doctor.system.test.ts`.
it.layer(LiveTestLayer)("doctor", (doctorIt) => {
  doctorIt.effect(
    "is healthy on delivered links, built-in skills included, and changes nothing",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "codex"]));
          successfulEnvelope(
            yield* hostTack(fixture, ["sync", "--project", "workspace", "--apply"]),
          );
          successfulEnvelope(yield* hostTack(fixture, ["sync", "--user", "--apply"]));
          const before = yield* snapshot(fixture);
          const { report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
          expect(exitCode).toBe(0);
          expect(outcomeOf(report, "state")?.outcome).toBe("ok");
          expect(outcomeOf(report, "projects")?.outcome).toBe("ok");
          expect(outcomeOf(report, "links")?.outcome).toBe("ok");
          expect(report.summary.failed).toBe(0);
          expect(yield* snapshot(fixture)).toEqual(before);
        }),
      ),
  );

  doctorIt.effect("checks imported skills, treating local edits as information", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files: ReadonlyArray<SkillFile> = [
          {
            path: "SKILL.md",
            bytes: new TextEncoder().encode("---\nname: pdf\ndescription: pdf\n---\n"),
            executable: false,
          },
        ];
        const recorded = recordFilesOf(files);
        yield* writeImports(fixture.sourceDirectory, [
          {
            name: "pdf",
            path: "skills/pdf",
            files,
            newFolders: [],
            record: {
              path: "skills/pdf",
              location: "github:acme/skills",
              transport: "https",
              "ref-kind": "default",
              revision: "a".repeat(40),
              "upstream-path": "skills/pdf",
              "upstream-tree": "b".repeat(40),
              "imported-at": "2026-11-11T12:40:00Z",
              digest: recorded.digest,
              files: recorded.files,
            },
          },
        ]);
        const quiet = doctorOf(yield* hostTack(fixture, ["doctor"])).report;
        expect(outcomeOf(quiet, "imports")).toMatchObject({
          outcome: "ok",
          message: expect.stringContaining("1 imported skill, all present and cataloged"),
        });
        yield* fs.writeFileString(
          path.join(fixture.sourceDirectory, "skills/pdf/SKILL.md"),
          "---\nname: pdf\ndescription: edited\n---\n",
        );
        const edited = doctorOf(yield* hostTack(fixture, ["doctor"])).report;
        expect(outcomeOf(edited, "imports")).toMatchObject({ outcome: "ok" });
        yield* fs.remove(path.join(fixture.sourceDirectory, "skills/pdf"), { recursive: true });
        const { report } = doctorOf(yield* hostTack(fixture, ["doctor"]));
        expect(outcomeOf(report, "imports")).toMatchObject({
          outcome: "failed",
          subjects: [expect.stringMatching(/:pdf$/)],
          next: [
            "tack",
            "import",
            "remove",
            expect.stringMatching(/:pdf$/),
            "--state-dir",
            fixture.stateDirectory,
          ],
        });
      }),
    ),
  );

  doctorIt.effect("warns about a source that declares nothing without failing the report", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.remove(path.join(fixture.sourceDirectory, "skills"), { recursive: true });
        yield* fs.writeFileString(path.join(fixture.sourceDirectory, "tack.yaml"), "version: 1\n");
        const { report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
        expect(exitCode).toBe(0);
        expect(outcomeOf(report, "sources")).toMatchObject({
          outcome: "warning",
          message: expect.stringContaining("manage-tack-sources"),
          subjects: [fixture.sourceDirectory],
        });
      }),
    ),
  );

  doctorIt.effect(
    "fails the sources check for a source with undeclared resource folders and carries its message",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(
            path.join(fixture.sourceDirectory, "tack.yaml"),
            "version: 1\n",
          );
          const { report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
          expect(exitCode).toBe(1);
          expect(outcomeOf(report, "sources")).toMatchObject({
            outcome: "failed",
            message: expect.stringContaining("Tack reads resources only from declarations"),
          });
          expect(outcomeOf(report, "sources")?.message).toContain("`skills/`");
        }),
      ),
  );

  doctorIt.effect("groups declaration problems per source in the sources check", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(fixture.sourceDirectory, "tack.yaml"),
          "version: 1\nskills:\n  - path: skills\n  - path: nowhere\n  - pth: typo\n",
        );
        yield* fs.makeDirectory(path.join(fixture.sourceDirectory, "skills", "broken"));
        yield* fs.writeFileString(
          path.join(fixture.sourceDirectory, "skills", "broken", "SKILL.md"),
          "no frontmatter",
        );
        const { report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
        expect(exitCode).toBe(0);
        const sources = outcomeOf(report, "sources");
        expect(sources).toMatchObject({
          outcome: "warning",
          subjects: [fixture.sourceDirectory],
          next: ["tack", "catalog", "--state-dir", fixture.stateDirectory],
        });
        expect(sources?.message).toContain("3 catalog candidates quarantined in 1 source");
        expect(sources?.message).toContain("2 declaration problems");
        expect(sources?.message).toContain("1 other problem");
      }),
    ),
  );

  doctorIt.effect(
    "reports every pick as pinned and names dependency sources that need registration",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          successfulEnvelope(
            yield* hostTack(fixture, ["pick", "include", "valid", "--project", "workspace"]),
          );
          yield* fs.writeFileString(
            path.join(fixture.sourceDirectory, "tack.yaml"),
            "version: 1\nskills:\n  - path: skills\ndepends-on:\n  - missing\n",
          );
          yield* fs.makeDirectory(path.join(fixture.sourceDirectory, "skills", "needs-lint"));
          yield* fs.writeFileString(
            path.join(fixture.sourceDirectory, "skills", "needs-lint", "SKILL.md"),
            "---\nname: needs-lint\ndescription: Needs lint\nmetadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n        name: lint\n        source: missing\n---\n",
          );
          const { report } = doctorOf(yield* hostTack(fixture, ["doctor"]));
          expect(outcomeOf(report, "unregistered-dependency-source")).toMatchObject({
            outcome: "warning",
            message: expect.stringContaining("tack source add"),
          });
        }),
      ),
  );

  doctorIt.effect("fails on a drifted link, names the project preview and exits 1", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        successfulEnvelope(yield* hostTack(fixture, ["adapter", "enable", "codex"]));
        successfulEnvelope(yield* hostTack(fixture, ["sync", "--project", "workspace", "--apply"]));
        successfulEnvelope(yield* hostTack(fixture, ["sync", "--user", "--apply"]));
        const link = path.join(fixture.primaryRoot, ".agents", "skills", "valid");
        yield* fileSystem.remove(link);
        yield* fileSystem.symlink(fixture.repositoryRoot, link);
        const before = yield* snapshot(fixture);
        const { envelope, report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
        expect(exitCode).toBe(1);
        expect(envelope).toMatchObject({ classification: "domain", status: "failure" });
        expect(envelope.diagnostics).toEqual([
          expect.objectContaining({ code: "doctor-check-failed", details: { check: "links" } }),
        ]);
        expect(outcomeOf(report, "links")).toMatchObject({
          outcome: "failed",
          subjects: ["workspace"],
          next: ["tack", "sync", "--project", "workspace", "--state-dir", fixture.stateDirectory],
        });
        expect(outcomeOf(report, "projects")?.outcome).toBe("ok");
        expect(yield* snapshot(fixture)).toEqual(before);
        expect(yield* fileSystem.readLink(link)).toBe(fixture.repositoryRoot);
      }),
    ),
  );

  doctorIt.effect("points an unmounted attached docs resource at its mount preview", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "notes"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(fixture.sourceDirectory, "notes", "a.md"),
          "# A\n",
        );
        yield* fileSystem.writeFileString(
          path.join(fixture.sourceDirectory, "tack.yaml"),
          "version: 1\nskills:\n  - path: skills\ndocs:\n  - name: notes\n    path: notes\n",
        );
        successfulEnvelope(
          yield* hostTack(fixture, ["docs", "--project", "workspace", "attach", "notes"]),
        );
        const { report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
        expect(exitCode).toBe(0);
        expect(outcomeOf(report, "docs")).toMatchObject({
          outcome: "warning",
          subjects: ["workspace"],
          next: ["tack", "sync", "--project", "workspace", "--state-dir", fixture.stateDirectory],
        });
      }),
    ),
  );

  doctorIt.effect("fails on a docs resource whose reader configuration is broken", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(fixture.sourceDirectory, "broken"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(fixture.sourceDirectory, "broken", "a.md"),
          "# A\n",
        );
        yield* fileSystem.writeFileString(
          path.join(fixture.sourceDirectory, "broken.reader.yaml"),
          "version: 1\ncontent: [unterminated\n",
        );
        yield* fileSystem.writeFileString(
          path.join(fixture.sourceDirectory, "tack.yaml"),
          "version: 1\nskills:\n  - path: skills\ndocs:\n  - name: broken\n    path: broken\n    reader: broken.reader.yaml\n",
        );
        successfulEnvelope(
          yield* hostTack(fixture, ["docs", "--project", "workspace", "attach", "broken"]),
        );
        const { report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
        expect(exitCode).toBe(1);
        expect(outcomeOf(report, "docs")).toMatchObject({
          outcome: "failed",
          subjects: ["workspace"],
        });
      }),
    ),
  );

  doctorIt.effect("fails the state check on a newer format and skips the rest", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(fixture.stateDirectory, "state.json"),
          '{"format":99,"data":{}}\n',
        );
        const { report, exitCode } = doctorOf(yield* hostTack(fixture, ["doctor"]));
        expect(exitCode).toBe(1);
        expect(outcomeOf(report, "state")).toMatchObject({
          outcome: "failed",
          next: ["tack", "upgrade"],
        });
        expect(outcomeOf(report, "links")?.outcome).toBe("skipped");
      }),
    ),
  );

  doctorIt.effect("exits 3 when the state document is corrupt", () =>
    withTackWorld((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(fixture.stateDirectory, "state.json"),
          '{"format":1,',
        );
        const result = yield* hostTack(fixture, ["doctor"]);
        expect(Number(result.exitCode)).toBe(3);
        expect(decodeEnvelope(JSON.parse(result.stdout))).toMatchObject({
          classification: "persistence",
          result: null,
        });
      }),
    ),
  );
});
