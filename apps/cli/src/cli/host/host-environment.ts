import { Context } from "effect";

/** The environment variables the host reads, such as `HOME` and `TACK_STATE_DIR`. */
export type HostEnvironmentShape = Readonly<Record<string, string | undefined>>;

/**
 * The environment the host reads its configuration from. It defaults to the live `process.env`
 * object, so a change to it is seen by the next invocation; a host without a process environment,
 * such as the in-memory browser build, provides its own record.
 */
export const HostEnvironment = Context.Reference<HostEnvironmentShape>(
  "tack/cli/cli/host/host-environment/HostEnvironment",
  {
    defaultValue: () =>
      (globalThis as { readonly process?: { readonly env: HostEnvironmentShape } }).process?.env ??
      {},
  },
);
