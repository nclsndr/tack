import { Effect, Layer } from "effect";
import {
  builtInsRoot,
  compiledRelease,
  installKind,
  linkedBuiltIns,
  packageRun,
  pruneBuiltIns,
} from "../../release.ts";
import { crashAtVariable, Installation } from "../../services/installation.ts";
import { currentVersionReport } from "../../version.ts";

/** The facts of the process's own install, read from `release.ts`. */
export const InstallationLive = Layer.succeed(Installation, {
  kind: installKind(),
  // Coverage skip: only the packaged bundle, which the package gate runs, keeps built-ins copies.
  /* v8 ignore start -- @preserve */
  ...(packageRun === true
    ? {
        pruneBuiltIns: ({ home, environment, folders }) =>
          Effect.sync(() => {
            const root = builtInsRoot(environment, home);
            if (root === undefined) return;
            pruneBuiltIns(root, currentVersionReport().stamp, linkedBuiltIns(root, folders));
          }).pipe(Effect.ignore),
      }
    : {}),
  /* v8 ignore stop -- @preserve */
  crashPoint: (step) =>
    Effect.sync(() => {
      // A compiled release ignores the crash hook; only source runs under test set it.
      if (compiledRelease === false && process.env[crashAtVariable] === step)
        process.kill(process.pid, "SIGKILL");
    }),
});
