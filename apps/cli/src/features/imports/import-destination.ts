import { Effect, FileSystem, Option, Path } from "effect";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { declaredPathSyntaxIssue } from "../sources/declared-path.ts";
import { isInside } from "../../domain/identity/path-containment.ts";
import {
  declaredSkillsFolders,
  passesOver,
  patternSelector,
  type DeclaredSkillsFolder,
} from "../sources/resource-declarations.ts";
import type { DeclaredSourceInspection } from "../../domain/sources/source-inspection.ts";
import { sourceFolderPath } from "../../domain/sources/source-schema.ts";
import { ImportError, importFailure } from "./import-error.ts";

/** A registered, healthy, non-built-in source that an import can write into. */
export type HealthyInspection = Extract<DeclaredSourceInspection, { readonly status: "healthy" }>;

/** The label an operator types for a source: its label, or its registration ID without one. */
export const sourceDisplayName = (inspection: DeclaredSourceInspection): string =>
  inspection.label === undefined || inspection.labelOrigin === "clashing"
    ? inspection.registration.id
    : inspection.label;

/** The folder an import writes into, and the declaration that covers it. */
export type ImportDestination = {
  readonly inspection: HealthyInspection;
  /** The source label, or its registration ID when the label is unusable. */
  readonly name: string;
  readonly root: string;
  /** The declared skills folder that covers `folder`. */
  readonly covering: DeclaredSkillsFolder;
  /** Where skills are written, relative to the source root: the declared folder or a group below. */
  readonly folder: string;
  /** Group folders below the declared folder that import creates, outermost first. */
  readonly missingFolders: ReadonlyArray<string>;
};

/**
 * The path of a skill folder named `name` in a destination folder, relative to the source root.
 * The source folder itself is written `.`, as its skills entry declares it.
 */
export const skillFolderPath = (folder: string, name: string) =>
  folder === sourceFolderPath ? name : `${folder}/${name}`;

/** The segments of `folder` below the declared folder that covers it, outermost first. */
export const segmentsBelow = (declaredPath: string, folder: string) =>
  folder === declaredPath
    ? []
    : declaredPath === sourceFolderPath
      ? folder.split("/")
      : folder.slice(declaredPath.length + 1).split("/");

/** One way a source can receive imports, as the preview without `--into` lists it. */
export type DestinationChoice = {
  readonly name: string;
  readonly registrationId: string;
  /** The declared skills folders, relative to the source root. */
  readonly folders: ReadonlyArray<string>;
};

/** Registered sources an import could target, before folder rules: healthy and not built in. */
const writable = (inspections: ReadonlyArray<DeclaredSourceInspection>) =>
  inspections.filter(
    (inspection): inspection is HealthyInspection =>
      inspection.status === "healthy" && inspection.origin !== "builtin",
  );

/**
 * Lists every registered source with the skills folders it declares. A source with no declared
 * skills folder cannot receive an import until its author declares one.
 */
export const destinationChoices = Effect.fnUntraced(function* (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
) {
  return yield* Effect.forEach(writable(inspections), (inspection) =>
    declaredSkillsFolders(inspection.registration, inspection.declaration).pipe(
      Effect.map((folders): DestinationChoice => ({
        name: sourceDisplayName(inspection),
        registrationId: inspection.registration.id,
        folders: folders.map((folder) => folder.declaredPath).sort(compareCodeUnits),
      })),
    ),
  );
});

/** The command that lists registered sources and their health. */
const listSources = ["tack", "source"];

/** Names the registered sources that can receive imports, or says how to register one. */
export const registeredSourcesText = (inspections: ReadonlyArray<DeclaredSourceInspection>) => {
  const names = writable(inspections).map(sourceDisplayName).sort(compareCodeUnits);
  return names.length === 0
    ? "No source is registered that can receive imports. Register one with `tack source add <path>`."
    : `Registered sources: ${names.join(", ")}.`;
};

/** Resolves the source named by `--into` to a healthy, writable inspection. */
export const resolveDestinationSource = (
  inspections: ReadonlyArray<DeclaredSourceInspection>,
  sourceText: string,
): Effect.Effect<HealthyInspection, ImportError> => {
  const matches = inspections.filter(
    (inspection) =>
      inspection.registration.id === sourceText ||
      (inspection.label === sourceText && inspection.origin !== "builtin"),
  );
  if (sourceText === "tack" || matches.some((match) => match.origin === "builtin"))
    return Effect.fail(
      importFailure(
        "import-destination-invalid",
        "The built-in source is not a destination. Import into a source you own.",
      ),
    );
  if (matches.length > 1)
    return Effect.fail(
      importFailure(
        "import-destination-invalid",
        `The source label ${sourceText} belongs to several registrations. Use one registration ID: ${matches.map((match) => match.registration.id).join(", ")}.`,
        { candidates: matches.map((match) => match.registration.id) },
      ),
    );
  const [only] = matches;
  if (only === undefined)
    return Effect.fail(
      importFailure(
        "import-destination-invalid",
        `No registered source is named ${JSON.stringify(sourceText.slice(0, 80))}. ${registeredSourcesText(inspections)}`,
      ),
    );
  if (only.status === "unhealthy")
    return Effect.fail(
      importFailure(
        "import-destination-invalid",
        `The source ${sourceDisplayName(only)} is not healthy: ${only.issue.message} Fix it, then repeat the command. \`${listSources.join(" ")}\` shows its health.`,
        undefined,
        [listSources],
      ),
    );
  return Effect.succeed(only);
};

const skillsEntryHint = (folder: string) => `skills: [{ path: ${folder} }]`;

const exactlyChoices = (name: string, folders: ReadonlyArray<string>) =>
  folders.map((folder) => `--into ${name}:${folder}`).join(" or ");

/** Where the segments of `folder` below the declared folder stop existing, outermost first. */
const missingBelow = Effect.fnUntraced(function* (
  inspection: HealthyInspection,
  covering: DeclaredSkillsFolder,
  folder: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const below = segmentsBelow(covering.declaredPath, folder);
  let current = covering.resolved;
  let relative = covering.declaredPath;
  const missing: Array<string> = [];
  for (const segment of below) {
    relative = skillFolderPath(relative, segment);
    if (missing.length > 0) {
      missing.push(relative);
      continue;
    }
    const target = path.join(current, segment);
    const real = yield* fileSystem.realPath(target).pipe(Effect.option);
    if (Option.isNone(real)) {
      missing.push(relative);
      current = target;
      continue;
    }
    if (isInside(inspection.registration.canonicalPath, real.value) === false)
      return { missing, problem: `${relative} resolves outside the source.` };
    const info = yield* fileSystem.stat(real.value).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory")
      return { missing, problem: `${relative} exists and is not a folder.` };
    current = real.value;
  }
  return { missing, problem: undefined };
});

/** Whether a folder, existing or about to be created, sits inside a skill folder. */
const insideSkill = Effect.fnUntraced(function* (covering: DeclaredSkillsFolder, folder: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const segments = segmentsBelow(covering.declaredPath, folder);
  const chain = [
    covering.resolved,
    ...segments.map((_, index) => path.join(covering.resolved, ...segments.slice(0, index + 1))),
  ];
  const holders = yield* Effect.forEach(chain, (directory) =>
    fileSystem.exists(path.join(directory, "SKILL.md")).pipe(Effect.orElseSucceed(() => false)),
  );
  const index = holders.indexOf(true);
  return index === -1 ? undefined : chain[index];
});

/**
 * Resolves the destination folder against the source's `skills` declarations. With no folder the
 * source's only declared skills folder is used; several or none are refused with the exact fix.
 * A named folder must be a declared skills folder or lie below one, outside every exclude
 * pattern and every skill folder; group folders that do not exist yet are created by the import.
 */
export const resolveDestination = Effect.fnUntraced(function* (
  inspection: HealthyInspection,
  folderText: string | undefined,
) {
  const path = yield* Path.Path;
  const name = sourceDisplayName(inspection);
  const declared = yield* declaredSkillsFolders(inspection.registration, inspection.declaration);
  const sorted = [...declared].sort((left, right) =>
    compareCodeUnits(left.declaredPath, right.declaredPath),
  );
  const result = (
    covering: DeclaredSkillsFolder,
    folder: string,
    missingFolders: ReadonlyArray<string>,
  ) =>
    ({
      inspection,
      name,
      root: inspection.registration.canonicalPath,
      covering,
      folder,
      missingFolders,
    }) satisfies ImportDestination;
  if (folderText === undefined) {
    const [only, ...others] = sorted;
    if (only === undefined)
      return yield* importFailure(
        "import-destination-invalid",
        `The source ${name} declares no skills folder, so nothing can be imported into it. Tack never edits a declaration. Add one by hand to its tack.yaml, for example ${skillsEntryHint("skills")}, then repeat the command.`,
      );
    if (others.length > 0)
      return yield* importFailure(
        "import-destination-invalid",
        `The source ${name} declares several skills folders. Choose one: ${exactlyChoices(
          name,
          sorted.map((folder) => folder.declaredPath),
        )}.`,
        { choices: sorted.map((folder) => `${name}:${folder.declaredPath}`) },
      );
    return result(only, only.declaredPath, []);
  }
  const folder = folderText.endsWith("/") ? folderText.slice(0, -1) : folderText;
  const syntax = declaredPathSyntaxIssue(folder);
  if (syntax !== undefined)
    return yield* importFailure(
      "import-destination-invalid",
      `The folder ${JSON.stringify(folderText.slice(0, 120))} is not valid. ${syntax}`,
    );
  const covering = sorted.find(
    (candidate) =>
      candidate.declaredPath === sourceFolderPath ||
      folder === candidate.declaredPath ||
      folder.startsWith(`${candidate.declaredPath}/`),
  );
  if (covering === undefined)
    return yield* importFailure(
      "import-destination-invalid",
      sorted.length === 0
        ? `The source ${name} declares no skills folder, and ${folder} is outside every declaration. Tack never edits a declaration. Add ${skillsEntryHint(folder)} to its tack.yaml by hand, then repeat the command.`
        : `${folder} is outside every skills folder that ${name} declares (${sorted.map((entry) => entry.declaredPath).join(", ")}). Tack never edits a declaration. Choose one of ${exactlyChoices(
            name,
            sorted.map((entry) => entry.declaredPath),
          )}, or add ${skillsEntryHint(folder)} to its tack.yaml by hand.`,
    );
  const below = segmentsBelow(covering.declaredPath, folder);
  const passed = below.find((segment) => passesOver(covering.declaredPath, segment));
  if (passed !== undefined)
    return yield* importFailure(
      "import-destination-invalid",
      `${folder} holds ${passed}, a name the skills entry "." passes over, as it passes over every dot, underscore and node_modules name, so skills there are not in the catalog. Choose another folder.`,
    );
  const excluded = patternSelector(covering.include, covering.exclude).prunedFolder(
    below.join("/"),
  );
  if (excluded !== undefined)
    return yield* importFailure(
      "import-destination-invalid",
      `${skillFolderPath(covering.declaredPath, excluded)} is excluded by the exclude patterns of the skills entry ${JSON.stringify(covering.declaredPath)}, so skills there are not in the catalog. Choose another folder, or change the patterns by hand.`,
    );
  const walked = yield* missingBelow(inspection, covering, folder);
  if (walked.problem !== undefined)
    return yield* importFailure(
      "import-destination-invalid",
      `${walked.problem} Choose a folder inside the declared skills folder.`,
    );
  const skill = yield* insideSkill(covering, folder);
  if (skill !== undefined)
    return yield* importFailure(
      "import-destination-invalid",
      `${path.relative(inspection.registration.canonicalPath, skill)} is a skill folder, and a skill folder is a leaf, so nothing can be imported inside it. Choose its parent folder.`,
    );
  return result(covering, folder, walked.missing);
});
