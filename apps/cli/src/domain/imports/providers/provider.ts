import { Result } from "effect";
import type { NextCommands } from "../../hints/next-commands.ts";
import type { RemoteTarget } from "../remote-target.ts";

/** Why a typed location was refused, before any network call. */
const importLocationRefusalCodes = [
  "location-empty",
  "location-unsafe",
  "location-at-form",
  "location-credentials",
  "location-file-unsupported",
  "location-local-path",
  "location-other-provider",
  "location-provider-missing",
  "location-provider-unknown",
  "location-ref-abbreviated",
  "location-ref-invalid",
  "location-repository-invalid",
  "location-scope-invalid",
  "location-unsupported",
] as const;

export type ImportLocationRefusal = {
  readonly code: (typeof importLocationRefusalCodes)[number];
  readonly message: string;
  /** The corrected location the operator can retype, when the refusal has exactly one. */
  readonly suggestion?: string;
  /** The commands the message names as the way past the refusal. */
  readonly next?: NextCommands;
};

/** Builds a failed parse, with the commands its message names. */
export const refuse = (code: ImportLocationRefusal["code"], message: string, next?: NextCommands) =>
  Result.fail<ImportLocationRefusal>({ code, message, ...(next === undefined ? {} : { next }) });

/**
 * A remote location in the provider's own terms, before the ref is known. The core reads only the
 * scope, the browse path and the transport; `repository` is the provider's text and nothing outside
 * its adapter reads inside it.
 */
export type ProviderLocation = {
  /** The repository as typed first, for example `Owner/Repo`. */
  readonly repository: string;
  /** How the operator reached it, such as `https` or `ssh`; its values belong to the provider. */
  readonly transport: string;
  /** The folder inside the repository, as typed. */
  readonly scope?: string;
  /**
   * A `tree` or `blob` URL keeps its unresolved path, because only the remote knows where the ref
   * ends and the folder begins.
   */
  readonly browse?: {
    readonly kind: "tree" | "blob";
    readonly segments: ReadonlyArray<string>;
  };
};

/** The facts the canonical text of a location is written from. */
export type LocationFacts = {
  readonly repository: string;
  readonly scope?: string | undefined;
  readonly ref?: string | undefined;
};

/** A URL form on one of a provider's hosts, split where the core can tell without the provider. */
export type ProviderUrl = {
  /** `https` for `https://host/path`, `ssh` for `git@host:path`. */
  readonly kind: "https" | "ssh";
  readonly host: string;
  /** Everything after the host: after the first `/` for https, after the `:` for ssh. */
  readonly path: string;
};

/**
 * One import provider: a named kind of remote location. The adapter owns everything about its own
 * locations and returns facts; it never runs git and never writes. The core owns the rest.
 */
export type ImportProvider = {
  /** The prefix of every canonical location it owns, lowercase. */
  readonly name: string;
  /** The hosts of the URLs it recognizes, lowercase. */
  readonly hosts: ReadonlyArray<string>;
  /** How its shorthand is written, for messages. */
  readonly shorthandForm: string;
  /** Parses the text after `<name>:`, without the ref. */
  readonly parseText: (text: string) => Result.Result<ProviderLocation, ImportLocationRefusal>;
  /** Parses a URL or `git@host:` form on one of its hosts. */
  readonly parseUrl: (url: ProviderUrl) => Result.Result<ProviderLocation, ImportLocationRefusal>;
  /** Refuses a ref shape only this provider cannot fetch; the shared shape rules run first. */
  readonly refRefusal: (ref: string) => ImportLocationRefusal | undefined;
  /** The canonical text after `<name>:`, with the casing typed first. */
  readonly canonicalText: (facts: LocationFacts) => string;
  /** Whether two canonical location texts (after `<name>:`, no ref) name one repository. */
  readonly sameRepository: (left: string, right: string) => boolean;
  /** The git remote for a location: its URL and protocols, and how to get access. */
  readonly remote: (location: ProviderLocation) => RemoteTarget;
};

/** URL schemes that can never be provider names, because they already mean something. */
export const reservedSchemes: ReadonlyArray<string> = [
  "https",
  "http",
  "ssh",
  "git",
  "file",
  "ext",
];

const providerNamePattern = /^[a-z][a-z0-9-]+$/;

/** Why a name cannot be a provider prefix, or `undefined` when it can. */
export const providerNameProblem = (name: string): string | undefined => {
  if (providerNamePattern.test(name) === false)
    return `"${name}" is not a provider name: use lowercase letters, digits and -, starting with a letter, at least two characters.`;
  if (reservedSchemes.includes(name))
    return `"${name}" is a URL scheme and cannot be a provider name.`;
  return undefined;
};

/** The canonical text of a location of `provider`: `<name>:<provider text>`. */
export const canonicalLocation = (provider: ImportProvider, facts: LocationFacts): string =>
  `${provider.name}:${provider.canonicalText(facts)}`;

/** Splits a record's location into its provider name and the text only that provider reads. */
export const splitLocation = (
  location: string,
): { readonly provider: string; readonly text: string } => {
  const colon = location.indexOf(":");
  return { provider: location.slice(0, colon), text: location.slice(colon + 1) };
};

/**
 * Whether a record's location and a new canonical location name the same repository. Locations of
 * different providers are never the same; the provider of the new location decides the rest, so a
 * record whose provider this release does not know is simply a different one.
 */
export const sameLocation = (
  provider: ImportProvider,
  recordLocation: string,
  location: string,
): boolean => {
  const record = splitLocation(recordLocation);
  return (
    record.provider === provider.name &&
    provider.sameRepository(record.text, splitLocation(location).text)
  );
};
