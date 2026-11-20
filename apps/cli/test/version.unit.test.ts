import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "vitest";
import { InvocationError, parseInvocation } from "../src/cli/commands/index.ts";
import { readVersionRequest } from "../src/cli/commands/version-request.ts";
import { renderHuman } from "../src/cli/host/human/render.ts";
import { makeStyle } from "../src/cli/host/human/style.ts";
import { createPublicEnvelope } from "../src/cli/host/public-outcome.ts";
import {
  currentVersionReport,
  releaseStamp,
  tackVersion,
  VersionReportSchema,
} from "../src/version.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const strict = { onExcessProperty: "error" } as const;
const decodeReport = Schema.decodeUnknownSync(VersionReportSchema, strict);
const decodeRootPackage = Schema.decodeUnknownSync(Schema.Struct({ version: Schema.String }));
const toJson = Schema.decodeUnknownSync(Schema.Json);

describe("release stamp", () => {
  it("marks a source run with +dev", () => {
    expect(releaseStamp("0.1.0")).toBe("0.1.0+dev");
  });

  it("names the commit of a release that was on origin/main at build time", () => {
    expect(releaseStamp("0.1.0", { commit: "fec4c8e", ahead: 0 })).toBe("0.1.0+gfec4c8e");
  });

  it("adds how many commits a release was ahead of origin/main", () => {
    expect(releaseStamp("0.1.0", { commit: "fec4c8e", ahead: 2 })).toBe("0.1.0+gfec4c8e.ahead.2");
    expect(
      releaseStamp("0.2.3", { commit: "b232fb73e8007ca089b4ea3839a33a7497f74adf", ahead: 11 }),
    ).toBe("0.2.3+gb232fb73e8007ca089b4ea3839a33a7497f74adf.ahead.11");
  });

  it("never carries a dirty marker and rejects build information that is not a commit", () => {
    for (const commit of ["", "xyz", "FEC4C8E", "fec4c8e-dirty", "abc", "fec4c8e.dirty"])
      expect(() => releaseStamp("0.1.0", { commit, ahead: 0 }), commit).toThrow(/commit/);
    for (const ahead of [-1, 1.5, Number.NaN])
      expect(() => releaseStamp("0.1.0", { commit: "fec4c8e", ahead }), String(ahead)).toThrow(
        /ahead/,
      );
  });

  it("compares equal to the plain version, because build metadata does not order releases", () => {
    for (const stamp of [
      releaseStamp("0.1.0"),
      releaseStamp("0.1.0", { commit: "fec4c8e", ahead: 0 }),
      releaseStamp("0.1.0", { commit: "fec4c8e", ahead: 2 }),
    ])
      expect(Bun.semver.order(stamp, "0.1.0"), stamp).toBe(0);
    expect(Bun.semver.order(releaseStamp("0.1.1"), "0.1.0")).toBe(1);
  });
});

describe("current version", () => {
  it("is the root package version", () => {
    const root = decodeRootPackage(
      JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
    );
    expect(tackVersion).toBe(root.version);
    expect(tackVersion).toMatch(/^0\.\d+\.\d+$/);
  });

  it("reports a source run with no commit", () => {
    const report = currentVersionReport();
    expect(report).toEqual({
      kind: "version",
      version: tackVersion,
      commit: null,
      stamp: `${tackVersion}+dev`,
      sourceRun: true,
      stateFormat: 1,
    });
    expect(Object.keys(report)).toEqual([
      "kind",
      "version",
      "commit",
      "stamp",
      "sourceRun",
      "stateFormat",
    ]);
    expect(decodeReport(report)).toEqual(report);
  });

  it("publishes a closed schema that rejects a stamp or version that is not text", () => {
    expect(() => decodeReport({ ...currentVersionReport(), extra: true })).toThrow();
    expect(() => decodeReport({ ...currentVersionReport(), version: 1 })).toThrow();
    expect(() => decodeReport({ ...currentVersionReport(), kind: "help" })).toThrow();
  });
});

describe("version request", () => {
  it("reads a lone --version as the version request, beside root flags and a help request", () => {
    expect(readVersionRequest(["--version"])).toEqual({ help: false });
    expect(readVersionRequest(["--json", "--version"])).toEqual({ help: false });
    expect(readVersionRequest(["--version", "--state-dir=/s", "--json"])).toEqual({ help: false });
    expect(readVersionRequest(["--state-dir", "/s", "--version"])).toEqual({ help: false });
    expect(readVersionRequest(["--version", "--help"])).toEqual({ help: true });
    expect(readVersionRequest(["--version", "-h"])).toEqual({ help: true });
  });

  it("leaves arguments without --version alone, including one after the operand terminator", () => {
    expect(readVersionRequest([])).toBeUndefined();
    expect(readVersionRequest(["version"])).toBeUndefined();
    expect(readVersionRequest(["--json", "version"])).toBeUndefined();
    expect(readVersionRequest(["script", "run", "demo", "--", "--version"])).toBeUndefined();
  });

  it("refuses --version beside another command, operand, flag or terminator", () => {
    for (const args of [
      ["status", "--version"],
      ["--version", "status"],
      ["--version", "--version"],
      ["version", "--version"],
      ["--version", "--user"],
      ["--version", "--", "x"],
    ])
      expect(readVersionRequest(args), args.join(" ")).toMatchObject({
        message: expect.stringContaining("--version"),
      });
  });

  it("parses --version to the version invocation and refuses it beside a command", async () => {
    const parse = (args: ReadonlyArray<string>) =>
      Effect.runPromise(parseInvocation(args).pipe(Effect.provide(BunServices.layer)));
    expect(await parse(["--version"])).toEqual({ invocation: { _tag: "version" } });
    expect(await parse(["--json", "--version"])).toEqual({
      invocation: { _tag: "version" },
    });
    expect(await parse(["--state-dir", "/s", "--version"])).toEqual({
      invocation: { _tag: "version" },
    });
    expect(await parse(["--version", "--help"])).toEqual({
      invocation: { _tag: "help", commandPath: [] },
    });
    const flip = (args: ReadonlyArray<string>) =>
      Effect.runPromise(parseInvocation(args).pipe(Effect.flip, Effect.provide(BunServices.layer)));
    const combined = await flip(["status", "--version"]);
    expect(combined).toBeInstanceOf(InvocationError);
    expect(combined).toMatchObject({ code: "invalid-flag", command: "version" });
  });
});

describe("human version view", () => {
  const view = (report: unknown, color = false) =>
    renderHuman(
      createPublicEnvelope("version", {
        classification: "success",
        diagnostics: [],
        result: toJson(report),
      }),
      makeStyle({ color, homeDirectory: "/fx/home", width: 80 }),
    );

  it("shows the stamp, the commit and the kind of run", () => {
    const text = view(currentVersionReport());
    expect(text).toContain("tack version");
    expect(text).toContain(`${tackVersion}+dev`);
    expect(text).toContain("source run");
    expect(text).toMatch(/^\s*State format\s+1$/m);
    expect(text).not.toContain("Readable");
    // A stamped build is any release, an npm or Bun package as much as a compiled one; `upgrade`
    // tells those apart, so the kind of run names no install.
    expect(
      view({
        kind: "version",
        version: "0.1.0",
        commit: "fec4c8e",
        stamp: "0.1.0+gfec4c8e",
        sourceRun: false,
        stateFormat: 1,
      }),
    ).toMatch(/Commit\s+fec4c8e[\s\S]*Run\s+release build$/m);
  });

  it("falls back to the generic view for a payload it cannot read", () => {
    expect(view({ kind: "other" })).toContain("other");
  });
});
