import { pendingRemovalsOf } from "../../domain/links/link-record-schema.ts";
import { mutateStateFixture, withStateFixture } from "../../../test/support/state-fixture.ts";
import { LiveTestLayer } from "../../../test/support/live-test-layer.ts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  AgentAdapterIdSchema,
  AgentAdapterDescriptorSchema,
  AgentCapabilityDecisionSchema,
  AgentCapabilitySchema,
  EnabledAdaptersSchema,
  type AgentAdapterDescriptor,
  type AgentCapabilityDecision,
} from "../../domain/links/agent-adapter-schema.ts";
import {
  agentAdapterDescriptor,
  agentAdapterDescriptors,
  agentAdapterIds,
  resolveAdapterCapability,
} from "../../domain/agents/agent-adapter.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { disableAdapter } from "../maintenance/adapter-disablement.ts";
import {
  AdapterNotEnabledError,
  AgentDisablementRequiredError,
  enableAdapters,
  listEnabledAdapters,
  resolveEffectiveAdapters,
} from "./agent.ts";
import { managedLinkDestinationPath } from "../../domain/agents/agent-layout.ts";
import { readState } from "../../services/state-store.ts";
import { emptyState, StateSchema } from "../../domain/state/state-schema.ts";

const descriptor = (
  id: AgentAdapterDescriptor["id"],
  capabilities: AgentAdapterDescriptor["capabilities"],
): AgentAdapterDescriptor => ({
  capabilities,
  id,
  projectSkillDirectory: [`.${id}`, "skills"],
  userSkillDirectory: [`.${id}`, "skills"],
});

it("advertises strict schema-derived adapter IDs and capabilities", () => {
  expect(Schema.encodeSync(AgentAdapterIdSchema)("claude")).toBe("claude");
  expect(Schema.encodeSync(AgentAdapterIdSchema)("cursor")).toBe("cursor");
  expect(Schema.encodeSync(AgentCapabilitySchema)("skill-links")).toBe("skill-links");
  expect(
    Schema.encodeSync(Schema.Array(AgentAdapterDescriptorSchema))(agentAdapterDescriptors),
  ).toEqual(agentAdapterDescriptors);
  // The table lists each adapter once, in canonical code-unit order.
  expect(agentAdapterIds).toEqual([...agentAdapterIds].sort(compareCodeUnits));
});

it("rejects malformed or excess adapter descriptor fields", () => {
  const decode = Schema.decodeUnknownSync(AgentAdapterDescriptorSchema, {
    onExcessProperty: "error",
  });

  expect(() =>
    decode({
      capabilities: ["skill-links"],
      id: "cursor",
      projectSkillDirectory: [".cursor", "skills"],
      userSkillDirectory: [".cursor", "skills"],
      version: 1,
    }),
  ).toThrow();
  expect(() =>
    decode({
      capabilities: ["skill-links"],
      id: "cursor",
      projectSkillDirectory: ["/outside"],
      userSkillDirectory: [".cursor", "skills"],
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AgentAdapterDescriptorSchema)({
      capabilities: ["skill-links", "skill-links"],
      id: "cursor",
      projectSkillDirectory: [".cursor", "skills"],
      userSkillDirectory: [".cursor", "skills"],
    }),
  ).toThrow();
  expect(() => Schema.decodeUnknownSync(EnabledAdaptersSchema)(["cursor", "codex"])).toThrow();
  expect(() => Schema.decodeUnknownSync(EnabledAdaptersSchema)(["codex", "codex"])).toThrow();
});

it("resolves a required capability as supported or blocked", () => {
  const unsupported = descriptor("cursor", []);

  const decisions: ReadonlyArray<AgentCapabilityDecision> = [
    resolveAdapterCapability(agentAdapterDescriptor("codex"), "skill-links"),
    resolveAdapterCapability(agentAdapterDescriptor("claude"), "command-links"),
    resolveAdapterCapability(unsupported, "skill-links"),
  ];

  expect(decisions).toEqual([
    { _tag: "supported", capability: "skill-links" },
    { _tag: "blocked", capability: "command-links" },
    { _tag: "blocked", capability: "skill-links" },
  ]);
  expect(() =>
    Schema.decodeUnknownSync(AgentCapabilityDecisionSchema)({
      _tag: "skipped",
      capability: "skill-links",
    }),
  ).toThrow();
});

it("returns a total descriptor for every closed adapter ID", () => {
  for (const id of AgentAdapterIdSchema.literals) {
    expect(agentAdapterDescriptor(id).id).toBe(id);
  }
  expect(agentAdapterDescriptor("claude")).toEqual({
    capabilities: ["skill-links"],
    id: "claude",
    projectSkillDirectory: [".claude", "skills"],
    userSkillDirectory: [".claude", "skills"],
  });
});

it("rejects invalid persisted adapter ordering and retains initial state compatibility", () => {
  const decode = Schema.decodeUnknownSync(StateSchema, { onExcessProperty: "error" });

  const withAdapters = (enabledAdapters: ReadonlyArray<string>) => ({
    data: { ...emptyState().data, enabledAdapters },
    version: 1,
  });
  expect(() => decode(withAdapters(["cursor", "codex"]))).toThrow();
  expect(() => decode(withAdapters(["codex", "codex"]))).toThrow();
  expect(decode(emptyState())).toEqual(emptyState());
});

it.layer(LiveTestLayer)("agent selection", (agentIt) => {
  agentIt.effect("lists an empty initial set and persists canonical unique enablement", () =>
    withStateFixture(({ options }) =>
      Effect.gen(function* () {
        expect(yield* listEnabledAdapters(options)).toEqual([]);

        const result = yield* enableAdapters(options, ["cursor", "claude", "codex"]);

        expect(result).toEqual({
          changed: true,
          enabledAdapters: ["claude", "codex", "cursor"],
        });
        expect(yield* listEnabledAdapters(options)).toEqual(["claude", "codex", "cursor"]);
      }),
    ),
  );

  agentIt.effect("makes equivalent enablement mutation a byte-preserving no-op", () =>
    withStateFixture(({ options, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* enableAdapters(options, ["cursor", "codex"]);
        const before = yield* fileSystem.readFileString(statePath);

        const result = yield* enableAdapters(options, ["codex", "cursor"]);

        expect(result).toEqual({
          changed: false,
          enabledAdapters: ["codex", "cursor"],
        });
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );

  agentIt.effect("rejects duplicate or unknown adapters without changing persisted state", () =>
    withStateFixture(({ options, statePath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const before = yield* fileSystem.readFileString(statePath);
        const duplicate = yield* Effect.flip(enableAdapters(options, ["cursor", "cursor"]));
        const unknown = yield* Effect.flip(enableAdapters(options, ["windsurf"]));

        expect(duplicate).toMatchObject({ code: "enabled-adapters-invalid" });
        expect(unknown).toMatchObject({ code: "enabled-adapters-invalid" });
        expect(yield* fileSystem.readFileString(statePath)).toBe(before);
      }),
    ),
  );

  agentIt.effect("keeps state enablement independent from environment values", () =>
    withStateFixture(({ options }) =>
      Effect.gen(function* () {
        const result = yield* enableAdapters(
          {
            ...options,
            environment: { ...options.environment, TACK_ADAPTERS: "cursor" },
          },
          ["codex"],
        );

        expect(result.enabledAdapters).toEqual(["codex"]);
        expect(yield* listEnabledAdapters(options)).toEqual(["codex"]);
      }),
    ),
  );

  agentIt.effect("preserves initial state compatibility and schema round trips", () =>
    withStateFixture(({ options }) =>
      Effect.gen(function* () {
        const state = yield* readState(options);
        expect(state.data.enabledAdapters).toEqual([]);
        yield* enableAdapters(options, ["cursor"]);
        expect((yield* readState(options)).data.enabledAdapters).toEqual(["cursor"]);
      }),
    ),
  );

  agentIt.effect(
    "rejects re-enablement while an adapter-disable retry can remove the desired link",
    () =>
      withStateFixture(({ options, root }) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sourcePath = path.join(root, "source");
          const userRootPath = path.join(root, "user");
          yield* fileSystem.makeDirectory(sourcePath, { recursive: true });
          yield* fileSystem.makeDirectory(userRootPath, { recursive: true });
          const sourceDirectoryPath = yield* fileSystem.realPath(sourcePath);
          const userRoot = yield* fileSystem.realPath(userRootPath);
          const evidence = {
            adapter: "cursor" as const,
            address: {
              kind: "skill" as const,
              name: "alpha",
              sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
            },
            sourceDirectoryPath,
            sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
            target: { _tag: "user" as const, canonicalPath: userRoot },
          };
          const destinationPath = managedLinkDestinationPath(evidence);
          yield* fileSystem.makeDirectory(path.dirname(destinationPath), { recursive: true });
          yield* fileSystem.writeFileString(destinationPath, "foreign");
          yield* mutateStateFixture(options, (state) => ({
            ...state,
            data: {
              ...state.data,
              enabledAdapters: ["cursor"],
              agentLinks: [evidence],
            },
          }));

          const disabled = yield* disableAdapter(options, "cursor", { apply: true });
          expect(disabled.plan.removal.actions[0]?.["_tag"]).toBe("blocked");
          const blockedState = yield* readState(options);
          expect(blockedState.data.enabledAdapters ?? []).toEqual([]);
          expect(pendingRemovalsOf(blockedState.data.links)[0]).toMatchObject({
            cause: "adapter-disable",
            evidence,
          });

          const error = yield* Effect.flip(enableAdapters(options, ["cursor"]));

          expect(error).toBeInstanceOf(AgentDisablementRequiredError);
          expect(error).toMatchObject({
            adapters: ["cursor"],
            code: "adapter-reenablement-blocked",
          });
          expect(yield* readState(options)).toEqual(blockedState);

          yield* fileSystem.remove(destinationPath);
          yield* fileSystem.symlink(
            path.relative(path.dirname(destinationPath), sourceDirectoryPath),
            destinationPath,
          );
          const retried = yield* disableAdapter(options, "cursor", { apply: true });
          expect(retried.applied?.removal.actions[0]?.["_tag"]).toBe("applied");
          expect(yield* fileSystem.exists(destinationPath)).toBe(false);
          expect(pendingRemovalsOf((yield* readState(options)).data.links)).toEqual([]);

          expect(yield* enableAdapters(options, ["cursor"])).toEqual({
            changed: true,
            enabledAdapters: ["cursor"],
          });
        }),
      ),
  );
});

it("uses persisted adapters unless an invocation override is explicitly supplied", () => {
  const persisted = ["codex", "cursor"] as const;
  const resolve = (options: Parameters<typeof resolveEffectiveAdapters>[1]) =>
    Effect.runSync(resolveEffectiveAdapters(persisted, options));
  expect(resolve({})).toEqual(["codex", "cursor"]);
  expect(resolve({ adapterOverride: ["cursor", "codex"] })).toEqual(["codex", "cursor"]);
  expect(resolve({ adapterOverride: ["cursor"] })).toEqual(["cursor"]);
  expect(resolve({ adapterOverride: [] })).toEqual([]);
  expect(persisted).toEqual(["codex", "cursor"]);
});

it("refuses an invocation override that names an adapter the machine has not enabled", () => {
  const error = Effect.runSync(
    Effect.flip(
      resolveEffectiveAdapters(["cursor"], { adapterOverride: ["opencode", "cursor", "claude"] }),
    ),
  );
  expect(error).toBeInstanceOf(AdapterNotEnabledError);
  expect(error).toMatchObject({
    adapters: ["claude", "opencode"],
    code: "adapter-not-enabled",
    enabledAdapters: ["cursor"],
  });
});
