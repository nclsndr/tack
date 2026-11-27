import { expect, it } from "vitest";
import type { ProfileApplication } from "../state/profile-application-schema.ts";
import { profileDelivery } from "./profile-delivery.ts";

const source = "00000000-0000-4000-8000-000000000001";

const application = (
  namespace: ProfileApplication["namespace"],
  inventory: ProfileApplication["inventory"],
): ProfileApplication => ({
  namespace,
  profileName: "ci",
  sourceRegistrationId: source,
  direct: inventory,
  inventory,
  targets: ["/work/demo"],
});

it("marks docs in a user profile as blocked because docs need a project", () => {
  const docs = { kind: "docs", name: "guide", sourceRegistrationId: source } as const;

  expect(profileDelivery(application({ _tag: "user" }, [docs]), ["codex"])).toEqual({
    issues: [`docs ${source}:guide: blocked, docs require a project target`],
    notes: [`docs ${source}:guide: blocked, docs require a project target`],
    skipped: [],
    incomplete: true,
  });
  expect(
    profileDelivery(application({ _tag: "project", projectName: "demo" }, [docs]), ["codex"]),
  ).toEqual({
    issues: [],
    notes: [`docs ${source}:guide: project docs mounts`],
    skipped: [],
    incomplete: false,
  });
});

it("skips a member for an agent that cannot take its kind, without making delivery incomplete", () => {
  const skill = { kind: "skill", name: "review", sourceRegistrationId: source } as const;
  const command = { kind: "command", name: "ship", sourceRegistrationId: source } as const;
  const delivery = profileDelivery(
    {
      ...application({ _tag: "project", projectName: "demo" }, [skill, command]),
      targets: ["/work/demo", "/work/demo-worktree"],
    },
    ["claude", "cursor"],
  );

  expect(delivery).toMatchObject({ issues: [], incomplete: false });
  // One skip per member and agent, however many targets the application has.
  expect(delivery.skipped).toEqual([
    {
      member: `command ${source}:ship`,
      adapter: "claude",
      reason: "Tack does not link commands for claude",
    },
  ]);
  expect(delivery.notes).toContain(
    `command ${source}:ship: Tack does not link commands for claude`,
  );
  expect(delivery.notes).toContain(
    `command ${source}:ship: cursor → /work/demo/.cursor/commands/ship.md`,
  );
});

it("marks a linkable resource incomplete when no adapter is enabled", () => {
  const skill = { kind: "skill", name: "review", sourceRegistrationId: source } as const;

  expect(
    profileDelivery(application({ _tag: "project", projectName: "demo" }, [skill]), []),
  ).toEqual({
    issues: [`skill ${source}:review: no enabled adapter`],
    notes: [`skill ${source}:review: no enabled adapter`],
    skipped: [],
    incomplete: true,
  });
});
