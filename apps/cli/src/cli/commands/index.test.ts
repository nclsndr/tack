import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { commandPathOf, parseInvocation } from "./index.ts";
import { publishedJsonSchema } from "./manifest.test-support.ts";

const parseFailure = (arguments_: ReadonlyArray<string>) =>
  parseInvocation(arguments_).pipe(Effect.flip, Effect.provide(BunServices.layer));

describe("flag combinations the grammar refuses", () => {
  it.effect("refuses a sync without adapters that also drops docs or targets the user", () =>
    Effect.gen(function* () {
      expect(yield* parseFailure(["sync", "--no-adapters", "--no-docs"])).toMatchObject({
        code: "invalid-flag",
        command: "sync",
        message: "--no-adapters cannot be combined with --no-docs.",
      });
      expect(yield* parseFailure(["sync", "--no-adapters", "--user"])).toMatchObject({
        code: "invalid-flag",
        command: "sync",
        message: "--no-adapters has no docs mounts for --user.",
      });
    }),
  );

  it.effect("refuses to set and clear the default writing resource at once", () =>
    Effect.gen(function* () {
      expect(
        yield* parseFailure(["docs", "configure", "--clear-default", "--default", "guide"]),
      ).toMatchObject({
        code: "invalid-flag",
        command: "docs configure",
        message: "--clear-default and --default cannot be used together.",
      });
    }),
  );
});

describe("command paths", () => {
  it("selects the flag requests by no word", () => {
    expect(commandPathOf("help")).toEqual([]);
    expect(commandPathOf("version")).toEqual([]);
    expect(commandPathOf("profile-apply")).toEqual(["profile", "apply"]);
  });
});

describe("published JSON Schema", () => {
  it("moves a repeated large node into a shared definition beside the named ones", () => {
    const Large = Schema.Struct({
      alpha: Schema.String,
      beta: Schema.Boolean,
      gamma: Schema.Literals([
        "one-long-literal-value",
        "another-long-literal-value",
        "third-long-literal-value",
      ]),
      delta: Schema.Array(Schema.String),
    });
    // A named definition that already takes the first shared name.
    const Named = Schema.Struct({ value: Schema.String }).annotate({ identifier: "shared-1" });
    const document = publishedJsonSchema(
      Schema.Struct({ first: Large, second: Large, named: Named }),
    );
    expect(document).toMatchObject({
      properties: {
        first: { $ref: "#/$defs/shared-2" },
        second: { $ref: "#/$defs/shared-2" },
        named: { $ref: "#/$defs/shared-1" },
      },
      $defs: {
        "shared-1": { properties: { value: { type: "string" } } },
        "shared-2": { properties: { alpha: { type: "string" } } },
      },
    });
  });
});
