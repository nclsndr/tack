import { Layer } from "effect";
import { DestinationLive } from "../platform/filesystem/destination-observation.ts";
import { StateStoreLive } from "../platform/state/state.ts";

/**
 * The layers that run on any file system Effect can reach: Tack state and destination observation.
 * They need `FileSystem`, `Path` and `Crypto`.
 */
export const PortableLive = Layer.mergeAll(StateStoreLive, DestinationLive);
