import { expect, it } from "vitest";
import { validateBundlePath } from "./bundle-path.ts";

it("accepts an ordinary relative path of exactly 256 UTF-8 bytes", () => {
  expect(() => validateBundlePath(`sources/${"a".repeat(248)}`)).not.toThrow();
});

it.each([
  ["characters", "a".repeat(257)],
  ["UTF-8 bytes", "é".repeat(129)],
])("refuses a path longer than 256 %s", (_unit, path) => {
  expect(() => validateBundlePath(path)).toThrow(
    "Bundle paths must fit 256 UTF-8 bytes; shorten the authored layout before export.",
  );
});

it.each(["", "a\\b", "C:x", "a\u0000b", "a\u007fb", "a//b", "./a", "a/.."])(
  "refuses the unsafe relative path %j",
  (path) => {
    expect(() => validateBundlePath(path)).toThrow(`Unsafe relative bundle path: ${path}`);
  },
);

it.each([".env.local", "a/.ssh/config", "credentials.json", "id_ed25519.pub", "a/state.json"])(
  "refuses the sensitive path %s",
  (path) => {
    expect(() => validateBundlePath(path)).toThrow(
      `Refused sensitive operator/configuration path: ${path}.`,
    );
  },
);
