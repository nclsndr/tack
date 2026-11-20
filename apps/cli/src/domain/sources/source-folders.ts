/** The resource keys `source add` declares from a flag of the same name: every one but `scripts`. */
export const sourceFolderKeys = ["skills", "commands", "context", "docs"] as const;

/** One resource key `source add` declares from its flag. */
export type SourceFolderKey = (typeof sourceFolderKeys)[number];

/** The folders `source add` declares, by resource key, each relative to the source as typed. */
export type SourceFolders = { readonly [Key in SourceFolderKey]: ReadonlyArray<string> };
