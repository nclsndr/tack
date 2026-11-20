import { booleanFlag } from "./flag-utils.ts";

/** Explicit opt-in to the version 1 machine envelope. */
export const jsonFlag = booleanFlag(
  "json",
  "Print the version 1 JSON envelope; only status, sync, doctor, upgrade and version have a stable payload",
);
