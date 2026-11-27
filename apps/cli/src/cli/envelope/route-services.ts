import type { FileSystem, Path, Scope, Stdio } from "effect";
import type { Command } from "effect/cli";
import type { SecureRandom } from "effect/crypto";
import type { BundleScanner } from "../../services/bundle-scanner.ts";
import type { Compression } from "../../services/compression.ts";
import type { Destination } from "../../services/destination.ts";
import type { Source } from "../../features/sources/source.ts";
import type { ExecutionWorker, RunHistory } from "../../services/execution-platform.ts";
import type { Git } from "../../services/git.ts";
import type { ImportRemote } from "../../services/import-remote.ts";
import type { Installation } from "../../services/installation.ts";
import type { Reader } from "../../services/reader.ts";
import type { ReaderCorpus } from "../../services/reader-corpus.ts";
import type { StateStore } from "../../services/state-store.ts";

/** The services a route may use; the composition root provides them all. */
export type RouteServices =
  | BundleScanner
  | Command.Environment
  | Compression
  | Destination
  | ExecutionWorker
  | FileSystem.FileSystem
  | Git
  | ImportRemote
  | Installation
  | Path.Path
  | Reader
  | ReaderCorpus
  | RunHistory
  | SecureRandom.SecureRandom
  | Scope.Scope
  | Source
  | StateStore
  | Stdio.Stdio;
