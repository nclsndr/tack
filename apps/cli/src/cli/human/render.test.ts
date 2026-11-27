import { describe, expect, it } from "vitest";
import { Record } from "effect";
import { commandNameOf, commandDeclarations, commandTagOf } from "../commands/index.ts";
import { createPublicEnvelope } from "../envelope/public-outcome.ts";
import {
  envelopeOf,
  expectViewContract,
  humanFixture,
  humanFixtureNames,
  styleOf,
} from "./human.test-support.ts";
import { humanViews, renderHuman } from "./render.ts";

/** Every public operation: the command paths of the tree and the two flag requests. */
const operations = [
  ...Record.keys(commandDeclarations).map(commandNameOf),
  commandNameOf("help"),
  commandNameOf("version"),
];

const longPath = `/srv/スキル/${"日本語のソースディレクトリ/".repeat(3)}a-checkout-with-a-rather-long-name`;

/** A failure every operation can report: a long path and wide characters in its diagnostic. */
const failureOf = (command: string) =>
  envelopeOf({
    command,
    classification: "invalid-configuration",
    diagnostics: [
      {
        code: "state-unreadable",
        message: `宣言ファイルを読み取れません。Tack cannot read ${longPath}; check the path and try again.`,
        severity: "error",
        details: { path: longPath },
      },
    ],
  });

describe("the view registry", () => {
  it("shows the invocations that share a command name through one view", () => {
    for (const tag of Record.keys(humanViews))
      expect(humanViews[tag], tag).toBe(humanViews[commandTagOf(commandNameOf(tag)) ?? tag]);
  });

  it.each(operations)("keeps the view contract for a failure of %s", (operation) => {
    expectViewContract(failureOf(operation));
  });

  it.each(humanFixtureNames)("keeps the view contract for the captured %s envelope", (name) => {
    expectViewContract(humanFixture(name), { homeDirectory: "/fx/home" });
  });
});

describe("the generic view", () => {
  it("renders every envelope fact, painted only when color is on", () => {
    const envelope = createPublicEnvelope("catalog", {
      classification: "partial",
      diagnostics: [
        {
          code: "source-invalid",
          message: "Source is invalid.",
          severity: "warning",
          details: { subject: "demo" },
        },
      ],
      result: { kind: "catalog", resources: [] },
      plan: { kind: "plan" },
      applied: { kind: "application" },
    });
    const plain = renderHuman(envelope, styleOf());
    expect(plain).toContain("tack catalog");
    expect(plain).toContain("partial");
    expect(plain).toContain('warning source-invalid · "demo"');
    for (const slot of ["result", "plan", "applied"]) expect(plain).toContain(slot);
    expect(plain).not.toContain("\u001b[");
    expect(renderHuman(envelope, styleOf({ color: true }))).toContain("\u001b[");
  });
});

describe("an internal failure", () => {
  it("never reaches the dedicated view, and shows a payload it still carries as generic slots", () => {
    const envelope = createPublicEnvelope("status", {
      classification: "internal",
      diagnostics: [{ code: "internal-error", message: "Tack failed.", severity: "error" }],
      result: { kind: "status" },
    });
    const plain = renderHuman(envelope, styleOf(), { status: () => "dedicated status view" });
    expect(plain).not.toContain("dedicated status view");
    expect(plain).toContain("internal-error");
    expect(plain).toContain('"kind": "status"');
  });
});
