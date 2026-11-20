import { Result } from "effect";
import type { RemoteTarget } from "../remote-target.ts";
import {
  refuse,
  type ImportLocationRefusal,
  type ImportProvider,
  type LocationFacts,
  type ProviderLocation,
  type ProviderUrl,
} from "./provider.ts";

/** How a GitHub location was reached: the transport git uses for it. */
type GithubTransport = "https" | "ssh";

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repositoryPattern = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const fullCommitPattern = /^[0-9a-f]{40}$/;
const hexPattern = /^[0-9a-fA-F]+$/;
// oxlint-disable-next-line eslint/no-control-regex -- Control characters are refused in path segments.
const segmentControlPattern = /[\u0000-\u001f\u007f-\u009f\\]/;

const decodeSegment = (segment: string): string | undefined => {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.includes("/") ? undefined : decoded;
  } catch {
    return undefined;
  }
};

const scopeRefusal = (message: string) => refuse("location-scope-invalid", message);

/** Validates folder segments: no empty, dot or dot-dot segment, no backslash, no control text. */
const checkSegments = (
  segments: ReadonlyArray<string>,
): Result.Result<ReadonlyArray<string>, ImportLocationRefusal> =>
  segments.reduce<Result.Result<ReadonlyArray<string>, ImportLocationRefusal>>(
    (accumulated, segment) =>
      Result.flatMap(accumulated, (decoded) => {
        const value = decodeSegment(segment);
        if (value === undefined || value.length === 0)
          return scopeRefusal(
            "A folder scope must be a relative path of plain segments, without empty or encoded separators.",
          );
        if (value === "." || value === "..")
          return scopeRefusal("A folder scope must not contain . or .. segments.");
        if (segmentControlPattern.test(value))
          return scopeRefusal("A folder scope must not contain backslashes or control characters.");
        return Result.succeed([...decoded, value]);
      }),
    Result.succeed([]),
  );

const checkRepository = (
  ownerText: string,
  repoText: string,
): Result.Result<{ readonly owner: string; readonly repo: string }, ImportLocationRefusal> => {
  const owner = ownerText;
  const repo = repoText.endsWith(".git") ? repoText.slice(0, -4) : repoText;
  if (ownerPattern.test(owner) === false)
    return refuse(
      "location-repository-invalid",
      "The repository owner must be a GitHub user or organization name.",
    );
  if (repo.length === 0 || repo === "." || repo === ".." || repositoryPattern.test(repo) === false)
    return refuse(
      "location-repository-invalid",
      "The repository name must be a GitHub repository name, written owner/repo.",
    );
  return Result.succeed({ owner, repo });
};

const located = (
  owner: string,
  repo: string,
  transport: GithubTransport,
  rest: Partial<Pick<ProviderLocation, "scope" | "browse">> = {},
): ProviderLocation => ({ repository: `${owner}/${repo}`, transport, ...rest });

const shorthandForm = "github:org/repo[/folder][#ref]";

const parseText = (text: string): Result.Result<ProviderLocation, ImportLocationRefusal> => {
  if (text.startsWith("/") || text.includes(":"))
    return refuse("location-unsupported", `Write the location as ${shorthandForm}.`);
  const parts = text.split("/");
  const [owner = "", repo = "", ...rest] = parts;
  if (parts.length < 2 || owner === "" || repo === "")
    return refuse("location-unsupported", `Write the location as ${shorthandForm}.`);
  return Result.flatMap(checkRepository(owner, repo), (checked) => {
    const trimmed = rest.at(-1) === "" ? rest.slice(0, -1) : rest;
    if (trimmed.length === 0) return Result.succeed(located(checked.owner, checked.repo, "https"));
    return Result.map(checkSegments(trimmed), (segments) =>
      located(checked.owner, checked.repo, "https", { scope: segments.join("/") }),
    );
  });
};

const parseHttpsPath = (
  pathText: string,
): Result.Result<ProviderLocation, ImportLocationRefusal> => {
  if (pathText.includes("?"))
    return refuse("location-unsupported", "Remove the query string from the GitHub URL.");
  const segments = pathText.split("/");
  if (segments.at(-1) === "") segments.pop();
  const [ownerText, repoText, mode, ...rest] = segments;
  if (ownerText === undefined || repoText === undefined || repoText === "")
    return refuse(
      "location-unsupported",
      "Write the GitHub URL as https://github.com/owner/repo, optionally followed by /tree/<ref>/<folder>.",
    );
  return Result.flatMap(checkRepository(ownerText, repoText), ({ owner, repo }) => {
    if (mode === undefined) return Result.succeed(located(owner, repo, "https"));
    if (mode !== "tree" && mode !== "blob")
      return refuse(
        "location-unsupported",
        "Only the repository, /tree/<ref>/<folder> and /blob/<ref>/<path>/SKILL.md URLs are supported.",
      );
    if (rest.length === 0)
      return mode === "blob"
        ? refuse(
            "location-file-unsupported",
            "A file location must end in SKILL.md. Other files are not supported yet.",
          )
        : refuse("location-unsupported", "A tree URL must name a ref after /tree/.");
    return Result.flatMap(checkSegments(rest), (decoded) => {
      if (mode === "blob" && (decoded.length < 2 || decoded.at(-1) !== "SKILL.md"))
        return refuse(
          "location-file-unsupported",
          "A file location must end in SKILL.md. Other files are not supported yet; commands, context and docs locations arrive in a later release.",
        );
      return Result.succeed(
        located(owner, repo, "https", { browse: { kind: mode, segments: decoded } }),
      );
    });
  });
};

const parseSshPath = (pathText: string): Result.Result<ProviderLocation, ImportLocationRefusal> => {
  const parts = pathText.split("/");
  const [owner = "", repo = ""] = parts;
  if (parts.length !== 2 || owner === "" || repo === "")
    return refuse(
      "location-unsupported",
      "Write the SSH location as git@github.com:owner/repo.git.",
    );
  return Result.map(checkRepository(owner, repo), (checked) =>
    located(checked.owner, checked.repo, "ssh"),
  );
};

const parseUrl = (url: ProviderUrl) =>
  url.kind === "https" ? parseHttpsPath(url.path) : parseSshPath(url.path);

const refRefusal = (ref: string): ImportLocationRefusal | undefined =>
  fullCommitPattern.test(ref) === false &&
  hexPattern.test(ref) &&
  ref.length >= 7 &&
  ref.length <= 64
    ? {
        code: "location-ref-abbreviated",
        message:
          "Abbreviated commit IDs cannot be fetched from GitHub. Use the full commit ID (40 hexadecimal characters) after #.",
      }
    : undefined;

const canonicalText = (facts: LocationFacts): string =>
  `${facts.repository}${facts.scope === undefined ? "" : `/${facts.scope}`}${
    facts.ref === undefined ? "" : `#${facts.ref}`
  }`;

/** The same GitHub repository: owner and repo compare without case, and `.git` is ignored. */
const sameRepository = (left: string, right: string): boolean => {
  const normalize = (text: string) => text.toLowerCase().replace(/\.git$/, "");
  return normalize(left) === normalize(right);
};

const authenticationHelp =
  "Configure a git credential helper (for example `gh auth setup-git`), use the SSH form git@github.com:owner/repo.git, or check the repository name: GitHub reports a private repository without access as not found.";

const remote = (location: ProviderLocation): RemoteTarget => ({
  url:
    location.transport === "ssh"
      ? `git@github.com:${location.repository}.git`
      : `https://github.com/${location.repository}.git`,
  protocols: ["https", "ssh"],
  fixturePath: location.repository,
  authenticationHelp,
});

/** The GitHub provider: `github:owner/repo[/folder][#ref]` and github.com URLs. */
export const githubProvider: ImportProvider = {
  name: "github",
  hosts: ["github.com"],
  shorthandForm,
  parseText,
  parseUrl,
  refRefusal,
  canonicalText,
  sameRepository,
  remote,
};
