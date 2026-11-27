# @tackup/core

`@tackup/core` holds Tack's script API and the runner behind it. It is a private workspace package
with two entrypoints:

- **`@tackup/core/script-api`** (`src/script-api.ts`) is what script authors write against. It
  imports nothing. Tack ships it as `@tackup/cli`, and the script worker provides that import at
  run time, so a source never installs it. The author guide is the built-in
  [scripts reference](../../apps/cli/src/builtins/skills/manage-tack-sources/references/scripts.md).
- **`@tackup/core`** (`src/index.ts`) is the Effect runner the CLI runs every script on. Its
  `defineScript({ contract: 1, ... })` is internal: a source script that default-exports one fails
  with `invalid_definition`, and the CLI adapts each script-API definition onto this runner.

The [scripts reference](https://tackup.dev/docs/reference/scripts) on the website covers run
targets, arguments, secrets, outcomes and history.

## Runner API

Everything below is exported from the package root, for the CLI and its tests.

| Export                                                                                                                                                                        | Kind         | Purpose                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineScript`, `ScriptContract`, `NoExpectedFailure`                                                                                                                         | Authoring    | Declare a script and its schemas, secrets and services; `NoExpectedFailure` marks an impossible error channel.                                       |
| `ScriptDefinition`, `ScriptServices`, `BoundarySchema`, `ErrorBoundary`, `ServiceName`                                                                                        | Types        | Shapes of a definition and its schemas and capability names.                                                                                         |
| `inspectScriptDefinition`, `parseScriptBoundary`, `RecognizedScript`, `definitionFailureCodes`, `DefinitionFailureCode`, `DefinitionInspection`                               | Recognition  | Validate an unknown module export as a definition and report why it is not one (`invalid_definition`, `unsupported_contract`, `unknown_capability`). |
| `Secret`, `Shell`, `ShellService`, `ShellCommand`, `ShellResult`, `ShellFailure`, `SecretRequirement`, `isCapabilityFailure`                                                  | Capabilities | The two capabilities a script can request and their types and failure.                                                                               |
| `runScript`, `RunOptions`                                                                                                                                                     | Runner       | Run a definition directly and return a structured outcome.                                                                                           |
| `RunOutcome`, `PrimaryOutcome`, `RunSuccess`, `RunFailure`, `RunStage`, `FailureCode`, `CauseDiagnostic`, `RunLog`, `LogTruncation`, `Finalization`, `JsonValue`, `RunLimits` | Outcome      | What a run reports: result, failure classification, bounded logs, cleanup status, and the size limits.                                               |
| `encodeRunOutcome`, `EncodedRunOutcomeSchema`, `EncodedRunOutcome`, `copyJson`                                                                                                | Encoding     | Encode an outcome to bounded JSON and copy JSON data safely.                                                                                         |
| `packageName`                                                                                                                                                                 | Constant     | Identifies the package at the workspace boundary.                                                                                                    |

## Architecture

The package is a small, flat set of modules with no I/O of its own:

- `definition.ts` owns the authoring helper and recognition of an unknown value as a definition.
- `capabilities.ts` declares the `Secret` and `Shell` capabilities as Effect services.
- `strict-input.ts` builds the strict input schema that rejects excess properties.
- `run-script.ts` is the runner: it validates input, builds the program lazily, runs it under a
  Scope, captures logs, and finalizes.
- `outcome.ts` and `outcome-schema.ts` define the outcome model, its limits and its JSON encoding.

A definition is data plus a lazy Effect program. Live Shell, secret resolution, run history and CLI
envelopes belong to the CLI, which supplies live capabilities to the same definition; the runner here
never selects live configuration. The same strict schemas and outcome model back both direct tests
and supervised runs.

## The internal definition

The CLI's adapter builds one definition per run. Its shape:

```ts
import { defineScript, NoExpectedFailure } from "@tackup/core";
import { Effect, Schema } from "effect";

export default defineScript({
  contract: 1,
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  error: NoExpectedFailure,
  secrets: [],
  services: [],
  run: ({ name }) => Effect.succeed(`Hello, ${name}`),
});
```

Input, output, and expected-failure schemas must be synchronous and require no services. Input is
JSON and rejects excess properties, including nested empty objects. Successful output and expected
failures must encode to bounded JSON through their declared schemas. Use a schema for authored
expected failures, or `NoExpectedFailure` when that error channel is impossible. This assertion
does not make Shell, cleanup, or other operational boundaries infallible.

## Declare capabilities

| Capability   | Declaration                                                             | Program access                                                                              | Behavior                                                                                                  |
| ------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Named secret | Include an unprefixed uppercase name in `secrets`, such as `API_TOKEN`. | Yield `Secret("API_TOKEN")` for an Effect `Redacted` value.                                 | Operator runs resolve `TACK_API_TOKEN`; direct tests supply a fake value for that exact name.             |
| Shell        | Include `"Shell"` in `services`.                                        | Yield `Shell`, then call `execute` with `executable`, `args`, and optional `cwd` and `env`. | A completed non-zero exit returns `ShellResult`; spawn, I/O, and termination failures use `ShellFailure`. |

The authoring helper checks that the Effect requirements match the declared secrets and services,
excluding the execution Scope. Unknown capability names and unsupported contract versions fail
recognition. Runtime validation does not infer erased TypeScript requirements. Secrets and Shell
are the initial capabilities; a definition cannot request arbitrary services from the CLI.

## Run directly with fakes

Import the definition and call `runScript(definition, { input, services })`. Use `services: {}`
when no capabilities are declared. Supply every declared secret through `services.secrets`, keyed
by its unprefixed name, and every declared Shell capability through `services.Shell.execute`.
The fake Shell method returns an Effect with captured `stdout`, `stderr`, and `exitCode`, or a
`ShellFailure`. Direct runs never select live configuration or a live Shell implicitly.

`runScript` returns a Promise of a structured core outcome after finalization. An optional
`signal` requests interruption; `onLog` observes captured Effect log events. Direct tests retain
decoded success, encoded boundary values when available, the primary outcome, bounded logs, and
cleanup status. They do not create CLI envelopes, run-history entries, or process exit codes.

Expected failures, capability failures, defects, interruptions, construction faults, invalid
programs, schema failures, and cleanup failures remain distinct. When an Effect Cause combines
several reasons, defect takes precedence over interruption, then capability failure, then
expected failure; the outcome retains contributing reasons. Cleanup failure makes the overall run
unsuccessful while preserving the primary outcome. Test both the primary result and finalization
when the script acquires resources.

The [exports](src/index.ts), [contract tests](test/script.test.ts) and
[type conformance cases](test/script.types.ts) are the reference for the supported API.
