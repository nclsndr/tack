# The source `tack.yaml` in detail

Source version 1 supports ordinary resources. Version 2 also accepts `profiles`, an explicit list
of `{ name, path }` publications. Each file has its own profile schema and version. Use
`author-tack-profiles` for the manifest and linkage rules. `tack check` reports malformed profile
publications/files while leaving unrelated healthy resources available. Version 2 also accepts
`bundle-support`, which names explicit resource support files/directories, complete closure and
non-secret setup prerequisites. Read `author-tack-profiles` before authoring that section.

A `tack.yaml` has one of two shapes. The **list form**, without `kind`, names folders and files in
resource keys; the rules below are its rules. A **collection** names a `kind` and no resource keys:
the folder that holds it is the collection.

## Collections

```yaml
version: 1
kind: skills
```

- `kind: skills`: each folder at the top that holds `SKILL.md` is a skill. Nothing deeper is read.
- `kind: commands`: each `.md` file at the top whose name is a command name, such as `deploy.md`,
  is a command. `README.md` and `CHANGELOG.md` are ignored.
- `kind: docs`: the whole folder is one docs resource, named by the required `name`, which is also
  the source label. An optional `reader` key tunes it as a docs entry's does.

Names that start with `.` or `_` are never resources, so `_draft/` hides a skill. A collection takes
`version: 1`, `name`, `maintainers` and, for skills and commands, `depends-on`; a skills collection
also holds the `imports` key Tack writes. It takes no resource keys, `include` or `exclude`, and
publishes no profiles. Context and scripts need the list form. A skills collection whose folder
holds `SKILL.md` is one skill, and the source is unhealthy with `source-is-one-skill`: register the
folder above it, or import it with `tack import add`. `kind: skill` is refused.

A collection declares nothing else. Other content beside it is its own source with its own
`tack.yaml`, such as a docs collection in `~/skills/handbook` beside a skills collection in
`~/skills`: the skills collection never reads `handbook`, which holds no `SKILL.md`. To keep one
source, move the skills into `skills/` and use the list form. Group folders at the top of a
collection are not read: make a group its own collection, or use the list form. `tack source add
--skills .` and `tack check` warn with `collection-folders-skipped` and name each `commands` folder
and each group folder with a `SKILL.md` below it that the collection skips; the warning changes no
exit code.

## List form

The main skill shows the shape of a declaration and the names it produces. This reference holds the
rules for each entry. Tack reads resources only from entries declared here, and a bad entry is
quarantined alone: the rest of the source keeps working.

**What each declaration contributes.** `tack source` lists the declarations of a healthy
source with their patterns, the number of resources each one contributes and its problems.
`tack catalog --details` shows `declaredPath` on each resource. A declaration that finds
nothing, such as an empty folder before an import, is valid and shows `0`.

**Paths.** Every `path` is relative and `/`-separated, with no `.`, `..`, empty segment or
backslash. After symlinks it must exist inside the source with the right type: a folder for
`skills` and `docs`, a folder or one file for `context`, a folder or one `.md` file for
`commands`, a `.ts` file for `scripts`. Everything found inside a declared folder must resolve
inside that folder, or it is refused with `resource-boundary-violation`: declare the other path
instead. Declarations of skills, commands, context and scripts may not overlap, so one file belongs
to one declaration: two entries overlap when their paths are equal or one lies inside the other, and
every overlapping entry is quarantined with `declaration-path-overlap`. A profile publication
counts as a file entry, so a profile inside a declared folder is refused too. An `exclude` on the
outer folder entry that prunes the inner path ends the overlap, because its walk never reaches that
path: `skills` with `exclude: ["vendor/**"]` beside a `skills/vendor` entry, or `context` `tools`
with `exclude: ["run.ts"]` beside a script `tools/run.ts`. An `include` does not, since the walk
still enters every folder. The finding names that exclude. `docs` paths are exempt: a docs folder
may hold or equal any other entry's folder.

**Nested sources.** Each `tack.yaml` marks the edge of a source. Below the source's root, a folder
that holds `tack.yaml` and no `SKILL.md` is another source, registered or not, and this source
never reads it: configurations never merge or inherit. An entry whose path is or lies inside such a
folder is refused with `declaration-reaches-source`; declare those resources in that folder's
`tack.yaml`. A skills, commands or context walk that meets one skips the folder and reports
`declaration-reaches-source`; add `exclude: ["vendor/**"]` to the entry when the nesting is
intended. A docs folder skips another source silently. A `tack.yaml` inside a skill folder is the
skill's content.

**Patterns.** `include` and `exclude` match a resource's path relative to the declared folder: a
skill's folder path, a command's or context item's file path. A resource is contributed when it
matches an `include` (any path when absent) and no `exclude`. A folder whose relative path followed
by `/` matches an `exclude` is not entered, so nothing inside it is read or reported. A folder
whose name starts with an underscore means nothing: exclude archives with
`exclude: ["**/_*/**"]`. Patterns need a declared folder: on an entry that names one skill, one
command or one file, the entry is quarantined with `declaration-entry-invalid`.

**Skill folders are leaves.** A folder that holds `SKILL.md` is one skill and Tack never looks
inside it for more skills: a `SKILL.md` below it is content. Tack finds skills, commands and
context at any depth, and group folders never change a name.

**Scripts** point at a `.ts` module whose default export is a `defineScript` definition imported
from `@tackup/cli`, which the running Tack provides: never install it. Read
[scripts.md](scripts.md) before writing one. A source needs a `package.json` only for packages its
scripts import; Tack never installs them, and `catalog` never imports a script, so only
`script run` finds a broken one. Scripts are run by reference, never selected.

**Docs** are folders of Markdown that need no frontmatter or configuration. A `reader` key, an
inline mapping or a source-relative `.yaml` file, tunes navigation and components (reader author
guide: `packages/reader/README.md` in the Tack repository). A component module imports `Icon`,
`Callout`, `Tabs`, `Tab` and `Term` from `@tackup/reader`; `Icon` names are typed, and written
literally so the reader bundles them. Writing the pages themselves is `write-reader-figures`.
Projects attach docs with `use-tack`.

**Imports.** `tack import add --into SOURCE --apply` writes a skill folder into a declared skills
folder and one record per skill into the top-level `imports` key, after one blank line and the
comment `# Written by tack import`. A record holds the skill's folder, the location, the ref and
its kind, the resolved revision, the upstream folder and tree ID, the import time, and a SHA-256
and executable bit for every file as imported. Tack replaces only that block, as text, and keeps
every other byte of the file, comments and line endings included; it rewrites the block whole, so
hand edits inside it are lost. `imports` in flow style, with an anchor, indented or repeated, makes
every import command refuse the source with the line number. The catalog never reads it, and a
source with the key is unhealthy for releases that predate import (`declaration-schema-invalid`).
While a write runs, Tack stages it in `.tack-import-staging/` at the top of the source; a declaration
entry that names that folder or a path inside it is quarantined with `declaration-path-invalid`,
and a leftover folder is finished or rolled back by the next `import add` or `import remove` with
`--apply` for the source.

## Declaration creation

`tack source add` writes `tack.yaml` from the folders you name, never from a guess. Each
`--skills`, `--commands`, `--context` or `--docs` flag names one path inside the source, relative to
it, and can repeat. Each becomes one folder entry, which covers every resource under it; a docs
entry is named after its folder. `.` as the folder writes a collection: `--skills .` writes
`kind: skills`, `--commands .` writes `kind: commands`, and `--docs .` writes `kind: docs` named
after the source folder. `.` cannot be combined with another flag (`declaration-flags-conflict`,
whose next commands register the collection and each other folder as its own source, except a
context folder, which needs a folder of a source), `--context .` is
refused because context needs a folder, and `--skills .` on a folder that holds `SKILL.md` fails
with `source-is-one-skill`. A path that is missing or resolves outside the source, two docs
folders with one name, a folder name that is no docs name, or two `--skills`, `--commands` or
`--context` folders that are equal or nested (`declaration-flags-conflict`: flags carry no
`exclude`, so write `tack.yaml` by hand to keep both) fails before anything is written.
There is no flag for scripts.

```sh
tack init # once per machine; it writes at once
tack source add /absolute/skills --skills . # a folder of skill folders: preview a collection
tack source add /absolute/path --skills personal/skills --skills team/skills --docs team/handbook
tack source add /absolute/path --skills personal/skills --skills team/skills --docs team/handbook --apply
tack check /absolute/path
tack catalog --details
```

The preview prints the file, the source name to use in `SOURCE:NAME` references, and what each
entry finds: the names of its resources, their count and its problems, as `tack check` reports
them. It writes neither the file nor state. `--apply` exclusively creates the file, then registers
the source. It never overwrites an existing file,
including one created by another process during the operation: a kind flag on a source that has
`tack.yaml` fails with `declaration-exists`. A bare `tack source add` on a folder without
`tack.yaml` fails with `declaration-flags-required`, names the flags, and proposes previews read
from the folder's top: `--skills .` for skill folders there, plus a source of its own for a
`commands` or `docs` folder beside them, or one flag per folder named after a kind, such as
`--skills skills --context context`. A folder that a registered
source's skills, commands or context walk reaches, or that holds one of its declared paths, fails
with `declaration-inside-source`: its new `tack.yaml` would take the folder out of that source.
Exclude the folder there first, as the message says. When every entry has a problem and finds no
resource, as with `--skills guide.md` on a Markdown file, the source would load nothing: the
preview is partial with `declaration-loads-nothing` and offers no `--apply`, and `--apply` fails
with the same code. Name other folders, then preview again.

The flags declare whole folders. Add the rest by hand, then run `tack check`: `include` and
`exclude` patterns, `scripts` entries, `depends-on`, or a docs name other than its folder's.
Registration remains permissive: fix every resource issue and repeat `tack check` until clean, then
verify `catalog --details`. If registration fails after creation, the generated declaration remains
available to inspect and repair.
