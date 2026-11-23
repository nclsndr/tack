import { describe, expect, it } from "vitest";
import { PlatformError } from "effect";
import { fileAccessFailure } from "./file-access.ts";

const system = (
  tag: PlatformError.SystemErrorTag,
  extra: { readonly pathOrDescriptor?: string | number; readonly description?: string } = {},
) => PlatformError.systemError({ _tag: tag, module: "FileSystem", method: "stat", ...extra });

describe("fileAccessFailure", () => {
  it("names the path the call reported and explains a known reason", () => {
    expect(fileAccessFailure(system("PermissionDenied", { pathOrDescriptor: "/a" }), "/b")).toEqual(
      {
        path: "/a",
        reason: "PermissionDenied",
        operation: "stat",
        explanation: "permission is denied",
      },
    );
  });

  it("falls back to the caller's path when the call reported none", () => {
    expect(fileAccessFailure(system("NotFound"), "/b").path).toBe("/b");
    expect(
      fileAccessFailure(PlatformError.badArgument({ module: "FileSystem", method: "open" }), "/b"),
    ).toEqual({
      path: "/b",
      reason: "BadArgument",
      operation: "open",
      explanation: "the path is not valid",
    });
  });

  it("gives the platform's description, or its reason, for a reason it does not explain", () => {
    expect(
      fileAccessFailure(system("Unknown", { pathOrDescriptor: 3, description: "EIO" }), "/b"),
    ).toMatchObject({ path: "3", explanation: "EIO" });
    expect(fileAccessFailure(system("TimedOut", { description: "" }), "/b").explanation).toBe(
      "the system reported TimedOut",
    );
    expect(fileAccessFailure(system("WouldBlock"), "/b").explanation).toBe(
      "the system reported WouldBlock",
    );
  });
});
