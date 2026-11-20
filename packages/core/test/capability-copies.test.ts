import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defineScript,
  isCapabilityFailure,
  NoExpectedFailure,
  runScript,
  Shell,
  ShellFailure,
} from "../src/index.ts";

describe("capability identity across core copies", () => {
  it("classifies a ShellFailure from an independently bundled core installation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tack-core-copy-"));
    try {
      const build = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../src/capabilities.ts", import.meta.url))],
        outdir: directory,
        target: "bun",
      });
      expect(build.success).toBe(true);
      const module = await import(pathToFileURL(join(directory, "capabilities.js")).href);
      const constructor: unknown = module.ShellFailure;
      if (typeof constructor !== "function")
        throw new Error("Copied package is missing ShellFailure");
      const error: unknown = Reflect.construct(constructor, [
        { operation: "spawn", message: "copied capability failed" },
      ]);
      expect(error).not.toBeInstanceOf(ShellFailure);
      expect(isCapabilityFailure(error)).toBe(true);
      if (!isCapabilityFailure(error)) throw new Error("Expected recognized capability failure");
      const script = defineScript({
        contract: 1,
        input: Schema.Struct({}),
        output: Schema.String,
        error: NoExpectedFailure,
        secrets: [],
        services: ["Shell"],
        run: () =>
          Effect.flatMap(Shell, (shell) =>
            Effect.map(shell.execute({ executable: "fake", args: [] }), (result) => result.stdout),
          ),
      });
      expect(
        (
          await runScript(script, {
            input: {},
            services: { Shell: { execute: () => Effect.fail(error) } },
          })
        ).code,
      ).toBe("capability_failure");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects tag collisions, unsupported brands and malformed failure fields", () => {
    const brand = Symbol.for("@tackup/ShellFailure/1");
    for (const value of [
      { _tag: "ShellFailure", operation: "spawn", message: "domain collision" },
      { [Symbol.for("@tackup/ShellFailure/2")]: true, operation: "spawn", message: "future" },
      { [brand]: true, operation: "other", message: "bad operation" },
      { [brand]: true, operation: "io", message: 1 },
      { [brand]: false, operation: "io", message: "wrong brand" },
    ])
      expect(isCapabilityFailure(value)).toBe(false);
  });
});

describe("author schemas across bundled runtime copies", () => {
  it("keeps source-owned decoding, encoding and schema failures consistent in the built runner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tack-boundary-copy-"));
    const base = {
      contract: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      error: NoExpectedFailure,
      secrets: [],
      services: [],
    } as const;
    try {
      const build = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        outdir: directory,
        target: "bun",
      });
      expect(build.success).toBe(true);
      const module = await import(pathToFileURL(join(directory, "index.js")).href);
      const run: unknown = module.runScript;
      if (typeof run !== "function") throw new Error("Built package is missing runScript");
      const cases = [
        {
          definition: defineScript({
            ...base,
            run: () =>
              Effect.gen(function* () {
                yield* Effect.log("copied runtime");
                return "done";
              }),
          }),
          input: {},
          expected: { code: "success", primary: { encoded: "done" } },
        },
        {
          definition: defineScript({
            ...base,
            input: Schema.Struct({ count: Schema.NumberFromString }),
            output: Schema.Struct({ count: Schema.NumberFromString }),
            run: (input) => Effect.succeed({ count: input.count + 1 }),
          }),
          input: { count: "1" },
          expected: {
            code: "success",
            encodedInput: { count: "1" },
            primary: { encoded: { count: "2" } },
          },
        },
        {
          definition: defineScript({
            ...base,
            error: Schema.Struct({ count: Schema.NumberFromString }),
            run: () => Effect.fail({ count: 2 }),
          }),
          input: {},
          expected: { code: "expected_failure", primary: { encoded: { count: "2" } } },
        },
        {
          definition: defineScript({ ...base, run: () => Effect.succeed("ok") }),
          input: { extra: true },
          expected: { code: "invalid_input" },
        },
        {
          definition: defineScript({
            ...base,
            input: Schema.Struct({ nested: Schema.Struct({}) }),
            run: () => Effect.succeed("ok"),
          }),
          input: { nested: { extra: true } },
          expected: { code: "invalid_input" },
        },
        {
          definition: defineScript({
            ...base,
            input: Schema.Struct({ nested: Schema.Struct({ name: Schema.String }) }),
            run: () => Effect.succeed("ok"),
          }),
          input: { nested: { name: "yes", extra: true } },
          expected: { code: "invalid_input" },
        },
        {
          definition: defineScript({
            ...base,
            output: Schema.String.check(Schema.makeFilter(() => false)),
            run: () => Effect.succeed("no"),
          }),
          input: {},
          expected: { code: "invalid_output" },
        },
        {
          definition: defineScript({
            ...base,
            output: Schema.String.check(
              Schema.makeFilter(() => {
                throw new Error("schema exploded");
              }),
            ),
            run: () => Effect.succeed("no"),
          }),
          input: {},
          expected: { code: "schema_defect" },
        },
      ];
      for (const { definition, input, expected } of cases) {
        const result: unknown = await run(definition, { input, services: {} });
        expect(result).toMatchObject(expected);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
