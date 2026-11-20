// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interactionContext } from "../browser.ts";
import { FileTree } from "./file-tree.tsx";
import type { FileTreeProps } from "./file-tree-model.ts";
import { fileTreeIssues } from "./catalog.ts";
import { issueLine } from "./issues.ts";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "/tree");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const source = [
  "~/.local/",
  "  bin/",
  "    tack -> ../share/tack/current/bin/tack  # created once",
  "  share/tack/",
  "    current -> releases/r1  # the pointer an update swaps [key]",
  "    releases/",
  "      r1/  [300 MB]",
  "        bin/tack  [69 MB]",
  "        ...",
  "    staging/  # only during an update [temp]",
  "    hold  # after a failure [temp]",
].join("\n");

const props: FileTreeProps = {
  id: "disk",
  title: "An update swaps one symlink, current",
  rule: { title: "Arrows are symlinks", text: "An arrow ends where the link resolves." },
  startWith: ["~/.local/bin/tack"],
  lenses: [
    {
      id: "during",
      label: "During an update",
      note: "staging/ exists.",
      present: ["~/.local/share/tack/staging/"],
    },
  ],
  source,
};

async function render(value: FileTreeProps): Promise<void> {
  await act(async () => root.render(createElement(FileTree, value)));
}
const row = (id: string): SVGGElement => {
  const element = container.querySelector<SVGGElement>(`g.tack-tree-row[data-entry="${id}"]`);
  if (element === null) throw new Error(`Missing row ${id}`);
  return element;
};
const button = (text: string): HTMLButtonElement => {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.firstChild?.textContent === text,
  );
  if (element === undefined) throw new Error(`Missing button ${text}`);
  return element;
};
const figure = (): HTMLElement => {
  const element = container.querySelector("figure");
  if (element === null) throw new Error("Missing figure");
  return element;
};
async function fire(element: Element, event: Event): Promise<void> {
  await act(async () => {
    element.dispatchEvent(event);
  });
}
const click = (element: Element) => fire(element, new MouseEvent("click", { bubbles: true }));
const arrows = () =>
  [...container.querySelectorAll(".tack-tree-arrows path")].map((path) =>
    path.getAttribute("data-kind"),
  );

describe("FileTree", () => {
  it("draws one row per entry with marks, sizes and symlink arrows on the ruled ground", async () => {
    await render(props);
    expect(figure().getAttribute("data-ground")).toBe("ruled-lines");
    expect(container.querySelectorAll("svg.tack-tree g.tack-tree-row")).toHaveLength(11);
    expect(row("~/.local/share/tack/current").hasAttribute("data-key")).toBe(true);
    expect(row("~/.local/share/tack/staging/").getAttribute("data-temp")).toBe("sometimes");
    expect(row("~/.local/share/tack/releases/").hasAttribute("data-directory")).toBe(true);
    expect(row("~/.local/share/tack/releases/r1/...").getAttribute("aria-hidden")).toBe("true");
    expect(
      [...container.querySelectorAll(".tack-tree-size")].map((text) => text.textContent),
    ).toEqual(["300 MB", "69 MB"]);
    expect(arrows()).toEqual(["rest", "rest"]);
    expect(row("~/.local/bin/tack").querySelector(".tack-tree-target")?.textContent).toBe(
      " -> ../share/tack/current/bin/tack",
    );
    const legend = [...container.querySelectorAll(".tack-figure-legend li")].map(
      (item) => item.textContent,
    );
    expect(legend).toEqual([
      "key entry",
      "exists only sometimes",
      "symlink, to where it resolves",
      "size, to scale with the largest",
    ]);
    expect(container.querySelector(".tack-figure-issues")).toBeNull();
  });

  it("inks a link's chain to the real file when it is in focus, and pins it in the URL", async () => {
    await render(props);
    await fire(row("~/.local/bin/tack"), new MouseEvent("mouseover", { bubbles: true }));
    expect(row("~/.local/bin/tack").getAttribute("data-ink")).toBe("focus");
    expect(row("~/.local/share/tack/current").getAttribute("data-ink")).toBe("near");
    expect(row("~/.local/share/tack/releases/r1/bin/tack").getAttribute("data-ink")).toBe("near");
    expect(row("~/.local/share/tack/releases/r1/").getAttribute("data-ink")).toBe("far");
    expect(row("~/.local/share/tack/hold").getAttribute("data-ink")).toBe("dim");
    expect(arrows()).toEqual(["out", "out"]);
    await click(row("~/.local/bin/tack"));
    expect(new URLSearchParams(window.location.search).get("reader.disk.pin")).toBe(
      "~/.local/bin/tack",
    );
    expect(container.textContent).toContain("Resolves through 2");
    await click(button("~/.local/share/tack/current"));
    expect(row("~/.local/share/tack/current").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("Pointed at by 1");
    expect(interactionContext(figure()).readable).toContain(
      "View: pinned ~/.local/share/tack/current",
    );
    await fire(
      row("~/.local/share/tack/current"),
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(window.location.search).toBe("");
    await fire(
      row("~/.local/share/tack/hold"),
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(row("~/.local/share/tack/hold").getAttribute("data-pinned")).toBe("");
    await fire(
      row("~/.local/share/tack/hold"),
      new KeyboardEvent("keydown", { key: "a", bubbles: true }),
    );
    await click(container.querySelector("svg.tack-tree") ?? figure());
    expect(window.location.search).toBe("");
  });

  it("previews an entry while hovered or focused and fades the arrows it is not on", async () => {
    await render({ ...props, summary: "Eleven entries under ~/.local." });
    expect(container.querySelector(".tack-figure-summary")?.textContent).toBe(
      "Eleven entries under ~/.local.",
    );
    const target = row("~/.local/share/tack/releases/r1/bin/tack");
    await fire(target, new MouseEvent("mouseover", { bubbles: true }));
    expect(target.getAttribute("data-ink")).toBe("focus");
    expect(row("~/.local/bin/tack").getAttribute("data-ink")).toBe("near");
    await fire(target, new MouseEvent("mouseout", { bubbles: true }));
    expect(target.getAttribute("data-ink")).toBeNull();
    const hold = row("~/.local/share/tack/hold");
    await act(async () => hold.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(hold.getAttribute("data-ink")).toBe("focus");
    expect(arrows()).toEqual(["fade", "fade"]);
    await act(async () => hold.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(hold.getAttribute("data-ink")).toBeNull();
    expect(arrows()).toEqual(["rest", "rest"]);
  });

  it("names a pinned entry's size, and draws a link to an entry above it upward", async () => {
    await render({
      id: "up",
      title: "A link can point back up the tree",
      source: ["top/  [2 MB]", "  data/", "    latest -> ../  # the newest"].join("\n"),
    });
    const arrow = container.querySelector(".tack-tree-arrows path")?.getAttribute("d") ?? "";
    const start = Number(/^M [\d.]+ ([\d.]+)/.exec(arrow)?.[1]);
    const lane = Number(/ V ([\d.]+)/.exec(arrow)?.[1]);
    expect(lane).toBeLessThan(start);
    await click(row("top/"));
    const details = container.querySelector(".tack-figure-panel")?.textContent ?? "";
    expect(details).toContain("2 MB");
  });

  it("switches moments with a lens: present entries solid, the others stamped absent, the lens in the URL", async () => {
    await render(props);
    await click(button("During an update"));
    expect(window.location.search).toBe("?reader.disk.case=during");
    expect(row("~/.local/share/tack/staging/").getAttribute("data-temp")).toBe("present");
    expect(row("~/.local/share/tack/hold").getAttribute("data-temp")).toBe("absent");
    expect(row("~/.local/share/tack/hold").querySelector(".tack-tree-stamp")?.textContent).toBe(
      "absent",
    );
    expect(container.textContent).toContain("staging/ exists.");
    expect(interactionContext(figure()).state).toEqual({
      disk: { pin: null, case: "during", step: null },
    });
    expect(interactionContext(figure()).readable).toContain("View: lens During an update");
    await click(button("During an update"));
    expect(row("~/.local/share/tack/hold").getAttribute("data-temp")).toBe("sometimes");
  });

  it("restores a lens from the URL and fades what it does not focus", async () => {
    window.history.replaceState(null, "", "/tree?reader.disk.case=focused");
    await render({
      ...props,
      lenses: [
        {
          id: "focused",
          label: "Focused",
          note: "Only hold.",
          focus: ["~/.local/share/tack/hold"],
        },
      ],
    });
    expect(row("~/.local/share/tack/hold").getAttribute("data-ink")).toBe("near");
    expect(row("~/.local/share/tack/current").getAttribute("data-ink")).toBe("dim");
  });

  it("renders what it can and lists the same issues the figure check prints", async () => {
    const broken = { ...props, title: "Disk", source: `${source}\n   odd` };
    await render(broken);
    const listed = [...container.querySelectorAll(".tack-figure-issues li")].map(
      (item) => item.textContent,
    );
    expect(listed).toEqual(fileTreeIssues(broken).map(issueLine));
    expect(listed).toHaveLength(2);
    expect(container.querySelectorAll("svg.tack-tree g.tack-tree-row")).toHaveLength(12);
  });
});
