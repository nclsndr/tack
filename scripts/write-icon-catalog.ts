#!/usr/bin/env bun
// Writes the reader's docs icon catalog from the curated icons and the installed lucide-react.
// A test fails until the shipped file matches; run `bun run icons:catalog`.
import { join } from "node:path";
import {
  iconCatalogSource,
  readLucidePackage,
} from "../packages/reader/src/icons/catalog-builder.ts";
import { curatedIcons } from "../packages/reader/src/icons/curated.ts";

const target = join(import.meta.dirname, "../packages/reader/src/icons/catalog.generated.ts");
await Bun.write(target, iconCatalogSource(curatedIcons, await readLucidePackage()));
console.log(`Wrote ${target}`);
