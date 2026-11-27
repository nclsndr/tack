import { Option } from "effect";
import type { HumanView } from "./render.ts";

/** Says the session closed; what it applied was reported inside the session. */
export const renderExplore: HumanView<"explore"> = (_envelope, { result }, style) =>
  Option.isNone(result) === true ? undefined : `${style.bold("tack explore")}  closed\n`;
