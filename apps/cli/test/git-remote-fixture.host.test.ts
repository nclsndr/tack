import { skillText } from "./support/source-tree.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { vi } from "vitest";
import { githubProvider } from "../src/domain/imports/providers/github.ts";
import { discoverSkillFolders } from "../src/features/imports/import-discovery.ts";
import { fixtureRemotesVariable, ImportRemoteLive } from "../src/platform/git/import-remote.ts";
import { ImportRemote } from "../src/services/import-remote.ts";
import { type RemoteTarget } from "../src/domain/imports/remote-target.ts";
import { LiveTestLayer } from "./support/live-test-layer.ts";
import { makeRemoteFixture } from "./support/git-remote-fixture.ts";

const target: RemoteTarget = githubProvider.remote({
  repository: "acme/skills",
  transport: "https",
});

it.layer(LiveTestLayer)("git remote fixture", (fixtureIt) => {
  fixtureIt.effect("serves a hostile repository through the live remote, end to end", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "tack-fixture-" }),
      );
      const fixture = yield* makeRemoteFixture(root, "acme", "skills", [
        {
          files: {
            "skills/pdf/SKILL.md": skillText("pdf"),
            "skills/pdf/run.sh": { content: "#!/bin/sh\n", executable: true },
            "skills/pdf/link": { symlink: "SKILL.md" },
            "skills/pdf/vendored": { submodule: "1".repeat(40) },
            "skills/_wip/draft/SKILL.md": skillText("draft"),
          },
          tag: "v1.0.0",
        },
      ]);
      const revision = fixture.revisions[0] ?? "";
      vi.stubEnv(fixtureRemotesVariable, root);
      try {
        const remote = yield* Effect.service(ImportRemote).pipe(
          Effect.provide(Layer.fresh(ImportRemoteLive)),
        );
        const refs = yield* remote.listRefs(target);
        expect(refs.headCommit).toBe(revision);
        expect(refs.tags.get("v1.0.0")).toBe(revision);
        const session = yield* remote.open(target, revision);
        const tree = yield* session.list(["skills"]);
        const modes = Object.fromEntries(tree.map((entry) => [entry.path, entry.mode]));
        expect(modes["skills/pdf/run.sh"]).toBe("100755");
        expect(modes["skills/pdf/link"]).toBe("120000");
        expect(modes["skills/pdf/vendored"]).toBe("160000");
        expect(modes["skills/_wip/draft/SKILL.md"]).toBe("100644");
        expect(discoverSkillFolders(tree, {}).map((folder) => folder.path)).toEqual(["skills/pdf"]);
        yield* session.prefetch(["skills/pdf"]);
        const script = tree.find((entry) => entry.path === "skills/pdf/run.sh");
        const contents = yield* session.read([script?.oid ?? ""]);
        expect(new TextDecoder().decode(contents.get(script?.oid ?? ""))).toBe("#!/bin/sh\n");
      } finally {
        vi.unstubAllEnvs();
      }
    }).pipe(Effect.scoped),
  );
});
