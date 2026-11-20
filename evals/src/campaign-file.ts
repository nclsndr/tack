import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { record } from "./plan.ts";

/**
 * Read a campaign file and inline each arm's `{ "file": path }` prompt or skill override as
 * `{ text, source }`, so the plan, its confirmation and the trial records carry the exact bytes.
 * A relative path resolves against the campaign file's folder. Everything else is left for
 * `planCampaign` to validate.
 */
export async function loadCampaign(path: string): Promise<unknown> {
  const campaign: unknown = JSON.parse(await readFile(path, "utf8"));
  const folder = dirname(resolve(path));
  const inline = async (value: unknown): Promise<unknown> => {
    if (typeof value !== "object" || value === null || "file" in value === false) return value;
    const { file, ...rest } = record(value);
    if (typeof file !== "string" || "text" in rest)
      throw new Error("An override names one file path, or gives its text instead");
    const location = resolve(folder, file);
    return { ...rest, text: await readFile(location, "utf8"), source: `file:${location}` };
  };
  if (typeof campaign !== "object" || campaign === null || Array.isArray(campaign)) return campaign;
  const input = record(campaign);
  if (Array.isArray(input["arms"]) === false) return input;
  return {
    ...input,
    arms: await Promise.all(
      input["arms"].map(async (arm: unknown) => {
        if (typeof arm !== "object" || arm === null) return arm;
        const fields = record(arm);
        const skills = fields["skills"];
        return {
          ...fields,
          ...(fields["prompt"] === undefined ? {} : { prompt: await inline(fields["prompt"]) }),
          ...(typeof skills !== "object" || skills === null
            ? {}
            : {
                skills: Object.fromEntries(
                  await Promise.all(
                    Object.entries(skills).map(async ([skill, value]) => [
                      skill,
                      await inline(value),
                    ]),
                  ),
                ),
              }),
        };
      }),
    ),
  };
}
