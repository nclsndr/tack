import { Option, Schema } from "effect";
import { ExploreSessionSchema } from "../../../commands/command-payloads.ts";
import type { PublicEnvelope } from "../../public-outcome.ts";
import type { Style } from "../style.ts";

const decode = Schema.decodeUnknownOption(ExploreSessionSchema);

/** Says the session closed; what it applied was reported inside the session. */
export const renderExplore = (envelope: PublicEnvelope, style: Style): string | undefined =>
  Option.match(decode(envelope.result), {
    onNone: () => undefined,
    onSome: () => `${style.bold("tack explore")}  closed\n`,
  });
