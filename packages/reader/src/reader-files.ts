import { fileURLToPath } from "node:url";

// A package build inlines the reader into bundles and names, relative to each bundle, the directory
// that holds the reader's own files, and the extension of its prebuilt process entry points.
// oxlint-disable-next-line eslint/no-underscore-dangle -- The package build injects this constant by its reserved name.
declare const __TACK_READER_DIR__: string | undefined;
// oxlint-disable-next-line eslint/no-underscore-dangle -- The package build injects this constant by its reserved name.
declare const __TACK_READER_ENTRY_EXTENSION__: string | undefined;

/**
 * The reader's directory: beside the package's bundle, or beside its sources in any other run. It is
 * resolved on first use, because a compiled release cannot resolve the reader package at all.
 */
const base = () =>
  typeof __TACK_READER_DIR__ === "string"
    ? new URL(__TACK_READER_DIR__, import.meta.url)
    : import.meta.resolve("@tackup/reader");

/** One file the reader ships for Rspack to compile at serve time: a module, stylesheet or source. */
export const readerFile = (name: string): string => fileURLToPath(new URL(name, base()));

/** A reader process entry point: TypeScript in a source run, prebuilt JavaScript in a package. */
export const readerEntry = (stem: "engine" | "watcher"): string =>
  readerFile(
    `${stem}${typeof __TACK_READER_ENTRY_EXTENSION__ === "string" ? __TACK_READER_ENTRY_EXTENSION__ : ".ts"}`,
  );
