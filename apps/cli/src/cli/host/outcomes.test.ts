import { describe, expect, it } from "@effect/vitest";
import { Cause, Exit } from "effect";
import { emptyState, type State } from "../../domain/state/state-schema.ts";
import type { LinkRecord } from "../../domain/links/link-record-schema.ts";
import type { SelectionEcho } from "../../features/projects/project.ts";
import { ExecutionError } from "../../services/execution-platform.ts";
import { errorRegistry, outcomeForError, type HostFailure } from "./errors.ts";
import {
  appliedAs,
  docsSearchOutcome,
  resultAs,
  sourcesOutcome,
  withOutsidePendingDiagnostic,
  withUnregisteredWorktree,
} from "./outcomes.ts";
import { envelopeFromExit } from "./public-outcome.ts";

const registrationId = "00000000-0000-4000-8000-000000000001";
const success = { classification: "success", diagnostics: [] } as const;

/** A pending removal owed at a user destination or at a root of the named project. */
const pending = (owner: string, name: string): LinkRecord => ({
  destinationPath: `/work/${owner}/.agents/skills/${name}`,
  sourceDirectoryPath: `/sources/tools/skills/${name}`,
  resource: { kind: "skill", name, sourceRegistrationId: registrationId },
  target:
    owner === "user"
      ? { _tag: "user", canonicalPath: "/work/user" }
      : { _tag: "project-root", canonicalPath: `/work/${owner}`, projectName: owner },
  delivery: { _tag: "agent", adapter: "codex" },
  removal: { cause: "clean" },
});

const withLinks = (links: ReadonlyArray<LinkRecord>): State => {
  const state = emptyState();
  return { ...state, data: { ...state.data, links } };
};

const selection = (selector: SelectionEcho["selector"], containing?: string): SelectionEcho => ({
  selector,
  targets: [],
  ...(containing === undefined
    ? {}
    : { containingRoot: { projectName: containing, root: `/work/${containing}` } }),
});

describe("pending removals outside the selected scope", () => {
  const state = withLinks([pending("user", "a"), pending("alpha", "b"), pending("beta", "c")]);

  it("counts the removals of other projects and the user from a bare selection in a root", () => {
    expect(
      withOutsidePendingDiagnostic(success, state, selection({ _tag: "bare" }, "alpha"))
        .diagnostics,
    ).toEqual([
      {
        code: "pending-removals-outside-scope",
        details: { count: 2, owners: ["beta", "user"] },
        message: "2 pending removals outside this scope (beta, user).",
        severity: "info",
      },
    ]);
  });

  it("counts every project removal from the user selection", () => {
    expect(
      withOutsidePendingDiagnostic(success, state, selection({ _tag: "user" })).diagnostics,
    ).toMatchObject([{ details: { count: 2, owners: ["alpha", "beta"] } }]);
  });

  it("counts a single removal of another project from a project selection", () => {
    expect(
      withOutsidePendingDiagnostic(
        success,
        withLinks([pending("alpha", "b"), pending("beta", "c")]),
        selection({ _tag: "project", projectName: "alpha" }),
      ).diagnostics,
    ).toMatchObject([{ message: "1 pending removal outside this scope (beta)." }]);
  });

  it("adds nothing for an all selection or when every removal is in scope", () => {
    expect(withOutsidePendingDiagnostic(success, state, selection({ _tag: "all" }))).toBe(success);
    expect(
      withOutsidePendingDiagnostic(
        success,
        withLinks([pending("alpha", "b")]),
        selection({ _tag: "project", projectName: "alpha" }),
      ),
    ).toBe(success);
  });
});

describe("status from an unregistered worktree", () => {
  const worktree = {
    _tag: "unregistered-worktree",
    projectName: "app",
    root: "/work/app-feature",
  } as const;

  it("turns a successful status partial and names the refresh", () => {
    const outcome = withUnregisteredWorktree(success, worktree, { _tag: "all" });
    expect(outcome.classification).toBe("partial");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "worktree-not-registered",
    ]);
    expect(outcome.next).toEqual([["tack", "project", "refresh", "--apply"]]);
  });

  it("keeps a failed status's classification and adds the warning to its own", () => {
    const failed = {
      classification: "domain",
      diagnostics: [
        { code: "state-unreadable", message: "State is unreadable.", severity: "error" },
      ],
    } as const;
    const outcome = withUnregisteredWorktree(failed, worktree, { _tag: "all" });
    expect(outcome.classification).toBe("domain");
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "state-unreadable",
      "worktree-not-registered",
    ]);
  });

  it("leaves a user status alone", () => {
    expect(withUnregisteredWorktree(success, worktree, { _tag: "user" })).toBe(success);
  });
});

describe("payloads of a declared slot", () => {
  it("lead with the kind of the schema the command declares for the slot", () => {
    expect(appliedAs("docs-detach")({ attachments: [], projectName: "demo" })).toEqual({
      applied: { kind: "docs-settings", attachments: [], projectName: "demo" },
      classification: "success",
      diagnostics: [],
    });
    expect(resultAs("pick-list")({ choices: [] }).result).toEqual({ kind: "choices", choices: [] });
  });
});

describe("source and docs outcomes", () => {
  it("reports each source label issue with its registration", () => {
    const outcome = sourcesOutcome([
      {
        status: "healthy",
        registration: { id: registrationId, canonicalPath: "/sources/tools" },
        labelIssues: [{ code: "source-label-reserved", message: "The label tack is reserved." }],
        declarations: [],
      },
    ]);
    expect(outcome).toMatchObject({
      classification: "partial",
      diagnostics: [
        {
          code: "source-label-reserved",
          details: { sourceRegistrationId: registrationId },
          message: "The label tack is reserved.",
          severity: "warning",
        },
      ],
    });
  });

  it("names the next setup step when docs search has nothing to search", () => {
    expect(
      docsSearchOutcome({
        project: { name: "demo", root: "/work/demo" },
        complete: false,
        issues: [],
        setup: {
          code: "no-docs-attached",
          message: "No docs are attached.",
          next: "tack docs attach SOURCE:NAME",
        },
        query: "ownership",
        limit: 10,
        total: 0,
        truncated: false,
        hits: [],
      }).diagnostics,
    ).toEqual([
      {
        code: "docs-setup-incomplete",
        details: { next: "tack docs attach SOURCE:NAME" },
        message: "No docs are attached. Next: tack docs attach SOURCE:NAME",
        severity: "warning",
      },
    ]);
  });
});

describe("failure outcomes", () => {
  it("omits absent run details and replaces an empty message", () => {
    expect(
      outcomeForError(
        new ExecutionError({
          stage: "worker",
          code: "run_failed",
          message: "",
          classification: "internal",
        }),
      ),
    ).toEqual({
      classification: "internal",
      diagnostics: [
        {
          code: "run_failed",
          details: { stage: "worker" },
          message: "The requested operation cannot be completed.",
          severity: "error",
        },
      ],
    });
  });

  it("redacts a failure whose tag has no registered rule", () => {
    const foreign = Object.assign(new Error("raw secret"), { _tag: "ForeignError" });
    expect(Object.hasOwn(errorRegistry, "ForeignError")).toBe(false);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The guard exists for values that escape the HostFailure type.
    expect(outcomeForError(foreign as unknown as HostFailure)).toEqual({
      classification: "internal",
      diagnostics: [
        {
          code: "internal-error",
          message: "An unexpected internal error occurred.",
          severity: "error",
        },
      ],
    });
  });

  it("redacts a defect and a cause with no typed failure as internal errors", () => {
    const handlers = { onFailure: () => success, onSuccess: () => success };
    for (const exit of [Exit.die(new Error("raw secret")), Exit.failCause(Cause.empty)])
      expect(envelopeFromExit("status", exit, handlers)).toMatchObject({
        classification: "internal",
        command: "status",
        diagnostics: [
          { code: "internal-error", message: "An unexpected internal error occurred." },
        ],
      });
  });
});
