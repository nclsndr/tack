/**
 * The one state format this release reads and writes, under the envelope key `format`: it is the
 * only number Tack compares.
 */
export const stateFormat = 1;

/** The file name of the state document inside a state directory. */
export const stateFileName = "state.json";

/**
 * What the first field of a state document says about it. `format` names a layout this or a later
 * release writes; anything else is not a state document.
 */
export type StateFirstField =
  | { readonly _tag: "format"; readonly format: number }
  | { readonly _tag: "unrecognized" };

const isEnvelopeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Routes a parsed document on its first field, the way every state read does. */
export const routeStateDocument = (document: unknown): StateFirstField => {
  if (typeof document !== "object" || document === null || Array.isArray(document))
    return { _tag: "unrecognized" };
  const [key] = Object.keys(document);
  const value: unknown = key === undefined ? undefined : Reflect.get(document, key);
  if (key === "format" && isEnvelopeNumber(value)) return { _tag: "format", format: value };
  return { _tag: "unrecognized" };
};

/** What a state file's first field says, read without decoding the rest of the file. */
export type InspectedStateFormat = {
  readonly exists: boolean;
  /** The number under the `format` key, when the file starts with one. */
  readonly format: number | null;
};

/** How many leading bytes of a state file the format probe reads. */
export const stateFormatPrefixLength = 256;

/**
 * What the leading bytes of an existing state file say. The scan stops after the first field;
 * Tack writes `format` as the document's first field.
 */
export const stateFormatOfPrefix = (bytes: Uint8Array): InspectedStateFormat => {
  const decoder = new TextDecoder();
  const end = bytes
    .subarray(0, stateFormatPrefixLength)
    .findIndex(
      (byte, index) =>
        byte === 44 || (byte === 125 && decoder.decode(bytes.subarray(0, index)).includes(":")),
    );
  const prefix = decoder.decode(bytes.subarray(0, end === -1 ? stateFormatPrefixLength : end + 1));
  const match = /^\s*\{\s*"format"\s*:\s*(\d+)(?=\s*[,}])/.exec(prefix);
  return { exists: true, format: match === null ? null : Number(match[1]) };
};
