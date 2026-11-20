import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { forgeProvider } from "../../../../test/support/forge-provider.ts";
import { ImportPlanSchema } from "../import-schema.ts";
import { githubProvider } from "./github.ts";
import { providerNameProblem, reservedSchemes, sameLocation, splitLocation } from "./provider.ts";
import {
  RecordLocationSchema,
  RegisteredProviderSchema,
  TransportSchema,
} from "./provider-schema.ts";
import {
  exampleLocation,
  importProviders,
  locationHelpText,
  providerForHost,
  providerHostsText,
  providerNamed,
  providerNamesText,
  shorthandFormsText,
} from "./registry.ts";
import { registryProblems } from "./registry.test-support.ts";

it("registers only usable providers", () => {
  expect(registryProblems(importProviders)).toEqual([]);
  expect(importProviders).toEqual([githubProvider]);
});

it("cannot register a URL scheme, a single letter or a malformed name", () => {
  for (const name of [...reservedSchemes, "a", "c", "GitHub", "1abc", "my_forge", "-forge", ""]) {
    expect(providerNameProblem(name), name).toBeDefined();
    expect(registryProblems([{ ...githubProvider, name, hosts: [] }]), name).toHaveLength(1);
  }
  for (const name of ["github", "gitlab", "my-forge", "forge2"])
    expect(providerNameProblem(name), name).toBeUndefined();
});

it("refuses a registry with two providers of one name or one host", () => {
  expect(registryProblems([githubProvider, { ...forgeProvider, name: "github" }])).toEqual([
    "Two providers are named github.",
  ]);
  expect(registryProblems([githubProvider, { ...forgeProvider, hosts: ["github.com"] }])).toEqual([
    "More than one provider serves github.com.",
  ]);
  expect(registryProblems([githubProvider, forgeProvider])).toEqual([]);
});

it("finds a provider by name and by host without case", () => {
  expect(providerNamed("GitHub")).toBe(githubProvider);
  expect(providerNamed("gitlab")).toBeUndefined();
  expect(providerForHost("GitHub.com")).toBe(githubProvider);
  expect(providerForHost("github.com:443")).toBeUndefined();
  expect(providerForHost("gitlab.com")).toBeUndefined();
});

it("derives every provider list from the registry", () => {
  const both = [githubProvider, forgeProvider];
  expect(providerNamesText(both)).toBe("github, forge");
  expect(providerHostsText(both)).toBe("github (github.com), forge (forge.example)");
  expect(shorthandFormsText(both)).toBe(
    "github:org/repo[/folder][#ref] or forge:org/repo[//folder][#ref]",
  );
  expect(locationHelpText(both)).toBe(
    "A location that names its provider: github:org/repo[/folder][#ref] or forge:org/repo[//folder][#ref], or an https://github.com/... URL or git@github.com:..., or an https://forge.example/... URL or git@forge.example:.... Providers: github, forge",
  );
  expect(exampleLocation(both)).toBe("github:anthropics/skills");
});

/** One place per derived fact; each must agree with the registry. */
it("agrees with the registry in the plan schema, the help and the examples", () => {
  const names = importProviders.map((provider) => provider.name);
  for (const name of names) expect(Schema.is(RegisteredProviderSchema)(name)).toBe(true);
  expect(Schema.is(RegisteredProviderSchema)("forge")).toBe(false);
  expect(Schema.is(RegisteredProviderSchema)("GitHub")).toBe(false);
  const providerField = ImportPlanSchema.fields.provider;
  expect(Schema.is(providerField)("github")).toBe(true);
  expect(Schema.is(providerField)("forge")).toBe(false);
  for (const provider of importProviders) {
    expect(locationHelpText()).toContain(provider.shorthandForm);
    for (const host of provider.hosts) expect(locationHelpText()).toContain(host);
    expect(exampleLocation().startsWith(`${provider.name}:`)).toBe(true);
  }
});

it("decodes a record location by shape, not against the registry", () => {
  const is = Schema.is(RecordLocationSchema);
  for (const location of ["github:acme/skills", "forge:acme/repo", "my-forge:a:b", "gitlab:x"])
    expect(is(location), location).toBe(true);
  for (const location of [
    "",
    "github",
    "github:",
    "acme/skills",
    "https://github.com/a/b",
    "http:x",
    "a:b",
    "GitHub:acme/skills",
    "1x:y",
    ":acme/skills",
  ])
    expect(is(location), location).toBe(false);
});

it("takes a transport as any lowercase word, because its values belong to the provider", () => {
  const is = Schema.is(TransportSchema);
  for (const transport of ["https", "ssh", "tarball", "git-http"]) expect(is(transport)).toBe(true);
  for (const transport of ["", "HTTPS", "1x", "a b"]) expect(is(transport)).toBe(false);
});

it("never treats locations of two providers as one repository", () => {
  expect(splitLocation("github:acme/skills")).toEqual({ provider: "github", text: "acme/skills" });
  expect(splitLocation("forge:a:b")).toEqual({ provider: "forge", text: "a:b" });
  expect(sameLocation(githubProvider, "github:Acme/Skills", "github:acme/skills")).toBe(true);
  expect(sameLocation(githubProvider, "forge:acme/skills", "github:acme/skills")).toBe(false);
  expect(sameLocation(forgeProvider, "github:acme/skills", "forge:acme/skills")).toBe(false);
  expect(sameLocation(forgeProvider, "forge:acme/skills", "forge:Acme/Skills")).toBe(false);
  expect(sameLocation(forgeProvider, "forge:acme/skills", "forge:acme/skills")).toBe(true);
});
