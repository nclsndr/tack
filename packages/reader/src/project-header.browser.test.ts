// @vitest-environment jsdom
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { press, pressKey, settle } from "./popover.test-support.ts";
import { IssueNotice, ProjectHeader } from "./project-header.tsx";
import type { ReaderDocument, ReaderResourceIssue } from "./types.ts";
import { testRoot } from "./react.test-support.ts";

const ui = testRoot();

const specs = {
  sourceRegistrationId: "source-1",
  name: "specs",
  sourcePath: "/Users/ada/work/atlas",
  directoryPath: "/Users/ada/work/atlas/docs/specs",
};
const handbook = {
  sourceRegistrationId: "source-2",
  name: "handbook",
  sourcePath: "/Users/ada/work/platform-handbook",
  directoryPath: "/Users/ada/work/platform-handbook/handbook",
};
const page = (resource: typeof specs, id: string): ReaderDocument => ({
  id,
  path: id,
  relativePath: "page.md",
  route: `/${id}`,
  title: id,
  metadata: { title: id, tags: [] },
  blocks: [],
  imports: [],
  searchText: "",
  source: "",
  resource,
});
const header = {
  boot: {
    worktree: "/Users/ada/work/atlas",
    project: { name: "atlas" },
    resources: [specs, handbook],
    documents: [page(specs, "a"), page(specs, "b"), page(handbook, "c")],
    version: "0.1.0+dev",
  },
  checkout: { kind: "branch", name: "feat/billing-export" } as const,
  live: { state: "live", label: "Live" } as const,
  attention: "",
};

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  await ui.render(element);
}

/** Finds an element in the document: an open panel renders in a portal outside the container. */
function query(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`Missing element: ${selector}`);
  return found;
}

function trigger(): HTMLButtonElement {
  const found = ui.container.querySelector("button");
  if (found === null) throw new Error("Missing popover trigger");
  return found;
}

const isOpen = () => trigger().getAttribute("aria-expanded") === "true";
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function open(): Promise<void> {
  await act(async () => trigger().click());
  await settle();
}

const text = (selector: string) =>
  Array.from(document.querySelectorAll(selector)).map((item) => item.textContent);

describe("ProjectHeader", () => {
  it("names the project with its monogram and the checked-out branch, closed", async () => {
    await render(createElement(ProjectHeader, header));

    expect(query(".tack-monogram").textContent).toBe("AS");
    expect(query(".tack-project-name").textContent).toBe("atlas");
    expect(query(".tack-project-place").textContent).toBe("feat/billing-export");
    expect(query(".tack-project-place").title).toBe("Branch feat/billing-export");
    expect(isOpen()).toBe(false);
    expect(panel()).toBeNull();
    expect(ui.container.textContent).not.toContain("Tack");
  });

  it("opens a popover with the branch, the root, each attached resource and the release", async () => {
    await render(createElement(ProjectHeader, header));
    await open();

    expect(isOpen()).toBe(true);
    expect(panel()?.contains(query(".tack-project-facts"))).toBe(true);
    expect(text(".tack-project-facts dt")).toEqual(["Branch", "Root"]);
    expect(text(".tack-project-facts dd")).toEqual(["feat/billing-export", "…/ada/work/atlas"]);
    expect(query(".tack-project-facts dd:last-child").title).toBe("/Users/ada/work/atlas");
    expect(query(".tack-project-docs-total").textContent).toBe("3 docs");
    expect(
      Array.from(document.querySelectorAll(".tack-project-docs li")).map((row) => [
        row.querySelector(".tack-project-docs-label")?.textContent,
        row.querySelector(".tack-project-docs-count")?.textContent,
        row.querySelector(".tack-project-docs-directory")?.textContent,
      ]),
    ).toEqual([
      ["atlas / specs", "2", "docs/specs"],
      ["platform-handbook / handbook", "1", "handbook"],
    ]);
    expect(query(".tack-project-footer").textContent).toBe("Livetack 0.1.0+dev");
  });

  it("shows a detached head by its commit", async () => {
    await render(
      createElement(ProjectHeader, {
        ...header,
        checkout: { kind: "detached", commit: "0123456" },
      }),
    );
    await open();

    expect(query(".tack-project-place").textContent).toBe("0123456");
    expect(query(".tack-project-place").title).toBe("Detached at 0123456");
    expect(text(".tack-project-facts dd")[0]).toBe("detached at 0123456");
  });

  it("names the root folder outside git and lists no branch", async () => {
    await render(
      createElement(ProjectHeader, {
        ...header,
        boot: { ...header.boot, worktree: "/private/var/tmp.yDlOZzjyVi/notes" },
        checkout: null,
      }),
    );
    await open();

    expect(query(".tack-project-place").textContent).toBe("notes");
    expect(query(".tack-project-place").title).toBe("/private/var/tmp.yDlOZzjyVi/notes");
    expect(text(".tack-project-facts dt")).toEqual(["Root"]);
  });

  it("gives a one-letter project a one-letter monogram and leaves out an unknown release", async () => {
    const { version: _version, ...withoutVersion } = header.boot;
    await render(
      createElement(ProjectHeader, {
        ...header,
        boot: { ...withoutVersion, project: { name: "a" }, resources: [], documents: [] },
      }),
    );
    await open();

    expect(query(".tack-monogram").textContent).toBe("A");
    expect(query(".tack-project-docs-total").textContent).toBe("0 docs");
    expect(query(".tack-project-footer").textContent).toBe("Live");
  });

  it("keeps only a small red indicator in the header when documentation is unavailable", async () => {
    await render(createElement(ProjectHeader, header));
    expect(ui.container.querySelector(".tack-project-attention")).toBeNull();

    await render(createElement(ProjectHeader, { ...header, attention: "1 doc skipped" }));
    const indicator = query(".tack-project-attention");

    expect(indicator.title).toBe("1 doc skipped");
    // Assistive technology hears the project first, then the issue count.
    expect(trigger().textContent).toBe("ASatlasfeat/billing-export · 1 doc skipped");
    expect(query(".tack-project-attention-label").className).toContain("sr-only");
  });
});

const skipped: ReaderResourceIssue = {
  resource: { sourceRegistrationId: "source-2", name: "handbook" },
  sourcePath: handbook.sourcePath,
  code: "document-load",
  path: `${handbook.directoryPath}/rollback.mdx`,
  message: `${handbook.directoryPath}/rollback.mdx: cannot parse authored MDX: Unexpected character`,
};
const unavailable: ReaderResourceIssue = {
  resource: { sourceRegistrationId: "source-3", name: "runbooks" },
  sourcePath: "/Users/ada/work/ops",
  code: "docs-resource-unavailable",
  message: "The registered source is unavailable.",
};

describe("IssueNotice", () => {
  it("renders nothing while every document is available", async () => {
    await render(createElement(IssueNotice, { issues: [], failure: "" }));

    expect(ui.container.innerHTML).toBe("");
  });

  it("counts issues on a closed notice and lists each by file and first clause when opened", async () => {
    await render(createElement(IssueNotice, { issues: [skipped, unavailable], failure: "" }));

    expect(trigger().textContent).toBe("1 doc skipped · 1 resource unavailable");
    expect(isOpen()).toBe(false);
    await open();

    expect(
      Array.from(document.querySelectorAll<HTMLElement>(".tack-issues li")).map((row) => [
        row.querySelector(".tack-issue-name")?.textContent,
        row.querySelector(".tack-issue-summary")?.textContent,
        row.title,
      ]),
    ).toEqual([
      ["rollback.mdx", "cannot parse authored MDX", skipped.message],
      ["ops / runbooks", "The registered source is unavailable", unavailable.message],
    ]);
  });

  it("lists each unknown icon by file and line, with the whole message", async () => {
    const icon = {
      path: "/Users/ada/work/atlas/docs/specs/page.mdx",
      line: 12,
      message: 'unknown icon "home": Lucide renamed it "house"',
      suggestions: ["house"],
    };
    await render(createElement(IssueNotice, { issues: [], failure: "", icons: [icon] }));
    await open();

    expect(trigger().textContent).toBe("1 unknown icon");
    expect(text(".tack-issue-name")).toEqual(["page.mdx:12"]);
    expect(text(".tack-issue-summary")).toEqual([icon.message]);
  });

  it("lists each misused author component by file and line", async () => {
    const part = {
      path: "/Users/ada/work/atlas/docs/specs/page.mdx",
      line: 7,
      component: "Tabs" as const,
      message: "Tabs needs at least two Tab children; one alternative is just content",
    };
    await render(createElement(IssueNotice, { issues: [], failure: "", components: [part] }));
    await open();

    expect(trigger().textContent).toBe("1 component issue");
    expect(text(".tack-issue-name")).toEqual(["page.mdx:7"]);
    expect(text(".tack-issue-summary")).toEqual([part.message]);
  });

  it("adds a failed rebuild of the served generation as its own entry", async () => {
    const failure = "Compilation failed: bad.mdx\nat line 3";
    await render(createElement(IssueNotice, { issues: [], failure }));
    await open();

    expect(trigger().textContent).toBe("Rebuild failed");
    expect(text(".tack-issue-name")).toEqual(["Last save"]);
    expect(text(".tack-issue-summary")).toEqual(["Compilation failed"]);
    expect(query(".tack-issues li").title).toBe(failure);
  });
});

describe("popover keyboard and pointer access", () => {
  it.each([
    ["the project header", () => createElement(ProjectHeader, header)],
    ["the issue notice", () => createElement(IssueNotice, { issues: [skipped], failure: "" })],
  ])("%s opens on its trigger, closes on Escape and returns focus", async (_name, element) => {
    await render(element());
    await act(async () => trigger().focus());
    await open();
    expect(panel()?.contains(document.activeElement)).toBe(true);

    await pressKey(document.activeElement, "Escape");
    expect(isOpen()).toBe(false);
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it.each([
    ["the project header", () => createElement(ProjectHeader, header)],
    ["the issue notice", () => createElement(IssueNotice, { issues: [skipped], failure: "" })],
  ])("%s closes on a pointer outside its panel", async (_name, element) => {
    await render(element());
    await open();
    await press(query('[role="dialog"]'));
    expect(isOpen()).toBe(true);

    await press(document.body);
    expect(isOpen()).toBe(false);
  });
});
