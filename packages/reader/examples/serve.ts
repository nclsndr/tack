/**
 * Serves the Atlas example docs set with the real reader, for development and screenshots:
 * `bun run reader:example [--port N]`. It prints the URL and stops on Ctrl-C.
 */
import { startReader } from "../src/server.ts";
import { exampleInput, examplePort } from "./example.ts";

const reader = await startReader({
  input: exampleInput(),
  port: examplePort(process.argv.slice(2)),
  version: "example",
  open: false,
});
process.stdout.write(`Atlas example docs: ${reader.url}\n`);
const stop = () => void reader.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await reader.closed;
