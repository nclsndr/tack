import { Config, ConfigProvider, Effect, Option } from "effect";
import type { StateOptions } from "../../services/state-store.ts";
import { HostConfigurationError } from "./errors.ts";
import { HostEnvironment } from "./host-environment.ts";

/**
 * The state options the host reads from its environment: the state directory from `--state-dir`
 * (`stateDirectory`) or `TACK_STATE_DIR`, and `HOME`, which default state needs and which
 * `homeWhenConfigured` asks for even when a state directory is set.
 */
export const hostStateOptions = Effect.fnUntraced(function* (
  stateDirectory: string | undefined,
  homeWhenConfigured: boolean,
) {
  const hostEnvironment = yield* HostEnvironment;
  const provider = ConfigProvider.fromEnv({
    env: Object.fromEntries(
      Object.entries(hostEnvironment).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    ),
    preserveEmptyStrings: true,
  });
  const environmentStateDirectory = yield* Config.String("TACK_STATE_DIR")
    .pipe(Config.option)
    .parse(provider)
    .pipe(
      Effect.mapError(
        // Coverage skip: an optional string read from the environment cannot fail to decode.
        /* v8 ignore next -- @preserve */
        () =>
          new HostConfigurationError({
            code: "state-directory-environment-invalid",
            message: "The state-directory environment value is invalid.",
          }),
      ),
    );
  const configuredStateDirectory =
    stateDirectory ?? Option.getOrUndefined(environmentStateDirectory);
  const needsHome = configuredStateDirectory === undefined || homeWhenConfigured;
  const located: StateOptions =
    configuredStateDirectory === undefined ? {} : { stateDirectory: configuredStateDirectory };
  if (needsHome === false) return located;
  const homeDirectory = yield* Config.String("HOME")
    .parse(provider)
    .pipe(
      Effect.mapError(
        () =>
          new HostConfigurationError({
            code: "home-directory-unavailable",
            message: "The operator home directory is unavailable.",
          }),
      ),
    );
  return { ...located, homeDirectory } satisfies StateOptions;
});
