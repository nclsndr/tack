import { Result, Schema } from "effect";
import { compareCodeUnits } from "../identity/ordering.ts";
import { sha256 } from "../identity/portable.ts";
import { RecordLocationSchema, TransportSchema } from "./providers/provider-schema.ts";

const hexDigest = (length: number) =>
  Schema.String.check(Schema.isPattern(/^[0-9a-f]+$/)).check(
    Schema.isLengthBetween(length, length),
  );

const filesAreSortedAndUnique = Schema.makeFilter(
  (files: ReadonlyArray<{ readonly path: string }>) =>
    files.every(
      (file, index) => index === 0 || compareCodeUnits(files[index - 1]?.path ?? "", file.path) < 0,
    )
      ? []
      : ["The files must be unique and sorted by path."],
);

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** One file of an imported skill as Tack wrote it: its digest and executable bit. */
const ImportRecordFileSchema = Schema.Struct({
  path: NonEmptyString,
  sha256: hexDigest(64),
  executable: Schema.Boolean,
});

/**
 * One record of the `imports` section of a source's `tack.yaml`: where an imported skill folder
 * came from and the files exactly as Tack wrote them. Keys are the kebab-case names the YAML uses.
 */
export const ImportRecordSchema = Schema.Struct({
  /** The skill folder, relative to the source root and `/`-separated. */
  path: NonEmptyString,
  /**
   * The canonical location without a ref or folder, `<provider>:<text>`. The provider is the
   * prefix; only its adapter reads the text.
   */
  location: RecordLocationSchema,
  /** How the location was reached; its values belong to the provider. */
  transport: TransportSchema,
  "ref-kind": Schema.Literals(["default", "branch", "tag", "commit"]),
  /** The ref as the operator typed it; absent for the default branch. */
  ref: Schema.optionalKey(NonEmptyString),
  /** The full commit the ref request resolved to. */
  revision: hexDigest(40),
  /** The upstream folder at that revision; empty for a skill at the repository root. */
  "upstream-path": Schema.String,
  "upstream-tree": hexDigest(40),
  "imported-at": Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
  ),
  /** `sha256:` followed by the digest over {@link ImportRecordFile} entries. */
  digest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  files: Schema.Array(ImportRecordFileSchema).check(filesAreSortedAndUnique),
});

/** One imported skill's record. */
export type ImportRecord = typeof ImportRecordSchema.Type;

/** One file entry of a record. */
export type ImportRecordFile = typeof ImportRecordFileSchema.Type;

const decodeStrictly = Schema.decodeUnknownResult(ImportRecordSchema, {
  onExcessProperty: "error",
});

/** Decodes a record strictly: unknown keys, wrong shapes and unsorted files are refused. */
export const decodeImportRecord = (value: unknown): Result.Result<ImportRecord, string> =>
  Result.mapError(decodeStrictly(value), (error) => error.message);

/** The SHA-256 of bytes as lowercase hexadecimal. */
export const sha256Hex = (bytes: Uint8Array): string => sha256(bytes);

/**
 * The digest over a record's files: sorted entries, each framed as JSON so no two layouts share
 * one, returned with the `sha256:` prefix the record stores.
 */
export const filesDigest = (files: ReadonlyArray<ImportRecordFile>): string =>
  `sha256:${sha256(
    [...files]
      .sort((left, right) => compareCodeUnits(left.path, right.path))
      .map((file) => `${JSON.stringify([file.path, file.sha256, file.executable])}\n`),
  )}`;
