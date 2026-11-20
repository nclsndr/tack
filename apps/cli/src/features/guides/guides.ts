import { Effect, FileSystem, Path, Schema } from "effect";
import { guideTopics, type GuideTopic } from "../../domain/guides/guide-schema.ts";
import { Source } from "../sources/source.ts";

/** The running Tack cannot read one of its own guides: its installation is incomplete. */
export class GuideUnreadableError extends Schema.TaggedError<GuideUnreadableError>()(
  "GuideUnreadableError",
  {
    /** The file the guide was read from, or the folder it was looked for in. */
    path: Schema.String,
    message: Schema.String,
  },
) {}

/** Reports whether `topic` names one of the guides. */
export const isGuideTopic = (topic: string): topic is GuideTopic =>
  guideTopics.some((known) => known === topic);

/**
 * Reads one guide from the running version's built-in `use-tack` skill, where the skill's agents
 * read it too. It reads no Tack state and writes nothing.
 */
export const readGuide = Effect.fnUntraced(function* (topic: GuideTopic) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const relative = path.join("skills", "use-tack", "references", `${topic}.md`);
  const [builtIns] = (yield* Source).builtInSources ?? [];
  if (builtIns === undefined)
    return yield* new GuideUnreadableError({
      path: relative,
      message: "This Tack has no built-in source to read its guides from.",
    });
  const file = path.join(builtIns.canonicalPath, relative);
  return yield* fileSystem
    .readFileString(file)
    .pipe(
      Effect.mapError((cause) => new GuideUnreadableError({ path: file, message: cause.message })),
    );
});

/** Every guide, in order, by the title of its first line: the guide's `#` heading. */
export const listGuides = Effect.forEach(guideTopics, (topic) =>
  readGuide(topic).pipe(
    Effect.map((markdown) => ({
      topic,
      title: markdown.replace(/\n[\s\S]*$/, "").replace(/^#\s+/, ""),
    })),
  ),
);
