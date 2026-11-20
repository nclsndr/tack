import { expect, it } from "vitest";
import type { DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";
import { isOwnedLink, linkResolvesToEvidence } from "./managed-link-ownership.ts";
import type { ManagedLinkEvidence } from "../../domain/links/managed-link-schema.ts";

const evidence = {
  adapter: "cursor",
  address: {
    kind: "skill",
    name: "guide",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  },
  sourceDirectoryPath: "/source/skills/guide",
  sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  target: { _tag: "user", canonicalPath: "/home" },
} satisfies ManagedLinkEvidence;

const destinationPath = "/home/.cursor/skills/guide";
const writtenText = "../../../source/skills/guide";

const observations = {
  absolute: { _tag: "absolute-link", destinationPath, rawTarget: evidence.sourceDirectoryPath },
  danglingForeign: {
    _tag: "unresolved-relative-link",
    destinationPath,
    message: "missing",
    rawTarget: `./${writtenText}`,
  },
  danglingWritten: {
    _tag: "unresolved-relative-link",
    destinationPath,
    message: "missing",
    rawTarget: writtenText,
  },
  elsewhere: {
    _tag: "relative-link",
    canonicalTarget: "/source/skills/other",
    destinationPath,
    rawTarget: "../../../source/skills/other",
  },
  resolving: {
    _tag: "relative-link",
    canonicalTarget: evidence.sourceDirectoryPath,
    destinationPath,
    rawTarget: writtenText,
  },
} satisfies Record<string, DestinationObservation>;

it("owns resolving links and dangling links only with the exact text Tack writes", () => {
  const decisions = Object.entries(observations).map(([name, observation]) => [
    name,
    linkResolvesToEvidence(observation, evidence),
    isOwnedLink(observation, evidence, writtenText),
    isOwnedLink(observation, evidence, undefined),
  ]);

  expect(decisions).toEqual([
    ["absolute", false, false, false],
    ["danglingForeign", false, false, false],
    ["danglingWritten", false, true, false],
    ["elsewhere", false, false, false],
    ["resolving", true, true, true],
  ]);
});
