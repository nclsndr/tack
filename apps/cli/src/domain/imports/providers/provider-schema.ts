import { Schema } from "effect";
import { providerNameProblem, splitLocation } from "./provider.ts";
import { isRegisteredProvider } from "./registry.ts";

/**
 * The name of a provider this release registers. The list is the registry's, so a new provider
 * needs no edit here.
 */
export const RegisteredProviderSchema = Schema.String.check(
  Schema.makeFilter((name: string) =>
    isRegisteredProvider(name) ? [] : [`"${name}" is not a registered import provider.`],
  ),
);

/** How a location was reached. Its values belong to the provider, so any lowercase word decodes. */
export const TransportSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/));

/**
 * A record's canonical location, `<provider>:<text>`: checked by shape, not against the providers
 * this release knows, so a record from a newer release still decodes.
 */
export const RecordLocationSchema = Schema.String.check(
  Schema.makeFilter((location: string) => {
    const colon = location.indexOf(":");
    if (colon === -1 || colon === location.length - 1)
      return ["A location is written <provider>:<text>."];
    const problem = providerNameProblem(splitLocation(location).provider);
    return problem === undefined ? [] : [problem];
  }),
);
