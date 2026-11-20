import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaIssue, SchemaParser } from "effect";
import { defineScript, NoExpectedFailure, runScript, type BoundarySchema } from "../src/index.ts";

const run = (inputSchema: BoundarySchema, input: unknown) =>
  runScript(
    defineScript({
      contract: 1,
      input: inputSchema,
      output: Schema.String,
      error: NoExpectedFailure,
      secrets: [],
      services: [],
      run: () => Effect.succeed("ok"),
    }),
    { input, services: {} },
  );

describe("strict empty input objects", () => {
  it("accepts empty objects but rejects properties, arrays and primitive values", async () => {
    expect((await run(Schema.Struct({}), {})).code).toBe("success");
    for (const value of [{ extra: true }, [], "text", 1, false, null]) {
      expect((await run(Schema.Struct({}), value)).code).toBe("invalid_input");
    }
  });
  it("checks empty structures inside arrays, tuples, records and unions", async () => {
    const cases = [
      { schema: Schema.Array(Schema.Struct({})), good: [{}], bad: [{ x: 1 }] },
      {
        schema: Schema.Tuple([Schema.String, Schema.Struct({})]),
        good: ["x", {}],
        bad: ["x", { x: 1 }],
      },
      {
        schema: Schema.Record(Schema.String, Schema.Struct({})),
        good: { x: {} },
        bad: { x: { y: 1 } },
      },
      {
        schema: Schema.Union([Schema.Struct({}), Schema.Struct({ name: Schema.String })]),
        good: { name: "yes" },
        bad: { name: "yes", extra: true },
      },
    ];
    for (const { schema, good, bad } of cases) {
      expect((await run(schema, good)).code).toBe("success");
      expect((await run(schema, bad)).code).toBe("invalid_input");
    }
  });
});

const echoInput = (input: BoundarySchema, value: unknown) =>
  runScript(
    defineScript({
      contract: 1,
      input,
      output: Schema.Unknown,
      error: NoExpectedFailure,
      secrets: [],
      services: [],
      run: (decoded) => Effect.succeed(decoded),
    }),
    { input: value, services: {} },
  );

describe("strict input branch decoding", () => {
  it("selects and encodes the transforming branch without mutating the author's schema", async () => {
    const schema = Schema.Union([
      Schema.Struct({}),
      Schema.Struct({ count: Schema.NumberFromString }),
    ]);
    const result = await echoInput(schema, { count: "42" });
    expect(result).toMatchObject({
      code: "success",
      primary: { value: { count: 42 }, encoded: { count: 42 } },
      encodedInput: { count: "42" },
    });
    expect(Schema.decodeUnknownSync(schema)({ count: "42" })).toEqual({ count: "42" });
  });

  it("retains branch refinements and decoding defaults", async () => {
    const refined = Schema.Union([
      Schema.Struct({}),
      Schema.Struct({ count: Schema.NumberFromString.check(Schema.isGreaterThan(0)) }),
    ]);
    expect((await echoInput(refined, { count: "-1" })).code).toBe("invalid_input");
    expect((await echoInput(refined, { count: "not-a-number" })).code).toBe("invalid_input");
    const defaulted = Schema.Union([
      Schema.Struct({}),
      Schema.Struct({
        kind: Schema.Literal("default"),
        count: Schema.NumberFromString.pipe(Schema.withDecodingDefaultKey(Effect.succeed("7"))),
      }),
    ]);
    expect(await echoInput(defaulted, { kind: "default" })).toMatchObject({
      code: "success",
      primary: { value: { kind: "default", count: 7 } },
      encodedInput: { kind: "default", count: "7" },
    });
  });

  it("preserves nested branches in records, arrays, optional tuples and tuple rests", async () => {
    const member = Schema.Union([
      Schema.Struct({}),
      Schema.Struct({ count: Schema.NumberFromString }),
    ]);
    const schema = Schema.Struct({
      entries: Schema.Record(Schema.String, Schema.Array(member)),
      optional: Schema.Tuple([Schema.optionalKey(member)]),
      rest: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [member, Schema.Boolean]),
    });
    expect(
      await echoInput(schema, {
        entries: { a: [{ count: "1" }, {}] },
        optional: [],
        rest: ["start", { count: "2" }, true],
      }),
    ).toMatchObject({
      code: "success",
      primary: {
        value: {
          entries: { a: [{ count: 1 }, {}] },
          optional: [],
          rest: ["start", { count: 2 }, true],
        },
      },
    });
    expect(
      (
        await echoInput(schema, {
          entries: {},
          optional: [{ other: 1 }],
          rest: ["start", true],
        })
      ).code,
    ).toBe("invalid_input");
  });

  it("keeps recursive input lazy while checking every selected branch", async () => {
    const recursive: BoundarySchema = Schema.suspend(() =>
      Schema.Union([
        Schema.Struct({}),
        Schema.Struct({ count: Schema.NumberFromString, child: Schema.optionalKey(recursive) }),
      ]),
    );
    expect(
      await echoInput(recursive, { count: "1", child: { count: "2", child: {} } }),
    ).toMatchObject({
      code: "success",
      primary: { value: { count: 1, child: { count: 2, child: {} } } },
      encodedInput: { count: "1", child: { count: "2", child: {} } },
    });
    expect((await echoInput(recursive, { count: "1", child: { extra: true } })).code).toBe(
      "invalid_input",
    );
  });
});

describe("strict input inside declarations", () => {
  type Box<A> = { readonly value: A };
  const isBox = (input: unknown): input is Box<unknown> =>
    typeof input === "object" && input !== null && "value" in input;
  /** A parametric declaration whose JSON form is `{ value }`, decoded with its type parameter. */
  const Box = <A extends Schema.Constraint>(item: A) =>
    Schema.declareConstructor<Box<A["Type"]>, Box<A["Encoded"]>>()(
      [item],
      ([itemCodec]) =>
        (input, ast, options) =>
          isBox(input)
            ? Effect.map(
                SchemaParser.decodeUnknownEffect(itemCodec)(input.value, options),
                (value) => ({
                  value,
                }),
              )
            : Effect.fail(new SchemaIssue.InvalidType(ast, input, options)),
    );

  it("checks empty structures inside a declaration's type parameters", async () => {
    const schema = Box(Schema.Struct({}));

    expect((await run(schema, { value: {} })).code).toBe("success");
    expect((await run(schema, { value: { extra: true } })).code).toBe("invalid_input");
    expect(Schema.decodeUnknownSync(schema)({ value: { extra: true } })).toEqual({
      value: { extra: true },
    });
  });
});
