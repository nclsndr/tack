import { Schema } from "effect";

/**
 * The guides `tack guide` prints, in the order it lists them. Each but `tack-yaml` is the reference
 * of the same name in the built-in `use-tack` skill, so the skill and the command read one file;
 * `tack-yaml` is built from the schemas that validate a `tack.yaml`. A guide stays small enough that
 * an agent's tool prints it whole: the larger skill references are not guides.
 */
export const guideTopics = ["onboarding", "agent-instructions", "day-two", "tack-yaml"] as const;

/** The guides that are a reference file of the built-in `use-tack` skill. */
export const referenceGuideTopics = guideTopics.filter(
  (topic): topic is Exclude<GuideTopic, "tack-yaml"> => topic !== "tack-yaml",
);

/** The name of one guide, as `tack guide <topic>` takes it. */
export type GuideTopic = (typeof guideTopics)[number];

const GuideTopicSchema = Schema.Literals(guideTopics);

/** `tack guide <topic>`: one guide as the running version ships it. */
export const GuideSchema = Schema.Struct({
  kind: Schema.Literal("guide"),
  topic: GuideTopicSchema,
  version: Schema.String.annotate({ description: "The release stamp of the running Tack." }),
  markdown: Schema.String.annotate({ description: "The guide's Markdown, byte for byte." }),
});

/** `tack guide`: every guide, by the title its first heading gives it. */
export const GuideIndexSchema = Schema.Struct({
  kind: Schema.Literal("guide-index"),
  guides: Schema.Array(Schema.Struct({ topic: GuideTopicSchema, title: Schema.String })),
});
