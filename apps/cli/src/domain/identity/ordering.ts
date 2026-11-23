import { Schema } from "effect";

/** Compares strings by JavaScript code units without locale-sensitive behavior. */
export const compareCodeUnits = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/** Returns one item per key in deterministic code-unit key order. */
export const sortAndDedupeBy = <A>(
  values: ReadonlyArray<A>,
  keyOf: (value: A) => string,
): ReadonlyArray<A> => {
  const seen = new Set<string>();
  return [...values]
    .sort((left, right) => compareCodeUnits(keyOf(left), keyOf(right)))
    .filter((value) => {
      const key = keyOf(value);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
};

/** Returns unique strings in deterministic code-unit order. */
export const sortAndDedupeStrings = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values)].sort(compareCodeUnits);

/** Whether the keys never go down in code-unit order. A repeated key keeps the order. */
export const isInCodeUnitOrder = (keys: ReadonlyArray<string>): boolean =>
  keys.every((key, index) => index === 0 || compareCodeUnits(keys[index - 1] ?? "", key) <= 0);

/**
 * Whether the keys strictly increase in code-unit order: each key once, in the order
 * `sortAndDedupeBy` returns.
 */
export const isSortedUnique = (keys: ReadonlyArray<string>): boolean =>
  keys.every((key, index) => index === 0 || compareCodeUnits(keys[index - 1] ?? "", key) < 0);

/**
 * What a `sortedUnique` check reports: one message for any breach, or one message for a repeated
 * key and another for a key out of order.
 */
export type SortedUniqueMessages =
  | string
  | { readonly duplicate: string; readonly unordered: string };

/**
 * The schema check for a collection that holds each key once, in code-unit key order: the check
 * twin of `sortAndDedupeBy`.
 */
export const sortedUnique = <A>(keyOf: (value: A) => string, messages: SortedUniqueMessages) =>
  Schema.makeFilter((values: ReadonlyArray<A>) => {
    const keys = values.map(keyOf);
    if (typeof messages === "string") {
      return isSortedUnique(keys) ? [] : [messages];
    }
    return [
      ...(new Set(keys).size === keys.length ? [] : [messages.duplicate]),
      ...(isInCodeUnitOrder(keys) ? [] : [messages.unordered]),
    ];
  });
