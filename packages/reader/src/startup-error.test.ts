import { describe, expect, it } from "vitest";
import { readerStartupError } from "./startup-error.ts";

describe("reader startup error translation", () => {
  it.each([
    new Error("[rsbuild:server] Port 4173 is occupied, please choose another one."),
    new Error(
      "\u001b[2m[rsbuild:server]\u001b[22m Port \u001b[33m4173\u001b[39m is occupied, please choose another one.",
    ),
    new Error(
      "[rsbuild:server] Failed to find an available port after 2 attempts, starting from 4173.",
    ),
    Object.assign(new Error("listen failed"), { code: "EADDRINUSE" }),
  ])("classifies the strict-port failure without exposing the vendor stack", (error) => {
    expect(readerStartupError(error, 4173)).toMatchObject({
      name: "ReaderPortInUseError",
      port: 4173,
      message: expect.stringContaining("Reader port 4173 is already in use."),
    });
    expect(readerStartupError(error, 4173)).toMatchObject({
      message: expect.stringContaining("--port"),
    });
  });

  it.each([
    new Error("port in use while loading a plugin"),
    new Error("[rsbuild:server] Port 9999 is occupied, please choose another one."),
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    new TypeError("Unexpected plugin failure", { cause: new Error("Plugin cause") }),
    "unexpected rejection",
    undefined,
  ])("preserves unknown failures and their diagnostics unchanged", (error) => {
    expect(readerStartupError(error, 4173)).toBe(error);
  });
});
