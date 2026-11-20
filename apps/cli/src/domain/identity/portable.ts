/**
 * Pure replacements for the few Node built-ins that domain and feature modules used for plain
 * computation, so the command graph runs wherever Effect runs. Each one is tested against the Node
 * function it replaces.
 */
import { Effect, Path } from "effect";

/**
 * POSIX path operations as plain functions: Effect's port of Node's `path.posix`, which is what
 * Node's `path` is on every platform Tack supports. `resolve` falls back to the process working
 * directory only for relative input.
 */
export const posixPath: Path.Path = Effect.runSync(
  Effect.gen(function* () {
    return yield* Path.Path;
  }).pipe(Effect.provide(Path.layer)),
);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * Node's `util.isDeepStrictEqual` for the plain data Tack compares (primitives, arrays and plain
 * objects): primitives by `Object.is`, containers by prototype, keys and items.
 */
export const deepStrictEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (isRecord(left) === false || isRecord(right) === false) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && deepStrictEqual(left[key], right[key]))
  );
};

/** Joins byte chunks into one array, as `Buffer.concat` does. */
export const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  chunks.reduce((offset, chunk) => {
    joined.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  return joined;
};

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const roundConstants = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = new TextEncoder();

const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** Runs the SHA-256 compression function over one 64-byte block at `offset`. */
const compress = (state: Uint32Array, block: DataView, offset: number, words: Uint32Array) => {
  for (let index = 0; index < 16; index += 1) words[index] = block.getUint32(offset + index * 4);
  for (let index = 16; index < 64; index += 1) {
    const early = words[index - 15] ?? 0;
    const late = words[index - 2] ?? 0;
    const sigma0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3);
    const sigma1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10);
    words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) | 0;
  }
  let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state;
  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    const choice = (e & f) ^ (~e & g);
    const first = (h + sum1 + choice + (roundConstants[index] ?? 0) + (words[index] ?? 0)) | 0;
    const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    h = g;
    g = f;
    f = e;
    e = (d + first) | 0;
    d = c;
    c = b;
    b = a;
    a = (first + sum0 + majority) | 0;
  }
  [a, b, c, d, e, f, g, h].forEach((value, index) => {
    state[index] = ((state[index] ?? 0) + value) | 0;
  });
};

/**
 * The SHA-256 of `input` as lowercase hexadecimal, computed synchronously in plain JavaScript.
 * Strings hash as their UTF-8 bytes, and a list of chunks hashes as their concatenation, the way
 * repeated `update` calls on a Node hash do.
 */
export const sha256 = (input: Uint8Array | string | ReadonlyArray<Uint8Array | string>): string => {
  const chunks = (typeof input === "string" || input instanceof Uint8Array ? [input] : input).map(
    (chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk),
  );
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  // The message, a 0x80 byte, zero padding, then the bit length as a 64-bit big-endian number.
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  chunks.reduce((offset, chunk) => {
    padded.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.byteLength - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.byteLength - 4, (length * 8) >>> 0);
  const state = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.byteLength; offset += 64)
    compress(state, view, offset, words);
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
};
