import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { parseCommandDocument, parseSkillDocument } from "./resource-frontmatter.ts";

it.effect("reads optional command frontmatter and the shared Tack metadata contract", () =>
  Effect.gen(function* () {
    expect(yield* parseCommandDocument("Plain markdown")).toEqual({
      activation: "default",
      dependencies: [],
      projects: [],
      frontmatter: {},
    });
    const command = yield* parseCommandDocument(
      "---\nname: cannot-rename\nmetadata:\n  tack: |\n    version: 1\n    activation: opt-in\n    projects: [workspace]\n    dependencies:\n      - kind: command\n        name: review\n---\n",
    );
    expect(command).toMatchObject({
      activation: "opt-in",
      projects: ["workspace"],
      dependencies: [{ kind: "command", name: "review" }],
    });
  }),
);

it.effect.each([
  ["---\nmissing closing fence", "command-frontmatter-invalid"],
  ["---\n[broken\n---", "command-frontmatter-invalid"],
  ["---\n- scalar\n---", "command-frontmatter-invalid"],
  ["---\nmetadata: invalid\n---", "command-metadata-invalid"],
  ["---\nmetadata:\n  tack: 2\n---", "command-metadata-invalid"],
  ["---\nmetadata:\n  tack: |\n    version: 2\n---", "command-metadata-invalid"],
] as const)("quarantines invalid supplied command metadata %s", ([encoded, code]) =>
  Effect.gen(function* () {
    expect(yield* Effect.flip(parseCommandDocument(encoded))).toMatchObject({ code });
  }),
);

it.effect("reads an independent global activation policy without changing project activation", () =>
  Effect.gen(function* () {
    const parsed = yield* parseSkillDocument({
      directoryName: "example",
      encoded:
        "---\nname: example\ndescription: Example\nmetadata:\n  tack: |\n    version: 1\n    activation: opt-in\n    user-activation: default\n---\n",
    });
    expect(parsed).toMatchObject({ activation: "opt-in", userActivation: "default" });
  }),
);

it.effect("rejects an invalid global activation policy", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(
      parseSkillDocument({
        directoryName: "example",
        encoded:
          "---\nname: example\ndescription: Example\nmetadata:\n  tack: |\n    version: 1\n    user-activation: always\n---\n",
      }),
    );
    expect(result).toMatchObject({ code: "skill-metadata-schema-invalid" });
  }),
);

it.effect("refuses a dependency with an unknown key", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      parseCommandDocument(
        "---\nmetadata:\n  tack: |\n    version: 1\n    dependencies:\n      - kind: skill\n        name: review\n        extra: true\n---\n",
      ),
    );
    expect(error).toMatchObject({ code: "command-metadata-invalid" });
  }),
);
