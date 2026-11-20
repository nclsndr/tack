import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import { Layer } from "effect";

/**
 * Process, filesystem, crypto, path, stdio and terminal services for Node and Bun alike. Bun's own
 * platform layer is a re-export of these same Node implementations, so one graph serves both.
 */
export const PlatformServicesLive = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeFileSystem.layer,
      NodeCrypto.layer,
      NodePath.layer,
      NodeStdio.layer,
      NodeTerminal.layer,
    ),
  ),
);
