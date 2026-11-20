import { expect, it } from "vitest";
import { Schema } from "effect";
import { SourceLabelSchema } from "../sources/source-schema.ts";
import { bundleRegistrationsFor, bundleSourceLabel } from "./bundle-registration.ts";
import { makeBundleManifest } from "./bundle-codec.ts";
const manifest = makeBundleManifest({
  version: 1,
  profile: { sourceKey: "source-0", name: "ci", path: "ci.yaml" },
  sources: [
    { key: "source-0", bindings: { team: "source-1" }, resources: [], prerequisites: [] },
    { key: "source-1", bindings: {}, resources: [], prerequisites: [] },
  ],
  files: [],
});
it("gives every artifact/key a usable bounded portable local qualifier", () => {
  const source = {
    identity: manifest.identity,
    sourceKey: "a".repeat(64),
    bindings: {},
    sourceKeys: {},
    files: [],
  };
  expect(Schema.is(SourceLabelSchema)(bundleSourceLabel(source))).toBe(true);
  expect(bundleSourceLabel(source)).not.toBe(
    bundleSourceLabel({ ...source, sourceKey: "different" }),
  );
  expect(bundleSourceLabel(source)).not.toBe(
    bundleSourceLabel({ ...source, identity: "0".repeat(64) }),
  );
});
it("requires a complete fresh local mapping before constructing any registration authority", () => {
  expect(() => bundleRegistrationsFor(manifest, new Map(), (key) => `/payload/${key}`)).toThrow();
  expect(() =>
    bundleRegistrationsFor(manifest, new Map([["source-0", "one"]]), (key) => `/payload/${key}`),
  ).toThrow();
  const registrations = bundleRegistrationsFor(
    manifest,
    new Map([
      ["source-0", "one"],
      ["source-1", "two"],
    ]),
    (key) => `/payload/${key}`,
  );
  expect(registrations[0]?.bundle?.bindings).toEqual({ team: "two" });
});
