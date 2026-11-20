import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  cliEntryPoint,
  entryPointOf,
  installKind,
  installKindOf,
  releaseSidecar,
  resolveBuiltIns,
  resolveSidecar,
} from "./release.ts";

it("resolves sidecars beside the real executable, including through a link", () => {
  expect(
    resolveSidecar("/$bunfs/root/main.js", "/tmp/share/tack/releases/one/bin/tack", "worker.js"),
  ).toBe("/tmp/share/tack/releases/one/worker.js");
});

it("uses a compiled release's own built-ins and a checkout's beside its modules", () => {
  expect(resolveBuiltIns("/$bunfs/root/main.js", "/tmp/release/bin/tack")).toBe(
    "/tmp/release/builtins",
  );
  expect(resolveBuiltIns("file:///checkout/apps/cli/src/release.ts", "/bun")).toBe(
    "/checkout/apps/cli/src/builtins",
  );
});

it("tells how a run was installed, from Bun's global folder for a package", () => {
  const run = (packageRun: boolean, entryPoint = "/x/main.js") =>
    installKindOf({ packageRun, entryPoint });
  expect(run(true, "/usr/local/lib/node_modules/@tackup/cli/dist/main.js")).toBe("npm");
  expect(run(true, "/home/ada/.bun/install/global/node_modules/@tackup/cli/dist/main.js")).toBe(
    "bun",
  );
  expect(run(false)).toBe("source");
  expect(installKind()).toBe("source");
});

it("a source run finds sidecars beside its modules", () => {
  expect(releaseSidecar("worker.js")).toBe(fileURLToPath(new URL("worker.js", import.meta.url)));
});

it("a worker re-runs main.ts beside this module in a source run, and the bundle itself otherwise", () => {
  expect(cliEntryPoint).toBe(fileURLToPath(new URL("main.ts", import.meta.url)));
  expect(entryPointOf("file:///package/dist/main.js")).toBe("/package/dist/main.js");
});
