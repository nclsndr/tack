---
name: author-tack-profiles
description: Author, publish, inspect and repair fixed Tack profiles. Use for profile files, source linkage, independent membership copies, explicit application and portable content bundles. Use manage-tack-sources for resource declarations and use-tack for daily selection.
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: default
---

# Author Tack profiles

Authoring, checking and source-based application support fixed positive resource manifests. Profiles reference
existing resources; they are not a resource kind.
Use `manage-tack-sources` before changing the owning source, including its maintainers check.

1. Inspect the resources with `tack catalog --details`. Agents use this noninteractive command;
   the terminal explorer is for people. In `tack explore`, press `d` and choose a profile or a
   new profile under Profiles. Profile mode lists opt-in and incompatible resources too, and rows
   show `● member`, `● required` or `○ not a member`. A project the profile is applied to opens
   read-only and says `fixed by SOURCE/PROFILE`. `i` toggles a positive member, `x` removes one, and `c` reviews
   direct and required inventory before save. Destination changes require save, discard or cancel
   when edits are pending. Profile save writes only its file and publication.
2. Publish the file in the owning source's `tack.yaml`, under its `profiles` key. A source
   declaration is version 1, with or without profiles. Any other source version fails before
   resource discovery. A broken profile leaves unrelated resources usable.

```yaml
version: 1
name: tools
skills:
  - path: skills
profiles:
  - name: ci
    path: profiles/ci.yaml
```

3. Write the separately versioned file. Only `version`, `name`, `depends-on` and `members` are
   accepted. The file's name must match its publication. Paths are source-relative regular files
   inside the source, with no dot or parent segments. A profile file inside a declared skills,
   commands, context or docs folder, or on a script, overlaps that entry, and both are refused
   with `declaration-path-overlap` until the folder entry excludes the file or the file moves. A
   docs entry takes no exclude, so a profile inside a docs folder must move.

```yaml
# profiles/ci.yaml
version: 1
name: ci
depends-on: [team]
members:
  - review
  - name: audit
    kind: command
    source: team
```

A bare member always belongs to this profile's own source, even if another source has the same
name. An external member always needs `source`, and that name must appear in the profile's
`depends-on`. Add `kind` when several kinds share a name in that source. Missing members never
retarget. Release-owned skills stay locked in profile and copy editing, just as in daily selections.
External sources need distinct portable names; repair missing or clashing names in
their declarations. Machine-local registration UUIDs and commit pins do not belong in a manifest.
Required dependencies follow each resource's source `depends-on` rules. Optional edges
are not expanded. New defaults never enter a saved profile without an explicit edit.

4. Write the files, run `tack check /absolute/path/to/source /absolute/path/to/companion-source`,
   and repeat until clean. A source folder checks declarations, resources, every profile file and
   docs figures. A profile file can be checked directly with its companion source folders. This
   authoring scope is stateless: it does not read registrations or require state initialization.
   The combined report gives file:line findings, structure, source linkage and direct/required
   inventory. Errors exit 1; warnings exit 0. No scripts, hooks or reader modules run.

For source-based use, required external sources must already be available and registered. Check
does not fetch or register them. A content bundle supplies retained source projections and registers
them locally before delivery, without original source access.

Before application, verify an isolated context and every resolved destination, or list every
root sharing the intent. Scratch HOME/state paths alone do not prove isolation. Existing selection
includes explicit picks/exclusions, owned delivery records and empty/incomplete prior applies;
computed defaults alone do not count. Force replaces that intent only and never bypasses isolation
or foreign-content protection.

## Apply from registered sources

Preview `tack profile apply SOURCE:PROFILE --project PROJECT --target-root /absolute/project`.
Repeat `--target-root` for every registered root of that project. After reviewing the physical
destinations, direct/required members, per-kind roles and additions/removals, repeat with `--apply`.
A fresh target with only computed defaults needs no force. Existing picks, exclusions, docs intent,
owned deliveries, target recovery or a retained empty/incomplete apply require explicit `--force`.
Foreign/changed entries stay protected and incomplete delivery remains visible.

For user application, use `tack profile apply SOURCE:PROFILE --user --target-home /isolated/home`
with matching HOME and an explicit state directory inside that home. Verify adapter/docs parents
resolve inside every authorized root. A different HOME that reuses ordinary state, a parent link
reaching outside the target, or a partial root list refuses even with force. Project application
leaves user paths and other projects alone; ambient user instructions and release skills remain
outside profile control. Docs require a project, context stays inspectable, and scripts remain
explicit-run resources.

Apply retains exact local identities, including empty and incomplete inventories. `tack sync` and
recovery use that inventory without adding new defaults or following later manifest edits. A changed
required closure reports `profile-inventory-unresolved` and needs explicit reapply. Reapply still
requires force when intent exists. Ordinary pick, explore and docs edits in a fixed context refuse
with `profile-fixed-context`; choose a separate daily-selection context. Inspect status and doctor
for intended inventory and incomplete delivery. A member an enabled agent cannot take, such as a
command for Claude Code, is skipped for that agent and still reaches every agent that takes it:
apply lists it under `Skipped for AGENT` with the reason and its plan's `delivery.skipped`, apply and
sync stay successful, and doctor's profiles check passes with a note. With no enabled adapter, or
docs in a user profile, delivery is incomplete: sync and status report `profile-delivery-incomplete`
and doctor's profiles check fails. Profile docs are the same attachments read by docs list/search/serve and writing-target
lookup; ordinary attachment/default mutations remain locked in fixed contexts.

Saves serialize updates to a source. A concurrent save or an intervening file edit produces `profile-save-conflict`; reload before retrying. Temporary staging files are removed on refusal.

## Copy between daily selection and profiles

Built-in release-owned skills are always delivered and locked. Selection copies omit them and say so in preview. A hand-written profile may still name them: check warns with `profile-builtin-omitted`, while adopt/apply skip those members with a note. They do not become picks or fixed inventory. Ordinary resources with the same name in another source remain normal members.

Use `tack profile save /path/to/source NAME --project PROJECT` to preview effective user + one
project membership, its origins and file/publication changes. `--apply` saves only the source
profile. `--input user` and `--input project --project PROJECT` narrow the input; `--edit` explicitly
updates an existing profile. In `tack explore`, the in-window save flow reviews/adjusts members before
source/name choice, then shows the authoring diff before final save. Saving delivers nothing.

Use `tack profile adopt SOURCE:PROFILE --project PROJECT` (or `--user`) to preview a one-time copy
into ordinary includes and applicable docs attachments. `--apply` writes intent without sync,
preserving unrelated picks. Normal defaults and later daily edits still apply; later profile edits
have no effect. User docs and fixed contexts refuse. Scripts remain explicit-run; context keeps its
ordinary selection role. The preview names remaining ordinary delivery blockers.

Follow [copy workflows](references/copy-workflows.md) for CI, VPS and team-sharing walkthroughs,
input narrowing, explicit existing-profile edits and cancellation without writes.

## Port a profile as content

Preview `tack profile export SOURCE:PROFILE /artifacts/profile.tar.gz`, then add `--apply` after
reviewing exact files, integrity facts, support closure and non-secret prerequisites.
Read the manifest with `tack profile inspect-bundle /artifacts/profile.tar.gz` and validate it with
`tack check /artifacts/profile.tar.gz`. Both work offline without local state; inspection is a
content read-out, while check verifies complete projected profile linkage and inventory.
Preview `tack profile apply-bundle /artifacts/profile.tar.gz --project PROJECT --target-root /repo`,
then add `--apply` after complete-target review. It retains content and registers its source
projections before fixed delivery, preserving originals and the same refusal/force contract.

Read [portable content](references/bundles.md) before export/apply: it defines bundle-support,
package/reader completeness, known sensitive paths, bounded archives, pristine-recipient setup,
identity conflicts, immutable payloads and incomplete-delivery recovery. Bundle operations never
execute supplied code, fetch content or install packages.
