import { describe, expect, it } from "vitest";
import type { PublicEnvelope } from "../public-outcome.ts";
import { plainStyle } from "./human.test-support.ts";
import { subjectText } from "./view.ts";

type Diagnostic = PublicEnvelope["diagnostics"][number];
const sourceId = "00000000-0000-4000-8000-000000000001";
const about = (details: Diagnostic["details"]): string | undefined =>
  subjectText(
    { code: "x", message: "m", severity: "warning", ...(details === undefined ? {} : { details }) },
    plainStyle,
  );

describe("diagnostic subject text", () => {
  it("is absent without details or with empty details", () => {
    expect(about(undefined)).toBeUndefined();
    expect(about({})).toBeUndefined();
  });

  it("reads flat details as key and value pairs, shortening home paths", () => {
    expect(about({ path: "/home/me/project", count: 2, forced: false })).toBe(
      "path ~/project · count 2 · forced false",
    );
  });

  it("reads a list of words as one shell line, trims text and leaves out empty lists", () => {
    expect(
      about({
        args: ["rev-parse", "--git-common-dir"],
        paths: ["/a", "/b c"],
        candidates: [],
        exitCode: 128,
        stderr: "fatal: not a git repository\n",
      }),
    ).toBe(
      "args rev-parse --git-common-dir · paths /a '/b c' · exitCode 128 · stderr fatal: not a git repository",
    );
    expect(about({ candidates: [] })).toBeUndefined();
  });

  it("keeps nested or non-object details as compact JSON", () => {
    expect(about({ paths: [["/a"], ["/b"]] })).toBe('{"paths":[["/a"],["/b"]]}');
    expect(about({ next: { command: "x" } })).toBe('{"next":{"command":"x"}}');
    expect(about("plain")).toBe('"plain"');
  });

  it("keeps a subject it cannot summarize as compact JSON", () => {
    expect(about({ subject: "loose" })).toBe('"loose"');
    expect(about({ subject: { unknown: 1 } })).toBe('{"unknown":1}');
  });

  it("is absent for an empty subject or one naming only the enabled adapters", () => {
    expect(about({ subject: {} })).toBeUndefined();
    expect(about({ subject: { enabledAdapters: ["claude"] } })).toBeUndefined();
  });

  it("names every distinct address, the adapter, the user namespace and the issue", () => {
    const review = { kind: "skill", name: "review", sourceRegistrationId: sourceId };
    expect(
      about({
        subject: {
          address: review,
          addresses: [review, { kind: "command", name: "ship" }, "not an address"],
          members: [{ kind: "skill", name: 3 }],
          adapter: "codex",
          target: { _tag: "user" },
          namespace: { _tag: "elsewhere" },
          issue: { message: "No code here." },
        },
      }),
    ).toBe(`skill ${sourceId}:review, command ship · codex · user · No code here.`);
  });

  it("names one destination by path and several by the first and a count", () => {
    expect(about({ subject: { destinationPaths: ["/home/me/a"] } })).toBe("~/a");
    expect(about({ subject: { destinationPaths: ["/home/me/a", "/b", 3, "/c"] } })).toBe(
      "~/a and 2 more",
    );
    expect(about({ subject: { destinationPaths: "/not/a/list", reason: "why" } })).toBe("why");
  });
});
