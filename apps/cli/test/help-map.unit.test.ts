import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { describeContracts } from "../src/cli/commands/manifest.test-support.ts";
import { mapModes, operationMap, type MapMode } from "../src/cli/host/human/help-map.ts";

const modeOf: Record<string, MapMode> = {
  "read-only": "read",
  immediate: "now",
  "preview-apply": "plan",
  execute: "run",
  conditional: "conditional",
};

const contracts = describeContracts([]).pipe(Effect.provide(BunServices.layer));

it.effect("lists every executable operation once, with the mode the command tree declares", () =>
  Effect.gen(function* () {
    const { commands } = yield* contracts;
    const mapped = operationMap.flatMap(({ rows }) =>
      rows.flatMap(({ operations, mode }) =>
        operations.map((operation): readonly [string, MapMode] => [operation, mode]),
      ),
    );
    expect(mapped.map(([operation]) => operation).toSorted()).toEqual(
      commands.map(({ command }) => command).toSorted(),
    );
    for (const [operation, mode] of mapped) {
      const contract = commands.find(({ command }) => command === operation);
      expect(mode, operation).toBe(modeOf[contract?.mutation ?? ""]);
    }
  }),
);

it("describes every mode a row uses in the legend, and nothing else", () => {
  const used = new Set(operationMap.flatMap(({ rows }) => rows.map(({ mode }) => mode)));
  expect(new Set(mapModes.map(([mode]) => mode))).toEqual(used);
});

it("spells each row's usage with the command path it covers", () => {
  for (const { rows } of operationMap)
    for (const { operations, usage } of rows)
      expect(
        usage.startsWith(operations[0]?.split(" ")[0] ?? ""),
        `${usage} starts with the command word of ${operations[0]}`,
      ).toBe(true);
});
