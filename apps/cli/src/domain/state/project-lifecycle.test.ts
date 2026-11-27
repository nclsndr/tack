import { describe, expect, it } from "@effect/vitest";
import { agentLink } from "../links/link-record-schema.ts";
import type { ProfileApplication } from "./profile-application-schema.ts";
import { emptyState, type State, type StateProject } from "./state-schema.ts";
import {
  finalizeHandoffs,
  finalizeRoot,
  handOffProject,
  handOffRoot,
  moveProjectRoots,
  removeProject,
} from "./project-lifecycle.ts";

const sourceId = "00000000-0000-4000-8000-000000000001";

const project = (
  name: string,
  roots: ReadonlyArray<string>,
  removingRoots: ReadonlyArray<string> = [],
  removalIntent?: "project",
): StateProject => ({
  gitCommonDirectory: `/git/${name}`,
  name,
  roots,
  removingRoots,
  ...(removalIntent === undefined ? {} : { removalIntent }),
});

const application = (namespace: ProfileApplication["namespace"]): ProfileApplication => ({
  direct: [],
  inventory: [],
  namespace,
  profileName: "team",
  sourceRegistrationId: sourceId,
  targets: [],
});

const userApplication = application({ _tag: "user" });
const demoApplication = application({ _tag: "project", projectName: "demo" });
const otherApplication = application({ _tag: "project", projectName: "other" });

/** An agent link held under one project root. */
const linkAt = (projectName: string, canonicalPath: string) =>
  agentLink({
    adapter: "codex",
    address: {
      kind: "skill",
      name: `alpha-${canonicalPath.replaceAll("/", "-")}`,
      sourceRegistrationId: sourceId,
    },
    sourceDirectoryPath: "/source/alpha",
    sourceRegistrationId: sourceId,
    target: { _tag: "project-root", canonicalPath, projectName },
  });

const stateWith = (
  projects: ReadonlyArray<StateProject>,
  extra: Partial<State["data"]> = {},
): State => ({
  ...emptyState(),
  data: { ...emptyState().data, projects, ...extra },
});

const projectsOf = (state: State) => state.data.projects;

describe("handOffRoot", () => {
  it("moves one active root to the handoff roots in canonical order", () => {
    const state = stateWith([project("demo", ["/a", "/c"], ["/d"]), project("other", ["/o"])]);

    expect(projectsOf(handOffRoot(state, "demo", "/c"))).toEqual([
      project("demo", ["/a"], ["/c", "/d"]),
      project("other", ["/o"]),
    ]);
  });

  it("records the intent to remove the project when the caller requests it", () => {
    const state = stateWith([project("demo", ["/a"])]);

    expect(projectsOf(handOffRoot(state, "demo", "/a", { requestProjectRemoval: true }))).toEqual([
      project("demo", [], ["/a"], "project"),
    ]);
  });

  it("keeps a root that is already handed off once", () => {
    const state = stateWith([project("demo", ["/a"], ["/b"])]);

    expect(projectsOf(handOffRoot(state, "demo", "/b"))).toEqual([project("demo", ["/a"], ["/b"])]);
  });

  it("leaves the state alone for a project that is not registered", () => {
    const state = stateWith([project("demo", ["/a"])]);

    expect(handOffRoot(state, "gone", "/a")).toBe(state);
  });
});

describe("handOffProject", () => {
  it("hands off every root and records the intent to remove the project", () => {
    const state = stateWith([project("demo", ["/c", "/e"], ["/d"])]);

    expect(projectsOf(handOffProject(state, "demo"))).toEqual([
      project("demo", [], ["/c", "/d", "/e"], "project"),
    ]);
  });

  it("leaves the state alone for a project that is not registered", () => {
    const state = stateWith([project("demo", ["/a"])]);

    expect(handOffProject(state, "gone")).toBe(state);
  });
});

describe("moveProjectRoots", () => {
  it("adds, reactivates, hands off and deregisters roots in one move", () => {
    const state = stateWith([project("demo", ["/a", "/b", "/c"], ["/r", "/s"])]);

    const next = moveProjectRoots(state, "demo", {
      additions: ["/z"],
      deregistrations: ["/b"],
      handoffs: ["/c"],
      reactivations: ["/r"],
    });

    expect(projectsOf(next)).toEqual([project("demo", ["/a", "/r", "/z"], ["/c", "/s"])]);
  });

  it("returns the same state when the move changes no root", () => {
    const state = stateWith([project("demo", ["/a"], ["/b"])]);

    expect(moveProjectRoots(state, "demo", { additions: ["/a"] })).toBe(state);
  });

  it("deregisters only active roots and keeps the removal intent", () => {
    const state = stateWith([project("demo", [], ["/a", "/b"], "project")]);

    expect(projectsOf(moveProjectRoots(state, "demo", { deregistrations: ["/a"] }))).toEqual([
      project("demo", [], ["/a", "/b"], "project"),
    ]);
  });

  it("forgets a project left with no root and its fixed profile application", () => {
    const state = stateWith([project("demo", ["/a"]), project("other", ["/o"])], {
      profileApplications: [userApplication, demoApplication, otherApplication],
    });

    const next = moveProjectRoots(state, "demo", { deregistrations: ["/a"] });

    expect(projectsOf(next)).toEqual([project("other", ["/o"])]);
    expect(next.data.profileApplications).toEqual([userApplication, otherApplication]);
  });

  it("leaves the profile applications alone while the project keeps a root", () => {
    const state = stateWith([project("demo", ["/a", "/b"])], {
      profileApplications: [otherApplication],
    });

    const next = moveProjectRoots(state, "demo", { deregistrations: ["/a"] });

    expect(projectsOf(next)).toEqual([project("demo", ["/b"])]);
    expect(next.data.profileApplications).toEqual([otherApplication]);
  });

  it("leaves the state alone for a project that is not registered", () => {
    const state = stateWith([project("demo", ["/a"])]);

    expect(moveProjectRoots(state, "gone", { additions: ["/z"] })).toBe(state);
  });
});

describe("removeProject", () => {
  it("removes the project and its fixed profile application only", () => {
    const state = stateWith([project("demo", ["/a"]), project("other", ["/o"])], {
      profileApplications: [userApplication, demoApplication, otherApplication],
    });

    const next = removeProject(state, "demo");

    expect(projectsOf(next)).toEqual([project("other", ["/o"])]);
    expect(next.data.profileApplications).toEqual([userApplication, otherApplication]);
  });

  it("adds no profile applications to a state that has none", () => {
    const state = stateWith([project("demo", ["/a"])]);

    expect(removeProject(state, "demo").data).not.toHaveProperty("profileApplications");
  });

  it("leaves the state alone for a project that is not registered", () => {
    const state = stateWith([project("demo", ["/a"])], {
      profileApplications: [otherApplication],
    });

    expect(removeProject(state, "gone")).toBe(state);
  });
});

describe("finalizeRoot", () => {
  it("forgets a settled root from the active and handoff roots", () => {
    const state = stateWith([project("demo", ["/a", "/b"], ["/c"])]);

    expect(projectsOf(finalizeRoot(state, "demo", "/b"))).toEqual([
      project("demo", ["/a"], ["/c"]),
    ]);
    expect(projectsOf(finalizeRoot(state, "demo", "/c"))).toEqual([project("demo", ["/a", "/b"])]);
  });

  it("leaves the profile applications alone while the project keeps a root", () => {
    const state = stateWith([project("demo", ["/a", "/b"])], {
      profileApplications: [otherApplication],
    });

    expect(finalizeRoot(state, "demo", "/b").data.profileApplications).toEqual([otherApplication]);
  });

  it("removes the project and its fixed profile application with its last root", () => {
    const state = stateWith([project("demo", [], ["/a"]), project("other", ["/o"])], {
      profileApplications: [userApplication, demoApplication],
    });

    const next = finalizeRoot(state, "demo", "/a");

    expect(projectsOf(next)).toEqual([project("other", ["/o"])]);
    expect(next.data.profileApplications).toEqual([userApplication]);
  });

  it("leaves the state alone for a project that is not registered", () => {
    const state = stateWith([project("demo", ["/a"])]);

    expect(finalizeRoot(state, "gone", "/a")).toBe(state);
  });
});

describe("finalizeHandoffs", () => {
  it("forgets handoff roots that hold no agent link and keeps the others", () => {
    const state = stateWith([project("demo", ["/a"], ["/b", "/c"])], {
      links: [linkAt("demo", "/c")],
    });

    expect(projectsOf(finalizeHandoffs(state))).toEqual([project("demo", ["/a"], ["/c"])]);
  });

  it("removes a removing project with no agent link left, and its fixed profile application", () => {
    const state = stateWith([project("demo", [], ["/b"], "project"), project("other", ["/o"])], {
      profileApplications: [userApplication, demoApplication, otherApplication],
    });

    const next = finalizeHandoffs(state);

    expect(projectsOf(next)).toEqual([project("other", ["/o"])]);
    expect(next.data.profileApplications).toEqual([userApplication, otherApplication]);
  });

  it("keeps every handoff root of a removing project that still holds a link elsewhere", () => {
    const state = stateWith([project("demo", [], ["/b", "/c"], "project")], {
      links: [linkAt("demo", "/elsewhere")],
    });

    expect(finalizeHandoffs(state)).toEqual(state);
  });

  it("finalizes only the selected projects", () => {
    const state = stateWith([project("demo", ["/a"], ["/b"]), project("other", ["/o"], ["/p"])]);

    expect(projectsOf(finalizeHandoffs(state, new Set(["other"])))).toEqual([
      project("demo", ["/a"], ["/b"]),
      project("other", ["/o"]),
    ]);
  });

  it("returns the same state when no project hands off a root", () => {
    const state = stateWith([project("demo", ["/a"])], {
      profileApplications: [otherApplication],
    });

    expect(finalizeHandoffs(state)).toBe(state);
  });
});
