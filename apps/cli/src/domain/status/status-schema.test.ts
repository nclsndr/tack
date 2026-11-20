import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { reportPendingRemoval } from "../links/pending-removal-schema.ts";
import {
  StatusNamespaceSchema,
  StatusPayloadSchema,
  StatusProjectRootSchema,
  StatusProjectSchema,
  StatusReportSchema,
  statusPayload,
} from "./status-schema.ts";

/** The raw JSON of a complete status report with drift, as `doctor` reads it. */
const fixture: unknown = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/status-report-trouble.json", import.meta.url),
    "utf8",
  ),
);
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
};
const list = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value;
};
const firstNamespace = () => record(list(record(fixture)["namespaces"])[0]);

const root = (path: string) => ({ health: "healthy", lifecycle: "active", path });

it.each([
  [
    "a healthy root that carries an issue",
    { ...root("/work/demo"), issue: { code: "root-missing", message: "gone" } },
    "Project-root health and issue must agree.",
  ],
  [
    "an unhealthy root without an issue",
    { ...root("/work/demo"), health: "unhealthy" },
    "Project-root health and issue must agree.",
  ],
  [
    "a missing root whose issue is not root-missing",
    {
      ...root("/work/demo"),
      health: "missing",
      issue: { code: "root-not-directory", message: "a file" },
    },
    "Missing roots must retain the root-missing issue.",
  ],
])("refuses %s", (_case, candidate, message) => {
  expect(() => Schema.decodeUnknownSync(StatusProjectRootSchema)(candidate)).toThrow(message);
});

it("refuses project roots out of canonical order", () => {
  const project = {
    ...record(list(record(fixture)["projects"])[0]),
    roots: [root("/work/b"), root("/work/a")],
  };

  expect(() => Schema.decodeUnknownSync(StatusProjectSchema)(project)).toThrow(
    "Status project roots must use unique canonical code-unit ordering.",
  );
});

it("accepts the reported namespace as recorded", () => {
  expect(() => Schema.decodeUnknownSync(StatusNamespaceSchema)(firstNamespace())).not.toThrow();
});

it("refuses namespace choices that belong to another namespace", () => {
  const namespace = firstNamespace();
  const choices = list(namespace["choices"]).map((choice) => ({
    ...record(choice),
    namespace: { _tag: "user" },
  }));

  expect(() => Schema.decodeUnknownSync(StatusNamespaceSchema)({ ...namespace, choices })).toThrow(
    "Status namespace choices must belong to the reported namespace.",
  );
});

it("refuses desired namespace addresses that repeat", () => {
  const namespace = firstNamespace();
  const desired = list(namespace["desired"]);

  expect(() =>
    Schema.decodeUnknownSync(StatusNamespaceSchema)({
      ...namespace,
      desired: [desired[0], ...desired],
    }),
  ).toThrow("Desired status addresses must use unique canonical ordering.");
});

it("refuses a selection that belongs to another namespace", () => {
  const namespace = firstNamespace();
  const selection = { ...record(namespace["selection"]), namespace: { _tag: "user" } };

  expect(() =>
    Schema.decodeUnknownSync(StatusNamespaceSchema)({ ...namespace, selection }),
  ).toThrow("Status selection must belong to the reported namespace.");
});

it("publishes a destination's owed removal and sharing, and no address when nothing names it", () => {
  const report = Schema.decodeUnknownSync(StatusReportSchema)(fixture);
  const [first, ...rest] = report.destinations;
  if (first?.evidence === undefined) throw new Error("Expected a recorded destination");
  const { evidence, ...unrecorded } = first;
  const sharing = {
    adapters: ["claude", "codex"],
    directory: "/work/demo/.agents/skills",
    physicalDirectory: "/work/demo/.claude/skills",
    role: "shared",
    writer: "claude",
  } as const;
  const pendingRemoval = reportPendingRemoval({ cause: "clean", evidence });

  const [published] = statusPayload({
    ...report,
    destinations: [{ ...unrecorded, desired: [], pendingRemoval, sharing }, ...rest],
  }).destinations;

  expect(published).not.toHaveProperty("address");
  expect(published?.pendingRemoval).toEqual(pendingRemoval);
  expect(published?.sharing).toEqual(sharing);
});

it("refuses published destinations out of canonical order", () => {
  const payload = statusPayload(Schema.decodeUnknownSync(StatusReportSchema)(fixture));

  expect(() =>
    Schema.decodeUnknownSync(StatusPayloadSchema)({
      ...payload,
      destinations: [...payload.destinations].reverse(),
    }),
  ).toThrow("Status destinations must use unique canonical code-unit ordering.");
});
