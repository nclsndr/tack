import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeCrypto from "@effect/platform-node-shared/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio";
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal";
import { Layer, Terminal } from "effect";

/**
 * Ends key input on Ctrl+C and Ctrl+D only. The explorer reads Esc as a key of its own, to clear a
 * filter, close a menu or go back, so Esc must not end input as the default Node terminal does.
 */
export const endsKeyInput = (input: Terminal.UserInput): boolean =>
  input.key.ctrl === true && (input.key.name === "c" || input.key.name === "d");

/** The process terminal, with Esc left to the explorer. */
const TerminalLive = Layer.effect(Terminal.Terminal, NodeTerminal.make(endsKeyInput));

/**
 * Process, filesystem, secure random, path, stdio and terminal services for Node and Bun alike.
 * Bun's own platform layer is a re-export of these same Node implementations, so one graph serves
 * both.
 */
export const PlatformServicesLive = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeFileSystem.layer,
      NodeCrypto.layerSecureRandom,
      NodePath.layer,
      NodeStdio.layer,
      TerminalLive,
    ),
  ),
);
