import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import type { SourceRegistration } from "../../domain/sources/source-schema.ts";
import { initializeState } from "../../services/state-store.ts";
import { bundleIntegrityIssue } from "./bundle-integrity.ts";
import { registerSource } from "./source.ts";

const identity = "a".repeat(64);

it.layer(LiveTestLayer)("source edges", (test) => {
  test.effect("lists the docs a newly registered source declares in name order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "tack-src-" }));
      const options = { environment: { TACK_STATE_DIR: path.join(root, "state") } };
      yield* initializeState(options);
      const source = path.join(root, "source");
      for (const folder of ["zeta", "alpha"])
        yield* fs.makeDirectory(path.join(source, folder), { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "tack.yaml"),
        "version: 1\ndocs:\n  - name: zeta\n    path: zeta\n  - name: alpha\n    path: alpha\n",
      );
      const registered = yield* registerSource(options, { sourcePath: source });
      expect(registered.docs).toEqual([{ name: "alpha" }, { name: "zeta" }]);
    }),
  );

  test.effect("reports a bundle source whose bindings no longer name its bundle siblings", () =>
    Effect.gen(function* () {
      const registration = (
        id: string,
        sourceKey: string,
        bindings: Readonly<Record<string, string>>,
      ): SourceRegistration => ({
        canonicalPath: `/bundles/${sourceKey}`,
        id,
        bundle: { identity, sourceKey, bindings, sourceKeys: { tools: "tools" }, files: [] },
      });
      const tools = "00000000-0000-4000-8000-000000000001";
      const other = "00000000-0000-4000-8000-000000000002";
      // The binding points at a registration that belongs to no bundle.
      const rebound = registration(tools, "tools", { tools: other });
      expect(
        yield* bundleIntegrityIssue(rebound, [rebound, { canonicalPath: "/x", id: other }]),
      ).toBe(
        `Bundle ${identity}/tools has a changed source binding; repair its retained mapping before retry.`,
      );
      // A binding for a source the bundle never had is a changed mapping too.
      const extra = registration(tools, "tools", { tools, more: other });
      expect(yield* bundleIntegrityIssue(extra, [extra])).toContain("has a changed source binding");
      expect(yield* bundleIntegrityIssue({ canonicalPath: "/x", id: other }, [])).toBeUndefined();
    }),
  );
});
