import { Result } from "effect";
import {
  canonicalLocation,
  providerNameProblem,
  refuse,
  reservedSchemes,
  type ImportLocationRefusal,
  type ImportProvider,
  type LocationFacts,
  type ProviderLocation,
} from "../../domain/imports/providers/provider.ts";
import {
  importProviders,
  providerForHost,
  providerHostsText,
  providerNamed,
  providerNamesText,
  shorthandFormsText,
} from "../../domain/imports/providers/registry.ts";

export { type ImportLocationRefusal };

/**
 * A location as the operator typed it: the provider that owns it, the provider's own facts, and the
 * ref request. A `tree` or `blob` URL keeps its unresolved path, because only the remote knows where
 * the ref ends and the folder begins.
 */
export type ParsedImportLocation = ProviderLocation & {
  readonly provider: ImportProvider;
  readonly ref?: string;
  /** Present when the operator typed a URL instead of the shorthand, and which form. */
  readonly urlForm?: "https" | "ssh";
};

/** Removes terminal control characters so untrusted text cannot rewrite the terminal. */
export const sanitizeForDisplay = (text: string): string =>
  // oxlint-disable-next-line eslint/no-control-regex -- Terminal control characters are the point.
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 200);

// oxlint-disable-next-line eslint/no-control-regex -- Control characters and whitespace are refused.
const unsafeTextPattern = /[\u0000-\u001f\u007f-\u009f\s]/;

const refShapeRefusal = (ref: string): string | undefined => {
  if (ref.length === 0)
    return "The ref after # is empty. Name a branch, a tag or a full commit ID.";
  if (ref.startsWith("refs/"))
    return "Name the branch or tag without a refs/ prefix, for example #main or #v1.2.3.";
  if (
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref === "@" ||
    // oxlint-disable-next-line eslint/no-control-regex -- Git refuses these characters in ref names.
    /[\u0000-\u001f\u007f ~^:?*[\\]/.test(ref) ||
    ref.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    return "The ref is not a valid git branch, tag or commit name.";
  return undefined;
};

/** The shared shape rules, then the provider's own. */
const checkRef = (provider: ImportProvider, ref: string): ImportLocationRefusal | undefined => {
  const shape = refShapeRefusal(ref);
  return shape === undefined
    ? provider.refRefusal(ref)
    : { code: "location-ref-invalid", message: shape };
};

const withRef = (
  parsed: ParsedImportLocation,
  ref: string | undefined,
): Result.Result<ParsedImportLocation, ImportLocationRefusal> => {
  if (ref === undefined) return Result.succeed(parsed);
  const refusal = checkRef(parsed.provider, ref);
  if (refusal !== undefined) return Result.fail(refusal);
  if (parsed.browse !== undefined)
    return refuse(
      "location-unsupported",
      `A tree or blob URL already names its ref. Remove the #ref, or use ${parsed.provider.shorthandForm}.`,
    );
  return Result.succeed({ ...parsed, ref });
};

const providersText = (providers: ReadonlyArray<ImportProvider>) =>
  `Providers: ${providerNamesText(providers)}.`;

const notServed = (host: string, providers: ReadonlyArray<ImportProvider>) =>
  refuse(
    "location-other-provider",
    `No import provider serves ${sanitizeForDisplay(host)}. Providers: ${providerHostsText(providers)}.`,
  );

/** The first provider host as an example of the URL forms, for messages. */
const urlExamples = (providers: ReadonlyArray<ImportProvider>) =>
  providers
    .flatMap((provider) => provider.hosts)
    .map((host) => `https://${host}/... or git@${host}:...`)
    .join("; ");

/** The refusal for a location typed without a provider, with the exact retype when there is one. */
const providerMissing = (
  body: string,
  ref: string | undefined,
  providers: ReadonlyArray<ImportProvider>,
) => {
  const suffix = ref === undefined ? "" : `#${ref}`;
  const candidates = providers
    .filter((provider) => Result.isSuccess(provider.parseText(body)))
    .map((provider) => `${provider.name}:${body}${suffix}`);
  const only = candidates.length === 1 ? candidates[0] : undefined;
  const advice =
    candidates.length === 0
      ? `Write the location as ${shorthandFormsText(providers)}`
      : `Name the provider: ${candidates.join(" or ")}`;
  return Result.fail<ImportLocationRefusal>({
    code: "location-provider-missing",
    message: `${advice}. Tack does not guess where org/repo lives. ${providersText(providers)}`,
    ...(only === undefined ? {} : { suggestion: only }),
  });
};

/** A location that starts with a host a provider serves, such as `host.example/acme/repo`. */
const hostWithoutScheme = (
  provider: ImportProvider,
  host: string,
  path: string,
  ref: string | undefined,
) => {
  const suffix = ref === undefined ? "" : `#${ref}`;
  const parsed = provider.parseUrl({ kind: "https", host, path });
  const shorthand =
    Result.isSuccess(parsed) && parsed.success.browse === undefined
      ? `${provider.name}:${provider.canonicalText({ repository: parsed.success.repository, scope: parsed.success.scope })}${suffix}`
      : undefined;
  return Result.fail<ImportLocationRefusal>({
    code: "location-provider-missing",
    message:
      shorthand === undefined
        ? `Write ${provider.shorthandForm}, or an https://${host}/... URL. Tack does not guess where a location lives.`
        : `Write ${shorthand}, or https://${host}/${path}${suffix}.`,
    ...(shorthand === undefined ? {} : { suggestion: shorthand }),
  });
};

/**
 * The refusal for `@`. When the text has exactly one `@` and no ref yet, `prefixes` (one per way to
 * write it) give the `#` retype; a retype is a suggestion only when there is exactly one.
 */
const atForm = (
  prefixes: ReadonlyArray<string>,
  rest: string,
  ref: string | undefined,
): ImportLocationRefusal => {
  const parts = rest.split("@");
  const [location, pin] = parts;
  const candidates =
    parts.length === 2 && ref === undefined && location !== "" && pin !== undefined && pin !== ""
      ? prefixes.map((prefix) => `${prefix}${location}#${pin}`)
      : [];
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return {
    code: "location-at-form",
    message: `@ is not accepted. Pin a ref with #${candidates.length === 0 ? "ref" : `: ${candidates.join(" or ")}`}. Choose skills with --skill NAME.`,
    ...(only === undefined ? {} : { suggestion: only }),
  };
};

const urlSplit = (text: string, schemeLength: number) => {
  const body = text.slice(schemeLength);
  const slash = body.indexOf("/");
  return {
    authority: slash === -1 ? body : body.slice(0, slash),
    path: slash === -1 ? "" : body.slice(slash + 1),
  };
};

const httpsLocation = (
  text: string,
  ref: string | undefined,
  providers: ReadonlyArray<ImportProvider>,
): Result.Result<ParsedImportLocation, ImportLocationRefusal> => {
  if (text.slice(0, "https://".length).toLowerCase() !== "https://")
    return refuse(
      "location-unsupported",
      `Write an https URL on a provider host: ${urlExamples(providers)}.`,
    );
  const { authority, path } = urlSplit(text, "https://".length);
  if (authority.includes("@"))
    return refuse(
      "location-credentials",
      "A URL with credentials is refused. Tack never stores or prints credentials; configure a git credential helper instead.",
    );
  const provider = providerForHost(authority, providers);
  if (provider === undefined) return notServed(authority, providers);
  if (path.includes("@")) return Result.fail(atForm([`https://${authority}/`], path, ref));
  return Result.flatMap(
    provider.parseUrl({ kind: "https", host: authority.toLowerCase(), path }),
    (location) => withRef({ ...location, provider, urlForm: "https" }, ref),
  );
};

const sshLocation = (
  text: string,
  ref: string | undefined,
  providers: ReadonlyArray<ImportProvider>,
): Result.Result<ParsedImportLocation, ImportLocationRefusal> => {
  const separator = text.indexOf(":");
  if (separator === -1)
    return refuse(
      "location-other-provider",
      `Write the SSH form with a host a provider serves. Providers: ${providerHostsText(providers)}.`,
    );
  const host = text.slice("git@".length, separator);
  const path = text.slice(separator + 1);
  const provider = providerForHost(host, providers);
  if (provider === undefined) return notServed(host, providers);
  if (path.includes("@")) return Result.fail(atForm([`git@${host}:`], path, ref));
  return Result.flatMap(
    provider.parseUrl({ kind: "ssh", host: host.toLowerCase(), path }),
    (location) => withRef({ ...location, provider, urlForm: "ssh" }, ref),
  );
};

/** Refusals for URL schemes that are not accepted, each naming what is. */
const refusedScheme = (scheme: string, providers: ReadonlyArray<ImportProvider>) =>
  scheme === "http"
    ? refuse(
        "location-other-provider",
        `Plain http is refused. Use an https URL on a provider host. Providers: ${providerHostsText(providers)}.`,
      )
    : scheme === "ssh"
      ? refuse(
          "location-other-provider",
          `ssh:// URLs are not accepted. Use the git@host:path form. Providers: ${providerHostsText(providers)}.`,
        )
      : notServed(`${scheme}:`, providers);

const addSource = ["tack", "source", "add"];

const localPath = refuse(
  "location-local-path",
  `Local paths are not supported by import; use \`${addSource.join(" ")}\` to register a local directory.`,
  [addSource],
);

/**
 * Parses the text an operator typed into a remote location. Refusals happen here, before any
 * network call: unsafe text, `@` forms, local paths, a missing, unknown or unserved provider, and
 * whatever the provider refuses in its own locations.
 *
 * The rules run in order: unsafe text, the `#` split, `@`, the prefix or URL host that routes to a
 * provider, local paths, and last the missing prefix.
 */
export const parseImportLocation = (
  input: string,
  providers: ReadonlyArray<ImportProvider> = importProviders,
): Result.Result<ParsedImportLocation, ImportLocationRefusal> => {
  const text = input.trim();
  if (text.length === 0)
    return refuse(
      "location-empty",
      `A location is required. Write ${shorthandFormsText(providers)}.`,
    );
  if (unsafeTextPattern.test(text) || text.startsWith("-") || text.includes("\\"))
    return refuse(
      "location-unsafe",
      `The location ${JSON.stringify(sanitizeForDisplay(text))} contains whitespace, control characters, backslashes or starts with -, which are refused.`,
    );
  const hash = text.indexOf("#");
  const body = hash === -1 ? text : text.slice(0, hash);
  const ref = hash === -1 ? undefined : text.slice(hash + 1);
  if (ref !== undefined && ref.includes("#"))
    return refuse("location-ref-invalid", "A location can carry only one #ref.");

  if (body.startsWith("git@")) return sshLocation(body, ref, providers);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(body)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme.length === 1) return localPath;
    if (scheme === "https") return httpsLocation(body, ref, providers);
    if (reservedSchemes.includes(scheme)) return refusedScheme(scheme, providers);
    const provider = providerNamed(scheme, providers);
    const rest = body.slice(scheme.length + 1);
    if (provider !== undefined) {
      if (rest.includes("@")) return Result.fail(atForm([`${provider.name}:`], rest, ref));
      return Result.flatMap(provider.parseText(rest), (location) =>
        withRef({ ...location, provider }, ref),
      );
    }
    return providerNameProblem(scheme) === undefined && rest.startsWith("//") === false
      ? refuse(
          "location-provider-unknown",
          `Tack has no import provider named ${scheme}. ${providersText(providers)}`,
        )
      : refusedScheme(scheme, providers);
  }
  if (body.startsWith("/") || body.startsWith(".") || body.startsWith("~")) return localPath;
  if (body.includes("@"))
    return Result.fail(
      atForm(
        providers.map((provider) => `${provider.name}:`),
        body,
        ref,
      ),
    );
  const first = body.split("/")[0] ?? "";
  const hostProvider = providerForHost(first, providers);
  if (hostProvider !== undefined)
    return hostWithoutScheme(hostProvider, first.toLowerCase(), body.slice(first.length + 1), ref);
  return providerMissing(body, ref, providers);
};

/** The canonical text `<provider>:<provider text>[#ref]`, with the casing typed first. */
export const canonicalLocationText = (
  location: LocationFacts & { readonly provider: ImportProvider },
  options: { readonly withRef?: boolean } = {},
): string =>
  canonicalLocation(location.provider, {
    repository: location.repository,
    scope: location.scope,
    ref: options.withRef === false ? undefined : location.ref,
  });
