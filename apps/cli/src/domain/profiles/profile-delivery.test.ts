import { expect, it } from "vitest";
import type { ProfileApplication } from "./profile-application.ts";
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
    incomplete: true,
  });
  expect(
    profileDelivery(application({ _tag: "project", projectName: "demo" }, [docs]), ["codex"]),
  ).toEqual({
    issues: [],
    notes: [`docs ${source}:guide: project docs mounts`],
    incomplete: false,
  });
});

it("marks a linkable resource incomplete when no adapter is enabled", () => {
  const skill = { kind: "skill", name: "review", sourceRegistrationId: source } as const;

  expect(
    profileDelivery(application({ _tag: "project", projectName: "demo" }, [skill]), []),
  ).toEqual({
    issues: [`skill ${source}:review: no enabled adapter`],
    notes: [`skill ${source}:review: no enabled adapter`],
    incomplete: true,
  });
});
