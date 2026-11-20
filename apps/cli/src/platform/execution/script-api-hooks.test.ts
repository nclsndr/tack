import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { scriptApiHook, scriptApiUrl } from "./script-api-hooks.ts";

it("provides the workspace's script API through Bun's virtual modules in a source run", () => {
  expect(fileURLToPath(scriptApiUrl)).toBe(
    fileURLToPath(new URL("../../../../../packages/core/src/script-api.ts", import.meta.url)),
  );
  expect(scriptApiHook()).toBe("bun-virtual-module");
});
