import { Result } from "effect";
import {
  refuse,
  type ImportProvider,
  type ProviderLocation,
} from "../../src/domain/imports/providers/provider.ts";

const located = (text: string, transport: string): ProviderLocation => {
  const [repository = "", scope] = text.split("//");
  return { repository, transport, ...(scope === undefined || scope === "" ? {} : { scope }) };
};

/**
 * A second provider for tests, shaped differently from GitHub on purpose: nested groups in the
 * repository, `//` before the folder, case-sensitive identity, no abbreviated-commit refusal. It
 * proves a provider is an adapter and a registry entry, with no edit to the core.
 */
export const forgeProvider: ImportProvider = {
  name: "forge",
  hosts: ["forge.example"],
  shorthandForm: "forge:org/repo[//folder][#ref]",
  parseText: (text) =>
    text.length === 0
      ? refuse("location-unsupported", "Write the location as forge:org/repo[//folder][#ref].")
      : Result.succeed(located(text, "https")),
  parseUrl: (url) =>
    url.path.length === 0
      ? refuse("location-unsupported", "Write the forge URL as https://forge.example/owner/repo.")
      : Result.succeed(located(url.path.replace(/\.git$/, ""), url.kind)),
  refRefusal: () => undefined,
  canonicalText: (facts) =>
    `${facts.repository}${facts.scope === undefined ? "" : `//${facts.scope}`}${
      facts.ref === undefined ? "" : `#${facts.ref}`
    }`,
  sameRepository: (left, right) => left === right,
  remote: (location) => ({
    url: `https://forge.example/${location.repository}.git`,
    protocols: ["https"],
    fixturePath: location.repository,
    authenticationHelp: "Sign in to forge.example with a git credential helper.",
  }),
};
