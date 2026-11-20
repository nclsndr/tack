import { Config, ConfigProvider, Effect, Option } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Only execution essentials are inherited by a worker; secrets travel privately. */
export const minimalWorkerEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"].flatMap((name) =>
      environment[name] === undefined ? [] : [[name, environment[name]]],
    ),
  );

/** Missing secrets report names only and never include lookup contents or provider diagnostics. */
export class SecretFailure extends Error {
  readonly code: "secret_missing" | "secret_configuration_failed";
  readonly names: ReadonlyArray<string>;
  constructor(
    code: "secret_missing" | "secret_configuration_failed",
    names: ReadonlyArray<string> = [],
  ) {
    super(
      code === "secret_missing"
        ? "One or more declared secrets are missing or empty."
        : "The operator secret configuration could not be read.",
    );
    this.code = code;
    this.names = names;
  }
}

/** Builds process-over-dotenv secret lookup at the owned worker integration edge. */
export const prepareSecretLookup = async (
  stateDirectory: string,
  environment: NodeJS.ProcessEnv,
) => {
  let contents: string;
  try {
    contents = await readFile(join(stateDirectory, ".env"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") contents = "";
    else throw new SecretFailure("secret_configuration_failed");
  }
  const dotenv = ConfigProvider.fromDotEnvContents(contents, { preserveEmptyStrings: true });
  const knownValues = Object.entries(environment)
    .filter(([name]) => name.startsWith("TACK_"))
    .flatMap(([, value]) => (value === undefined || value.length === 0 ? [] : [value]));
  return {
    knownValues,
    lookup: async (names: ReadonlyArray<string>) => {
      const secrets: Record<string, string> = {};
      const missing: string[] = [];
      for (const name of names) {
        if (/^[A-Z][A-Z0-9_]*$/.test(name) === false)
          throw new SecretFailure("secret_configuration_failed");
        const key = `TACK_${name}`;
        let value = environment[key];
        if (value === undefined) {
          try {
            value = Option.getOrUndefined(
              await Effect.runPromise(Config.String(key).pipe(Config.option).parse(dotenv)),
            );
          } catch {
            throw new SecretFailure("secret_configuration_failed");
          }
        }
        if (value === undefined || value.length === 0) missing.push(name);
        else {
          secrets[name] = value;
          knownValues.push(value);
        }
      }
      if (missing.length > 0) throw new SecretFailure("secret_missing", missing);
      return secrets;
    },
  };
};

/** Redacts only diagnostics owned by Tack, retaining intentional script data separately. */
export const redactDiagnostic = (text: string, values: ReadonlyArray<string>) =>
  values
    .reduce(
      (result, value) => (value.length === 0 ? result : result.split(value).join("[REDACTED]")),
      text,
    )
    .slice(0, 65536);

/** Bounds and redacts JSON diagnostics without truncating an encoded document mid-token. */
export const redactOwnedJson = (
  value: import("effect").Schema.Json,
  values: ReadonlyArray<string>,
  depth = 0,
): import("effect").Schema.Json => {
  if (typeof value === "string") return redactDiagnostic(value, values).slice(0, 8192);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value))
    return value.slice(0, 64).map((item) => redactOwnedJson(item, values, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .map(([key, item]) => [key, redactOwnedJson(item, values, depth + 1)]),
  );
};
