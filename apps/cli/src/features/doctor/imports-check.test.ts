import { expect, it } from "vitest";
import type { ImportsDisplay } from "../imports/import-display.ts";
import type { ImportSummary } from "../../domain/imports/import-schema.ts";
import { importsCheck, type GitProbe } from "./doctor-observations.ts";

const git: GitProbe = { available: true, version: "2.43" };
const next = (argv: ReadonlyArray<string>) => argv;
const none = { added: [], removed: [], changed: [], executable: [], special: [] } as const;

const summary = (
  name: string,
  overrides: Partial<Pick<ImportSummary, "conditions" | "local">> = {},
): ImportSummary => ({
  reference: `personal-brain:${name}`,
  name,
  source: "personal-brain",
  registrationId: "00000000-0000-4000-8000-000000000001",
  path: `skills/${name}`,
  location: "github:acme/skills",
  transport: "https",
  ref: { kind: "default", tracking: true },
  revision: "a".repeat(40),
  upstreamPath: `skills/${name}`,
  importedAt: "2026-11-11T12:40:00Z",
  local: { state: "unchanged", ...none },
  conditions: [],
  ...overrides,
});

const display = (
  imports: ReadonlyArray<ImportSummary>,
  problems: ImportsDisplay["problems"] = [],
): ImportsDisplay => ({ imports, problems, byDirectory: new Map(), bySource: new Map() });

const problem = (code: "imports-invalid" | "staging-left-over") => ({
  source: "personal-brain",
  registrationId: "00000000-0000-4000-8000-000000000001",
  code,
  message: `the ${code} message.`,
});

it("is ok with no imports and a working git", () => {
  expect(importsCheck(display([]), git, next)).toEqual({
    id: "imports",
    outcome: "ok",
    message: "No skill is imported. git 2.43 can fetch for `tack import add`.",
  });
});

it("is ok with present imports and reports local changes as information", () => {
  const changed = summary("pdf", {
    local: { state: "changed", ...none, changed: ["SKILL.md"] },
    conditions: [{ code: "import-locally-changed", message: "SKILL.md changed" }],
  });
  expect(importsCheck(display([summary("docx"), changed]), git, next)).toMatchObject({
    outcome: "ok",
    subjects: ["personal-brain:pdf"],
    message: expect.stringContaining("2 imported skills, all present and cataloged"),
  });
  expect(importsCheck(display([summary("docx"), changed]), git, next).message).toContain(
    "1 imported skill has local changes, which is allowed: personal-brain:pdf.",
  );
  expect(
    importsCheck(display([changed, summary("x", { local: changed.local })]), git, next).message,
  ).toContain("2 imported skills have local changes");
});

it("fails on a missing folder and names the removal preview as the next command", () => {
  const gone = summary("pdf", {
    local: { state: "missing", ...none },
    conditions: [{ code: "import-folder-missing", message: "skills/pdf is gone." }],
  });
  expect(importsCheck(display([gone]), git, next)).toEqual({
    id: "imports",
    outcome: "failed",
    message: "skills/pdf is gone.",
    subjects: ["personal-brain:pdf"],
    next: ["tack", "import", "remove", "personal-brain:pdf"],
  });
});

it("fails on a folder the catalog does not hold and points at the catalog", () => {
  const lost = summary("pdf", {
    conditions: [{ code: "import-folder-not-cataloged", message: "not cataloged." }],
  });
  expect(importsCheck(display([lost]), git, next)).toMatchObject({
    outcome: "failed",
    message: "not cataloged.",
    next: ["tack", "catalog"],
  });
});

it("fails on an unreadable section or a leftover staging folder and points at the listing", () => {
  expect(importsCheck(display([], [problem("imports-invalid")]), git, next)).toEqual({
    id: "imports",
    outcome: "failed",
    message: "the imports-invalid message.",
    subjects: ["personal-brain"],
    next: ["tack", "import"],
  });
  expect(importsCheck(display([], [problem("staging-left-over")]), git, next)).toMatchObject({
    outcome: "failed",
    next: ["tack", "import"],
  });
});

it("warns, without failing, when git cannot fetch", () => {
  expect(
    importsCheck(display([]), { available: false, message: "Git could not be started." }, next),
  ).toEqual({
    id: "imports",
    outcome: "warning",
    message: "Git could not be started. `tack import add` needs git to fetch.",
  });
});
