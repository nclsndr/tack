import { Result, Schema } from "effect";
import {
  commandDeclarations,
  flagRequestPayloads,
  payloadSlots,
  type PayloadSchemas,
} from "../../src/cli/commands/declarations.ts";

/** The declared slot schemas of the command an envelope names, or `undefined` for none. */
const declaredSchemasOf = (command: string): PayloadSchemas | undefined =>
  command === "help" || command === "version"
    ? flagRequestPayloads[command]
    : Object.values(commandDeclarations).find(({ path }) => path.join(" ") === command);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && Array.isArray(value) === false;

/**
 * Every payload slot of an envelope that its command's declaration does not describe: a slot the
 * declaration leaves out, or one its schema does not decode. A value that is not an envelope of a
 * declared command has no problem to report. Failed runs are checked too, since a failed script run
 * still fills `result`.
 */
export const undeclaredPayloads = (envelope: unknown): ReadonlyArray<string> => {
  if (isRecord(envelope) === false || typeof envelope["command"] !== "string") return [];
  const command = envelope["command"];
  const declared = declaredSchemasOf(command);
  if (declared === undefined) return [];
  return payloadSlots.flatMap((slot) => {
    const payload = envelope[slot];
    if (payload === null || payload === undefined) return [];
    const schema = declared[slot];
    if (schema === undefined) return [`${command} fills ${slot}, which it does not declare`];
    const decoded = Schema.decodeUnknownResult(schema)(payload);
    return Result.isSuccess(decoded) ? [] : [`${command} ${slot}: ${String(decoded.failure)}`];
  });
};

/** {@link undeclaredPayloads} of what a `--json` run printed; other output has none. */
export const undeclaredPayloadsOfOutput = (stdout: string): ReadonlyArray<string> => {
  try {
    return undeclaredPayloads(JSON.parse(stdout));
  } catch {
    return [];
  }
};
