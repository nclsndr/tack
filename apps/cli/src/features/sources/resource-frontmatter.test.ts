import { skillText } from "../../../test/support/source-tree.ts";
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
  ["---\nmetadata:\n  tack: |\n    version: 99\n---", "command-metadata-invalid"],
] as const)("quarantines invalid supplied command metadata %s", ([encoded, code]) =>
  Effect.gen(function* () {
    expect(yield* Effect.flip(parseCommandDocument(encoded))).toMatchObject({ code });
  }),
);

it.effect("reads an independent global activation policy without changing project activation", () =>
  Effect.gen(function* () {
    const parsed = yield* parseSkillDocument({
      directoryName: "example",
      encoded: skillText("example", {
        description: "Example",
        tack: ["activation: opt-in", "user-activation: default"],
        body: "",
      }),
    });
    expect(parsed).toMatchObject({ activation: "opt-in", userActivation: "default" });
  }),
);

it.effect("rejects an invalid global activation policy", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(
      parseSkillDocument({
        directoryName: "example",
        encoded: skillText("example", {
          description: "Example",
          tack: ["user-activation: always"],
          body: "",
        }),
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

it.effect("refuses a key repeated in SKILL.md frontmatter, at both of its lines in the file", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      parseSkillDocument({
        directoryName: "example",
        encoded: "---\nname: example\ndescription: One\ndescription: Two\n---\nBody\n",
      }),
    );
    expect(error).toMatchObject({
      code: "skill-frontmatter-yaml-malformed",
      message: 'The key "description" appears twice, at lines 3 and 4. Keep one of them.',
    });
  }),
);
