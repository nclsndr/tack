export { filterDocuments } from "./search.ts";

export type RenderedBlock = { id: string; file: string; version: string };
export type RenderedSelection = { readable: string; blocks: RenderedBlock[] };

const headingSelector = ":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6";

function leafBlocks(blocks: HTMLElement[]): HTMLElement[] {
  return blocks.filter(
    (element) => blocks.some((other) => other !== element && element.contains(other)) === false,
  );
}

/** Maps a rendered text range to the authored leaf blocks it actually intersects. */
export function collectSelection(
  selection: Selection | null,
  root: Element,
): RenderedSelection | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed === true)
    return null;
  const range = selection.getRangeAt(0);
  if (root.contains(range.commonAncestorContainer) === false) return null;
  const matches = Array.from(root.querySelectorAll<HTMLElement>("[data-source-id]")).filter(
    (element) => range.intersectsNode(element) === true,
  );
  const leaves = leafBlocks(matches);
  if (leaves.length === 0) return null;
  return {
    readable: selection.toString(),
    blocks: leaves.map((element) => ({
      id: element.dataset["sourceId"] ?? "",
      file: element.dataset["sourceFile"] ?? "",
      version: element.dataset["sourceVersion"] ?? "",
    })),
  };
}

/** Includes a heading's following semantic blocks until its next peer or ancestor heading. */
export function sectionIds(root: Element, id: string): string[] {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("[data-source-id]"));
  const start = blocks.findIndex((block) => block.dataset["sourceId"] === id);
  if (start === -1) return [];
  const heading = blocks[start]?.querySelector(headingSelector);
  const level = heading === null || heading === undefined ? 0 : Number(heading.tagName.slice(1));
  const end =
    level === 0
      ? start + 1
      : blocks.findIndex(
          (block, index) =>
            index > start &&
            Array.from(block.querySelectorAll(headingSelector)).some(
              (item) => Number(item.tagName.slice(1)) <= level,
            ),
        );
  return leafBlocks(blocks.slice(start, end === -1 ? undefined : end)).map(
    (block) => block.dataset["sourceId"] ?? "",
  );
}

/** Reuses optional readable exports and state without inspecting arbitrary React semantics. */
export function interactionContext(root: Element): {
  readable: string;
  state: Record<string, unknown>;
} {
  const elements = [
    ...(root.matches("[data-reader-readable],[data-reader-state]") === true ? [root] : []),
    ...Array.from(root.querySelectorAll("[data-reader-readable],[data-reader-state]")),
  ];
  return {
    readable: elements
      .map((element) => element.getAttribute("data-reader-readable") ?? "")
      .filter((value) => value.length > 0)
      .join("\n\n"),
    state: elements.reduce<Record<string, unknown>>((state, element) => {
      const serialized = element.getAttribute("data-reader-state");
      if (serialized === null) return state;
      try {
        const value: unknown = JSON.parse(serialized);
        return typeof value === "object" && value !== null && Array.isArray(value) === false
          ? { ...state, ...(element.id === "" ? value : { [element.id]: value }) }
          : state;
      } catch {
        return state;
      }
    }, {}),
  };
}
