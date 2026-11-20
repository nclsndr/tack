/**
 * The Tack script API: plain async functions, no Effect. The running Tack provides this module to a
 * script under its published name, so a source installs nothing:
 *
 * ```ts
 * import { defineScript } from "@tackup/cli";
 *
 * export default defineScript({
 *   args: { name: { type: "string", description: "Who to greet" } },
 *   run: async ({ args, log }) => {
 *     log(`Greeting ${args.name}`);
 *     return { greeting: `Hello, ${args.name}` };
 *   },
 * });
 * ```
 *
 * This module imports nothing, so it can be loaded on its own by any script under Node or Bun.
 */

/** The value types an argument can take. */
export type ArgType = "string" | "number" | "boolean";

/** One named argument, in the shape of Node's `util.parseArgs` options plus `number` and `choices`. */
export type ArgSpec = {
  readonly type: ArgType;
  /** One line shown in argument errors. */
  readonly description?: string;
  /** Accept a list of values. */
  readonly multiple?: boolean;
  /** Allow the argument to be absent; it is then `undefined`. */
  readonly optional?: boolean;
  /** The value used when the argument is absent. */
  readonly default?: string | number | boolean | ReadonlyArray<string | number | boolean>;
  /** Restrict a string argument to these values. */
  readonly choices?: ReadonlyArray<string>;
};

type Base<S> = S extends { readonly type: "string"; readonly choices: ReadonlyArray<infer C> }
  ? C
  : S extends { readonly type: "string" }
    ? string
    : S extends { readonly type: "number" }
      ? number
      : boolean;
type ValueOf<S> = S extends { readonly multiple: true } ? ReadonlyArray<Base<S>> : Base<S>;
type MayBeAbsent<S> = S extends { readonly default: unknown }
  ? false
  : S extends { readonly optional: true }
    ? true
    : false;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The parsed and validated arguments a script receives. */
export type Args<A extends Record<string, ArgSpec>> = Simplify<
  { readonly [K in keyof A as MayBeAbsent<A[K]> extends true ? never : K]: ValueOf<A[K]> } & {
    readonly [K in keyof A as MayBeAbsent<A[K]> extends true ? K : never]?: ValueOf<A[K]>;
  }
>;

/** Writes to the run's log. Calling it directly logs at info level. */
export type Log = ((...parts: ReadonlyArray<unknown>) => void) & {
  readonly debug: (...parts: ReadonlyArray<unknown>) => void;
  readonly info: (...parts: ReadonlyArray<unknown>) => void;
  readonly warn: (...parts: ReadonlyArray<unknown>) => void;
  readonly error: (...parts: ReadonlyArray<unknown>) => void;
};

/** Files, with relative paths resolved from `cwd`. Every call stops once the run is cancelled. */
export type Files = {
  readonly read: (path: string) => Promise<string>;
  readonly readJson: (path: string) => Promise<unknown>;
  /** Creates parent directories as needed. */
  readonly write: (path: string, content: string) => Promise<void>;
  readonly writeJson: (path: string, value: unknown) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
  /** The files matching a glob, relative to `cwd`, sorted. */
  readonly list: (pattern: string) => Promise<ReadonlyArray<string>>;
  readonly remove: (path: string) => Promise<void>;
};

/** Options for one `exec` call. */
export type ExecOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Return the result instead of throwing when the command exits non-zero. */
  readonly allowFailure?: boolean;
};

/** What one command printed and how it exited. */
export type ExecResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/** Runs one executable with an argument list, without a shell. Throws on a non-zero exit. */
export type Exec = (
  command: string,
  args?: ReadonlyArray<string>,
  options?: ExecOptions,
) => Promise<ExecResult>;

/** Everything Tack gives a running script. */
export type ScriptContext<A extends Record<string, ArgSpec>, S extends string> = {
  readonly args: Args<A>;
  /** The declared secrets. Tack replaces their values with `<redacted>` in logs and results. */
  readonly secrets: { readonly [K in S]: string };
  readonly log: Log;
  readonly fs: Files;
  readonly exec: Exec;
  /** The run's working directory: the selected project root or the user's home. */
  readonly cwd: string;
  /** Aborted when the operator cancels the run or it times out. */
  readonly signal: AbortSignal;
  /** Ends the run with an expected failure that the operator should read. */
  readonly fail: (message: string, details?: unknown) => never;
};

/** What `defineScript` takes. */
export type ScriptOptions<A extends Record<string, ArgSpec>, S extends ReadonlyArray<string>> = {
  readonly args?: A;
  /** Names of operator secrets, read from `TACK_<NAME>` in the environment or the state `.env`. */
  readonly secrets?: S;
  /** The script. Return JSON data, or nothing. */
  readonly run: (context: ScriptContext<A, S[number]>) => unknown;
};

const brand = Symbol.for("tack.script-api/1");

/** The value `defineScript` returns; export it as the module's default export. */
export type Script = { readonly [brand]: 1 };

/** Thrown by `defineScript` when a definition is malformed; the message says how to fix it. */
export class ScriptDefinitionError extends Error {
  override readonly name = "ScriptDefinitionError";
}

const optionKeys = ["args", "secrets", "run"] as const;
const argKeys = ["type", "description", "multiple", "optional", "default", "choices"] as const;
const argTypes: ReadonlyArray<string> = ["string", "number", "boolean"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && Array.isArray(value) === false;

/** The known name sharing the most leading characters with an unknown one, if any shares one. */
const closest = (word: string, known: ReadonlyArray<string>) =>
  known
    .map((name) => ({
      name,
      shared: Array.from({ length: name.length }, (_, at) => at).findIndex(
        (at) => word[at] !== name[at],
      ),
    }))
    .map(({ name, shared }) => ({ name, shared: shared === -1 ? name.length : shared }))
    .reduce<{ readonly name?: string; readonly shared: number }>(
      (best, candidate) => (candidate.shared > best.shared ? candidate : best),
      { shared: 0 },
    ).name;

/** Every problem with one argument declaration. */
const argumentProblems = (name: string, spec: unknown): ReadonlyArray<string> => {
  if (/^[a-z][a-zA-Z0-9-]*$/.test(name) === false)
    return [`Argument "${name}" needs a lower-camel or kebab name, such as "repo" or "dry-run".`];
  if (
    isRecord(spec) === false ||
    typeof spec["type"] !== "string" ||
    argTypes.includes(spec["type"]) === false
  )
    return [`Argument "${name}" needs a type: { type: "string" | "number" | "boolean" }.`];
  return [
    ...Object.keys(spec).flatMap((key) =>
      (argKeys as ReadonlyArray<string>).includes(key) === true
        ? []
        : [`Argument "${name}" has no "${key}" field. Fields: ${argKeys.join(", ")}.`],
    ),
    ...(spec["choices"] !== undefined && spec["type"] !== "string"
      ? [`Argument "${name}" can only list choices when its type is "string".`]
      : []),
  ];
};

/** Every problem with one definition, each naming its fix. */
const definitionProblems = (options: unknown): ReadonlyArray<string> => {
  if (isRecord(options) === false)
    return ["defineScript expects an object: defineScript({ run: async (context) => { ... } })."];
  const unknownKeys = Object.keys(options).flatMap((key) => {
    if ((optionKeys as ReadonlyArray<string>).includes(key) === true) return [];
    const suggestion = closest(key, optionKeys);
    return [
      `defineScript has no "${key}" option.${suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`} Options: ${optionKeys.join(", ")}.`,
    ];
  });
  const run =
    typeof options["run"] === "function"
      ? []
      : ["defineScript needs a run function: run: async ({ args, log }) => { ... }."];
  const args = isRecord(options["args"])
    ? Object.entries(options["args"]).flatMap(([name, spec]) => argumentProblems(name, spec))
    : options["args"] === undefined
      ? []
      : ['defineScript "args" must be an object of argument declarations.'];
  const secrets = Array.isArray(options["secrets"])
    ? options["secrets"].flatMap((name: unknown) =>
        typeof name === "string" &&
        /^[A-Z][A-Z0-9_]*$/.test(name) &&
        name.startsWith("TACK_") === false
          ? []
          : [
              `Secret "${String(name)}" needs an uppercase name without the TACK_ prefix, such as "GITHUB_TOKEN".`,
            ],
      )
    : options["secrets"] === undefined
      ? []
      : ['defineScript "secrets" must be a list of names, such as ["GITHUB_TOKEN"].'];
  return [...unknownKeys, ...run, ...args, ...secrets];
};

/**
 * Declares a Tack script; export the result as the module's default export. A malformed definition
 * throws {@link ScriptDefinitionError} when the module loads, listing every problem.
 */
export function defineScript<
  const A extends Record<string, ArgSpec> = {},
  const S extends ReadonlyArray<string> = [],
>(options: ScriptOptions<A, S>): Script {
  const problems = definitionProblems(options);
  if (problems.length > 0) throw new ScriptDefinitionError(problems.join("\n"));
  return Object.freeze({ [brand]: 1 as const, options: Object.freeze({ ...options }) });
}

/**
 * A recognized definition, without the authoring generics.
 * @internal Used by the Tack worker; not part of the authoring contract.
 */
export type RecognizedScriptOptions = ScriptOptions<Record<string, ArgSpec>, ReadonlyArray<string>>;

/**
 * The options of a value `defineScript` returned, from any copy of this module, else `undefined`.
 * @internal Used by the Tack worker; not part of the authoring contract.
 */
export const recognizeScript = (value: unknown): RecognizedScriptOptions | undefined =>
  isRecord(value) && brand in value && "options" in value && isRecord(value["options"])
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only defineScript sets the brand, after validating these options.
      (value["options"] as RecognizedScriptOptions)
    : undefined;
