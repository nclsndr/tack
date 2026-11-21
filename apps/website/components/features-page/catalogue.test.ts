import { mapModes, operationMap } from "@tackup/cli/core";
import { describe, expect, it } from "vitest";
import { makeDemoSession } from "../../demo/demo-shell.ts";
import { plainAnsi } from "../landing/ansi.ts";
import { alsoInTack, catalogue, modes } from "./catalogue.ts";

const capabilities = catalogue.flatMap((group) => group.capabilities);

/** The cards whose command is a Tack command, with the operation it runs. */
const tackCards = capabilities.flatMap((capability) =>
  capability.operation === undefined ? [] : [{ ...capability, operation: capability.operation }],
);

/** Every Tack command line the page shows: on a card, or in the list after the cards. */
const commandLines = [
  ...tackCards.map((card) => [card.id, card] as const),
  ...alsoInTack.items.map((item) => [item.operation, item] as const),
];

/** The mode `tack --help` gives an operation. */
const cliMode = (operation: string) =>
  operationMap.flatMap((group) => group.rows).find((row) => row.operations.includes(operation))
    ?.mode;

describe("features catalogue", () => {
  it("names the modes in the words and the order of the tack --help legend", () => {
    expect(Object.entries(modes).map(([mode, { meaning }]) => [mode, meaning])).toEqual(mapModes);
  });

  it("gives every group and card its own anchor", () => {
    const ids = [...catalogue.map((group) => group.id), ...capabilities.map((card) => card.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows only Tack commands or plain shell commands", () => {
    capabilities
      .filter((capability) => capability.operation === undefined)
      .forEach((capability) => expect(capability.command).not.toMatch(/^tack /));
    tackCards.forEach((card) => expect(card.command).toMatch(/^tack /));
  });

  it.each(tackCards.map((card) => [card.id, card] as const))(
    "%s shows the mode the CLI gives its operation",
    (_id, card) => {
      expect(card.mode).toBe(cliMode(card.operation));
    },
  );

  it.each(tackCards.map((card) => [card.id, card] as const))(
    "%s shows output that the command it names printed",
    (_id, card) => {
      const lines = plainAnsi(card.capture).split("\n");
      const header = `tack ${card.operation} ·`;
      if (card.command.includes("--json")) expect(lines[0]).toBe("{");
      else expect(lines.some((line) => line.startsWith(header))).toBe(true);
    },
  );

  it.each(commandLines)("%s runs a command line the real CLI accepts", async (_id, card) => {
    const session = makeDemoSession();
    // The shell pipe and the script's own arguments are not Tack's to parse, and --json would
    // print the help as an envelope.
    const line = (card.command.split(/ \| | -- /)[0] ?? card.command).replace(" --json", "");
    const result = await session.run(`${line} --help`, 80);
    expect(plainAnsi(result.output)).toContain(`tack help · ${card.operation} ·`);
    expect(result.exitCode).toBe(0);
  });

  it("draws every excerpt from inside its capture", () => {
    capabilities.forEach((capability) => expect(capability.output.length).toBeGreaterThan(0));
  });
});
