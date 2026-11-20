import { FileSystem, Layer, Path } from "effect";
import { fileSystemContract } from "@tackup/cli/test/file-system-contract";
import { makeMemoryFileSystem, makeMemoryPath } from "./memory-file-system.ts";
import { makeMemoryVolume } from "./memory-volume.ts";

const path = makeMemoryPath("/");

// The memory volume stands in for Node's file system, so it keeps every behaviour Tack relies on.
fileSystemContract(
  "In-memory",
  Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, makeMemoryFileSystem(makeMemoryVolume(), path)),
    Layer.succeed(Path.Path, path),
  ),
);
