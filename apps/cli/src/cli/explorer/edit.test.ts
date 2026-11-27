import { describe, expect, it } from "vitest";
import type { State } from "../../domain/state/state-schema.ts";
import { destinationText, stagedState } from "./edit.ts";

const sourceRegistrationId = "00000000-0000-4000-8000-000000000001";
const skill = (name: string) => ({ kind: "skill", name, sourceRegistrationId }) as const;
const docs = (name: string) => ({ sourceRegistrationId, name }) as const;

const state = (overrides: Partial<State["data"]> = {}): State => ({
  format: 1,
  data: {
    enabledAdapters: [],
    userChoices: [],
    links: [],
    projects: [],
    sources: [],
    ...overrides,
  },
});

describe("destination text", () => {
  it("names which selections a copy saves", () => {
    const copy = (input: { user: boolean; projectName?: string }) =>
      destinationText({ _tag: "copy", input });
    expect(copy({ user: true, projectName: "demo" })).toBe("save selection: user + project demo");
    expect(copy({ user: false, projectName: "demo" })).toBe("save selection: project demo");
    expect(copy({ user: true })).toBe("save selection: user");
  });
});

describe("staged state", () => {
  it("replaces or drops the user's existing choice for a staged address", () => {
    const before = state({
      userChoices: [
        { address: skill("lint"), decision: "include" },
        { address: skill("review"), decision: "include" },
      ],
    });
    const staged = stagedState(before, { _tag: "user" }, [
      { kind: "choice", address: skill("review"), decision: "unset" },
      { kind: "choice", address: skill("lint"), decision: "exclude" },
    ]);
    expect(staged.data.userChoices).toEqual([{ address: skill("lint"), decision: "exclude" }]);
  });

  it("ignores a docs change outside a project", () => {
    const before = state();
    expect(
      stagedState(before, { _tag: "user" }, [
        { kind: "docs", resource: docs("guide"), attached: true },
      ]),
    ).toEqual(before);
  });

  it("keeps the writing default while another attachment is detached, and drops it with its own", () => {
    const before = state({
      projects: [
        {
          name: "demo",
          gitCommonDirectory: "/home/me/demo/.git",
          roots: ["/home/me/demo"],
          removingRoots: [],
          docs: { attachments: [{ ...docs("guide"), writingDefault: true }, docs("notes")] },
        },
      ],
    });
    const project = { _tag: "project", projectName: "demo" } as const;
    const attachments = (changes: Parameters<typeof stagedState>[2]) =>
      stagedState(before, project, changes).data.projects[0]?.docs?.attachments;
    expect(attachments([{ kind: "docs", resource: docs("notes"), attached: false }])).toEqual([
      { ...docs("guide"), writingDefault: true },
    ]);
    expect(attachments([{ kind: "docs", resource: docs("guide"), attached: false }])).toEqual([
      docs("notes"),
    ]);
    expect(attachments([{ kind: "docs", resource: docs("extra"), attached: true }])).toEqual([
      { ...docs("guide"), writingDefault: true },
      docs("notes"),
      docs("extra"),
    ]);
  });
});
