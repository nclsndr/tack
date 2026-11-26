import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalContextShape } from "../src/cli/host/human/terminal-context.ts";
import { exitCodeForEnvelope } from "../src/cli/host/public-outcome.ts";
import { guideTopics } from "../src/domain/guides/guide-schema.ts";
import { Source } from "../src/features/sources/source.ts";
import { tackYamlGuide } from "../src/features/guides/tack-yaml-guide.ts";
import { builtInSource } from "../src/release.ts";
import { StateStore } from "../src/services/state-store.ts";
import { currentVersionReport } from "../src/version.ts";
import { outsideRepositoryGit } from "./support/fake-git.ts";
import { runHost } from "./support/host-runner.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { decodeEnvelope } from "./support/tack-process.ts";

const pipe: TerminalContextShape = {
  columns: 120,
  environment: { TERM: "dumb" },
  stdinIsTerminal: false,
  stdoutIsTerminal: false,
};

/** The guide a built-in skill ships, read the way an agent reads the skill's reference. */
const shipped = (topic: string) =>
  readFileSync(
    join(builtInSource.canonicalPath, "skills", "use-tack", "references", `${topic}.md`),
    "utf8",
  );

const stamp = currentVersionReport().stamp;

/**
 * Runs `tack` with no HOME and no state, its built-in source at `builtIns`, or none when `null`. A
 * read of Tack state is a defect, so a run that succeeds proves the command needs neither.
 */
const tack = (args: ReadonlyArray<string>, builtIns: string | null = builtInSource.canonicalPath) =>
  Effect.gen(function* () {
    const source = yield* Source;
    const store = yield* StateStore;
    return yield* runHost({ args, git: outsideRepositoryGit, terminal: pipe }).pipe(
      Effect.provideService(Source, {
        ...source,
        builtInSources: builtIns === null ? [] : [{ ...builtInSource, canonicalPath: builtIns }],
      }),
      Effect.provideService(StateStore, {
        ...store,
        read: () => Effect.die("tack guide read Tack state"),
      }),
    );
  });

const json = (args: ReadonlyArray<string>, builtIns?: string | null) =>
  tack(["--json", ...args], builtIns).pipe(Effect.map(({ stdout }) => decodeEnvelope(stdout)));

it.layer(LiveTestLayer)("tack guide", (guideIt) => {
  guideIt.effect(
    "prints a guide verbatim under a header that names the running version, without HOME or state",
    () =>
      Effect.gen(function* () {
        const { stdout } = yield* tack(["guide", "onboarding"]);
        expect(stdout.startsWith(`tack guide · onboarding · tack ${stamp} · ✓ success\n`)).toBe(
          true,
        );
        expect(stdout.endsWith(`\n\n${shipped("onboarding")}`)).toBe(true);

        const envelope = yield* json(["guide", "agent-instructions"]);
        expect(exitCodeForEnvelope(envelope)).toBe(0);
        expect(envelope).toMatchObject({ command: "guide", next: [] });
        expect(envelope.result).toEqual({
          kind: "guide",
          topic: "agent-instructions",
          version: stamp,
          markdown: shipped("agent-instructions"),
        });
      }),
  );

  guideIt.effect(
    "prints the tack-yaml guide it builds from the schemas, even without its built-in guides",
    () =>
      Effect.gen(function* () {
        const envelope = yield* json(["guide", "tack-yaml"], null);
        expect(exitCodeForEnvelope(envelope)).toBe(0);
        expect(envelope.result).toEqual({
          kind: "guide",
          topic: "tack-yaml",
          version: stamp,
          markdown: tackYamlGuide(),
        });
      }),
  );

  guideIt.effect("lists every guide by its title, and names the onboarding guide next", () =>
    Effect.gen(function* () {
      const envelope = yield* json(["guide"]);
      expect(envelope).toMatchObject({ status: "success", next: ["tack guide onboarding"] });
      expect(envelope.result).toEqual({
        kind: "guide-index",
        guides: guideTopics.map((topic) => ({
          topic,
          title: /^# (.+)$/m.exec(topic === "tack-yaml" ? tackYamlGuide() : shipped(topic))?.[1],
        })),
      });
      const { stdout } = yield* tack(["guide"]);
      expect(stdout).toContain("  onboarding          Onboard a machine to Tack\n");
      expect(stdout.endsWith("Next\n  tack guide onboarding\n")).toBe(true);
    }),
  );

  guideIt.effect("refuses a topic it does not have and names the ones it has", () =>
    Effect.gen(function* () {
      const envelope = yield* json(["guide", "setup"]);
      expect(exitCodeForEnvelope(envelope)).toBe(2);
      expect(envelope).toMatchObject({
        classification: "invalid-invocation",
        result: null,
        next: ["tack guide"],
      });
      expect(envelope.diagnostics).toEqual([
        {
          code: "guide-topic-unknown",
          severity: "error",
          message: `Tack has no guide named "setup". The guides are ${guideTopics.join(", ")}.`,
          details: { topic: "setup", topics: [...guideTopics] },
        },
      ]);
    }),
  );

  guideIt.effect("fails, naming the file, when the running Tack lost its built-in guides", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const empty = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-guide-" });
      const guide = join("skills", "use-tack", "references", "onboarding.md");
      for (const [args, builtIns, path] of [
        [["guide"], empty, join(empty, guide)],
        [["guide", "onboarding"], empty, join(empty, guide)],
        // A host that registers no built-in source names the file by its place in the source.
        [["guide", "onboarding"], null, guide],
      ] as const) {
        const envelope = yield* json(args, builtIns);
        expect(exitCodeForEnvelope(envelope), args.join(" ")).toBe(3);
        expect(envelope.classification).toBe("internal");
        expect(envelope.diagnostics).toMatchObject([
          { code: "guide-unreadable", severity: "error", details: { path } },
        ]);
      }
    }),
  );
});
