import { Effect, FileSystem } from "effect";
import {
  type InspectedStateFormat,
  stateFormatOfPrefix,
  stateFormatPrefixLength,
} from "../../domain/state/state-format.ts";

/**
 * Reads what a state file's first field says without decoding the rest. A missing file does not
 * exist; any other failure to open or read it is an existing file of no known format.
 */
export const inspectStateFormat = (statePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.scoped(
      fileSystem
        .open(statePath)
        .pipe(Effect.flatMap((file) => file.readAlloc(stateFormatPrefixLength))),
    ).pipe(
      Effect.map((read): InspectedStateFormat =>
        stateFormatOfPrefix(read._tag === "Some" ? read.value : new Uint8Array()),
      ),
      Effect.catch((error) =>
        Effect.succeed<InspectedStateFormat>({
          exists: error.reason._tag !== "NotFound",
          format: null,
        }),
      ),
    );
  });
