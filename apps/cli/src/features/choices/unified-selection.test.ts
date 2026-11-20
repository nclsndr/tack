import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  resolveInitialSelection,
  resolveNamespaceSelection,
} from "../../domain/choices/selection.ts";
import {
  resolveDependencyClosure,
  selectedDependencyAddresses,
} from "../../domain/choices/dependency-resolution.ts";
import {
  SelectableAddressSchema,
  type SelectableCatalogEntry,
  type LinkableCatalogEntry,
} from "../../domain/sources/catalog-schema.ts";

const namespace = { _tag: "project", projectName: "project" } as const;
const resource = (kind: "skill" | "command", name: string): LinkableCatalogEntry => {
  const common = {
    activation: "default" as const,
    address: { kind, name, sourceRegistrationId: "00000000-0000-4000-8000-000000000001" },
    dependencies: [],
    projects: [],
    directoryPath: `/source/${kind}/${name}`,
    sourcePath: "/source",
    sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
  };
  return kind === "skill"
    ? {
        ...common,
        address: { ...common.address, kind },
        description: name,
        frontmatter: { name, description: name },
        skillFilePath: `${common.directoryPath}/SKILL.md`,
      }
    : {
        ...common,
        address: { ...common.address, kind },
        frontmatter: {},
        filePath: `${common.directoryPath}.md`,
      };
};

it.each(["project", "user"] as const)(
  "selects context only through a positive choice in %s",
  (scope) => {
    const context: SelectableCatalogEntry = {
      address: {
        kind: "context",
        name: "notes/design.md",
        sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
      },
      directoryPath: "/source/context/notes",
      filePath: "/source/context/notes/design.md",
      sourcePath: "/source",
      sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
    };
    const selectedNamespace = scope === "project" ? namespace : { _tag: "user" as const };
    for (const decision of [undefined, "exclude", "include"] as const) {
      const selected = resolveInitialSelection({
        entries: [context],
        namespace: selectedNamespace,
        choices:
          decision === undefined
            ? []
            : [{ namespace: selectedNamespace, address: context.address, decision }],
      });
      const closure = resolveDependencyClosure({
        entries: [context],
        includeOptional: true,
        initialSelection: selected,
        quarantined: [],
      });
      expect(selectedDependencyAddresses(closure)).toEqual(
        decision === "include" ? [context.address] : [],
      );
    }
    expect(() =>
      Schema.decodeUnknownSync(SelectableAddressSchema)({
        kind: "script",
        name: "run",
      }),
    ).toThrow();
  },
);

it("applies independent command activation, compatibility, and choice precedence", () => {
  const command = { ...resource("command", "review"), projects: ["other"] };
  for (const decision of [undefined, "include", "exclude"] as const) {
    const selected = resolveInitialSelection({
      entries: [command],
      namespace,
      choices: decision === undefined ? [] : [{ namespace, address: command.address, decision }],
    });
    expect(selected.decisions[0]).toMatchObject(
      decision === "include"
        ? { _tag: "selected", compatibility: "forced", reason: "include" }
        : {
            _tag: "not-selected",
            reason: decision === "exclude" ? "exclude" : "project-incompatible",
          },
    );
  }
  const global = resolveInitialSelection({
    entries: [command],
    namespace: { _tag: "user" },
    choices: [],
  });
  expect(global.decisions[0]).toMatchObject({ _tag: "not-selected", reason: "opt-in" });
  const globalDefault = resolveInitialSelection({
    entries: [{ ...command, userActivation: "default" }],
    namespace: { _tag: "user" },
    choices: [],
  });
  expect(globalDefault.decisions[0]).toMatchObject({ _tag: "selected", reason: "default" });
});

it("closes mixed skill-command cycles and adds optional command closure only on request", () => {
  const skill = resource("skill", "review");
  const command = resource("command", "review");
  const optional = resource("command", "extra");
  const entries = [
    { ...skill, dependencies: [command.address, { ...optional.address, optional: true as const }] },
    { ...command, activation: "opt-in" as const, dependencies: [skill.address] },
    { ...optional, activation: "opt-in" as const },
  ];
  const initialSelection = resolveInitialSelection({ entries, namespace, choices: [] });
  const required = resolveDependencyClosure({
    entries,
    initialSelection,
    includeOptional: false,
    quarantined: [],
  });
  expect(required.groups).toEqual([
    { _tag: "selected", members: [command.address, skill.address] },
  ]);
  const withOptional = resolveDependencyClosure({
    entries,
    initialSelection,
    includeOptional: true,
    quarantined: [],
  });
  expect(selectedDependencyAddresses(withOptional)).toContainEqual(optional.address);
  const excluded = resolveInitialSelection({
    entries,
    namespace,
    choices: [{ namespace, address: command.address, decision: "exclude" }],
  });
  const blocked = resolveDependencyClosure({
    entries,
    initialSelection: excluded,
    includeOptional: false,
    quarantined: [],
  });
  expect(selectedDependencyAddresses(blocked)).toEqual([]);
  expect(blocked.groups[0]).toMatchObject({
    _tag: "blocked",
    blockers: [{ _tag: "required-excluded", dependency: command.address }],
  });
});

it("composes initial selection and dependency closure once per namespace", () => {
  const skill = resource("skill", "review");
  const optional = resource("command", "extra");
  const entries = [
    { ...skill, dependencies: [{ ...optional.address, optional: true as const }] },
    { ...optional, activation: "opt-in" as const },
  ];
  const choices = [{ namespace, address: skill.address, decision: "include" as const }];
  for (const includeOptional of [false, true]) {
    const selection = resolveInitialSelection({ entries, namespace, choices });
    expect(
      resolveNamespaceSelection({
        catalog: { entries, quarantined: [] },
        choices,
        includeOptional,
        namespace,
      }),
    ).toEqual({
      resolution: resolveDependencyClosure({
        entries,
        includeOptional,
        initialSelection: selection,
        quarantined: [],
      }),
      selection,
    });
  }
});
