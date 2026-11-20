import { type Effect, type Exit, Schema, type Scope } from "effect";
import {
  type SecretRequirement,
  type Shell,
  type ShellFailure,
  type ShellService,
} from "./capabilities.ts";

import { strictInputSchema } from "./strict-input.ts";

export const ScriptContract = 1 as const;
export const NoExpectedFailure = "@tackup/NoExpectedFailure" as const;
export type BoundarySchema = Schema.Codec<unknown>;
export type ErrorBoundary = BoundarySchema | typeof NoExpectedFailure;
export type ServiceName = "Shell";
type DomainError<E extends ErrorBoundary> = E extends BoundarySchema ? E["Type"] : never;
type Requirements<Names extends readonly string[], Services extends readonly ServiceName[]> =
  | { [Name in Names[number]]: SecretRequirement<Name> }[Names[number]]
  | ("Shell" extends Services[number] ? Shell : never);
type CapabilityError<Services extends readonly ServiceName[]> = "Shell" extends Services[number]
  ? ShellFailure
  : never;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const DefinitionId = Symbol.for("@tackup/ScriptDefinition");
const BoundaryParserId = Symbol.for("@tackup/ScriptBoundaryParser/1");
type BoundaryParser = (
  schema: BoundarySchema,
  value: unknown,
  direction: "decode" | "encode" | "encodeInput",
) => Exit.Exit<unknown, Schema.SchemaError>;
const parseAuthorBoundary: BoundaryParser = (schema, value, direction) => {
  if (direction === "encode") return Schema.encodeUnknownExit(schema)(value);
  const input = strictInputSchema(schema);
  return direction === "encodeInput"
    ? Schema.encodeUnknownExit(input)(value)
    : Schema.decodeUnknownExit(input, { onExcessProperty: "error" })(value);
};

export type ScriptDefinition<
  I extends BoundarySchema = BoundarySchema,
  O extends BoundarySchema = BoundarySchema,
  E extends ErrorBoundary = ErrorBoundary,
  Names extends readonly string[] = readonly string[],
  Services extends readonly ServiceName[] = readonly ServiceName[],
> = {
  readonly [DefinitionId]: true;
  readonly [BoundaryParserId]: BoundaryParser;
  readonly contract: typeof ScriptContract;
  readonly input: I;
  readonly output: O;
  readonly error: E;
  readonly secrets: Names;
  readonly services: Services;
  readonly run: (
    input: I["Type"],
  ) => Effect.Effect<
    O["Type"],
    DomainError<E> | CapabilityError<Services>,
    Requirements<Names, Services> | Scope.Scope
  >;
};

export type ScriptServices<
  Names extends readonly string[],
  Services extends readonly ServiceName[],
> = (Names[number] extends never
  ? { readonly secrets?: Readonly<Record<string, string>> }
  : { readonly secrets: Readonly<Record<Names[number], string>> }) &
  ("Shell" extends Services[number]
    ? { readonly Shell: ShellService }
    : { readonly Shell?: ShellService });

/** Defines a lazy program with exact declared capabilities and service-free boundaries. */
export function defineScript<
  I extends BoundarySchema,
  O extends BoundarySchema,
  E extends ErrorBoundary,
  const Names extends readonly string[],
  const Services extends readonly ServiceName[],
  Program extends Effect.Effect<
    O["Type"],
    DomainError<E> | CapabilityError<Services>,
    Requirements<Names, Services> | Scope.Scope
  >,
>(
  definition: {
    readonly contract: typeof ScriptContract;
    readonly input: I;
    readonly output: O;
    readonly error: E;
    readonly secrets: Names;
    readonly services: Services;
    readonly run: (input: I["Type"]) => Program;
  },
  ..._agreement: Same<
    Exclude<Effect.Services<Program>, Scope.Scope>,
    Requirements<Names, Services>
  > extends true
    ? []
    : [requirementsMustMatchDeclarations: never]
): ScriptDefinition<I, O, E, Names, Services> {
  // The rest-parameter proof enforces the environment equality erased at runtime.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The generic equality proof is erased; tuple copies preserve the declared literals.
  return Object.freeze({
    ...definition,
    secrets: Object.freeze([...definition.secrets]),
    services: Object.freeze([...definition.services]),
    [DefinitionId]: true,
    [BoundaryParserId]: parseAuthorBoundary,
  }) as unknown as ScriptDefinition<I, O, E, Names, Services>;
}

/** Runtime representation after recognition, without erased authoring generics. */
declare const RecognizedId: unique symbol;
export type RecognizedScript = {
  readonly [RecognizedId]: true;
  readonly [BoundaryParserId]: BoundaryParser;
  readonly contract: typeof ScriptContract;
  readonly input: BoundarySchema;
  readonly output: BoundarySchema;
  readonly error: ErrorBoundary;
  readonly secrets: readonly string[];
  readonly services: readonly ServiceName[];
  readonly run: (input: unknown) => unknown;
};
/** Every code {@link inspectScriptDefinition} reports for a value it cannot recognize. */
export const definitionFailureCodes = [
  "invalid_definition",
  "unsupported_contract",
  "unknown_capability",
] as const;
export type DefinitionFailureCode = (typeof definitionFailureCodes)[number];
export type DefinitionInspection =
  | { readonly ok: true; readonly definition: RecognizedScript }
  | {
      readonly ok: false;
      readonly code: DefinitionFailureCode;
      readonly message: string;
    };

/** Recognizes a supported definition without constructing or executing its program. */
export function inspectScriptDefinition(value: unknown): DefinitionInspection {
  if (
    typeof value !== "object" ||
    value === null ||
    !(DefinitionId in value) ||
    value[DefinitionId] !== true ||
    !(BoundaryParserId in value) ||
    typeof value[BoundaryParserId] !== "function"
  ) {
    return {
      ok: false,
      code: "invalid_definition",
      message: "Expected a definition created by defineScript.",
    };
  }
  if (!("contract" in value) || value.contract !== ScriptContract) {
    return {
      ok: false,
      code: "unsupported_contract",
      message: "Unsupported script contract version.",
    };
  }
  if (
    !("services" in value) ||
    !Array.isArray(value.services) ||
    value.services.some((service: unknown) => service !== "Shell")
  ) {
    return { ok: false, code: "unknown_capability", message: "Unknown service capability." };
  }
  if (
    !("secrets" in value) ||
    !Array.isArray(value.secrets) ||
    value.secrets.some(
      (name: unknown) =>
        typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name) || name.startsWith("TACK_"),
    )
  ) {
    return {
      ok: false,
      code: "unknown_capability",
      message: "Secret names must be unprefixed uppercase environment names.",
    };
  }
  if (
    !("input" in value) ||
    !Schema.isSchema(value.input) ||
    !("output" in value) ||
    !Schema.isSchema(value.output) ||
    !("error" in value) ||
    (value.error !== NoExpectedFailure && !Schema.isSchema(value.error)) ||
    !("run" in value) ||
    typeof value.run !== "function"
  ) {
    return {
      ok: false,
      code: "invalid_definition",
      message: "Missing script schemas or program constructor.",
    };
  }
  // Schema requirements and callback types are erased. Synchronous parsing and isEffect
  // validate their runtime behavior before execution; no external context is supplied.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Recognition validates the runtime structure; schemas are checked synchronously at use.
  return { ok: true, definition: value as unknown as RecognizedScript };
}

/** Uses the defining package's Schema runtime so foreign parser sentinels never mix. */
export function parseScriptBoundary(
  definition: RecognizedScript,
  schema: BoundarySchema,
  value: unknown,
  direction: "decode" | "encode" | "encodeInput",
) {
  return definition[BoundaryParserId](schema, value, direction);
}
