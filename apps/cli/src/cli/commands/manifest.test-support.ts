import { Effect, JsonSchema, Schema } from "effect";
import { commandDeclarations, payloadSlots, type CommandDeclaration } from "./declarations.ts";
import {
  type CommandContract,
  CommandContractSchema,
  describeTree,
  samePath,
  startsWith,
  unknownPath,
} from "./manifest.ts";

/**
 * The contracts of the executable commands under one path. No command prints it; the tests derive
 * the operation list, the flags and the payload checks from it.
 */
export const CommandContractsSchema = Schema.Struct({
  /** JSON Schema of each typed payload kind named by a response slot; `json` slots have none. */
  payloads: Schema.Record(Schema.String, Schema.Json),
  commands: Schema.Array(CommandContractSchema),
});

/** The contracts under one command path. */
type CommandContracts = typeof CommandContractsSchema.Type;

const toJson = Schema.decodeUnknownSync(Schema.Json);

/** Moves repeated JSON Schema nodes into shared definitions within one published document. */
const shareDefinitions = (schema: unknown, existing: Record<string, unknown>) => {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && Array.isArray(value) === false;
  const isSchemaNode = (value: Record<string, unknown>) =>
    ["type", "anyOf", "oneOf", "allOf", "$ref", "enum", "const", "not"].some((key) => key in value);
  const counts = new Map<string, number>();
  const count = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => count(item));
      return;
    }
    if (isObject(value)) {
      if (isSchemaNode(value)) {
        const key = JSON.stringify(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      Object.values(value).forEach((item) => count(item));
    }
  };
  count(schema);
  count(existing);
  const shared: Record<string, unknown> = {};
  const names = new Map<string, string>();
  let nextName = 1;
  const visit = (value: unknown, root = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (!isObject(value)) return value;
    const key = JSON.stringify(value);
    if (root === false && isSchemaNode(value) && key.length >= 200 && (counts.get(key) ?? 0) > 1) {
      let name = names.get(key);
      if (name === undefined) {
        do {
          name = `shared-${nextName++}`;
        } while (name in existing);
        names.set(key, name);
        shared[name] = Object.fromEntries(
          Object.entries(value).map(([field, child]) => [field, visit(child)]),
        );
      }
      return { $ref: `#/$defs/${name}` };
    }
    return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, visit(child)]));
  };
  const body = visit(schema, true);
  const definitions = Object.fromEntries(
    Object.entries(existing).map(([name, value]) => [name, visit(value, true)]),
  );
  return { body: isObject(body) ? body : {}, definitions: { ...definitions, ...shared } };
};

/**
 * Publishes a schema as a standalone JSON Schema (draft 2020-12) document. Objects are closed,
 * because published payloads carry no fields beyond their contract.
 */
export const publishedJsonSchema = (schema: Schema.Top): Schema.Json => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  const shared = shareDefinitions(document.schema, document.definitions);
  return toJson({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    ...shared.body,
    ...(Object.keys(shared.definitions).length === 0 ? {} : { $defs: shared.definitions }),
  });
};

/** The payload schemas of the stable `--json` contract, by kind; no other command has one. */
const payloadSchemas = Object.fromEntries(
  Object.values<CommandDeclaration>(commandDeclarations).flatMap((declaration) =>
    declaration.stable === true
      ? payloadSlots.flatMap((slot) => {
          const schema = declaration[slot];
          return schema === undefined
            ? []
            : [[schema.fields.kind.literal, publishedJsonSchema(schema)] as const];
        })
      : [],
  ),
);

/** Describes the contracts of every executable command at or below one command path. */
export const describeContracts = Effect.fnUntraced(function* (commandPath: ReadonlyArray<string>) {
  const tree = yield* describeTree();
  if (!tree.some(({ grammar }) => samePath(grammar.commandPath, commandPath)))
    return yield* unknownPath(commandPath);
  const commands = tree.flatMap(({ grammar, responses }): ReadonlyArray<CommandContract> =>
    grammar.mutation !== undefined && startsWith(grammar.commandPath, commandPath)
      ? [
          {
            command: grammar.commandPath.join(" "),
            ...grammar,
            mutation: grammar.mutation,
            responses,
          },
        ]
      : [],
  );
  const referenced = new Set<string>(
    commands.flatMap((command) =>
      command.responses.flatMap((response) => Object.values(response.slots)),
    ),
  );
  return {
    payloads: Object.fromEntries(
      Object.entries(payloadSchemas).filter(([kind]) => referenced.has(kind)),
    ),
    commands,
  } satisfies CommandContracts;
});
