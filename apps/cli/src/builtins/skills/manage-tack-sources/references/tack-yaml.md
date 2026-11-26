# The source `tack.yaml` in detail

Source version 1 supports ordinary resources. Version 2 also accepts `profiles`, an explicit list
of `{ name, path }` publications. Each file has its own profile schema and version. Use
`author-tack-profiles` for the manifest and linkage rules. `tack check` reports malformed profile
publications/files while leaving unrelated healthy resources available. Version 2 also accepts
`bundle-support`, which names explicit resource support files/directories, complete closure and
non-secret setup prerequisites. Read `author-tack-profiles` before authoring that section.

A `tack.yaml` names folders and files in resource keys; the rules below are its rules. The path
`.` names the folder that holds the `tack.yaml` itself.

## The source folder

```yaml
version: 1
name: review-skills
skills:
  - path: .
```

- A `skills` entry `.`: the source folder is a folder of skills. Its walk finds each folder below
  it that holds `SKILL.md`, as for any skills folder.
- A `commands` entry `.`: each `.md` file below the source folder whose name is a command name is a
  command. Exclude a `README.md` with `exclude: ["README.md"]`.
- A `docs` entry `.`: the whole source folder is one docs resource, named by the entry's `name`.

A `.` entry walks the source folder as a declared folder, with `include` and `exclude`, and it
passes over dot, underscore and `node_modules` names, as a docs walk does, so `_drafts/` and
`.git/` stay out. It passes over another source's folder without a finding, as a docs walk does.
A `tack.yaml` with a `.` entry declares that one kind: another resource key would read the same
files, so `tack check` refuses each other key with `declaration-schema-invalid`. Content of
another kind is a source of its own, in a folder with its own `tack.yaml`, such as
`~/skills/handbook` with a docs entry `.` beside `~/skills` with a skills entry `.`. A `context` entry is never `.`: context would take every file, the `tack.yaml` too, so it is
refused with `declaration-path-invalid`. A source with a skills entry `.` whose folder holds
`SKILL.md` is one skill, and the source is unhealthy with `source-is-one-skill`: register the folder
above it, or import it with `tack import add`.

`kind` is no key of a `tack.yaml`. `tack check` refuses it with `declaration-schema-invalid` and
prints the `tack.yaml` to write instead, with the kind's `.` entry.

A key a `tack.yaml` mapping names twice, anywhere in the file, is refused with
`declaration-malformed`, which names the key and both of its lines. Remove one of them.

## Entries

The main skill shows the shape of a declaration and the names it produces. This reference holds the
rules for each entry. Tack reads resources only from entries declared here, and a bad entry is
quarantined alone: the rest of the source keeps working.

**What each declaration contributes.** `tack source` lists the declarations of a healthy
source with their patterns, the number of resources each one contributes and its problems.
`tack catalog --details` shows `declaredPath` on each resource. A declaration that finds
nothing, such as an empty folder before an import, is valid and shows `0`.

**Paths.** Every `path` is `.`, the source folder, or relative and `/`-separated, with no `.`,
`..`, empty segment or backslash. After symlinks it must exist inside the source with the right type: a folder for
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

`tack source add PATH --config '<json>'` writes `tack.yaml` from a declaration you write, never
from a guess. The value of `--config` is the declaration itself, as JSON: the same keys and values
as `tack.yaml`. `--config -` reads it from standard input instead, which
suits a long declaration in a heredoc. A value is never read as a path, and YAML or any other text
fails with `config-not-json`. `tack guide tack-yaml` lists every key a declaration and each entry takes,
and prints the JSON Schema of the whole declaration. The `imports` key is refused with
`config-imports-not-allowed`: only `tack import add` writes it.

```sh
tack init # once per machine; it writes at once
tack source add /absolute/path --config '{"version": 1, "name": "personal", "skills": [{"path": "."}]}'
tack source add /absolute/path --config '{"version": 1, "name": "personal", "skills": [{"path": "."}]}' --apply
tack check /absolute/path
tack catalog --details
```

For a source with skills under `personal/skills` minus archived folders, a report script and a
handbook, pass this declaration, on one line or through `--config -`:

```json
{
  "version": 1,
  "name": "personal",
  "skills": [{ "path": "personal/skills", "exclude": ["**/_*/**"] }],
  "scripts": [{ "name": "report", "path": "tools/report.ts", "description": "Weekly report" }],
  "docs": [{ "name": "handbook", "path": "team/handbook" }]
}
```

`source add` checks the config as `tack check` checks a `tack.yaml`, with the same decoder and the
same catalog discovery. A config that does not decode fails before anything else, with every issue
at once, each with its field and its line in the config: an unknown key names the keys its form
takes, and a missing `name` suggests one from the folder. Exit 2, and `tack guide tack-yaml` is the
next command. Otherwise the preview prints the `tack.yaml` that `--apply` writes, normalized to YAML
in the order of the keys above, the source name to use in `SOURCE:NAME` references, and what each
entry finds: the names of its resources, their count and its problems at their line in the config.
It writes neither the file nor state, and never repeats the JSON back as a next command: run the
same command again with `--apply`. `--apply` reads and checks the config again, exclusively creates
the file, then registers the source; pipe the same JSON again for `--config -`.

It never overwrites an existing file, including one created by another process during the
operation: `--config` on a source that has `tack.yaml` fails with `declaration-exists`. Edit that
file by hand and run `tack check`. A bare `tack source add` on a folder without `tack.yaml` fails
with `declaration-config-required` and suggests a declaration read from the folder's top: a skills
entry `.` for skill folders there, plus a source of its own with a `.` entry for a `commands` or
`docs` folder beside them, or one entry per folder named after a kind. A folder that a registered
source's skills, commands or context walk reaches, other than a `.` entry's, or that holds one of its declared paths, fails with
`declaration-inside-source`: its new `tack.yaml` would take the folder out of that source. Exclude
the folder there first, as the message says. A preview in which a declared resource cannot be read,
such as a command whose frontmatter does not parse, is partial and lists each error under Problems
with its file; `--apply` still registers the source. When every entry has a problem and finds no
resource, as with a skills entry that names a Markdown file, the source would load nothing: the
preview is partial with `declaration-loads-nothing` and offers no `--apply`, and `--apply` fails
with the same code. Fix the entries, then preview again.

Registration remains permissive: fix every resource issue and repeat `tack check` until clean, then
verify `catalog --details`. If registration fails after creation, the written declaration remains
available to inspect and repair.
