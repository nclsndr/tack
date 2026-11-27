import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { describeContracts } from "../src/cli/commands/manifest.test-support.ts";
import { MutationModeSchema, type MutationMode } from "../src/cli/commands/operation-contract.ts";
import { operationMap } from "../src/cli/human/help-map.ts";

const contracts = describeContracts([]).pipe(Effect.provide(BunServices.layer));

it.effect("lists every executable operation once, with the mode the command tree declares", () =>
  Effect.gen(function* () {
    const { commands } = yield* contracts;
    const mapped = operationMap.flatMap(({ rows }) =>
      rows.flatMap(({ operations, mode }) =>
        operations.map((operation): readonly [string, MutationMode] => [operation, mode]),
      ),
    );
    expect(mapped.map(([operation]) => operation).toSorted()).toEqual(
      commands.map(({ command }) => command).toSorted(),
    );
    for (const [operation, mode] of mapped) {
      const contract = commands.find(({ command }) => command === operation);
      expect(mode, operation).toBe(contract?.mutation);
    }
  }),
);

it("uses every mode the legend describes", () => {
  const used = new Set(operationMap.flatMap(({ rows }) => rows.map(({ mode }) => mode)));
  expect(used).toEqual(new Set(MutationModeSchema.literals));
});

it("spells each row's usage with the command path it covers", () => {
  for (const { rows } of operationMap)
    for (const { operations, usage } of rows)
      expect(
        usage.startsWith(operations[0]?.split(" ")[0] ?? ""),
        `${usage} starts with the command word of ${operations[0]}`,
      ).toBe(true);
});
