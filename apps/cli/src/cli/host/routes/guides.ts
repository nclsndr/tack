import { Effect } from "effect";
import { guideTopics } from "../../../domain/guides/guide-schema.ts";
import {
  GuideUnreadableError,
  isGuideTopic,
  listGuides,
  readGuide,
} from "../../../features/guides/guides.ts";
import { currentVersionReport } from "../../../version.ts";
import { invocation } from "../command-line.ts";
import { resultOutcome } from "../outcomes.ts";
import type { PublicOutcome } from "../public-outcome.ts";
import type { RoutesFor } from "./route.ts";

/** A topic that names no guide: the outcome lists the ones there are and how to see them. */
const unknownTopic = (topic: string): PublicOutcome => ({
  classification: "invalid-invocation",
  diagnostics: [
    {
      code: "guide-topic-unknown",
      severity: "error",
      message: `Tack has no guide named "${topic}". The guides are ${guideTopics.join(", ")}.`,
      details: { topic, topics: [...guideTopics] },
    },
  ],
  next: [invocation("guide")],
});

/** A guide file the running Tack cannot read: its installation lost a file it ships. */
const unreadable = (error: GuideUnreadableError): PublicOutcome => ({
  classification: "internal",
  diagnostics: [
    {
      code: "guide-unreadable",
      severity: "error",
      message: `Tack cannot read its guide: ${error.message}. Reinstall Tack, then run tack init.`,
      details: { path: error.path },
    },
  ],
});

/** The guides of the running Tack. They need no HOME and no state, so they work before setup. */
export const guideRoutes: RoutesFor<"guide"> = {
  guide: {
    needsHome: false,
    stateless: true,
    run: ({ topic }) => {
      if (topic !== undefined && isGuideTopic(topic) === false)
        return Effect.succeed(unknownTopic(topic));
      const outcome =
        topic === undefined
          ? listGuides.pipe(Effect.map((guides) => resultOutcome({ kind: "guide-index", guides })))
          : readGuide(topic).pipe(
              Effect.map((markdown) =>
                resultOutcome({
                  kind: "guide",
                  topic,
                  version: currentVersionReport().stamp,
                  markdown,
                }),
              ),
            );
      return outcome.pipe(
        Effect.catchTag("GuideUnreadableError", (error) => Effect.succeed(unreadable(error))),
      );
    },
  },
};
