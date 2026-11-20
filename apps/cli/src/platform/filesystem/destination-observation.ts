import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { Destination } from "../../services/destination.ts";
import { type DestinationObservation } from "../../domain/reconciliation/destination-observation-schema.ts";

const isNotFound = (error: PlatformError.PlatformError) => {
  return error.reason._tag === "NotFound";
};

const entryType = (type: FileSystem.File.Type): "directory" | "file" | "special" => {
  if (type === "Directory") {
    return "directory";
  }
  return type === "File" ? "file" : "special";
};

/** Builds destination observation against explicit platform services. */
export const makeDestinationService = (fileSystem: FileSystem.FileSystem, path: Path.Path) => {
  const realDirectory = (
    directoryPath: string,
    missingSegments: ReadonlyArray<string>,
  ): Effect.Effect<string> =>
    fileSystem.realPath(directoryPath).pipe(
      Effect.map((realPath) => path.join(realPath, ...missingSegments)),
      Effect.catch((error) => {
        const parent = path.dirname(directoryPath);
        // An unreadable ancestor keeps its lexical spelling; observing it reports the failure.
        return isNotFound(error) && parent !== directoryPath
          ? realDirectory(parent, [path.basename(directoryPath), ...missingSegments])
          : Effect.succeed(path.join(directoryPath, ...missingSegments));
      }),
    );

  return Destination.of({
    linkDirectory: (directoryPath) => realDirectory(directoryPath, []),
    observe: Effect.fnUntraced(function* (
      destinationPath: string,
    ): Effect.fn.Return<DestinationObservation> {
      const link = yield* fileSystem.readLink(destinationPath).pipe(
        Effect.map((rawTarget) => ({ rawTarget }) as const),
        Effect.catch((error) => Effect.succeed({ error } as const)),
      );

      if ("rawTarget" in link) {
        if (path.isAbsolute(link.rawTarget) === true) {
          return { _tag: "absolute-link", destinationPath, rawTarget: link.rawTarget };
        }
        // The OS resolves relative link text from the real directory containing the link, which
        // differs from its lexical parent when an ancestor is itself a symbolic link.
        const canonical = yield* fileSystem.realPath(destinationPath).pipe(
          Effect.map((canonicalTarget) => ({ canonicalTarget }) as const),
          Effect.catch((error) => Effect.succeed({ error } as const)),
        );
        return "canonicalTarget" in canonical
          ? {
              _tag: "relative-link",
              canonicalTarget: canonical.canonicalTarget,
              destinationPath,
              rawTarget: link.rawTarget,
            }
          : {
              _tag: "unresolved-relative-link",
              destinationPath,
              message: canonical.error.message,
              rawTarget: link.rawTarget,
            };
      }

      if (isNotFound(link.error)) {
        return { _tag: "absent", destinationPath };
      }

      const stat = yield* fileSystem.stat(destinationPath).pipe(
        Effect.map((info) => ({ info }) as const),
        Effect.catch((error) => Effect.succeed({ error } as const)),
      );
      if ("info" in stat) {
        return { _tag: "entry", destinationPath, entryType: entryType(stat.info.type) };
      }
      return isNotFound(stat.error)
        ? { _tag: "absent", destinationPath }
        : {
            _tag: "access-failed",
            destinationPath,
            message: stat.error.message,
            operation: "stat",
          };
    }),
  });
};

/** Provides destination observation over the Effect filesystem and path services. */
export const DestinationLive = Layer.effect(
  Destination,
  Effect.gen(function* () {
    return makeDestinationService(yield* FileSystem.FileSystem, yield* Path.Path);
  }),
);
