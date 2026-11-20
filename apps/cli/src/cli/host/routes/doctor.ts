import { Effect } from "effect";
import { runDoctor } from "../../../features/doctor/doctor.ts";
import { HostConfigurationError } from "../errors.ts";
import { doctorOutcome } from "../outcomes.ts";
import type { RoutesFor } from "./route.ts";

/** The machine-wide health report of the operator's home and the selected state; it changes nothing. */
export const doctorRoutes: RoutesFor<"doctor"> = {
  doctor: {
    needsHome: true,
    run: (_invocation, stateOptions) =>
      Effect.gen(function* () {
        const home = stateOptions.homeDirectory;
        // Coverage skip: the host supplies a home to every route that needs one; this narrows it.
        /* v8 ignore next -- @preserve */
        if (home === undefined)
          return yield* new HostConfigurationError({
            code: "home-directory-unavailable",
            message: "The operator home directory is unavailable.",
          });
        return doctorOutcome(yield* runDoctor(stateOptions, home));
      }),
  },
};
