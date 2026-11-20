import { describe, expect, it } from "vitest";
import { documentAt } from "./document-route.ts";

const documents = [
  { route: "/docs/personal-brain/tack/guide" },
  { route: "/docs/personal-brain/tack/index" },
  { route: "/docs/personal-brain/tack/specs/index" },
];

describe("documentAt", () => {
  it("finds a document by its route", () => {
    expect(documentAt(documents, "/docs/personal-brain/tack/guide")).toBe(documents[0]);
  });

  it("finds an index document at the folder path Rspress serves it under", () => {
    expect(documentAt(documents, "/docs/personal-brain/tack/")).toBe(documents[1]);
    expect(documentAt(documents, "/docs/personal-brain/tack/specs/")).toBe(documents[2]);
    expect(documentAt(documents, "/docs/personal-brain/tack/index")).toBe(documents[1]);
    expect(documentAt(documents, "/docs/personal-brain/tack/specs")).toBe(documents[2]);
  });

  it("opens the first document at the root, and none at an unknown path", () => {
    expect(documentAt(documents, "/")).toBe(documents[0]);
    expect(documentAt(documents, "/docs/personal-brain/tack/missing")).toBeUndefined();
  });
});
