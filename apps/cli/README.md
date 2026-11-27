# @tackup/cli

The `tack` executable. It publishes to npm as `@tackup/cli`; its `bin` is `dist/main.js`. The
documentation for using Tack is on [tackup.dev](https://tackup.dev/docs/): start with
[Get started](https://tackup.dev/docs/getting-started), then the
[reference](https://tackup.dev/docs/reference/setup) for every command, the
[source format](https://tackup.dev/docs/reference/tack-yaml) and the
[automation contract](https://tackup.dev/docs/reference/automation).

## Run and build

From the repository root, run the checkout's CLI from source with `bun tack`. Give every run that
tests Tack itself a throwaway home and state directory, as [CONTRIBUTING.md](../../CONTRIBUTING.md#run-your-changes)
shows, so it never touches your real `~/.tack` or agent folders.

```sh
bun run --cwd apps/cli build       # dist/main.js, dist/worker.js and dist/builtins
bun run --cwd apps/cli typecheck
bun --bun vitest run apps/cli      # this package's tests
```

`bun run install:local` at the root builds, packs and installs a checkout as the global `tack`.

## Layout

| Path           | Content                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `src/main.ts`  | The entrypoint.                                                                                |
| `src/cli`      | Commands, routes and the text views.                                                           |
| `src/features` | One folder per feature, such as sources, choices, reconciliation, docs, profiles and doctor.   |
| `src/domain`   | The domain model and the JSON payload schemas.                                                 |
| `src/platform` | State, the file system, Git, bundles and the script worker.                                    |
| `src/builtins` | The built-in source and its skills, copied into `dist/builtins` and shipped with each release. |
| `test`         | System, host and repository tests, and the shared support in `test/support`.                   |

The `tack-cli-architecture` skill in [.ai/skills](../../.ai/skills/tack-cli-architecture) explains
where code goes. A change to a command, a flag, an output or the source format also updates the
built-in skills and the matching [website docs](../website/docs/docs) page in the same pull request;
the `maintain-tack` skill in [.ai/skills](../../.ai/skills/maintain-tack/SKILL.md) names what to
update.
