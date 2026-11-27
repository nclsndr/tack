import { Yaml } from "../../domain/runtime-neutral.ts";
import { membershipEntries } from "./membership-entries.ts";
import { builtinProfileSourceIds } from "../../domain/profiles/profile-policy.ts";
import { profileHasErrors } from "../../domain/profiles/profile-policy.ts";
import { profileDeliveryCollisions } from "../../domain/profiles/inventory-collisions.ts";
import { Effect, FileSystem, type Context } from "effect";
import type { Profile } from "../../domain/profiles/profile-schema.ts";
import { portableProfile } from "../../domain/profiles/portable-profile.ts";
import { openSelectionCopy } from "./copy-editor.ts";
import { resolveProfile } from "../../domain/profiles/profile-resolution.ts";
import {
  resourceAddressIdentity,
  type ResourceAddress,
} from "../../domain/sources/catalog-schema.ts";
import { profileContext } from "../../features/profiles/profile-check.ts";
import { readProfileFile } from "../../features/sources/profile-files.ts";
import { profilePublications } from "../../features/sources/profile-publications.ts";
import { saveProfile } from "../../features/profiles/profile-save.ts";
import { readInvocationSnapshot } from "../../features/snapshot/command-snapshot.ts";
import type { StateOptions } from "../../services/state-store.ts";
import type { RouteServices } from "../envelope/route-services.ts";
import type { Style } from "../human/style.ts";
import { profileCheckLines } from "../human/profile.ts";
import { initialEditState, type PendingChange } from "./edit.ts";
import { loadExplorer, makeExplorerEditor, type ExplorerEditor } from "./editor.ts";
import type { DestinationOption, OpenableDestination, ProfileDestination } from "./destination.ts";
import { profileLabel } from "./activity.ts";
import { choiceNamespaceIdentity, type Namespace } from "../../domain/choices/choice-schema.ts";
import type { ProfileCopyInput } from "../../features/profiles/profile-copy.ts";
import type { ExplorerEntry, ExplorerState } from "./model.ts";

/** Session effects for changing destinations without leaving the catalog window. */
export type ExplorerDestinations = {
  readonly options: ReadonlyArray<DestinationOption>;
  readonly open: (
    state: ExplorerState,
    destination: OpenableDestination,
  ) => Effect.Effect<{
    readonly state: ExplorerState;
    readonly editor: ExplorerEditor | undefined;
  }>;
};

/** Loads available namespaces and published profiles without changing state. */
export const makeExplorerDestinations = Effect.fnUntraced(function* (options: {
  readonly stateOptions: StateOptions;
  readonly style: Style;
  readonly cwd: string;
  readonly context: Context.Context<RouteServices>;
}) {
  const { stateOptions, style, context } = options;
  const run = <A, E>(effect: Effect.Effect<A, E, RouteServices>) =>
    Effect.provideContext(effect, context);
  const snapshot = yield* readInvocationSnapshot(stateOptions);
  const sources = yield* snapshot.sourceInspections;
  const catalog = yield* snapshot.catalog;
  const applications = snapshot.state.data.profileApplications ?? [];
  const namespaceLabel = (namespace: Namespace) =>
    namespace._tag === "user" ? "user" : namespace.projectName;
  // A fixed selection still opens, read-only; the note says which profile owns it.
  const fixedNote = (namespace: Namespace) => {
    const application = applications.find(
      (item) => choiceNamespaceIdentity(item.namespace) === choiceNamespaceIdentity(namespace),
    );
    return application === undefined
      ? {}
      : {
          note: `fixed by ${profileLabel(catalog, application.sourceRegistrationId, application.profileName)} (read-only)`,
        };
  };
  const daily = (label: string, namespace: Namespace): DestinationOption => ({
    label,
    group: "Daily selections",
    ...fixedNote(namespace),
    destination: namespace,
  });
  const copy = (label: string, input: ProfileCopyInput): DestinationOption => ({
    label,
    group: "Save selection as profile",
    destination: { _tag: "copy", input },
  });
  const destinations: ReadonlyArray<DestinationOption> = [
    { label: "Browse only", destination: { _tag: "browse" } },
    daily("User", { _tag: "user" }),
    ...snapshot.state.data.projects.map((project) =>
      daily(`Project ${project.name}`, { _tag: "project", projectName: project.name }),
    ),
    ...sources.flatMap((source): ReadonlyArray<DestinationOption> =>
      source.status !== "healthy" ||
      source.origin === "builtin" ||
      source.registration.bundle !== undefined
        ? []
        : [
            ...profilePublications(
              source.registration.canonicalPath,
              source.declaration,
            ).publications.map((publication): DestinationOption => {
              const appliedTo = applications
                .filter(
                  (application) =>
                    application.sourceRegistrationId === source.registration.id &&
                    application.profileName === publication.name,
                )
                .map((application) => namespaceLabel(application.namespace));
              return {
                label: profileLabel(catalog, source.registration.id, publication.name),
                group: "Profiles",
                ...(appliedTo.length === 0 ? {} : { note: `applied to ${appliedTo.join(", ")}` }),
                destination: {
                  _tag: "profile",
                  sourcePath: source.registration.canonicalPath,
                  profileName: publication.name,
                  create: false,
                },
              };
            }),
            {
              label: `New profile in ${source.label ?? source.registration.canonicalPath}`,
              group: "Profiles",
              destination: { _tag: "new-profile", sourcePath: source.registration.canonicalPath },
            },
          ],
    ),
    ...[...snapshot.state.data.projects]
      .sort(
        (left, right) =>
          Number(
            right.roots.some((root) => options.cwd === root || options.cwd.startsWith(`${root}/`)),
          ) -
          Number(
            left.roots.some((root) => options.cwd === root || options.cwd.startsWith(`${root}/`)),
          ),
      )
      .flatMap((project): ReadonlyArray<DestinationOption> => [
        copy(`User + project ${project.name} (default)`, { user: true, projectName: project.name }),
        copy(`Project ${project.name} only`, { user: false, projectName: project.name }),
      ]),
    copy("User only", { user: true }),
  ];

  const openProfile = Effect.fnUntraced(function* (
    state: ExplorerState,
    destination: ProfileDestination,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const current = yield* profileContext(stateOptions, destination.sourcePath);
    const sourcePath = current.source.canonicalPath;
    const publication = profilePublications(
      sourcePath,
      current.source.declaration,
    ).publications.find((entry) => entry.name === destination.profileName);
    if (destination.create === true && publication !== undefined)
      return yield* Effect.fail("That profile already exists. Choose its published entry.");
    const loaded =
      publication === undefined
        ? undefined
        : yield* readProfileFile(sourcePath, current.source.declaration, publication);
    if (destination.create === false && loaded?.profile === undefined)
      return yield* Effect.fail(
        loaded?.findings.map((finding) => finding.message).join(" ") ??
          "The profile is no longer published.",
      );
    let profile: Profile = loaded?.profile ?? {
      version: 1,
      name: destination.profileName,
      members: [],
    };
    let expectedContent = loaded === undefined ? undefined : yield* fs.readFileString(loaded.file);
    const file = loaded?.file ?? `${sourcePath}/profiles/${destination.profileName}.yaml`;
    const report = (value: Profile) => {
      const inventory = resolveProfile(value, current.registration.id, current.catalog, file);
      const findings = [
        ...inventory.findings,
        ...(destination.seed === undefined
          ? []
          : profileDeliveryCollisions([...inventory.direct, ...inventory.required]).map((name) => ({
              code: "profile-copy-collision",
              category: "linkage" as const,
              severity: "error" as const,
              file,
              message: `${name} has several owning sources.`,
              remedy: "Narrow membership explicitly before saving; no winner is chosen.",
            }))),
      ];
      return {
        kind: "profile-check" as const,
        sourcePath,
        profileName: value.name,
        structural: "valid" as const,
        ...inventory,
        findings,
        linkage:
          profileHasErrors(findings) === true ? ("incomplete" as const) : ("complete" as const),
      };
    };
    const builtinSources = builtinProfileSourceIds(current.catalog);
    const entryList = yield* loadExplorer(stateOptions, style, {
      _tag: "profile",
      sourcePath,
      profileName: destination.profileName,
    });
    // Rows name membership with the same glyphs and words as every other destination.
    const entriesFor = (value: Profile) => {
      const inventory = report(value);
      const identities = (addresses: ReadonlyArray<ResourceAddress>) =>
        new Set(addresses.map((address) => resourceAddressIdentity(address)));
      const direct = identities(inventory.direct);
      const required = identities(inventory.required);
      return membershipEntries(
        entryList.entries,
        current.catalog,
        inventory.direct.map((address) => ({ address, tags: [] })),
      ).map((entry): ExplorerEntry => {
        if (entry.editable?.kind !== "member" || entry.address === undefined) return entry;
        const identity = resourceAddressIdentity(entry.address);
        return {
          ...entry,
          activity: direct.has(identity)
            ? { active: true, reason: "member" }
            : required.has(identity)
              ? { active: true, reason: "required" }
              : { active: false, reason: "not a member" },
        };
      });
    };
    const portableMember = (address: ResourceAddress) => {
      const portable = portableProfile(
        profile.name,
        current.registration.id,
        [address],
        current.catalog,
      );
      if (portable.findings.length > 0)
        throw new Error(portable.findings.map((finding) => finding.message).join(" "));
      const member = portable.profile.members[0];
      if (member === undefined) throw new Error("Cannot resolve portable member.");
      return member;
    };
    if (destination.seed !== undefined) {
      const portable = portableProfile(
        profile.name,
        current.registration.id,
        destination.seed.map((member) => member.address),
        current.catalog,
      );
      if (portable.findings.length > 0)
        return yield* Effect.fail(portable.findings.map((finding) => finding.message).join(" "));
      profile = portable.profile;
    }
    const staged = (pending: ReadonlyArray<PendingChange>): Profile => {
      const changes = pending.filter(
        (change): change is Extract<PendingChange, { kind: "member" }> =>
          change.kind === "member" &&
          builtinSources.has(change.address.sourceRegistrationId) === false,
      );
      const touched = new Set(changes.map((change) => resourceAddressIdentity(change.address)));
      const retained = profile.members.filter((member) =>
        resolveProfile(
          { ...profile, members: [member] },
          current.registration.id,
          current.catalog,
          file,
        ).direct.every((address) => touched.has(resourceAddressIdentity(address)) === false),
      );
      const members = [
        ...retained,
        ...changes.flatMap((change) => (change.included ? [portableMember(change.address)] : [])),
      ];
      const requiredSources = [
        ...new Set(
          members.flatMap((member) =>
            typeof member === "string" || member.source === undefined ? [] : [member.source],
          ),
        ),
      ];
      return {
        ...profile,
        members,
        "depends-on": [...new Set([...(profile["depends-on"] ?? []), ...requiredSources])],
      };
    };
    const editor: ExplorerEditor = {
      preview: (pending) =>
        Effect.try({
          try: () => [
            ...profileCheckLines(report(staged(pending)), style),
            ...(destination.seed ?? []).map(
              (member) =>
                `${member.address.kind} ${member.address.name} · ${member.origins.join(", ")}`,
            ),
            "",
            `File: ${file}`,
            "--- before",
            ...(expectedContent ?? "(new file)").split(/\r?\n/),
            "+++ after",
            ...Yaml.stringify(staged(pending)).trimEnd().split(/\r?\n/),
            publication === undefined
              ? `Publication: add ${destination.profileName} → profiles/${destination.profileName}.yaml to tack.yaml`
              : "Publication unchanged; explicit membership edit.",
            "",
            "Save writes only this profile and its publication. No picks, registration or delivery changes.",
          ],
          catch: (error) => String(error),
        }).pipe(Effect.catch((error) => Effect.succeed([error]))),
      apply: (pending) =>
        run(
          Effect.gen(function* () {
            const next = yield* Effect.try({
              try: () => staged(pending),
              catch: (error) => String(error),
            });
            if (destination.seed !== undefined) {
              const inventory = report(next);
              const portable = portableProfile(
                next.name,
                current.registration.id,
                [...inventory.direct, ...inventory.required],
                current.catalog,
              );
              if (profileHasErrors(inventory.findings) === true)
                return { lines: profileCheckLines(inventory, style), entries: undefined };
              if (portable.findings.length > 0)
                return {
                  lines: portable.findings.map((finding) => finding.message),
                  entries: undefined,
                };
            }
            const saved = yield* saveProfile(stateOptions, {
              sourcePath: sourcePath,
              profile: next,
              ...(expectedContent === undefined ? {} : { expectedContent }),
            });
            if (saved.saved === false)
              return { lines: profileCheckLines(saved.report, style), entries: undefined };
            profile = next;
            expectedContent = yield* fs.readFileString(file);
            return {
              lines: [`Saved profile ${profile.name}.`, ...profileCheckLines(saved.report, style)],
              entries: entriesFor(profile),
            };
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              lines: [`Cannot save profile: ${String(cause)}`],
              entries: undefined,
            }),
          ),
        ),
    };
    return {
      editor,
      state: {
        ...state,
        entries: entriesFor(profile),
        cursor: 0,
        query: "",
        edit: initialEditState({ ...destination, sourcePath }),
      },
    };
  });
  const open: ExplorerDestinations["open"] = (state, destination) =>
    run(
      destination._tag === "copy"
        ? openSelectionCopy(
            stateOptions,
            style,
            state,
            destination,
            destinations.filter(
              (option) =>
                option.destination._tag === "profile" || option.destination._tag === "new-profile",
            ),
          )
        : destination._tag === "profile"
          ? openProfile(state, destination)
          : destination._tag === "browse"
            ? loadExplorer(stateOptions, style, undefined).pipe(
                Effect.map((loaded): Effect.Success<ReturnType<ExplorerDestinations["open"]>> => {
                  const { edit: _edit, ...readOnly } = state;
                  return {
                    state: { ...readOnly, entries: loaded.entries, cursor: 0, query: "" },
                    editor: undefined,
                  };
                }),
              )
            : loadExplorer(stateOptions, style, destination).pipe(
                Effect.map((loaded) => ({
                  state: {
                    ...state,
                    entries: loaded.entries,
                    cursor: 0,
                    query: "",
                    edit: initialEditState(destination, loaded.fixedBy),
                  },
                  editor: makeExplorerEditor({ ...options, namespace: destination }),
                })),
              ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          state: {
            ...state,
            preview: { title: "Cannot change destination", lines: [String(cause)], offset: 0 },
          },
          editor: undefined,
        }),
      ),
    );
  return { options: destinations, open } satisfies ExplorerDestinations;
});
