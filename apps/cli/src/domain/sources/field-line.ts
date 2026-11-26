import { isMap, isNode, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

/** The keys and indexes a field names: `skills[1].exclude` is `skills`, `1`, `exclude`. */
const segmentsOf = (field: string) =>
  [...field.matchAll(/\[(\d+)\]|[^.[\]]+/g)].map((match) =>
    match[1] === undefined ? match[0] : Number(match[1]),
  );

/** Where a key or an item of `node` starts in the text, and the node it holds. */
const childOf = (node: unknown, segment: string | number) => {
  if (typeof segment === "number" && isSeq(node) === true) {
    const item = node.items[segment];
    return isNode(item) === true && item.range !== undefined && item.range !== null
      ? { start: item.range[0], node: item }
      : undefined;
  }
  if (typeof segment === "string" && isMap(node) === true) {
    // A repeated key keeps its last value when Tack parses the text, so it anchors there too.
    const pair = node.items.findLast(
      (candidate) => isScalar(candidate.key) === true && candidate.key.value === segment,
    );
    return isScalar(pair?.key) === true && pair.key.range !== undefined && pair.key.range !== null
      ? { start: pair.key.range[0], node: pair.value }
      : undefined;
  }
  return undefined;
};

/**
 * The one-based line of `field`, such as `skills[1]` or `maintainers[0]`, in a YAML or JSON
 * declaration's text: the line of its deepest key or item the text holds. A field the text does
 * not hold at all, no field, and text that does not parse anchor at line 1.
 */
export const fieldLine = (text: string, field: string | undefined) => {
  if (field === undefined) return 1;
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, uniqueKeys: false });
  if (document.errors.length > 0) return 1;
  const found = segmentsOf(field).reduce<{ node: unknown; start?: number; open: boolean }>(
    (walk, segment) => {
      if (walk.open === false) return walk;
      const child = childOf(walk.node, segment);
      return child === undefined
        ? { ...walk, open: false }
        : { node: child.node, start: child.start, open: true };
    },
    { node: document.contents, open: true },
  );
  return found.start === undefined ? 1 : lineCounter.linePos(found.start).line;
};
