import { membershipEntries } from "./membership-entries.ts";
import { profileDependencyClosure } from "../../../../domain/profiles/profile-closure.ts";
import {
  builtinProfileSourceIds,
  profileControlledAddresses,
} from "../../../../domain/profiles/profile-policy.ts";
import { profileDeliveryCollisions } from "../../../../domain/profiles/inventory-collisions.ts";
import { Effect } from "effect";
import {
  collectProfileInput,
  type ProfileCopyMember,
} from "../../../../features/profiles/profile-copy.ts";
import { readInvocationSnapshot } from "../../../../features/snapshot/command-snapshot.ts";
import { resourceAddressIdentity } from "../../../../domain/sources/catalog-schema.ts";
import {
  resolutionIsUnresolved,
  selectedDependencyAddresses,
} from "../../../../domain/choices/dependency-resolution.ts";
import type { StateOptions } from "../../../../services/state-store.ts";
import type { Style } from "../style.ts";
import type { CopyDestination, DestinationOption } from "./destination.ts";
import type { ExplorerState } from "./model.ts";
import { loadExplorer, type ExplorerEditor } from "./editor.ts";
import { initialEditState, type PendingChange } from "./edit.ts";

/** Reviews and adjusts a copy before choosing its source/name; confirmation here writes nothing. */
export const openSelectionCopy = Effect.fnUntraced(function* (
  stateOptions: StateOptions,
  style: Style,
  state: ExplorerState,
  destination: CopyDestination,
  targets: ReadonlyArray<DestinationOption>,
) {
  const snapshot = yield* readInvocationSnapshot(stateOptions);
  const catalog = yield* snapshot.catalog;
  const input = yield* collectProfileInput(snapshot, destination.input);
  const builtinSources = builtinProfileSourceIds(catalog);
  const loaded = yield* loadExplorer(stateOptions, style, undefined);
  const originals = new Map(
    input.members.map((member) => [resourceAddressIdentity(member.address), member]),
  );
  const entries = membershipEntries(
    loaded.entries,
    catalog,
    input.members.map((member) => ({ address: member.address, tags: member.origins })),
  );
  const staged = (pending: ReadonlyArray<PendingChange>) => {
    const members = new Map(originals);
    for (const change of pending) {
      if (
        change.kind !== "member" ||
        builtinSources.has(change.address.sourceRegistrationId) === true
      )
        continue;
      const key = resourceAddressIdentity(change.address);
      if (change.included)
        members.set(
          key,
          originals.get(key) ?? { address: change.address, origins: ["explicit adjustment"] },
        );
      else members.delete(key);
    }
    const addresses = [...members.values()].map((member) => member.address);
    const closure = profileDependencyClosure(catalog, addresses);
    const controlled = new Set(
      profileControlledAddresses(
        catalog,
        [...members.values()].map((member) => member.address),
      ).map(resourceAddressIdentity),
    );
    for (const [key] of members) if (controlled.has(key) === false) members.delete(key);
    for (const address of profileControlledAddresses(catalog, selectedDependencyAddresses(closure)))
      if (members.has(resourceAddressIdentity(address)) === false)
        members.set(resourceAddressIdentity(address), {
          address,
          origins: ["required dependency"],
        });
    const findings = input.findings.filter((finding) => finding.code !== "profile-copy-collision");
    if (resolutionIsUnresolved(closure))
      findings.push({
        code: "profile-copy-required",
        message:
          "Required closure is blocked. Repair missing/ambiguous dependencies before saving.",
      });
    findings.push(
      ...profileDeliveryCollisions([...members.values()].map((member) => member.address)).map(
        (name) => ({
          code: "profile-copy-collision",
          message: `${name} has several owning sources. Narrow membership explicitly before saving.`,
        }),
      ),
    );
    return { members: [...members.values()] as ReadonlyArray<ProfileCopyMember>, findings };
  };
  const linesFor = (pending: ReadonlyArray<PendingChange>) => {
    const next = staged(pending);
    return [
      `Input: ${[...(destination.input.user ? ["user"] : []), ...(destination.input.projectName === undefined ? [] : [`project ${destination.input.projectName}`])].join(" + ")}`,
      "Exact identities are folded once; levels have no precedence. Required dependencies are included.",
      ...input.notes,
      ...next.members.map(
        (member) =>
          `${member.address.kind} ${member.address.sourceRegistrationId}:${member.address.name} · ${member.origins.join(", ")}`,
      ),
      ...next.findings.map((finding) => `${finding.code}: ${finding.message}`),
      "",
      "Docs need project attachments on adoption; scripts remain explicit-run resources; context keeps its ordinary selection role.",
      "Confirm to choose source and name, then review the file/publication diff. Nothing has been written.",
    ];
  };
  const opened: ExplorerState = {
    ...state,
    entries,
    cursor: 0,
    query: "",
    edit: initialEditState(destination),
  };
  const editor: ExplorerEditor = {
    preview: (pending) => Effect.succeed(linesFor(pending)),
    apply: (pending) => {
      const next = staged(pending);
      if (next.findings.length > 0)
        return Effect.succeed({ lines: linesFor(pending), entries: undefined });
      return Effect.succeed({
        lines: [],
        entries: undefined,
        nextState: {
          ...opened,
          edit: {
            ...initialEditState(destination),
            pending: new Map(
              pending.map((change) => [
                entries.find(
                  (entry) =>
                    entry.address !== undefined &&
                    change.kind === "member" &&
                    resourceAddressIdentity(entry.address) ===
                      resourceAddressIdentity(change.address),
                )?.id ?? "",
                change,
              ]),
            ),
          },
          destinationMenu: {
            phase: "choose",
            cursor: 0,
            title: "Choose destination source and profile (existing entries are explicit edits)",
            options: targets.map((option) => ({
              ...option,
              destination: { ...option.destination, seed: next.members },
            })),
          },
        },
      });
    },
  };
  return { state: opened, editor };
});
