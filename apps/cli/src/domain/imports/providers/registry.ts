import { githubProvider } from "./github.ts";
import type { ImportProvider } from "./provider.ts";

/**
 * The one list of import providers. The plan's provider field, the record check, every
 * "Providers: ..." text, the help and the examples are derived from it, so a new provider is an
 * adapter and one entry here.
 */
export const importProviders: ReadonlyArray<ImportProvider> = [githubProvider];

/** The provider that registered `name`, compared without case. */
export const providerNamed = (
  name: string,
  providers: ReadonlyArray<ImportProvider> = importProviders,
): ImportProvider | undefined => providers.find((provider) => provider.name === name.toLowerCase());

/** The provider that serves `host`, compared without case. */
export const providerForHost = (
  host: string,
  providers: ReadonlyArray<ImportProvider> = importProviders,
): ImportProvider | undefined =>
  providers.find((provider) => provider.hosts.includes(host.toLowerCase()));

/** `github`, or `github, forge`: the provider names for a refusal. */
export const providerNamesText = (providers: ReadonlyArray<ImportProvider> = importProviders) =>
  providers.map((provider) => provider.name).join(", ");

/** `github (github.com)`: each provider with the hosts it serves. */
export const providerHostsText = (providers: ReadonlyArray<ImportProvider> = importProviders) =>
  providers.map((provider) => `${provider.name} (${provider.hosts.join(", ")})`).join(", ");

/** The shorthand form of every provider, for help and messages. */
export const shorthandFormsText = (providers: ReadonlyArray<ImportProvider> = importProviders) =>
  providers.map((provider) => provider.shorthandForm).join(" or ");

/** What a location argument accepts, for help: every provider's shorthand and URL forms. */
export const locationHelpText = (providers: ReadonlyArray<ImportProvider> = importProviders) =>
  `A location that names its provider: ${shorthandFormsText(providers)}, or ${providers
    .flatMap((provider) => provider.hosts)
    .map((host) => `an https://${host}/... URL or git@${host}:...`)
    .join(", or ")}. Providers: ${providerNamesText(providers)}`;

/** A location to show in examples, written with the first provider's prefix. */
export const exampleLocation = (providers: ReadonlyArray<ImportProvider> = importProviders) =>
  `${providers[0]?.name ?? ""}:anthropics/skills`;

/** Whether `name` is registered; the plan's provider field accepts exactly these. */
export const isRegisteredProvider = (name: string): boolean =>
  importProviders.some((provider) => provider.name === name);
