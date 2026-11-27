import { Layer } from "effect";
import { SourceLive } from "../features/sources/source-live.ts";
import { GitLive } from "../platform/git/git.ts";
import { ImportRemoteLive } from "../platform/git/import-remote.ts";
import { BundleScannerLive } from "../platform/bundles/bundle-scanner.ts";
import { CompressionLive } from "../platform/compression/compression.ts";
import { InstallationLive } from "../platform/installation/installation.ts";
import { ReaderLive } from "../platform/reader/reader.ts";
import { ReaderCorpusLive } from "../platform/reader/search.ts";
import { ExecutionPlatformLive } from "../platform/execution/execution-platform.ts";
import { TerminalContextLive } from "../cli/human/terminal-context.ts";
import { PortableLive } from "./portable-layer.ts";
import { PlatformServicesLive } from "./platform-services.ts";

/** The complete production dependency graph for the Tack CLI: the portable core over Node. */
export const ApplicationLive = Layer.mergeAll(
  PortableLive,
  GitLive,
  ImportRemoteLive,
  InstallationLive,
  CompressionLive,
  BundleScannerLive,
  SourceLive,
  ReaderLive,
  ReaderCorpusLive,
  ExecutionPlatformLive,
  TerminalContextLive,
).pipe(Layer.provideMerge(PlatformServicesLive));
