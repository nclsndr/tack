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
    "/home/ada/.agents/skills",
    "/home/ada/.cursor/skills",
    "/home/ada/.cursor/commands",
    "/work/demo/.claude/skills",
    "/work/demo/.agents/skills",
    "/work/demo/.cursor/skills",
    "/work/demo/.cursor/commands",
  ]);
});
