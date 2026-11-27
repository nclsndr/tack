import { expect, it } from "vitest";
import {
  colorEnabled,
  jsonRequestInArguments,
  resolveOutputFormat,
  type TerminalContextShape,
} from "./terminal-context.ts";

const terminal = (overrides: Partial<TerminalContextShape> = {}): TerminalContextShape => ({
  columns: 80,
  environment: { TERM: "xterm-256color" },
  stdinIsTerminal: true,
  stdoutIsTerminal: true,
  ...overrides,
});

it("defaults to human output", () => {
  expect(resolveOutputFormat(false)).toEqual({ format: "human", reason: "default" });
});

it("uses only the explicit JSON flag, including on invalid invocations", () => {
  expect(resolveOutputFormat(true)).toEqual({ format: "json", reason: "flag" });
  expect(jsonRequestInArguments(["--json", "catalog", "--bogus"])).toBe(true);
  expect(jsonRequestInArguments(["catalog", "--", "--json"])).toBe(false);
});

it("keeps ANSI escapes out of pipes and NO_COLOR terminals", () => {
  expect(colorEnabled(terminal({ stdoutIsTerminal: false }))).toBe(false);
  expect(
    colorEnabled(terminal({ environment: { TERM: "xterm", NO_COLOR: "1", FORCE_COLOR: "1" } })),
  ).toBe(false);
  expect(
    colorEnabled(terminal({ stdoutIsTerminal: false, environment: { FORCE_COLOR: "1" } })),
  ).toBe(true);
});
