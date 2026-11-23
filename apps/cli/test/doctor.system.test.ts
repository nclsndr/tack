import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { DoctorReportSchema } from "../src/domain/doctor/doctor-schema.ts";
import { PublicEnvelopeSchema } from "../src/cli/host/public-outcome.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { runProcess } from "./fixtures/tack-world.ts";

const decodeReport = Schema.decodeUnknownSync(DoctorReportSchema, { onExcessProperty: "error" });
const decodeEnvelope = Schema.decodeUnknownSync(PublicEnvelopeSchema);

const outcomeOf = (report: ReturnType<typeof decodeReport>, id: string) =>
  report.checks.find((check) => check.id === id);

// The process-level smoke test of `tack doctor`. Its other cases run in process, in
// `doctor-cli.host.test.ts`.
it.layer(LiveTestLayer)("doctor", (doctorIt) => {
  doctorIt.effect("reports missing state and skill setup as findings without creating state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-doctor-empty-" });
      const home = path.join(root, "home");
      yield* fileSystem.makeDirectory(home, { recursive: true });
      const entrypoint = path.join(path.resolve("."), "apps", "cli", "src", "main.ts");
      const result = yield* runProcess("bun", [entrypoint, "--json", "doctor"], {
        cwd: root,
        environment: { HOME: home, TACK_STATE_DIR: undefined },
      });
      expect(result.stderr).toBe("");
      const envelope = decodeEnvelope(JSON.parse(result.stdout));
      const report = decodeReport(envelope.result);
      expect(Number(result.exitCode)).toBe(0);
      expect(envelope).toMatchObject({ command: "doctor", classification: "success" });
      expect(outcomeOf(report, "state")).toMatchObject({
        outcome: "warning",
        next: ["tack", "init"],
      });
      for (const id of [
        "adapters",
        "sources",
        "imports",
        "projects",
        "links",
        "docs",
        "unregistered-dependency-source",
      ])
        expect(outcomeOf(report, id)?.outcome, id).toBe("skipped");
      expect(report.summary).toMatchObject({ failed: 0, total: 11 });
      expect(yield* fileSystem.exists(path.join(home, ".tack"))).toBe(false);
    }).pipe(Effect.scoped),
  );
});
