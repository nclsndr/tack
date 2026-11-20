import { expect, it } from "vitest";
import { emptyState, type State } from "./state-schema.ts";
import { allDocsSettings, docsSettingsFor } from "./state-intent.ts";

const source = "21380456-fa78-4ed4-95ae-110da2a6d41c";

const state: State = {
  ...emptyState(),
  data: {
    ...emptyState().data,
    projects: [
      {
        gitCommonDirectory: "/work/demo/.git",
        name: "demo",
        roots: ["/work/demo"],
        removingRoots: [],
        docs: {
          attachments: [{ sourceRegistrationId: source, name: "guide", writingDefault: true }],
          destination: "docs/shared",
        },
      },
      {
        gitCommonDirectory: "/work/plain/.git",
        name: "plain",
        roots: ["/work/plain"],
        removingRoots: [],
      },
    ],
  },
};

it("has no docs settings for a project that is not registered", () => {
  expect(docsSettingsFor(state, "missing")).toBeUndefined();
});

it("reports retained docs settings with their destination and writing default", () => {
  expect(docsSettingsFor(state, "demo")).toEqual({
    projectName: "demo",
    attachments: [{ sourceRegistrationId: source, name: "guide" }],
    destination: "docs/shared",
    defaultWritingResource: { sourceRegistrationId: source, name: "guide" },
  });
  expect(allDocsSettings(state).map((settings) => settings.projectName)).toEqual(["demo"]);
});
