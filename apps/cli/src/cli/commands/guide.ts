import { Argument, Command } from "effect/cli";
import { guideTopics } from "../../domain/guides/guide-schema.ts";
import { receive } from "./invocation-receiver.ts";

/** Prints a built-in guide for agents, or lists them; it reads no state and writes nothing. */
export const guideCommand = Command.make(
  "guide",
  {
    topic: Argument.String("topic").pipe(
      Argument.withDescription(`The guide to print: ${guideTopics.join(", ")}`),
      Argument.optional,
    ),
  },
  ({ topic }) =>
    receive({ _tag: "guide", ...(topic._tag === "Some" ? { topic: topic.value } : {}) }),
).pipe(
  Command.withDescription(
    "Print a guide of the running Tack for an agent to follow, such as the onboarding guide for setting up a machine. Without a topic, list the guides. It needs no state and writes nothing",
  ),
  Command.withExamples([{ command: "tack guide onboarding" }, { command: "tack guide" }]),
);
