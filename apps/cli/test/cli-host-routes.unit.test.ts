import { describe, expect, it } from "@effect/vitest";
import { commandNameOf, commandDeclarations, commandTagOf } from "../src/cli/commands/index.ts";
import { routes } from "../src/cli/host/routes/index.ts";

describe("CLI host routes", () => {
  it("routes exactly the invocations that have a command path", () => {
    expect(Object.keys(routes).toSorted()).toEqual(
      [...Object.keys(commandDeclarations), "help", "version"].toSorted(),
    );
  });

  it("routes the help and version requests, which have no command path", () => {
    expect(commandNameOf("help")).toBe("help");
    expect(commandNameOf("version")).toBe("version");
  });

  it.each([
    ["adapter enable", "adapter-set"],
    ["pick", "pick-list"],
    ["state clean", "clean"],
    ["help", "help"],
    ["version", "version"],
  ] as const)("names the invocation of the command name %s", (name, tag) => {
    expect(commandTagOf(name)).toBe(tag);
  });

  it.each(["unknown", "profile", "state"])("names no invocation for %s", (name) => {
    expect(commandTagOf(name)).toBeUndefined();
  });
});
