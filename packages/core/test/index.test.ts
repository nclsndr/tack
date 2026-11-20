import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { packageName } from "../src/index.ts";

describe("core package", () => {
  it.effect("exposes its workspace identity", () =>
    Effect.sync(() => {
      expect(packageName).toBe("@tackup/core");
    }),
  );
});
