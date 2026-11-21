import { describe, expect, it } from "vitest";
import { makeDemoSession, shellWords } from "../../demo/demo-shell.ts";
import { also, steps } from "./content.ts";

/** Every `tack` command line the features page shows a visitor. */
const shownCommands = [
  ...steps.flatMap((step) => [...step.run, ...(step.elsewhere?.run ?? [])]),
  ...also.items.map((item) => item.proof),
].filter((line) => line.startsWith("tack "));

/**
 * The words of a Tack command before the script arguments that follow a lone `--`, without the
 * leading `tack`.
 */
const tackWords = (line: string) => {
  const words = shellWords(line).slice(1);
  const end = words.indexOf("--");
  return end === -1 ? words : words.slice(0, end);
};

const escape = String.fromCharCode(27);
const plain = (text: string) => text.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");

/**
 * The help Tack prints for the longest run of a line's leading words it accepts with `--help`,
 * and the command path its header names. Some commands refuse `--help` after their arguments, so
 * shorter runs are tried until one is accepted.
 */
const commandHelp = async (session: ReturnType<typeof makeDemoSession>, line: string) => {
  const words = tackWords(line);
  const firstFlag = words.findIndex((word) => word.startsWith("-"));
  const leading = firstFlag === -1 ? words : words.slice(0, firstFlag);
  const lengths = Array.from({ length: leading.length }, (_, index) => leading.length - index);
  return lengths.reduce<Promise<{ path: string; help: string } | undefined>>(
    async (earlier, length) => {
      const settled = await earlier;
      if (settled !== undefined) return settled;
      const result = await session.run(`tack ${leading.slice(0, length).join(" ")} --help`, 120);
      if (result.exitCode !== 0) return undefined;
      const help = plain(result.output);
      const path = /^tack help · (.+?) · /u.exec(help)?.[1];
      return path === undefined ? undefined : { path, help };
    },
    Promise.resolve(undefined),
  );
};

describe("features page commands", () => {
  it("shows at least one Tack command per step", () => {
    expect(
      steps.filter((step) => step.run.some((line) => line.startsWith("tack ")) === false),
    ).toEqual([]);
  });

  it("shows each terminal under the command that printed it, one the step runs", () => {
    expect(
      steps.flatMap((step) =>
        step.output === undefined ||
        [...step.run, ...(step.elsewhere?.run ?? [])].includes(step.output.command) === true
          ? []
          : [step.id],
      ),
    ).toEqual([]);
  });

  it.each(shownCommands)("%s names a real command and only flags its help lists", async (line) => {
    const session = makeDemoSession();
    const found = await commandHelp(session, line);

    expect(found).toBeDefined();
    expect(
      tackWords(line)
        .join(" ")
        .startsWith(found?.path ?? "-"),
    ).toBe(true);
    const flags = tackWords(line)
      .filter((word) => word.startsWith("--"))
      .map((word) => word.split("=")[0] ?? word);
    expect(flags.filter((flag) => found?.help.includes(`${flag} `) !== true)).toEqual([]);
  });
});
