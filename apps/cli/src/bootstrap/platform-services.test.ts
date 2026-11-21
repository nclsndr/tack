import { expect, it } from "@effect/vitest";
import { Option, type Terminal } from "effect";
import { endsKeyInput } from "./platform-services.ts";

const pressed = (name: string, ctrl = false): Terminal.UserInput => ({
  input: Option.none(),
  key: { name, ctrl, meta: false, shift: false },
});

it("ends key input on Ctrl+C and Ctrl+D only", () => {
  expect(endsKeyInput(pressed("c", true))).toBe(true);
  expect(endsKeyInput(pressed("d", true))).toBe(true);
  expect(endsKeyInput(pressed("c"))).toBe(false);
  expect(endsKeyInput(pressed("q"))).toBe(false);
});

it("leaves Esc to the explorer, which clears a filter, closes a menu or goes back with it", () => {
  expect(endsKeyInput(pressed("escape"))).toBe(false);
});
