import { Effect, FileSystem, Path } from "effect";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { ImportError } from "./import-error.ts";
import { unsafeRelativePath } from "./import-discovery.ts";
import {
  filesDigest,
  sha256Hex,
  type ImportRecordFile,
} from "../../domain/imports/import-record.ts";

/** One regular file of a skill folder, byte for byte, with its executable bit. */
export type SkillFile = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
};

/** The record entries and digest for a skill's files, as the imports section stores them. */
export const recordFilesOf = (files: ReadonlyArray<SkillFile>) => {
  const entries: ReadonlyArray<ImportRecordFile> = [...files]
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map((file) => ({
      path: file.path,
      sha256: sha256Hex(file.bytes),
      executable: file.executable,
    }));
  return { files: entries, digest: filesDigest(entries) };
};

/** Whether bytes look like text: no NUL in the first 8 KiB and valid UTF-8 throughout. */
export const isTextBytes = (bytes: Uint8Array): boolean => {
  if (bytes.subarray(0, 8000).includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * Writes files into a directory, refusing any path that could leave it. Bytes are written as
 * given, and the executable bit is made exact after the umask has had its say.
 */
export const writeSkillFiles = Effect.fnUntraced(function* (
  directory: string,
  files: ReadonlyArray<SkillFile>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  for (const file of files) {
    const unsafe = unsafeRelativePath(file.path);
    if (unsafe !== undefined)
      return yield* new ImportError({
        code: "import-write-failed",
        message: `Refusing to write ${JSON.stringify(file.path)}: ${unsafe}.`,
      });
    const target = path.join(directory, ...file.path.split("/"));
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFile(target, file.bytes, { mode: file.executable ? 0o755 : 0o644 });
    yield* fileSystem.chmod(target, file.executable ? 0o755 : 0o644);
  }
  return undefined;
});
