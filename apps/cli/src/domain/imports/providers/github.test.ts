import { expect, it } from "@effect/vitest";
import { githubProvider } from "./github.ts";

it("compares repositories without case and ignores .git", () => {
  const same: ReadonlyArray<readonly [string, string]> = [
    ["acme/skills", "acme/skills"],
    ["Acme/Skills", "acme/skills"],
    ["acme/skills.git", "acme/skills"],
    ["ACME/SKILLS.GIT", "acme/skills"],
  ];
  for (const [left, right] of same) {
    expect(githubProvider.sameRepository(left, right), `${left} ${right}`).toBe(true);
    expect(githubProvider.sameRepository(right, left), `${right} ${left}`).toBe(true);
  }
  expect(githubProvider.sameRepository("acme/skills", "acme/other")).toBe(false);
  expect(githubProvider.sameRepository("acme/skills", "other/skills")).toBe(false);
  expect(githubProvider.sameRepository("acme/skills", "acme/skills-git")).toBe(false);
});

it("builds the git remote of a location from its transport", () => {
  const https = githubProvider.remote({ repository: "o/r", transport: "https" });
  const ssh = githubProvider.remote({ repository: "o/r", transport: "ssh" });
  expect(https.url).toBe("https://github.com/o/r.git");
  expect(ssh.url).toBe("git@github.com:o/r.git");
  for (const remote of [https, ssh]) {
    expect(remote.protocols).toEqual(["https", "ssh"]);
    expect(remote.fixturePath).toBe("o/r");
    expect(remote.authenticationHelp).toMatch(/gh auth setup-git/);
    expect(remote.authenticationHelp).toMatch(/git@github\.com:owner\/repo\.git/);
    expect(remote.authenticationHelp).toMatch(/not found/);
  }
});

it("writes canonical text with the casing typed first", () => {
  expect(githubProvider.canonicalText({ repository: "Acme/Skills" })).toBe("Acme/Skills");
  expect(
    githubProvider.canonicalText({ repository: "Acme/Skills", scope: "skills/pdf", ref: "v1" }),
  ).toBe("Acme/Skills/skills/pdf#v1");
});

it("refuses only an abbreviated commit as a GitHub ref", () => {
  expect(githubProvider.refRefusal("1a2c79d")?.code).toBe("location-ref-abbreviated");
  expect(githubProvider.refRefusal("0123456789abcdef0123456789abcdef01234567")).toBeUndefined();
  expect(githubProvider.refRefusal("v1.2.3")).toBeUndefined();
  expect(githubProvider.refRefusal("abc123")).toBeUndefined();
  expect(githubProvider.refRefusal("deadbeef".repeat(9))).toBeUndefined();
});

it("reads the text after the prefix and URL forms of its host only", () => {
  const text = githubProvider.parseText("acme/skills/skills/pdf");
  expect(text._tag === "Success" && text.success).toEqual({
    repository: "acme/skills",
    transport: "https",
    scope: "skills/pdf",
  });
  const ssh = githubProvider.parseUrl({ kind: "ssh", host: "github.com", path: "acme/skills.git" });
  expect(ssh._tag === "Success" && ssh.success).toEqual({
    repository: "acme/skills",
    transport: "ssh",
  });
  const tree = githubProvider.parseUrl({
    kind: "https",
    host: "github.com",
    path: "acme/skills/tree/main/skills",
  });
  expect(tree._tag === "Success" && tree.success.browse).toEqual({
    kind: "tree",
    segments: ["main", "skills"],
  });
});

it("refuses folder segments that are badly encoded or decode to control text", () => {
  for (const [path, message] of [
    ["acme/skills/tree/main/%E0%A4%A", /plain segments/],
    ["acme/skills/tree/main/a%5Cb", /backslashes or control/],
    ["acme/skills/tree/main/a%00b", /backslashes or control/],
  ] as const) {
    const result = githubProvider.parseUrl({ kind: "https", host: "github.com", path });
    expect(result._tag === "Failure" && result.failure.code, path).toBe("location-scope-invalid");
    expect(result._tag === "Failure" && result.failure.message, path).toMatch(message);
  }
});

it("refuses a blob URL that names no file", () => {
  const result = githubProvider.parseUrl({
    kind: "https",
    host: "github.com",
    path: "acme/skills/blob",
  });

  expect(result._tag === "Failure" && result.failure).toMatchObject({
    code: "location-file-unsupported",
    message: "A file location must end in SKILL.md. Other files are not supported yet.",
  });
});
