import { describe, expect, it } from "vitest";
import { describeInstall, installTarget } from "./install-target.ts";

const voltaShim = "/home/maintainer/.volta/bin/volta-shim";
const plainNpm = "/usr/local/lib/node_modules/npm/bin/npm-cli.js";

describe("installTarget", () => {
  it("lets npm's own prefix decide when npm is not Volta's shim", () => {
    expect(installTarget(plainNpm, { npm_config_prefix: "/tmp/x" })).toEqual({
      kind: "npm-prefix",
      env: {},
    });
  });

  it.each(["npm_config_prefix", "NPM_CONFIG_PREFIX"])(
    "turns off Volta's interception when %s asks for a prefix",
    (key) => {
      expect(installTarget(voltaShim, { [key]: "/tmp/x" })).toEqual({
        kind: "npm-prefix",
        env: { VOLTA_UNSAFE_GLOBAL: "1" },
      });
    },
  );

  it("installs into Volta's own image when Volta's shim runs npm without a prefix", () => {
    expect(installTarget(voltaShim, {})).toEqual({
      kind: "volta",
      bin: "/home/maintainer/.volta/bin/tack",
    });
  });

  it("treats an empty prefix as no prefix", () => {
    expect(installTarget(voltaShim, { npm_config_prefix: "" }).kind).toBe("volta");
  });
});

describe("describeInstall", () => {
  const built = { version: "0.1.0", commit: "9ebca9e2" };

  it.each([
    {
      onPath: "/tmp/x/bin/tack",
      expected:
        "Installed @tackup/cli 0.1.0 (9ebca9e2) as /tmp/x/bin/tack, which is the `tack` on PATH. Run `tack init` to relink built-in skills.",
    },
    {
      onPath: undefined,
      expected:
        "Installed @tackup/cli 0.1.0 (9ebca9e2) as /tmp/x/bin/tack, which is not on PATH: add /tmp/x/bin to PATH to run it as `tack`.",
    },
    {
      onPath: "/home/maintainer/.volta/bin/tack",
      expected:
        "Installed @tackup/cli 0.1.0 (9ebca9e2) as /tmp/x/bin/tack, but `tack` on PATH is still /home/maintainer/.volta/bin/tack: put /tmp/x/bin first on PATH to run this build as `tack`.",
    },
  ])("reports where the build landed when `tack` on PATH is $onPath", ({ onPath, expected }) => {
    expect(describeInstall({ ...built, bin: "/tmp/x/bin/tack", onPath })).toBe(expected);
  });
});
