import { LiveTestLayer } from "./support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  partialEnvelope,
  runGit,
  runTack,
  successfulEnvelope,
  withTackWorld,
} from "./fixtures/tack-world.ts";

const decodeRunId = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }));

/** A script on the script API that installs nothing; the running Tack provides the import. */
const scriptDefinition = () =>
  `import { defineScript } from "@tackup/cli"; export default defineScript({ run: () => "done" });`;

it.layer(LiveTestLayer)("nested registered roots", (nestedIt) => {
  nestedIt.effect(
    "resolves docs, status, and script run to the innermost registered project",
    () =>
      withTackWorld((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const scripts = path.join(fixture.sourceDirectory, "scripts");
          yield* fileSystem.makeDirectory(scripts, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "package.json"),
            "{}",
          );
          yield* fileSystem.writeFileString(
            path.join(fixture.sourceDirectory, "tack.yaml"),
            "version: 1\nskills:\n  - path: skills\nscripts:\n  - name: run\n    path: scripts/run.ts\n    description: Run fixture\n",
          );
          yield* fileSystem.writeFileString(path.join(scripts, "run.ts"), scriptDefinition());
          // "workspace" owns the outer root and sorts before "zeta-inner", so a first-match scan
          // by project name would claim the nested root for the outer project.
          const innerRoot = path.join(fixture.primaryRoot, "inner");
          const deeper = path.join(innerRoot, "deeper");
          yield* runGit(fixture.primaryRoot, ["init", innerRoot]);
          yield* fileSystem.makeDirectory(deeper, { recursive: true });
          successfulEnvelope(
            yield* runTack(fixture, [
              "project",
              "add",
              "zeta-inner",
              "--repository-cwd",
              innerRoot,
            ]),
          );

          for (const cwd of [innerRoot, deeper]) {
            // Nothing is attached, so the docs setup is incomplete rather than failed.
            const docs = partialEnvelope(yield* runTack(fixture, ["docs", "list"], cwd));
            // No adapter is enabled, so status is partial only because nothing is delivered.
            const status = partialEnvelope(yield* runTack(fixture, ["status"], cwd));
            expect(status.diagnostics.map(({ code }) => code)).toEqual(["no-adapters-enabled"]);
            const run = successfulEnvelope(
              yield* runTack(fixture, ["script", "run", "run", "--input-json", "{}"], cwd),
            );
            const { runId } = decodeRunId(run.result);
            const history = successfulEnvelope(
              yield* runTack(fixture, ["script", "history", "show", runId], cwd),
            );
            expect({
              docs: docs.result,
              history: history.result,
              status: status.result,
            }).toMatchObject({
              docs: { complete: false, project: { name: "zeta-inner", root: innerRoot } },
              history: {
                target: {
                  _tag: "project-root",
                  canonicalPath: innerRoot,
                  projectName: "zeta-inner",
                },
              },
              status: {
                scope: { _tag: "project", projectName: "zeta-inner" },
                selection: {
                  selector: { _tag: "bare" },
                  containingRoot: { projectName: "zeta-inner", root: innerRoot },
                },
              },
            });
          }

          const outer = partialEnvelope(
            yield* runTack(fixture, ["docs", "list"], fixture.primaryRoot),
          );
          expect(outer.result).toMatchObject({
            project: { name: "workspace", root: fixture.primaryRoot },
          });
        }),
      ),
    { timeout: 30_000 },
  );
});
