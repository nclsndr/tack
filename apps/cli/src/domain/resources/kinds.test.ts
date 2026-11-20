import { describe, expect, it } from "@effect/vitest";
import { declarationResourceKeys } from "../sources/source-schema.ts";
import {
  dependencyTargetKinds,
  isLinkableKind,
  isSelectableKind,
  linkableKinds,
  ResourceKindSchema,
  resourceKinds,
  selectableKinds,
} from "./kinds.ts";

describe("resource kind table", () => {
  it("derives each set of kinds in catalog order", () => {
    expect(selectableKinds).toEqual(["skill", "command", "context"]);
    expect(linkableKinds).toEqual(["skill", "command"]);
    expect(dependencyTargetKinds).toEqual(["skill", "command"]);
  });

  it("delivers only kinds that a namespace can select", () => {
    expect(linkableKinds.every(isSelectableKind)).toBe(true);
  });

  it("answers each guard from the same row as the derived set", () => {
    for (const kind of ResourceKindSchema.literals) {
      expect(isSelectableKind(kind), kind).toBe(selectableKinds.some((each) => each === kind));
      expect(isLinkableKind(kind), kind).toBe(linkableKinds.some((each) => each === kind));
    }
  });

  it("names every tack.yaml resource key once, in catalog order", () => {
    const keys = ResourceKindSchema.literals.map((kind) => resourceKinds[kind].declarationKey);
    expect(keys).toEqual(declarationResourceKeys);
  });

  it("imports only skills", () => {
    expect(ResourceKindSchema.literals.filter((kind) => resourceKinds[kind].importable)).toEqual([
      "skill",
    ]);
  });
});
