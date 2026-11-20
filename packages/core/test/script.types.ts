import { Context, Effect, Redacted, Schema, SchemaGetter } from "effect";
import { defineScript, NoExpectedFailure, runScript, Secret, Shell } from "../src/index.ts";
const base = {
  contract: 1,
  input: Schema.Struct({}),
  output: Schema.String,
  error: NoExpectedFailure,
  secrets: [],
  services: [],
} as const;
const valid = defineScript({ ...base, run: () => Effect.succeed("ok") });
void runScript(valid, { input: {}, services: {} });
const secret = defineScript({
  ...base,
  secrets: ["TOKEN"],
  run: () => Effect.map(Secret("TOKEN"), (value) => Redacted.value(value)),
});
void runScript(secret, { input: {}, services: { secrets: { TOKEN: "fake" } } });
// @ts-expect-error A declared secret must have an explicit fake.
void runScript(secret, { input: {}, services: {} });
// @ts-expect-error Hidden secret requirement.
defineScript({ ...base, run: () => Effect.map(Secret("TOKEN"), (value) => Redacted.value(value)) });
// @ts-expect-error A declaration cannot include unused capabilities.
defineScript({ ...base, secrets: ["TOKEN"], run: () => Effect.succeed("ok") });
defineScript({
  ...base,
  // @ts-expect-error Shell cannot be used without declaring it.
  run: () => Effect.flatMap(Shell, (shell) => shell.execute({ executable: "echo", args: [] })),
});
const shellScript = defineScript({
  ...base,
  output: Schema.Number,
  services: ["Shell"],
  run: () =>
    Effect.flatMap(Shell, (shell) =>
      Effect.map(shell.execute({ executable: "echo", args: [] }), (result) => result.exitCode),
    ),
});
// @ts-expect-error Explicit no-failure rejects authored domain errors.
defineScript({ ...base, run: () => Effect.fail("domain failure") });
// @ts-expect-error Output schema must agree with the program success type.
defineScript({ ...base, run: () => Effect.succeed(42) });
// @ts-expect-error Unknown service identity.
defineScript({ ...base, services: ["Network"], run: () => Effect.succeed("ok") });
// @ts-expect-error Unsupported version.
defineScript({ ...base, contract: 2, run: () => Effect.succeed("ok") });
// @ts-expect-error No implicit Shell implementation.
void runScript(shellScript, { input: {}, services: {} });
class Hidden extends Context.Service<Hidden, string>()("test/Hidden") {}
// @ts-expect-error Arbitrary services are outside the declared contract.
defineScript({ ...base, run: () => Hidden });
// @ts-expect-error A Promise callback is not an Effect program.
defineScript({ ...base, run: async () => "wrong" });
const multi = defineScript({
  ...base,
  secrets: ["A", "B"],
  run: () =>
    Effect.gen(function* () {
      yield* Secret("A");
      yield* Secret("B");
      return "ok";
    }),
});
void multi;

const dependent = defineScript({
  ...base,
  input: Schema.Number,
  services: ["Shell"],
  run: (input) =>
    Effect.flatMap(Shell, (shell) =>
      Effect.map(
        shell.execute({ executable: "echo", args: [String(input)] }),
        (result) => result.stdout,
      ),
    ),
});
void dependent;
const serviceSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformEffect(() => Hidden),
    encode: SchemaGetter.transform((value: string) => value),
  }),
);
// @ts-expect-error Boundary codecs cannot require services.
defineScript({ ...base, input: serviceSchema, run: () => Effect.succeed("ok") });
const unknownInputSecret = defineScript({
  ...base,
  input: Schema.Unknown,
  secrets: ["TOKEN"],
  run: () => Effect.map(Secret("TOKEN"), (value) => Redacted.value(value)),
});
// @ts-expect-error Unknown-input definitions cannot use the recognized-host overload to skip fakes.
void runScript(unknownInputSecret, { input: {}, services: {} });
const unknownInputShell = defineScript({
  ...base,
  input: Schema.Unknown,
  services: ["Shell"],
  run: () => Effect.map(Shell, () => "ok"),
});
// @ts-expect-error The nominal inspection result prevents this host-overload escape too.
void runScript(unknownInputShell, { input: {}, services: {} });
