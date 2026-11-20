# Write a Tack script

A script is a TypeScript module declared under `scripts` in the source's `tack.yaml`. It
default-exports one `defineScript` definition imported from `@tackup/cli`. Tack provides that
import at run time, from the Tack that runs the script: **never install `@tackup/cli`** (or the
unrelated `tack` package) in a source, and do not add a `package.json` only for it. An installed
copy is ignored when the script runs.

```ts
import { defineScript } from "@tackup/cli";

export default defineScript({
  args: {
    repo: { type: "string", description: "The repository, such as nclsndr/tack" },
    limit: { type: "number", default: 20 },
    state: { type: "string", choices: ["open", "closed"], default: "open" },
    labels: { type: "string", multiple: true, optional: true },
  },
  secrets: ["GITHUB_TOKEN"],
  run: async ({ args, secrets, log, fs, exec, fail }) => {
    const { stdout } = await exec("gh", ["pr", "list", "--repo", args.repo, "--json", "title"]);
    const prs: unknown[] = JSON.parse(stdout);
    if (prs.length === 0) fail(`No ${args.state} pull requests in ${args.repo}.`);
    await fs.writeJson("reports/prs.json", prs);
    log.info(`Saved ${prs.length} pull requests`);
    return { count: prs.length };
  },
});
```

## The definition

`defineScript` takes three options and checks them when the module loads. A typo such as `arg:`
fails the run with `invalid_definition` and names the fix.

| Option    | Shape                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `args`    | `{ [name]: { type: "string" \| "number" \| "boolean", description?, default?, optional?, multiple?, choices? } }` |
| `secrets` | Names such as `["GITHUB_TOKEN"]`: uppercase, without the `TACK_` prefix                                           |
| `run`     | `async (context) => result`; return JSON data or nothing                                                          |

An argument is required unless it has a `default` or `optional: true`; `choices` restrict a string
argument; `multiple: true` takes a list. TypeScript infers `args` exactly from the declarations.
Argument names are lower camel or kebab case.

An operator passes arguments after `--`:
`tack script run report --project demo -- --repo nclsndr/tack --limit 5 --labels bug --labels ui`.
A boolean takes `--dry-run` or `--no-dry-run`, and a camel-case name also answers to its kebab
spelling. `tack script show report` prints the arguments, their defaults and the secrets, so write
a `description` for every argument that is not obvious.

## The context

| Field     | What it does                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `args`    | The validated arguments, with defaults filled in.                                                                                                                                                                                                          |
| `secrets` | Each declared secret as a string, read from `TACK_<NAME>` in the environment or the state directory's `.env`.                                                                                                                                              |
| `log`     | `log(...)` or `log.debug`/`info`/`warn`/`error`; lines join the run log. `console.log` also works, as captured output.                                                                                                                                     |
| `fs`      | `read`, `readJson`, `write`, `writeJson`, `exists`, `list(glob)`, `remove`; relative paths resolve from `cwd`, `write` creates parent directories.                                                                                                         |
| `exec`    | `exec(command, args?, { cwd?, env?, allowFailure? })` runs one executable without a shell and returns `{ stdout, stderr, exitCode }`. It throws on a non-zero exit unless `allowFailure: true`. Write `exec("git", ["status"])`, not `exec("git status")`. |
| `cwd`     | The run's working directory: the selected project root, or the user's home with `--user`.                                                                                                                                                                  |
| `signal`  | An `AbortSignal`, aborted when the operator cancels or the run times out. Clean up in `try`/`finally`: Tack waits for it.                                                                                                                                  |
| `fail`    | `fail(message, details?)` ends the run with an expected failure the operator should read.                                                                                                                                                                  |

Tack replaces every declared secret value with `<redacted>` in logs, results and messages. A value
the script writes to a file, or passes to a command, is the author's responsibility.

## Outcomes

| Code                 | When                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `success`            | `run` returned JSON data or nothing.                                                       |
| `invalid_args`       | The run's arguments do not match the declarations; every problem is listed with its help.  |
| `secret_missing`     | A declared secret has no value.                                                            |
| `expected_failure`   | `run` called `fail`.                                                                       |
| `executed_defect`    | `run` threw, an `exec` exited non-zero, or the result is not JSON. The message says which. |
| `invalid_definition` | The module's default export is not a valid `defineScript` definition.                      |
| `cleanup_failed`     | Cleanup in `finally` threw after the run was cancelled.                                    |

## Editor types

Run `tack types --apply` in the source folder (or `tack types PATH --apply`). It writes
`tack-env.d.ts`, the types of the API this Tack provides, and a `tsconfig.json` when the source has
none, so the editor knows `@tackup/cli` and infers `args` and `secrets`. Commit both files, and
run it again after upgrading Tack. An existing `tsconfig.json` is never changed: when it does not
include `tack-env.d.ts`, the command warns (`types-stub-out-of-scope`) and you add it to `include`.
Without `--apply`, it only previews.

## Dependencies and TypeScript

A script needs no `package.json`. When it imports other packages, give the source a `package.json`
listing them and install them in the source; Tack checks that each declared dependency is installed
before it runs a script, and never installs anything itself. A script that imports `node:` modules
needs `@types/node` installed for editor types only.

Scripts run on Node or Bun with the same TypeScript: a type imported as a value, extensionless
relative imports, enums and JSON imports all work.
