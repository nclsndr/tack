import { expect, it } from "vitest";
import { agentAdapterDescriptors } from "./agent-adapter.ts";
import {
  agentLinkFolders,
  deliversKind,
  managedLinkDestinationPath,
  resourceDirectory,
  resourceName,
} from "./agent-layout.ts";

const targets = [
  { _tag: "user", canonicalPath: "/home/operator" },
  { _tag: "project-root", canonicalPath: "/work/repo" },
] as const;

const kinds = ["skill", "command"] as const;

it("derives delivery from adapter directories in agreement with advertised capabilities", () => {
  const disagreements = agentAdapterDescriptors.flatMap((descriptor) =>
    targets.flatMap((target) =>
      kinds.flatMap((kind) => {
        const advertised = descriptor.capabilities.some(
          (capability) => capability === (kind === "skill" ? "skill-links" : "command-links"),
        );
        return deliversKind(descriptor, target, kind) === advertised
          ? []
          : [`${descriptor.id}/${target._tag}/${kind}`];
      }),
    ),
  );

  expect(disagreements).toEqual([]);
});

it("derives every directory and destination from one adapter and target layout", () => {
  const [user, project] = targets;

  expect(resourceDirectory("claude", user, "skill")).toBe("/home/operator/.claude/skills");
  expect(resourceDirectory("codex", project, "skill")).toBe("/work/repo/.agents/skills");
  expect(resourceDirectory("cursor", project, "skill")).toBe("/work/repo/.cursor/skills");
  expect(resourceDirectory("cursor", user, "command")).toBe("/home/operator/.cursor/commands");
  expect(resourceDirectory("claude", user, "command")).toBeUndefined();
  expect(resourceName({ kind: "command", name: "review" })).toBe("review.md");
  expect(resourceName({ kind: "skill", name: "review" })).toBe("review");
  expect(
    managedLinkDestinationPath({
      adapter: "cursor",
      address: { kind: "command", name: "review" },
      target: project,
    }),
  ).toBe("/work/repo/.cursor/commands/review.md");
  expect(
    managedLinkDestinationPath({
      adapter: "claude",
      address: { kind: "skill", name: "review" },
      target: { _tag: "user", canonicalPath: "/" },
    }),
  ).toBe("/.claude/skills/review");
});

it.each([
  ["cline", "user", "skill", "/home/operator/.cline/skills"],
  ["cline", "user", "command", "/home/operator/Documents/Cline/Workflows"],
  ["cline", "project-root", "skill", "/work/repo/.cline/skills"],
  ["cline", "project-root", "command", "/work/repo/.clinerules/workflows"],
  ["copilot", "user", "skill", "/home/operator/.copilot/skills"],
  ["copilot", "project-root", "skill", "/work/repo/.github/skills"],
  ["gemini", "user", "skill", "/home/operator/.gemini/skills"],
  ["gemini", "project-root", "skill", "/work/repo/.gemini/skills"],
  ["junie", "user", "skill", "/home/operator/.junie/skills"],
  ["junie", "user", "command", "/home/operator/.junie/commands"],
  ["junie", "project-root", "skill", "/work/repo/.junie/skills"],
  ["junie", "project-root", "command", "/work/repo/.junie/commands"],
  ["opencode", "user", "skill", "/home/operator/.config/opencode/skills"],
  ["opencode", "user", "command", "/home/operator/.config/opencode/commands"],
  ["opencode", "project-root", "skill", "/work/repo/.opencode/skills"],
  ["opencode", "project-root", "command", "/work/repo/.opencode/commands"],
  ["pi", "user", "skill", "/home/operator/.pi/agent/skills"],
  ["pi", "user", "command", "/home/operator/.pi/agent/prompts"],
  ["pi", "project-root", "skill", "/work/repo/.pi/skills"],
  ["pi", "project-root", "command", "/work/repo/.pi/prompts"],
] as const)(
  "places %s %s %s links in the agent's native folder",
  (adapter, tag, kind, directory) => {
    const target = targets.find((candidate) => candidate._tag === tag) ?? targets[0];

    expect(resourceDirectory(adapter, target, kind)).toBe(directory);
  },
);

it.each([
  ["copilot", "user"],
  ["copilot", "project-root"],
  ["gemini", "user"],
  ["gemini", "project-root"],
] as const)("leaves %s %s commands undelivered", (adapter, tag) => {
  const target = targets.find((candidate) => candidate._tag === tag) ?? targets[0];

  expect(resourceDirectory(adapter, target, "command")).toBeUndefined();
});

it("gives every adapter folders of its own, so no two adapters plan the same link", () => {
  const folders = agentLinkFolders(targets);

  expect(new Set(folders).size).toBe(folders.length);
});

it("places a Pi command as a direct Markdown child of the prompts folder", () => {
  expect(
    managedLinkDestinationPath({
      adapter: "pi",
      address: { kind: "command", name: "review" },
      target: targets[1],
    }),
  ).toBe("/work/repo/.pi/prompts/review.md");
});

it("places a Junie command as a Markdown file named after the command", () => {
  expect(
    managedLinkDestinationPath({
      adapter: "junie",
      address: { kind: "command", name: "review" },
      target: targets[1],
    }),
  ).toBe("/work/repo/.junie/commands/review.md");
});

it("refuses to place a managed link for a kind the adapter does not deliver", () => {
  expect(() =>
    managedLinkDestinationPath({
      adapter: "claude",
      address: { kind: "command", name: "review" },
      target: targets[0],
    }),
  ).toThrow("Managed-link evidence requires a supported adapter destination.");
});

it("lists every folder that may hold managed links for the user and each project root", () => {
  expect(
    agentLinkFolders([
      { _tag: "user", canonicalPath: "/home/ada" },
      { _tag: "project-root", canonicalPath: "/work/demo" },
    ]),
  ).toEqual([
    "/home/ada/.claude/skills",
    "/home/ada/.cline/skills",
    "/home/ada/Documents/Cline/Workflows",
    "/home/ada/.agents/skills",
    "/home/ada/.copilot/skills",
    "/home/ada/.cursor/skills",
    "/home/ada/.cursor/commands",
    "/home/ada/.gemini/skills",
    "/home/ada/.junie/skills",
    "/home/ada/.junie/commands",
    "/home/ada/.config/opencode/skills",
    "/home/ada/.config/opencode/commands",
    "/home/ada/.pi/agent/skills",
    "/home/ada/.pi/agent/prompts",
    "/work/demo/.claude/skills",
    "/work/demo/.cline/skills",
    "/work/demo/.clinerules/workflows",
    "/work/demo/.agents/skills",
    "/work/demo/.github/skills",
    "/work/demo/.cursor/skills",
    "/work/demo/.cursor/commands",
    "/work/demo/.gemini/skills",
    "/work/demo/.junie/skills",
    "/work/demo/.junie/commands",
    "/work/demo/.opencode/skills",
    "/work/demo/.opencode/commands",
    "/work/demo/.pi/skills",
    "/work/demo/.pi/prompts",
  ]);
});
