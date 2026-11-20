import { BunServices } from "@effect/platform-bun";
import { fileSystemContract } from "./support/file-system-contract.ts";

// Node's file system, which the CLI runs on, must keep every behaviour the contract states.
fileSystemContract("Node", BunServices.layer);
