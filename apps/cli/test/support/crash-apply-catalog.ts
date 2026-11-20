import type { SkillCatalogEntry } from "../../src/domain/sources/catalog-schema.ts";

/** The registration every crash-apply skill belongs to, shared by the fixture and its test. */
export const crashApplyRegistrationId = "00000000-0000-4000-8000-000000000001";

/** The directory of the `index`-th crash-apply skill below `sourcesDirectory`. */
const crashApplySkillDirectory = (sourcesDirectory: string, index: number) =>
  `${sourcesDirectory}/skill-${String(index).padStart(3, "0")}`;

/** The catalog entries of `count` skills, one per directory that `crashApplySkillDirectory` names. */
export const applyCatalogEntries = (
  sourcesDirectory: string,
  count: number,
): ReadonlyArray<SkillCatalogEntry> =>
  Array.from({ length: count }, (_, index): SkillCatalogEntry => {
    const directoryPath = crashApplySkillDirectory(sourcesDirectory, index);
    const name = `skill-${String(index).padStart(3, "0")}`;
    return {
      activation: "default",
      address: { kind: "skill", name, sourceRegistrationId: crashApplyRegistrationId },
      dependencies: [],
      description: `${name} description`,
      directoryPath,
      frontmatter: { description: `${name} description`, name },
      projects: [],
      skillFilePath: `${directoryPath}/SKILL.md`,
      sourcePath: sourcesDirectory,
      sourceRegistrationId: crashApplyRegistrationId,
    };
  });
