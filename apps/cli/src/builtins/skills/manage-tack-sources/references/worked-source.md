# Worked source: quality tools

This example uses three separately registered directories: `quality-tools`, `base-skills` and
`audit-tools`. Source labels describe the content. Register all three before checking dependencies.

## Declare several resource paths

Create this layout in `quality-tools`:

```text
quality-tools/
  tack.yaml
  skills/
    delivery/review/SKILL.md
    delivery/review/references/checklist.md
    delivery/_drafts/experiment/SKILL.md
    git/SKILL.md
  vendor/skills/format/SKILL.md
  labs/one-off/SKILL.md
  commands/release.md
  prompts/review.md
  context/architecture.md
  context/generated/snapshot.md
  tools/report.ts
  knowledge/index.md
  runbooks/index.md
```

Write `quality-tools/tack.yaml`:

```yaml
version: 1
name: quality-tools
maintainers: [docs-contact]
depends-on: [base-skills, audit-tools]
skills:
  - path: skills
    include: ["delivery/**", "git"]
    exclude: ["**/_*/**"]
  - path: vendor/skills
  - path: labs/one-off
commands:
  - path: commands
    include: ["**/*.md"]
  - path: prompts/review.md
context:
  - path: context
    include: ["**/*.md"]
    exclude: ["generated/**"]
scripts:
  - name: report
    path: tools/report.ts
    description: Summarize the current project's checks.
docs:
  - name: handbook
    path: knowledge
  - name: operations
    path: runbooks
```

The skill names are `review`, `git`, `format` and `one-off`. `delivery` is a group folder; it never
prefixes `review`. Every skill's frontmatter name must match its folder. `references/checklist.md`
is content delivered with `review`. A skill is a leaf: another `SKILL.md` inside `review` would
remain content, not become a second skill.

Patterns match paths relative to each declared folder. Under `skills`, `delivery/review` matches
`delivery/**`; `delivery/_drafts/` matches the exclude and is not entered. `git` is included
explicitly. Under `context`, `architecture.md` loads and `generated/snapshot.md` does not. The
single-skill entry `labs/one-off` takes no patterns. The three skills paths are disjoint: do not
also declare `skills/delivery`, because it overlaps `skills`, whose walk enters `delivery`. Only an
`exclude` that prunes `delivery` on the `skills` entry would end that overlap; an `include` does
not.

The command `review` and skill `review` coexist because they have different kinds. The script's
reference is `report`, from its declared name, and its module must default-export a `defineScript`
definition imported from `@tackup/cli`, which Tack provides at run time; see
[scripts.md](scripts.md). `catalog` does not execute scripts.
The docs references are `handbook` and `operations`; they are attached separately to a project.
Docs entries have no include/exclude patterns. Use `reader.content` settings to filter documents
inside a docs resource, as described in the reader author guide.

## Pair source dependencies with skill metadata

The separate `base-skills` directory holds its skills at its top, such as `lint/SKILL.md`, and
nothing else, so it is a skills collection (`tack source add PATH --config -` writes it from the
same declaration as JSON):

```yaml
version: 1
name: base-skills
kind: skills
```

In `audit-tools`, provide `skills/lint/SKILL.md` and `knowledge/index.md`:

```yaml
version: 1
name: audit-tools
skills:
  - path: skills
docs:
  - name: handbook
    path: knowledge
```

Each `lint/SKILL.md` needs `name: lint` and a non-empty description. In
`quality-tools/skills/delivery/review/SKILL.md`, write:

```markdown
---
name: review
description: Review a change using the repository checks and lint guidance.
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: opt-in
    dependencies:
      - kind: skill
        name: git
      - kind: skill
        name: lint
        source: base-skills
      - kind: command
        name: release
        optional: true
---

Read references/checklist.md before reviewing the change.
```

`git` resolves in the requester's own source, `quality-tools`. `lint` resolves in `base-skills`,
which `depends-on` allows. The optional edge to the local `release` command is followed
only when optional dependencies are requested. `depends-on` alone selects nothing: the per-resource
edges say which resources are needed. Required edges can select opt-in dependencies; an explicit
exclusion blocks the requester. See [metadata rules](metadata.md) for activation defaults.

## Resolve name clashes

Both dependency sources provide a skill called `lint`. They are healthy resources with distinct
identities. If the `review` dependency omitted `source: base-skills`, both declared sources would
match and block `review`. Keep the explicit `source` on that edge. For an operator choice, use a
qualified reference such as `tack pick include base-skills:lint --project PROJECT`. Qualification
chooses a candidate; including both skills still causes a delivery collision. If both are selected
by default, explicitly include the desired candidate or exclude the other.

Both `quality-tools` and `audit-tools` provide docs named `handbook`. Use
`tack docs attach quality-tools:handbook --project PROJECT` to choose one; a bare `handbook` is
ambiguous. Distinct source-qualified docs mounts can coexist.

Within `quality-tools`, adding `vendor/skills/review/SKILL.md` would instead duplicate the same
kind and name in one source. Both skills would be quarantined, and `quality-tools:review` would
not resolve the duplicate. Rename the new folder to `vendor-review` and its frontmatter to
`name: vendor-review`, or exclude `review` from the `vendor/skills` declaration. No source label
can distinguish two same-kind resources inside one source. Two sources with the same label also
need distinct `name` values before that label can qualify references.

## Check the authored source

Create the files before registration. Write each `tack.yaml` by hand, or give its declaration as
JSON to `tack source add PATH --config '<json>'`, which previews the `tack.yaml` it writes and checks it
as `tack check` does. `source add` previews each existing `tack.yaml` as it is; `--apply` registers
it. Check each source before registration, repair local findings, then initialize state if absent.
Use absolute paths for the three source directories:

```sh
tack check /absolute/path/base-skills
tack check /absolute/path/audit-tools
tack check /absolute/path/quality-tools
# Fix local findings and repeat the checks until clean.
tack init # if Tack is not set up; it writes at once
tack source add /absolute/path/base-skills # preview; read it, then add --apply
tack source add /absolute/path/base-skills --apply
tack source add /absolute/path/audit-tools --apply
tack source add /absolute/path/quality-tools --apply
tack source
tack catalog --details
tack doctor
```

Read every declaration's count and problems. An empty declaration is valid, so an exit code alone
does not prove that a pattern found the intended resources. Fix every catalog issue, then check
again. The qualified choices and docs attachment above change state immediately; register a test
project before trying them. Preview `tack sync --project PROJECT` before applying delivery.
