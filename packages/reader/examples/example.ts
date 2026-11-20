import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReaderProjectInput } from "../src/types.ts";

/** The root of Atlas, the fake project whose docs exercise every part of the reader. */
export const exampleRoot = fileURLToPath(new URL("./atlas", import.meta.url));

/**
 * The project input the CLI would pass the reader for Atlas: two docs resources declared by its
 * `tack.yaml`, and a third, `ops / runbooks`, whose source is unavailable. With the deliberately
 * broken draft, it makes the issue popover show both kinds of issue.
 */
export function exampleInput(): ReaderProjectInput {
  const source = { sourceRegistrationId: "atlas", sourcePath: exampleRoot };
  const declaration = { kind: "source", path: join(exampleRoot, "tack.yaml") } as const;
  return {
    project: { name: "atlas", root: exampleRoot },
    resources: [
      {
        ...source,
        name: "specs",
        directoryPath: join(exampleRoot, "docs"),
        readerConfig: declaration,
      },
      {
        ...source,
        name: "handbook",
        directoryPath: join(exampleRoot, "handbook"),
        readerConfig: declaration,
      },
    ],
    issues: [
      {
        resource: { sourceRegistrationId: "ops", name: "runbooks" },
        sourcePath: join(exampleRoot, "..", "ops"),
        code: "docs-resource-unavailable",
        message: "The registered source is unavailable: its checkout is missing.",
      },
    ],
    defaultWritingResource: { sourceRegistrationId: "atlas", name: "specs" },
  };
}

/**
 * The port `serve.ts` listens on: `--port N` or `--port=N`, else 4317, away from the 4173 a real
 * `tack docs serve` uses. Port 0 picks a free port.
 */
export function examplePort(argv: readonly string[]): number {
  const flag = argv.findIndex(
    (argument) => argument === "--port" || argument.startsWith("--port="),
  );
  if (flag === -1) return 4317;
  const flagValue = argv[flag] ?? "";
  const text = flagValue.includes("=") ? flagValue.slice("--port=".length) : argv[flag + 1];
  const port = Number(text);
  if (text === undefined || /^\d+$/.test(text) === false || port > 65535)
    throw new Error("--port takes a port number from 0 to 65535");
  return port;
}
