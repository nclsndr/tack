import { expect, it } from "@effect/vitest";
import { Result } from "effect";
import {
  canonicalLocationText,
  parseImportLocation,
  type ParsedImportLocation,
} from "./import-location.ts";
import { forgeProvider } from "../../../test/support/forge-provider.ts";
import { githubProvider } from "../../domain/imports/providers/github.ts";

const summarize = (parsed: ParsedImportLocation) =>
  [
    `${parsed.provider.name}:${parsed.repository}`,
    parsed.transport,
    parsed.scope === undefined ? "-" : `scope=${parsed.scope}`,
    parsed.ref === undefined ? "-" : `ref=${parsed.ref}`,
    parsed.browse === undefined ? "-" : `${parsed.browse.kind}:${parsed.browse.segments.join("/")}`,
    parsed.urlForm === undefined ? "-" : `from ${parsed.urlForm}`,
  ].join(" | ");

/** The grammar of import phase 1, each row written with the provider prefix. */
const accepted: ReadonlyArray<readonly [string, string]> = [
  ["github:owner/repo", "github:owner/repo | https | - | - | - | -"],
  ["github:Owner/Repo", "github:Owner/Repo | https | - | - | - | -"],
  ["GitHub:Owner/Repo", "github:Owner/Repo | https | - | - | - | -"],
  ["github:owner/repo/skills/pdf", "github:owner/repo | https | scope=skills/pdf | - | - | -"],
  ["github:owner/repo/skills/pdf/", "github:owner/repo | https | scope=skills/pdf | - | - | -"],
  ["github:owner/repo#v1.2.3", "github:owner/repo | https | - | ref=v1.2.3 | - | -"],
  [
    "github:owner/repo#0123456789abcdef0123456789abcdef01234567",
    "github:owner/repo | https | - | ref=0123456789abcdef0123456789abcdef01234567 | - | -",
  ],
  [
    "github:owner/repo#feature/install",
    "github:owner/repo | https | - | ref=feature/install | - | -",
  ],
  [
    "github:owner/repo/skills#v1.2.3",
    "github:owner/repo | https | scope=skills | ref=v1.2.3 | - | -",
  ],
  ["github:owner/repo/skills#main", "github:owner/repo | https | scope=skills | ref=main | - | -"],
  ["https://github.com/owner/repo", "github:owner/repo | https | - | - | - | from https"],
  ["https://github.com/owner/repo/", "github:owner/repo | https | - | - | - | from https"],
  ["https://github.com/owner/repo.git", "github:owner/repo | https | - | - | - | from https"],
  [
    "https://github.com/owner/repo.git#dev",
    "github:owner/repo | https | - | ref=dev | - | from https",
  ],
  ["https://GitHub.com/owner/repo", "github:owner/repo | https | - | - | - | from https"],
  ["HTTPS://github.com/owner/repo", "github:owner/repo | https | - | - | - | from https"],
  [
    "https://github.com/o/r/tree/main/skills/x",
    "github:o/r | https | - | - | tree:main/skills/x | from https",
  ],
  [
    "https://github.com/o/r/tree/feature/install/skills/x",
    "github:o/r | https | - | - | tree:feature/install/skills/x | from https",
  ],
  ["https://github.com/o/r/tree/v1.0.0", "github:o/r | https | - | - | tree:v1.0.0 | from https"],
  [
    "https://github.com/o/r/blob/main/skills/x/SKILL.md",
    "github:o/r | https | - | - | blob:main/skills/x/SKILL.md | from https",
  ],
  ["git@github.com:owner/repo.git", "github:owner/repo | ssh | - | - | - | from ssh"],
  ["git@github.com:owner/repo", "github:owner/repo | ssh | - | - | - | from ssh"],
  ["git@github.com:owner/repo.git#v2", "github:owner/repo | ssh | - | ref=v2 | - | from ssh"],
];

const refused: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["", "location-empty", /location is required.*github:org\/repo/i],
  ["   ", "location-empty", /location/i],
  ["github:owner/repo@skill", "location-at-form", /#.*--skill/],
  ["github:owner/repo#1a2c79d", "location-ref-abbreviated", /full commit/i],
  ["github:owner/repo#1a2c79d4e6c4", "location-ref-abbreviated", /full commit/i],
  ["github:owner/repo#", "location-ref-invalid", /ref/i],
  ["github:owner/repo#-flag", "location-ref-invalid", /ref/i],
  ["github:owner/repo#a..b", "location-ref-invalid", /ref/i],
  ["github:owner/repo#a#b", "location-ref-invalid", /only one/i],
  ["github:owner/repo#a b", "location-unsafe", /.+/],
  ["github:owner/repo#refs/heads/main", "location-ref-invalid", /refs\//],
  ["github:owner/repo#branch.lock", "location-ref-invalid", /ref/i],
  ["-owner/repo", "location-unsafe", /-/],
  ["--upload-pack=evil", "location-unsafe", /-/],
  ["github:owner/-repo", "location-repository-invalid", /repository/i],
  ["github:-owner/repo", "location-repository-invalid", /owner/i],
  ["github:owner", "location-unsupported", /github:org\/repo\[\/folder\]\[#ref\]/],
  ["github:owner/", "location-unsupported", /github:org\/repo/],
  ["github:/owner/repo", "location-unsupported", /github:org\/repo/],
  ["github://owner/repo", "location-unsupported", /github:org\/repo/],
  ["github:owner/repo:x", "location-unsupported", /github:org\/repo/],
  ["/owner/repo", "location-local-path", /local/i],
  ["./owner/repo", "location-local-path", /local/i],
  ["../owner/repo", "location-local-path", /local/i],
  ["~/owner/repo", "location-local-path", /local/i],
  ["c:owner/repo", "location-local-path", /local/i],
  ["file:///tmp/repo", "location-other-provider", /No import provider serves file:\./],
  ["file://localhost/tmp/repo", "location-other-provider", /No import provider serves file:\./],
  ["ext::sh -c touch% /tmp/pwned", "location-unsafe", /.+/],
  ["ext::sh", "location-other-provider", /No import provider serves ext:\./],
  ["git://github.com/owner/repo", "location-other-provider", /No import provider serves git:\./],
  ["http://github.com/owner/repo", "location-other-provider", /Plain http.*https URL/],
  ["ssh://git@github.com/owner/repo.git", "location-other-provider", /git@host:path form/],
  ["ftp://github.com/owner/repo", "location-other-provider", /No import provider serves ftp:\./],
  [
    "https://gitlab.com/owner/repo",
    "location-other-provider",
    /No import provider serves gitlab\.com\. Providers: github \(github\.com\)\./,
  ],
  [
    "https://www.github.com/owner/repo",
    "location-other-provider",
    /No import provider serves www\.github\.com\./,
  ],
  [
    "https://github.com:8443/owner/repo",
    "location-other-provider",
    /No import provider serves github\.com:8443\./,
  ],
  [
    "git@gitlab.com:owner/repo.git",
    "location-other-provider",
    /No import provider serves gitlab\.com\. Providers: github \(github\.com\)\./,
  ],
  ["git@gitlab.com", "location-other-provider", /github \(github\.com\)/],
  ["https:github.com/owner/repo", "location-unsupported", /https:\/\/github\.com\/\.\.\./],
  ["https://user:secret@github.com/owner/repo", "location-credentials", /credential/i],
  ["https://github.com/owner/repo?tab=readme", "location-unsupported", /.+/],
  ["https://github.com/owner/repo/issues/1", "location-unsupported", /tree|blob/],
  ["https://github.com/owner", "location-unsupported", /github\.com\/owner\/repo/],
  ["https://github.com/o/r/blob/main/README.md", "location-file-unsupported", /SKILL\.md/],
  ["https://github.com/o/r/blob/main", "location-file-unsupported", /SKILL\.md/],
  ["https://github.com/o/r/tree", "location-unsupported", /.+/],
  ["https://github.com/o/r/tree/main/../x", "location-scope-invalid", /scope|\.\./],
  ["https://github.com/o/r/tree/main/a%2Fb", "location-scope-invalid", /scope/],
  ["https://github.com/o/r/tree/main#dev", "location-unsupported", /already names its ref/],
  ["github:owner/repo/../x", "location-scope-invalid", /\.\./],
  ["github:owner/repo/a/./b", "location-scope-invalid", /scope/],
  ["github:owner/repo/a//b", "location-scope-invalid", /scope/],
  ["github:owner/repo/a\\b", "location-unsafe", /.+/],
  ["github:owner/repo/\u0000x", "location-unsafe", /.+/],
  ["github:owner/repo/x\ny", "location-unsafe", /.+/],
  ["github:owner/repo\u001b[31m", "location-unsafe", /.+/],
  ["git@github.com:owner/repo/extra", "location-unsupported", /git@github\.com:owner\/repo/],
  ["git@github.com:owner", "location-unsupported", /git@github\.com:owner\/repo/],
];

it("parses every accepted location form", () => {
  for (const [input, expected] of accepted) {
    const result = parseImportLocation(input);
    expect(result._tag, input).toBe("Success");
    if (result._tag === "Success") expect(summarize(result.success), input).toBe(expected);
  }
});

it("refuses every unsupported form with a code and a message that names the fix", () => {
  for (const [input, code, message] of refused) {
    const result = parseImportLocation(input);
    expect(result._tag, JSON.stringify(input)).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code, JSON.stringify(input)).toBe(code);
      expect(result.failure.message, JSON.stringify(input)).toMatch(message);
    }
  }
});

/** Typed text with no provider, and the exact location to retype. */
const missing: ReadonlyArray<readonly [string, string | undefined, RegExp]> = [
  [
    "acme/repo/skills#v1",
    "github:acme/repo/skills#v1",
    /^Name the provider: github:acme\/repo\/skills#v1\. Tack does not guess where org\/repo lives\. Providers: github\.$/,
  ],
  ["acme/repo", "github:acme/repo", /Name the provider: github:acme\/repo\./],
  ["Acme/Repo/skills/pdf", "github:Acme/Repo/skills/pdf", /github:Acme\/Repo\/skills\/pdf/],
  ["acme/repo#feature/install", "github:acme/repo#feature/install", /github:acme\/repo#feature/],
  [
    "github.com/acme/repo",
    "github:acme/repo",
    /^Write github:acme\/repo, or https:\/\/github\.com\/acme\/repo\.$/,
  ],
  [
    "GitHub.com/acme/repo#v1",
    "github:acme/repo#v1",
    /^Write github:acme\/repo#v1, or https:\/\/github\.com\/acme\/repo#v1\.$/,
  ],
  // Text a provider cannot read is not offered back as a retype.
  [
    "github.com/acme/repo/tree/main/skills",
    undefined,
    /Write github:org\/repo\[\/folder\]\[#ref\], or an https:\/\/github\.com\/\.\.\. URL/,
  ],
  [
    "acme",
    undefined,
    /Write the location as github:org\/repo\[\/folder\]\[#ref\]\. Tack does not guess/,
  ],
  ["gitlab.com/acme/repo", undefined, /Write the location as github:org\/repo/],
  ["acme/-repo", undefined, /Write the location as github:/],
];

it("refuses a location with no provider and gives the exact text to retype", () => {
  for (const [input, suggestion, message] of missing) {
    const result = parseImportLocation(input);
    expect(result._tag, input).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code, input).toBe("location-provider-missing");
      expect(result.failure.suggestion, input).toBe(suggestion);
      expect(result.failure.message, input).toMatch(message);
    }
  }
});

it("names the provider of an unknown prefix", () => {
  for (const input of ["gitlab:acme/repo", "GitLab:acme/repo", "forge:acme/repo"]) {
    const result = parseImportLocation(input);
    expect(result._tag, input).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code, input).toBe("location-provider-unknown");
      expect(result.failure.message, input).toMatch(
        /^Tack has no import provider named (gitlab|forge)\. Providers: github\.$/,
      );
    }
  }
});

it("refuses @ on every path, with the # form when there is exactly one", () => {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["github:acme/repo@v1", "github:acme/repo#v1"],
    ["GitHub:acme/repo/skills@v1.2.3", "github:acme/repo/skills#v1.2.3"],
    ["acme/repo@v1", "github:acme/repo#v1"],
    ["acme/repo@skill", "github:acme/repo#skill"],
    ["https://github.com/acme/repo@v1", "https://github.com/acme/repo#v1"],
    ["git@github.com:acme/repo.git@v1", "git@github.com:acme/repo.git#v1"],
    ["acme/repo@v1@v2", undefined],
    ["acme/repo@v1#main", undefined],
    ["acme/repo@", undefined],
    ["@v1", undefined],
  ];
  for (const [input, suggestion] of cases) {
    const result = parseImportLocation(input);
    expect(result._tag, input).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code, input).toBe("location-at-form");
      expect(result.failure.suggestion, input).toBe(suggestion);
      expect(result.failure.message, input).toBe(
        `@ is not accepted. Pin a ref with #${suggestion === undefined ? "ref" : `: ${suggestion}`}. Choose skills with --skill NAME.`,
      );
    }
  }
});

it("never echoes credentials from a refused URL", () => {
  const result = parseImportLocation("https://user:hunter2@github.com/owner/repo");
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(JSON.stringify(result.failure)).not.toContain("hunter2");
});

it("keeps control characters of untrusted text out of refusal messages", () => {
  const result = parseImportLocation("github:owner/repo\u001b[31mred");
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.message.includes("\u001b")).toBe(false);
});

it("renders the canonical text with the casing typed first", () => {
  const result = parseImportLocation("github:Owner/Repo.git/skills/pdf#v1");
  expect(result._tag).toBe("Success");
  if (result._tag !== "Success") return;
  expect(canonicalLocationText(result.success)).toBe("github:Owner/Repo/skills/pdf#v1");
  expect(canonicalLocationText(result.success, { withRef: false })).toBe(
    "github:Owner/Repo/skills/pdf",
  );
});

it("renders the same canonical text whether the operator typed the shorthand or a URL", () => {
  const typed = [
    "github:acme/repo/skills#v1",
    "https://github.com/acme/repo.git#v1",
    "git@github.com:acme/repo.git#v1",
  ].map((input) => {
    const result = parseImportLocation(input);
    return Result.isSuccess(result)
      ? canonicalLocationText({ ...result.success, scope: "skills" })
      : "";
  });
  expect(typed).toEqual(Array.from({ length: 3 }, () => "github:acme/repo/skills#v1"));
});

const providers = [githubProvider, forgeProvider];

it("routes a prefix to its provider without any change to the core", () => {
  const result = parseImportLocation("forge:acme/repo//docs#v1", providers);
  expect(result._tag).toBe("Success");
  if (result._tag !== "Success") return;
  expect(result.success.provider).toBe(forgeProvider);
  expect(canonicalLocationText(result.success)).toBe("forge:acme/repo//docs#v1");
  expect(parseImportLocation("FORGE:acme/repo", providers)._tag).toBe("Success");
});

it("routes a URL to the provider that serves its host", () => {
  const forge = parseImportLocation("https://forge.example/acme/repo", providers);
  expect(forge._tag).toBe("Success");
  if (forge._tag === "Success") {
    expect(forge.success.provider).toBe(forgeProvider);
    expect(forge.success.urlForm).toBe("https");
  }
  const github = parseImportLocation("git@github.com:acme/repo.git", providers);
  expect(github._tag === "Success" && github.success.provider === githubProvider).toBe(true);
  const unserved = parseImportLocation("https://gitlab.com/acme/repo", providers);
  expect(unserved._tag === "Failure" && unserved.failure.message).toBe(
    "No import provider serves gitlab.com. Providers: github (github.com), forge (forge.example).",
  );
});

it("lists every provider in the refusal of a location without one", () => {
  const result = parseImportLocation("acme/repo", providers);
  expect(result._tag === "Failure" && result.failure).toEqual({
    code: "location-provider-missing",
    message:
      "Name the provider: github:acme/repo or forge:acme/repo. Tack does not guess where org/repo lives. Providers: github, forge.",
  });
  const pinned = parseImportLocation("acme/repo@v1", providers);
  expect(pinned._tag === "Failure" && pinned.failure).toEqual({
    code: "location-at-form",
    message:
      "@ is not accepted. Pin a ref with #: github:acme/repo#v1 or forge:acme/repo#v1. Choose skills with --skill NAME.",
  });
  const empty = parseImportLocation("", providers);
  expect(empty._tag === "Failure" && empty.failure.message).toBe(
    "A location is required. Write github:org/repo[/folder][#ref] or forge:org/repo[//folder][#ref].",
  );
});

it("applies a provider's own ref rules after the shared shape rules", () => {
  const forge = parseImportLocation("forge:acme/repo#abc1234", providers);
  expect(forge._tag).toBe("Success");
  const github = parseImportLocation("github:acme/repo#abc1234", providers);
  expect(github._tag === "Failure" && github.failure.code).toBe("location-ref-abbreviated");
  const shape = parseImportLocation("forge:acme/repo#a..b", providers);
  expect(shape._tag === "Failure" && shape.failure.code).toBe("location-ref-invalid");
});

it("refuses an https URL that names only a host", () => {
  expect(parseImportLocation("https://github.com")).toMatchObject({
    _tag: "Failure",
    failure: { code: "location-unsupported", message: expect.stringContaining("owner/repo") },
  });
  expect(parseImportLocation("https://example.com")).toMatchObject({
    _tag: "Failure",
    failure: { code: "location-other-provider", message: expect.stringContaining("example.com") },
  });
});
