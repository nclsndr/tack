#!/usr/bin/env bun
// Writes the component reference of the built-in write-reader-figures skill from the reader's
// figure contracts. A test fails until the shipped file matches; run `bun run figures:reference`.
import { join } from "node:path";
import { figureReference } from "../packages/reader/src/figures/reference.ts";

const target = join(
  import.meta.dirname,
  "../apps/cli/src/builtins/skills/write-reader-figures/references/figure-components.md",
);
await Bun.write(target, figureReference());
console.log(`Wrote ${target}`);
