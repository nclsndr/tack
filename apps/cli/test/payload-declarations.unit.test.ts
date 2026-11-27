import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { undeclaredPayloads } from "./support/declared-payloads.ts";

const fixtureDirectory = new URL("./fixtures/human/", import.meta.url);

/**
 * The `sync` fixtures captured before sync also planned docs mounts: each slot holds the agent-link
 * part alone, which the sync view still renders. They are checked as that part of a sync payload.
 */
const agentLinkOnlySyncFixtures = new Set([
  "plan-after.json",
  "plan-before.json",
  "plan-remove.json",
  "plan-trouble.json",
  "reconcile-apply.json",
  "reconcile-preview.json",
  "reconcile-trouble.json",
]);

/** A captured envelope, with an agent-link-only sync payload wrapped as the sync payload's part. */
const capturedEnvelope = (name: string): Readonly<Record<string, unknown>> => {
  const envelope = JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
  if (agentLinkOnlySyncFixtures.has(name) === false) return envelope;
  const asPartOf = (kind: string, part: unknown) =>
    part === null ? null : { kind, resources: part, docs: [] };
  return {
    ...envelope,
    plan: asPartOf("sync-plan", envelope.plan),
    applied: asPartOf("sync-application", envelope.applied),
  };
};

const fixtureNames = readdirSync(fixtureDirectory).filter((name) => name.endsWith(".json"));

describe("declared payload schemas", () => {
  it.each(fixtureNames)("decode every filled slot of the captured envelope %s", (name) => {
    expect(undeclaredPayloads(capturedEnvelope(name))).toEqual([]);
  });

  it("names the agent-link-only sync fixtures by what they hold", () => {
    for (const name of agentLinkOnlySyncFixtures) {
      const envelope = JSON.parse(readFileSync(new URL(name, fixtureDirectory), "utf8"));
      expect(envelope.command, name).toBe("sync");
      expect(envelope.plan.kind, name).toBe("skill-reconciliation-plan");
    }
  });

  it.each([
    [
      "a slot its schema does not decode",
      { command: "status", result: { kind: "skill-status" } },
      /^status result: /,
    ],
    [
      "a slot the command does not declare",
      { command: "status", plan: { kind: "skill-status" } },
      /^status fills plan, which it does not declare$/,
    ],
  ])("reports %s", (_case, envelope, problem) => {
    expect(undeclaredPayloads(envelope)).toEqual([expect.stringMatching(problem)]);
  });

  it.each([
    ["an undeclared command", { command: "unknown", result: { anything: true } }],
    ["a value that is not an envelope", ["status"]],
    ["empty slots", { command: "version", result: null }],
  ])("has nothing to report for %s", (_case, value) => {
    expect(undeclaredPayloads(value)).toEqual([]);
  });
});
