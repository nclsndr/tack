# Copy workflows

Saving, adopting and applying have different effects. Save writes a source profile/publication.
Adopt writes ordinary includes and project docs attachments once. Apply retains exact inventory
for a complete dedicated target. None of these operations executes resource content.

Built-in release-owned skills are always delivered and locked. Selection copies omit them and say so in preview. A hand-written profile may still name them: check warns with `profile-builtin-omitted`, while adopt/apply skip those members with a note. They do not become picks or fixed inventory. Ordinary resources with the same name in another source remain normal members.

## CI agent for one repository

In a registered repository, open `tack explore`, press `d`, then choose
“User + project … (default)” under “Save selection as profile”. The containing project is offered first.
Outside a registered repository, choose one named project. User-only and project-only are explicit
choices in this same window; there is no every-project composition or precedence between levels.

Review the effective membership and user/project origins. Exact duplicates appear once with both
origins, and required dependencies remain visible. Use `i` or `x` to adjust members explicitly;
select project-only if personal tools should not enter CI. Review with `c`, confirm the membership,
choose the destination source, then enter “ci-review”. Review the before/after file and publication,
then confirm save. Cancel at any review or source/name chooser before saving to leave files,
picks and links unchanged. A pending destination change asks for save, discard or cancel.

For an existing profile, choose its published entry at the source/name step. This is an explicit
edit, with its prior file and proposed membership shown before save. A new-name collision refuses;
it never silently overwrites a published profile.

Agents can preview the same copy without an interactive terminal:

```sh
tack profile save /path/to/source ci-review --project demo
tack profile save /path/to/source ci-review --project demo --apply
```

`--input user+project` is the default. `--project` may be omitted inside the intended registered
repository. Use `--input project --project demo` to narrow the copy. Use `--edit` for an explicit
existing-profile update after reviewing the diff. The command copies the complete chosen input;
use `tack explore` to adjust individual members before source/name choice.

Later daily picks and new source defaults do not rewrite the saved file. Required dependencies
are resolved when a profile is checked/applied; explicitly reapply changed inventory to a fixed target.

## General or repository-bound VPS

Choose user-only for a general toolbox:

```sh
tack profile save /path/to/source toolbox --input user
```

A repository-bound agent can keep user + one deployment project, then explicitly remove personal
resources in `tack explore`. Review external source linkage and runtime requirements. Every external
member keeps its source qualifier even when globally unique. Missing or clashing portable source
names require a distinct `name` in their declarations; UUIDs are never substituted.

## Share a team setup and adopt it for daily work

Choose project-only to avoid personal user picks, or deliberately retain the combined input after
reviewing origins. Save into the chosen source. A teammate with those sources already registered can
preview ordinary adoption:

```sh
tack profile adopt tools:ci-review --project demo
tack profile adopt tools:ci-review --project demo --apply
```

Adoption changes copied exclusions to positive includes and preserves unrelated picks. It does
not sync or promise exact physical delivery; the preview names remaining ordinary blockers. Docs
become project attachments with existing writing defaults retained. User-only adoption refuses
profiles containing docs; choose a project. Context keeps its ordinary selection role. Scripts
remain explicit-run resources, with no pick, attachment, execution or invented execution allowlist.

Profile edits after adoption leave those picks unchanged. Daily picks and future defaults can
continue evolving without changing the source profile. A fixed application context refuses
adoption before writing choices that fixed sync would ignore; choose a separate daily context.
