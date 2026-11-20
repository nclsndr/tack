import { stripVTControlCharacters } from "node:util";

/** The requested reader port is already owned by another process. */
export class ReaderPortInUseError extends Error {
  override readonly name = "ReaderPortInUseError";
  readonly port: number;

  constructor(port: number) {
    super(
      `Reader port ${port} is already in use. Stop the process using it or choose another port with --port <port> (use --port 0 for an available port).`,
    );
    this.port = port;
  }
}

/** Translates Rsbuild's strict-port failures while preserving unknown failures unchanged. */
export function readerStartupError(error: unknown, port: number): unknown {
  if (error instanceof Error) {
    const message = stripVTControlCharacters(error.message);
    // Rsbuild 2.2.14 drops EADDRINUSE and throws these messages from getPort.
    if (
      ("code" in error && error.code === "EADDRINUSE") ||
      message === `[rsbuild:server] Port ${port} is occupied, please choose another one.` ||
      message ===
        `[rsbuild:server] Failed to find an available port after 2 attempts, starting from ${port}.`
    ) {
      return new ReaderPortInUseError(port);
    }
  }
  return error;
}
