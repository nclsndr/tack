import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { Effect, Redacted, Schema } from "effect";
import {
  defineScript as defineContractScript,
  ScriptError,
  Secret,
  Shell,
  type ShellService,
} from "@tackup/core";
import { expectedArgumentValue, recognizeScript } from "@tackup/core/script-api";
import {
  ScriptDeclarationsSchema,
  type ScriptDeclarations,
} from "../../domain/execution/execution-schema.ts";
import type {
  ArgSpec,
  Exec,
  ExecResult,
  Files,
  Log,
  RecognizedScriptOptions,
} from "@tackup/core/script-api";

/** Arguments after validation, or every problem with them. */
export type ParsedArguments =
  | { readonly ok: true; readonly args: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && Array.isArray(value) === false;

const describeArgument = (name: string, spec: ArgSpec) =>
  `--${name} (${spec.type}${spec.multiple === true ? " list" : ""}${spec.description === undefined ? "" : `: ${spec.description}`})`;

/**
 * The problem with one supplied value of an argument, if it has one. `defineScript` holds each
 * default to the same rule, so a value the run fills in fits too.
 */
const valueProblem = (name: string, spec: ArgSpec, value: unknown): string | undefined => {
  const expected = expectedArgumentValue(spec, value);
  return expected === undefined
    ? undefined
    : `--${name} must be ${expected}, got ${JSON.stringify(value)}.`;
};

/** Every problem with one declared argument's supplied value; a missing one may take its default. */
const argumentProblems = (name: string, spec: ArgSpec, value: unknown): ReadonlyArray<string> => {
  if (value === undefined)
    return spec.default !== undefined || spec.optional === true
      ? []
      : [`Missing ${describeArgument(name, spec)}.`];
  if (spec.multiple === true)
    return Array.isArray(value)
      ? value.flatMap((item: unknown) => valueProblem(name, spec, item) ?? [])
      : [`--${name} takes a list, got ${JSON.stringify(value)}.`];
  return [valueProblem(name, spec, value) ?? []].flat();
};

/**
 * Validates a run's JSON input against a script's argument declarations, listing every problem with
 * the argument help, and fills in defaults.
 */
export const parseArguments = (
  specs: Readonly<Record<string, ArgSpec>>,
  input: unknown,
): ParsedArguments => {
  const names = Object.keys(specs);
  if (isRecord(input) === false)
    return { ok: false, problems: ['Pass arguments as a JSON object, such as {"name": "Ada"}.'] };
  const problems = [
    ...Object.keys(input).flatMap((key) =>
      key in specs
        ? []
        : [
            names.length === 0
              ? `Unknown argument --${key}. This script takes no arguments.`
              : `Unknown argument --${key}. Arguments: ${names.map((name) => `--${name}`).join(", ")}.`,
          ],
    ),
    ...Object.entries(specs).flatMap(([name, spec]) => argumentProblems(name, spec, input[name])),
  ];
  return problems.length > 0
    ? { ok: false, problems }
    : {
        ok: true,
        args: Object.fromEntries(
          Object.entries(specs).flatMap(([name, spec]) => {
            const value = input[name] ?? spec.default;
            return value === undefined ? [] : [[name, value]];
          }),
        ),
      };
};

/** The kebab-case spelling of an argument name, which the command line also accepts. */
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * The input object that command-line words after `--` spell, with every problem in the words
 * themselves; the declarations check then judges the input.
 */
export const inputFromWords = (
  specs: Readonly<Record<string, ArgSpec>>,
  words: ReadonlyArray<string>,
): {
  readonly input: Readonly<Record<string, unknown>>;
  readonly problems: ReadonlyArray<string>;
} => {
  const named = (key: string) =>
    Object.keys(specs).find((name) => name === key || kebab(name) === key);
  const input: Record<string, unknown> = {};
  const problems: Array<string> = [];
  const supply = (name: string, spec: ArgSpec, value: unknown) => {
    const previous = input[name];
    if (spec.multiple === true)
      input[name] = Array.isArray(previous) ? [...previous, value] : [value];
    else if (name in input) problems.push(`--${name} was given more than once.`);
    else input[name] = value;
  };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    const flag = /^--([^=]+)(?:=(.*))?$/s.exec(word);
    if (flag === null) {
      problems.push(`Unexpected "${word}". Pass each argument as --name value.`);
      continue;
    }
    const key = flag[1] ?? "";
    const inline = flag[2];
    const name = named(key);
    const spec = name === undefined ? undefined : specs[name];
    const next = words[index + 1];
    const following = next === undefined || next.startsWith("--") ? undefined : next;
    if (name === undefined || spec === undefined) {
      const negated = key.startsWith("no-") ? named(key.slice(3)) : undefined;
      const negatedSpec = negated === undefined ? undefined : specs[negated];
      if (negated !== undefined && negatedSpec?.type === "boolean" && inline === undefined)
        supply(negated, negatedSpec, false);
      else {
        // An unknown name keeps its value for the declarations check, which names the argument.
        input[key] = inline ?? following ?? true;
        if (inline === undefined && following !== undefined) index += 1;
      }
      continue;
    }
    if (spec.type === "boolean") {
      if (inline === undefined || inline === "true" || inline === "false")
        supply(name, spec, inline !== "false");
      else problems.push(`--${name} is a boolean: pass --${name} or --no-${name}.`);
      continue;
    }
    const text = inline ?? following;
    if (inline === undefined && following !== undefined) index += 1;
    if (text === undefined) problems.push(`--${name} needs a ${spec.type} value.`);
    // A word that is no number stays text, and the declarations check names its type.
    else if (spec.type === "number" && text.trim() !== "" && Number.isFinite(Number(text)))
      supply(name, spec, Number(text));
    else supply(name, spec, text);
  }
  return { input, problems };
};

/** Replaces every declared secret value in a text with `<redacted>`. */
export const scrubSecrets = (text: string, values: ReadonlyArray<string>): string =>
  values
    .filter((value) => value.length > 0)
    .reduce((scrubbed, value) => scrubbed.replaceAll(value, "<redacted>"), text);

/** Why a returned value is not JSON data, naming the first offending path, if it is not. */
export const jsonProblem = (value: unknown, path = "result"): string | undefined => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? undefined : `${path} is ${value}; return JSON data.`;
  if (value instanceof Date) return `${path} is a Date (use .toISOString()); return JSON data.`;
  if (Array.isArray(value))
    return value.map((item, index) => jsonProblem(item, `${path}[${index}]`)).find(Boolean);
  if (isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return Object.entries(value)
      .map(([key, item]) => jsonProblem(item, `${path}.${key}`))
      .find(Boolean);
  const kind = isRecord(value) ? (value.constructor?.name ?? "object") : typeof value;
  return `${path} is ${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind}; return JSON data.`;
};

/** Ends a run with an expected failure; `fail` throws it inside the author's function. */
class ExpectedFailure {
  readonly message: string;
  readonly details: unknown;
  constructor(message: string, details: unknown) {
    this.message = message;
    this.details = details;
  }
}

/** The files a glob selects under `cwd`, walking only below the pattern's literal prefix. */
const listFiles = async (cwd: string, pattern: string): Promise<ReadonlyArray<string>> => {
  const literal = pattern.split("/").findIndex((part) => /[*?[\]{}()!]/.test(part));
  const prefix =
    literal === -1 ? dirname(pattern) : pattern.split("/").slice(0, literal).join("/") || ".";
  const matches = picomatch(pattern, { dot: true });
  const entries = await readdir(resolve(cwd, prefix), {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(cwd, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => matches(path))
    .sort();
};

/** File tools rooted at `cwd`; every call first checks that the run is still live. */
export const makeFiles = (cwd: string, signal: AbortSignal): Files => {
  const at = (path: string) => {
    signal.throwIfAborted();
    return isAbsolute(path) ? path : resolve(cwd, path);
  };
  const write = async (path: string, content: string) => {
    const target = at(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { signal });
  };
  return {
    read: async (path) => readFile(at(path), { encoding: "utf8", signal }),
    readJson: async (path): Promise<unknown> =>
      JSON.parse(await readFile(at(path), { encoding: "utf8", signal })),
    write,
    writeJson: (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`),
    exists: async (path) =>
      stat(at(path)).then(
        () => true,
        () => false,
      ),
    list: async (pattern) => {
      signal.throwIfAborted();
      return listFiles(cwd, pattern);
    },
    remove: async (path) => rm(at(path), { recursive: true, force: true }),
  };
};

/** A command that exited non-zero where the author did not allow it. */
class ExecFailed extends Error {}

/** Runs commands on the live Shell capability without a shell, throwing on a non-zero exit. */
export const makeExec =
  (
    execute: (command: Parameters<ShellService["execute"]>[0]) => Promise<ExecResult>,
    cwd: string,
  ): Exec =>
  async (command, args = [], options = {}) => {
    if (args.length === 0 && /\s/.test(command.trim()))
      throw new ExecFailed(
        `exec runs one executable without a shell. Write exec(${JSON.stringify(command.trim().split(/\s+/)[0])}, ${JSON.stringify(command.trim().split(/\s+/).slice(1))}).`,
      );
    const result = await execute({
      executable: command,
      args,
      cwd: options.cwd === undefined ? cwd : resolve(cwd, options.cwd),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (result.exitCode !== 0 && options.allowFailure !== true)
      throw new ExecFailed(
        `${command} exited with ${result.exitCode}${result.stderr.trim() === "" ? "." : `: ${result.stderr.trim().slice(0, 2000)}`}`,
      );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  };

/** Formats the parts of one log call the way `console.log` would join them. */
const logText = (parts: ReadonlyArray<unknown>) =>
  parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");

const ExpectedFailureSchema = Schema.Struct({ message: Schema.String, details: Schema.Json });

/** The message a run shows for what a script threw. */
const thrownMessage = (error: unknown) =>
  error instanceof Error ? error.message : `The script threw ${String(error)}.`;

/**
 * Runs a script-API definition on the contract 1 runner, so the supervisor, the outcome model, the
 * run log and history stay as they are. The author's function gets plain values and promises: the
 * declared secrets as strings, `exec` over the live Shell, `fs`, `log`, `fail`, and the run's
 * cancellation signal. Every message that leaves the run has the secret values replaced.
 */
export const adaptScript = (options: RecognizedScriptOptions, args: unknown, cwd: string) => {
  const names = options.secrets ?? [];
  const program = Effect.gen(function* () {
    const shell = yield* Shell;
    const secrets: Readonly<Record<string, string>> = Object.fromEntries(
      yield* Effect.forEach(names, (name) =>
        Effect.map(Secret(name), (value) => [name, Redacted.value(value)] as const),
      ),
    );
    const scrub = (text: string) => scrubSecrets(text, Object.values(secrets));
    const context = yield* Effect.context();
    const runSync = Effect.runSyncWith(context);
    const write =
      (level: typeof Effect.logInfo) =>
      (...parts: ReadonlyArray<unknown>) =>
        runSync(level(scrub(logText(parts))));
    const log: Log = Object.assign(write(Effect.logInfo), {
      debug: write(Effect.logDebug),
      info: write(Effect.logInfo),
      warn: write(Effect.logWarning),
      error: write(Effect.logError),
    });
    const settle = (signal: AbortSignal) =>
      Promise.resolve()
        .then(() =>
          options.run({
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `parseArguments` validated these values against the same declarations.
            args: args as never,
            secrets,
            log,
            fs: makeFiles(cwd, signal),
            exec: makeExec(
              (command) => Effect.runPromiseWith(context)(shell.execute(command), { signal }),
              cwd,
            ),
            cwd,
            signal,
            fail: (message, details) => {
              throw new ExpectedFailure(message, details ?? null);
            },
          }),
        )
        .then(
          (value: unknown) => ({ ok: true as const, value: value === undefined ? null : value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
    // A cancelled run aborts the signal; closing the run's scope then waits for the script to
    // settle, so its own `finally` cleanup completes before the run reports its finalization. An
    // error that cleanup raises, other than the abort itself, is a cleanup failure.
    const controller = new AbortController();
    let finished = false;
    const settled = yield* Effect.acquireRelease(
      Effect.sync(() =>
        settle(controller.signal).then((result) => {
          finished = true;
          return result;
        }),
      ),
      (running) => {
        if (finished === true) return Effect.void;
        controller.abort(new DOMException("The run was cancelled.", "AbortError"));
        return Effect.flatMap(
          Effect.promise(() => running),
          (result) =>
            result.ok === false && result.error !== controller.signal.reason
              ? Effect.die(new ScriptError(scrub(thrownMessage(result.error))))
              : Effect.void,
        );
      },
    );
    const outcome = yield* Effect.promise(() => settled);
    if (outcome.ok === true) {
      const problem = jsonProblem(outcome.value);
      if (problem !== undefined) return yield* Effect.die(new ScriptError(problem));
      return yield* Effect.succeed(
        Schema.decodeUnknownSync(Schema.Json)(JSON.parse(scrub(JSON.stringify(outcome.value)))),
      );
    }
    if (outcome.error instanceof ExpectedFailure)
      return yield* Effect.fail({
        message: scrub(outcome.error.message),
        details: Schema.decodeUnknownSync(Schema.Json)(
          JSON.parse(scrub(JSON.stringify(outcome.error.details) ?? "null")),
        ),
      });
    return yield* Effect.die(new ScriptError(scrub(thrownMessage(outcome.error))));
  });
  // The declared secrets are only known at run time, so the requirement proof cannot be stated.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The adapter supplies exactly the declared secrets and the Shell it asks for.
  return defineContractScript({
    contract: 1,
    input: Schema.Struct({}),
    output: Schema.Json,
    error: ExpectedFailureSchema,
    secrets: names,
    services: ["Shell"],
    run: () => program,
  } as never);
};

/** Why a module's default export cannot run, with the code and message the run reports. */
export type ScriptRefusal = {
  readonly ok: false;
  readonly code: "invalid_definition" | "invalid_args";
  readonly message: string;
};

/** Why a default export that `defineScript` did not return is no script. */
const refusal: ScriptRefusal = {
  ok: false,
  code: "invalid_definition",
  message:
    'The script\'s default export is not a script. Export default defineScript({ run: async (context) => { ... } }), imported from "@tackup/cli".',
};

/** What a script module's default export declares, or why it is no script. */
export const declarationsOf = (
  exported: unknown,
): { readonly ok: true; readonly declarations: ScriptDeclarations } | ScriptRefusal => {
  const options = recognizeScript(exported);
  return options === undefined
    ? refusal
    : {
        ok: true,
        declarations: Schema.decodeUnknownSync(ScriptDeclarationsSchema)({
          args: options.args ?? {},
          secrets: options.secrets ?? [],
        }),
      };
};

/**
 * Turns a script module's default export and the run's input, or its command-line words when the
 * run has them, into a runnable definition, or says why it cannot run: anything that
 * `defineScript` did not return is no script, and arguments are checked against the declarations
 * first.
 */
export const prepareScript = (
  exported: unknown,
  input: unknown,
  cwd: string,
  words?: ReadonlyArray<string>,
): { readonly ok: true; readonly definition: ReturnType<typeof adaptScript> } | ScriptRefusal => {
  const options = recognizeScript(exported);
  if (options === undefined) return refusal;
  const specs = options.args ?? {};
  const spelled = words === undefined ? { input, problems: [] } : inputFromWords(specs, words);
  const parsed = parseArguments(specs, spelled.input);
  const problems = [...spelled.problems, ...(parsed.ok === true ? [] : parsed.problems)];
  return parsed.ok === true && problems.length === 0
    ? { ok: true, definition: adaptScript(options, parsed.args, cwd) }
    : { ok: false, code: "invalid_args", message: problems.join("\n") };
};
