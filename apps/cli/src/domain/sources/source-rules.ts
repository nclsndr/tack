import type { SourceWarning } from "./source-inspection.ts";
import type { SourceDeclaration } from "./source-schema.ts";

/** The characters a source description holds before `tack check` warns: about one sentence. */
export const sourceDescriptionLimit = 200;

/** The UTF-8 bytes of a rules body that the `tack-sources` skill inlines. */
export const rulesBodyLimit = 2048;

/** The UTF-8 size of `text`, the size an agent reads. */
export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Whether the `tack-sources` skill inlines this rules body, or points to the `tack.yaml` instead. */
export const inlinesRulesBody = (body: string) => byteLength(body) <= rulesBodyLimit;

/**
 * The heads-ups about a declaration's description and rules. Each leaves the source healthy: the
 * skill still lists a long description, and points to the `tack.yaml` for a body it cannot inline.
 */
export const declarationWarnings = (
  declaration: Pick<SourceDeclaration, "description" | "rules">,
): ReadonlyArray<SourceWarning> => [
  ...(declaration.description !== undefined &&
  declaration.description.length > sourceDescriptionLimit
    ? [
        {
          code: "source-description-long" as const,
          field: "description",
          message: `The description has ${declaration.description.length} characters; keep it to one sentence of at most ${sourceDescriptionLimit} characters, which names what the source holds.`,
        },
      ]
    : []),
  ...(declaration.rules !== undefined && inlinesRulesBody(declaration.rules.body) === false
    ? [
        {
          code: "source-rules-long" as const,
          field: "rules.body",
          message: `The rules body has ${byteLength(declaration.rules.body)} bytes, over the ${rulesBodyLimit} that the tack-sources skill inlines. The skill points agents to this tack.yaml instead: shorten the body to inline it.`,
        },
      ]
    : []),
];
