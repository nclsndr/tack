/**
 * Watches the reader's roots from a process of its own and reports each saved change to the engine
 * that spawned it.
 *
 * On macOS, Bun serves every recursive watch of a process from one FSEvents stream and rebuilds that
 * stream whenever a watcher opens or closes, losing changes saved meanwhile. The dev server opens and
 * closes watchers each time the engine restarts it, so a watcher sharing its process misses saves.
 * This process opens its watchers once and never again.
 */
import { watch } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

/** What the watcher reports to the engine. */
export type WatcherMessage =
  | { type: "watching" }
  | { type: "change"; path: string }
  | { type: "unavailable"; root: string; message: string };

const options = z
  .object({ roots: z.array(z.string()), sentinel: z.string() })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const report = (message: WatcherMessage) => process.send?.(message);
/** Opens one recursive watch, reporting a root it cannot watch instead of stopping. */
function watchRoot(root: string, changed: (filename: string) => void): boolean {
  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename !== null) changed(filename);
    });
    watcher.on("error", (error) => report({ type: "unavailable", root, message: error.message }));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report({ type: "unavailable", root, message });
    return false;
  }
}
process.on("disconnect", () => process.exit(0));
options.roots.forEach((root) =>
  watchRoot(root, (filename) => report({ type: "change", path: resolve(root, filename) })),
);
// A recursive watch starts delivering a moment after `watch` returns. The sentinel watcher opens last,
// so its first event comes from the stream that covers every root: from then on no save is lost.
await mkdir(options.sentinel, { recursive: true });
const delivering = Promise.withResolvers<void>();
if (watchRoot(options.sentinel, () => delivering.resolve()) === true) {
  const touch = () => writeFile(join(options.sentinel, "touch"), String(Date.now()));
  await touch();
  const retouch = setInterval(() => void touch(), 50);
  await delivering.promise;
  clearInterval(retouch);
}
report({ type: "watching" });
