import { describe, expect, it } from "vitest";
import { defineScript, recognizeScript, ScriptDefinitionError } from "../src/script-api.ts";

const run = () => undefined;
/** Calls defineScript with a value the types would refuse, as a script without types can. */
const defineUnchecked = (options: unknown) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test feeds malformed definitions on purpose.
  defineScript(options as Parameters<typeof defineScript>[0]);

describe("defineScript", () => {
  it("returns a definition the worker recognizes, from any copy of the module", () => {
    const options = { args: { name: { type: "string" } }, secrets: ["API_TOKEN"], run } as const;
    const script = defineScript(options);

    expect(recognizeScript(script)).toEqual(options);
    expect(recognizeScript({ ...script })).toEqual(options);
    expect(recognizeScript({ run })).toBeUndefined();
    expect(recognizeScript(undefined)).toBeUndefined();
  });

  it("names the option an author probably meant", () => {
    expect(() => defineUnchecked({ arg: {}, run })).toThrow(
      'defineScript has no "arg" option. Did you mean "args"? Options: args, secrets, run.',
    );
    expect(() => defineUnchecked({ runs: () => null })).toThrow(
      'defineScript has no "runs" option. Did you mean "run"? Options: args, secrets, run.',
    );
    expect(() => defineUnchecked({ timeout: 5, run })).toThrow(
      'defineScript has no "timeout" option. Options: args, secrets, run.',
    );
  });

  it("lists every problem of a malformed definition at once", () => {
    let thrown: unknown;
    try {
      defineUnchecked({
        args: {
          Name: { type: "string" },
          count: { type: "integer" },
          tone: { type: "number", choices: ["warm"] },
          shout: { type: "boolean", alias: "s" },
        },
        secrets: ["token", "TACK_KEY", "GITHUB_TOKEN"],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ScriptDefinitionError);
    expect(thrown instanceof Error ? thrown.message.split("\n") : []).toEqual([
      "defineScript needs a run function: run: async ({ args, log }) => { ... }.",
      'Argument "Name" needs a lower-camel or kebab name, such as "repo" or "dry-run".',
      'Argument "count" needs a type: { type: "string" | "number" | "boolean" }.',
      'Argument "tone" can only list choices when its type is "string".',
      'Argument "shout" has no "alias" field. Fields: type, description, multiple, optional, default, choices.',
      'Secret "token" needs an uppercase name without the TACK_ prefix, such as "GITHUB_TOKEN".',
      'Secret "TACK_KEY" needs an uppercase name without the TACK_ prefix, such as "GITHUB_TOKEN".',
    ]);
  });

  it("refuses a definition that is not an object, and args or secrets of the wrong shape", () => {
    expect(() => defineUnchecked("run")).toThrow("defineScript expects an object");
    expect(() => defineUnchecked({ args: [], secrets: "TOKEN", run })).toThrow(
      'defineScript "args" must be an object of argument declarations.\ndefineScript "secrets" must be a list of names, such as ["GITHUB_TOKEN"].',
    );
  });
});

describe("a script-API error in the runner", () => {
  it("becomes the run's message, while any other defect stays generic", async () => {
    const { Effect, Schema } = await import("effect");
    const {
      defineScript: defineContract,
      NoExpectedFailure,
      runScript,
      ScriptError,
    } = await import("../src/index.ts");
    const dying = (defect: unknown) =>
      defineContract({
        contract: 1,
        input: Schema.Struct({}),
        output: Schema.String,
        error: NoExpectedFailure,
        secrets: [],
        services: [],
        run: () => Effect.die(defect),
      });

    const thrown = await runScript(dying(new ScriptError("Boom: <redacted>")), {
      input: {},
      services: {},
    });
    const other = await runScript(dying(new Error("internal")), { input: {}, services: {} });

    expect(thrown.primary).toMatchObject({ code: "executed_defect", message: "Boom: <redacted>" });
    expect(other.primary).toMatchObject({
      code: "executed_defect",
      message: "Program execution defect.",
    });
  });
});
