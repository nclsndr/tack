import { Readable } from "node:stream";
import { open } from "node:fs/promises";
import {
  executionLimits,
  runFailure,
  type OperatorRunRequest,
  type RunFailure,
} from "../../domain/execution/execution-schema.ts";
import { Schema } from "effect";

/** Classifies input transport failures before schema decoding or program construction. */
export class InputFailure extends Error {
  readonly outcome: RunFailure;
  constructor(outcome: RunFailure) {
    super(outcome.message);
    this.outcome = outcome;
  }
}
const failure = (code: string, message: string) =>
  new InputFailure(runFailure("invocation", code, message));
const interruption = () =>
  new InputFailure(
    runFailure("execution", "interrupted", "The run was interrupted while reading JSON input."),
  );
const readBounded = async (
  stream: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    if (signal?.aborted === true) {
      if (stream instanceof Readable) stream.destroy();
      throw interruption();
    }
    const next = await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      const aborted = () => {
        if (stream instanceof Readable) stream.destroy();
        reject(interruption());
      };
      signal?.addEventListener("abort", aborted, { once: true });
      void iterator.next().then(
        (item) => {
          signal?.removeEventListener("abort", aborted);
          resolve(item);
        },
        (error: unknown) => {
          signal?.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
    if (next.done === true) break;
    bytes += next.value.length;
    if (bytes > executionLimits.inputBytes) {
      if (stream instanceof Readable) stream.destroy();
      throw failure("input_too_large", "JSON input exceeds the 1 MiB limit.");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** Reads exactly one JSON source, preserving the original JSON value without runtime serialization. */
export const readRunInput = async (
  request: OperatorRunRequest,
  stdin: AsyncIterable<Uint8Array> = process.stdin,
  signal?: AbortSignal,
): Promise<Schema.Json> => {
  const sources = [
    request.inputJson !== undefined,
    request.inputFile !== undefined,
    request.inputStdin === true,
    request.words !== undefined,
  ].filter((value) => value).length;
  if (sources > 1)
    throw failure(
      "input_sources_conflict",
      "Choose one of inline JSON, a JSON file, standard input, or arguments after --.",
    );
  let text = request.inputJson ?? "{}";
  if (request.inputFile !== undefined) {
    let file;
    try {
      file = await open(request.inputFile, "r");
      text = await readBounded(file.createReadStream({ autoClose: false }), signal);
    } catch (error) {
      if (error instanceof InputFailure) throw error;
      throw failure("input_file_read_failed", "The JSON input file could not be read.");
    } finally {
      await file?.close();
    }
  } else if (request.inputStdin === true) {
    try {
      text = await readBounded(stdin, signal);
    } catch (error) {
      if (error instanceof InputFailure) throw error;
      throw failure("input_stdin_read_failed", "JSON input could not be read from standard input.");
    }
  }
  if (Buffer.byteLength(text) > executionLimits.inputBytes)
    throw failure("input_too_large", "JSON input exceeds the 1 MiB limit.");
  try {
    return Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text));
  } catch {
    throw failure("input_json_invalid", "Input must be valid JSON.");
  }
};
