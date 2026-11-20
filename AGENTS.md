# Tack

Tack is a Bun and Effect monorepo for the `tack` project.

Tack manages explicitly declared, versioned sources of skills, commands, context, scripts and docs, and links the selected resources into supported coding-agent locations without copying them or hiding ownership.

- `apps/cli` contains the `tack` executable and CLI-owned behavior.
- `packages/core` contains the reusable workbench script contract and author-facing helpers.
- `packages/reader` contains the docs reader and search that `tack docs serve` runs.
- `evals` contains internal Docker-only agent evals; it is a private workspace that releases never include.

## Install Tack and deliver this repository's skills

The root `tack.yaml` declares the skills in `.ai/skills` as the source `tack-repo`. Deliver them with
the installed `tack`, from the root of the checkout:

1. Check Tack with `tack --version` and `tack doctor`. When `tack` is missing, install this checkout
   with `bun run install:local`, as [CONTRIBUTING.md](CONTRIBUTING.md#run-your-changes) describes.
2. Run `tack source`. When no `tack-repo` source is listed, run `tack source add "$PWD"`. Register
   one checkout only: each checkout of this repository is another `tack-repo` source, and the skill
   names then clash.
3. Run `tack project`. When no project holds this checkout, run `tack project add tack`. After you
   add a worktree, run `tack project refresh --project tack --apply`.
4. When `bun run ai:init` linked the skills before, run `bun run ai:reset` first. Tack does not
   replace links it did not make and reports them as `foreign-destination`.
5. Run `tack sync --project tack`, read the preview, then run `tack sync --project tack --apply`.
   Run `tack sync --user --apply` when `tack doctor` reports the built-in skills as not linked.
6. Confirm with `tack status --project tack`. After you edit a skill, run `tack check "$PWD"`. The
   links point into the registered checkout, so an edit there needs no sync. A new or renamed
   skill does.

To test a change to Tack itself, run the checkout's build as `bun tack` with a throwaway `HOME` and
`--state-dir`, as [CONTRIBUTING.md](CONTRIBUTING.md#run-your-changes) shows. Do not run `bun tack`
against the real `~/.tack`: it would link your agents' built-in skills into this checkout.

## Pull request screenshots

A PR with a user-visible change (terminal output, reader, explorer, website) includes before and
after screenshots. An internal-only change skips them. Add the media to the orphan branch
`pr-assets` under `pr-<number>/`, as new commits: never rewrite, merge or delete that branch. Link
each file from the PR body with a commit-pinned URL:
`https://github.com/nclsndr/tack/blob/<commit-sha>/pr-<number>/<file>?raw=true`.
