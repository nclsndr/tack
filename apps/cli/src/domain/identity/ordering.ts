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
