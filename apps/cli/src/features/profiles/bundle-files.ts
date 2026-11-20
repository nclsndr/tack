import { readBoundedBundleFile } from "../sources/bundle-file-read.ts";
import { Effect, FileSystem, Option, Path } from "effect";
import { bundleDigest } from "../../domain/bundles/bundle-codec.ts";
import { BundleError } from "../../domain/bundles/bundle-error.ts";
import { validateBundlePath } from "../../domain/bundles/bundle-path.ts";
import { bundleLimits, type ArchiveEntry } from "../../domain/bundles/tar.ts";
import type { ProfilePlanFinding } from "../../domain/profiles/profile-schema.ts";

/** One invocation's shared budget prevents an export walk from accumulating unbounded content. */
export type BundleBudget = { bytes: number; entries: number; exhausted: boolean };
/** Collects only explicit resource/support paths, refusing links, sensitive paths and special files. */
export const makeBundleFileCollector = Effect.fnUntraced(function* (
  root: string,
  prefix: string,
  findings: ProfilePlanFinding[],
  budget: BundleBudget,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = new Map<string, ArchiveEntry>();
  const exhausted = () => {
    budget.exhausted = true;
    findings.push({
      code: "profile-bundle-limit",
      message:
        "Export exceeds the bounded total byte/entry inventory. Narrow resource or support content.",
    });
  };
  const add = (entry: ArchiveEntry) => {
    const previous = entries.get(entry.path);
    if (
      previous !== undefined &&
      (bundleDigest(previous.bytes) !== bundleDigest(entry.bytes) ||
        previous.mode !== entry.mode ||
        previous.kind !== entry.kind)
    )
      findings.push({
        code: "profile-bundle-incomplete",
        message: `${entry.path} changed while reading; retry from stable content.`,
      });
    const cost = 512 + Math.ceil(entry.bytes.length / 512) * 512;
    if (previous === undefined) {
      if (
        budget.exhausted === true ||
        budget.entries + 1 > bundleLimits.entries ||
        budget.bytes + cost > bundleLimits.expandedBytes
      ) {
        if (budget.exhausted === false) exhausted();
        return;
      }
      budget.entries += 1;
      budget.bytes += cost;
    }
    entries.set(entry.path, entry);
  };
  const walk = Effect.fnUntraced(function* (
    relative: string,
  ): Effect.fn.Return<
    void,
    import("effect").PlatformError.PlatformError | BundleError,
    FileSystem.FileSystem
  > {
    if (budget.exhausted === true) return;
    try {
      validateBundlePath(relative);
    } catch (error) {
      findings.push({
        code: error instanceof BundleError ? error.code : "profile-bundle-invalid",
        message: String(error),
      });
      return;
    }
    const parts = relative.split("/");
    for (let count = 1; count <= parts.length; count += 1) {
      const parent = parts.slice(0, count).join("/");
      const absolute = path.join(root, parent);
      if (Option.isSome(yield* fs.readLink(absolute).pipe(Effect.option))) {
        findings.push({
          code: "profile-bundle-incomplete",
          message: `${parent} is a source symlink. Explicitly materialize regular content before export.`,
        });
        return;
      }
      const info = yield* fs.stat(absolute);
      if (info.type !== "File" && info.type !== "Directory") {
        findings.push({
          code: "profile-bundle-incomplete",
          message: `${parent} is not a regular file/directory. Materialize its content first.`,
        });
        return;
      }
      if (count < parts.length)
        add({
          path: prefix + parent,
          kind: "directory",
          mode: info.mode & 0o777,
          bytes: new Uint8Array(),
        });
    }
    const absolute = path.join(root, relative);
    const info = yield* fs.stat(absolute);
    if (info.type === "Directory") {
      add({
        path: prefix + relative,
        kind: "directory",
        mode: info.mode & 0o777,
        bytes: new Uint8Array(),
      });
      for (const name of (yield* fs.readDirectory(absolute)).sort())
        yield* walk(`${relative}/${name}`);
    } else {
      const size = Number(info.size);
      if (size > bundleLimits.fileBytes) {
        findings.push({
          code: "profile-bundle-limit",
          message: `${relative} exceeds the per-file bundle limit.`,
        });
        return;
      }
      if (
        entries.has(prefix + relative) === false &&
        budget.bytes + 512 + Math.ceil(size / 512) * 512 > bundleLimits.expandedBytes
      ) {
        exhausted();
        return;
      }
      add({
        path: prefix + relative,
        kind: "file",
        mode: info.mode & 0o777,
        bytes: yield* readBoundedBundleFile(absolute),
      });
    }
  });
  const include = (relative: string) =>
    walk(relative).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          findings.push({
            code: error instanceof BundleError ? error.code : "profile-bundle-incomplete",
            message: `Required content ${relative} is unavailable: ${error.message}. Declare/materialize missing support before export.`,
          });
        }),
      ),
    );
  const checkDeclaredPath = Effect.fnUntraced(function* (declared: string) {
    const parts = declared.split("/");
    for (let index = 1; index <= parts.length; index += 1)
      if (
        Option.isSome(
          yield* fs.readLink(path.join(root, ...parts.slice(0, index))).pipe(Effect.option),
        )
      )
        findings.push({
          code: "profile-bundle-incomplete",
          message: `${declared} is a source symlink. Materialize it explicitly before export.`,
        });
  });
  return { entries, add, include, checkDeclaredPath };
});
