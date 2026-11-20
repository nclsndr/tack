import { Yaml } from "../../domain/runtime-neutral.ts";
import { Effect, FileSystem, Path, Predicate, Schema } from "effect";
import type {
  FetchSession,
  ImportFetchError,
  ImportLimits,
  TreeEntry,
} from "../../services/import-remote.ts";
import { compareCodeUnits } from "../../domain/identity/ordering.ts";
import { SkillNameSchema } from "../../domain/sources/catalog-schema.ts";
import { resolveCatalogFromInspections } from "../sources/catalog.ts";
import { type DiscoveredSkillFolder, unsafeRelativePath } from "./import-discovery.ts";
import { isTextBytes, writeSkillFiles, type SkillFile } from "./import-files.ts";
import { sanitizeForDisplay } from "./import-location.ts";
import type { ImportCandidate } from "../../domain/imports/import-schema.ts";

type SkillIdentity = {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly internal: boolean;
};

const textDecoder = new TextDecoder();
const isSkillName = Schema.is(SkillNameSchema);

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

/** Reads the identity facts of a SKILL.md without validating them; the catalog validates. */
const readIdentity = (bytes: Uint8Array): SkillIdentity => {
  const none: SkillIdentity = { name: undefined, description: undefined, internal: false };
  const lines = textDecoder.decode(bytes).split(/\r?\n/);
  if (lines[0] !== "---") return none;
  const closing = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closing === -1) return none;
  let parsed: unknown;
  try {
    parsed = Yaml.parse(lines.slice(1, closing).join("\n"));
  } catch {
    return none;
  }
  const record = asRecord(parsed);
  if (record === undefined) return none;
  const metadata = asRecord(record["metadata"]) ?? {};
  const internal =
    metadata["internal"] === true ||
    (typeof metadata["internal"] === "string" && metadata["internal"].toLowerCase() === "true");
  return {
    name: typeof record["name"] === "string" ? record["name"] : undefined,
    description: typeof record["description"] === "string" ? record["description"] : undefined,
    internal,
  };
};

const oneLine = (text: string) =>
  sanitizeForDisplay(text.replace(/\s+/g, " ").trim()).slice(0, 240);

const regularModes: ReadonlySet<string> = new Set(["100644", "100755"]);

type FolderContents = {
  readonly regular: ReadonlyArray<TreeEntry & { readonly relative: string }>;
  readonly symlinks: number;
  readonly submodules: number;
};

/** Splits what a tree lists under one folder into regular files and entries import never copies. */
const contentsOf = (entries: ReadonlyArray<TreeEntry>, folder: string): FolderContents => {
  const prefix = folder.length === 0 ? "" : `${folder}/`;
  const inside = entries.filter((entry) => entry.path.startsWith(prefix) && entry.type !== "tree");
  const regular = inside
    .filter((entry) => entry.type === "blob" && regularModes.has(entry.mode))
    .map((entry) => ({ ...entry, relative: entry.path.slice(prefix.length) }))
    .sort((left, right) => compareCodeUnits(left.relative, right.relative));
  const submodules = inside.filter((entry) => entry.type === "commit").length;
  return { regular, submodules, symlinks: inside.length - regular.length - submodules };
};

/** The folders of `SKILL.md` files below the candidate's own: content under the leaf rule. */
const nestedSkillPaths = (files: ReadonlyArray<{ readonly relative: string }>) =>
  files
    .filter((file) => file.relative.endsWith("/SKILL.md"))
    .map((file) => file.relative.slice(0, -"/SKILL.md".length))
    .map(sanitizeForDisplay);

/** What the catalog's own rules say about one skill's files, and what they loaded. */
type CatalogVerdict =
  | {
      readonly importable: true;
      readonly tack: ImportCandidate["upstreamTack"];
    }
  | { readonly importable: false; readonly code: string; readonly message: string };

/**
 * The verdict the catalog itself gives: the skill is written to a throwaway source whose
 * declaration names its parent folder, and the catalog resolves it. Importable means loaded with
 * no quarantine.
 */
const catalogVerdict = (identity: SkillIdentity, files: ReadonlyArray<SkillFile>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directoryName =
        identity.name !== undefined && isSkillName(identity.name) ? identity.name : "candidate";
      const root = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "tack-verdict-" })
        .pipe(Effect.orDie);
      const canonical = yield* fileSystem.realPath(root).pipe(Effect.orDie);
      const sourcePath = path.join(canonical, "source");
      yield* writeSkillFiles(path.join(sourcePath, "skills", directoryName), files).pipe(
        Effect.orDie,
      );
      const catalog = yield* resolveCatalogFromInspections([
        {
          status: "healthy",
          declaration: { version: 1, skills: [{ path: "skills" }] },
          registration: { id: "00000000-0000-4000-8000-000000000000", canonicalPath: sourcePath },
        },
      ]);
      const entry = catalog.entries.find(
        (candidate) =>
          candidate.address.kind === "skill" && candidate.address.name === identity.name,
      );
      if (entry !== undefined && "activation" in entry && catalog.quarantined.length === 0) {
        const metadata = asRecord(entry.frontmatter["metadata"]);
        return {
          importable: true,
          tack:
            metadata !== undefined && "tack" in metadata
              ? {
                  activation: entry.activation,
                  userActivation: entry.userActivation ?? "opt-in",
                  projects: [...entry.projects],
                  dependencies: entry.dependencies.map((dependency) => ({ ...dependency })),
                }
              : undefined,
        } satisfies CatalogVerdict;
      }
      const reason = catalog.quarantined[0];
      return {
        importable: false,
        code: reason?.code ?? "skill-not-loaded",
        message: oneLine(reason?.message ?? "The catalog did not load this skill."),
      } satisfies CatalogVerdict;
    }),
  );

/** Reads the regular files of one folder: bytes and executable bits, relative to the folder. */
export const loadSkillFiles = Effect.fnUntraced(function* (
  session: FetchSession,
  folder: string,
  entries: ReadonlyArray<TreeEntry>,
) {
  const contents = contentsOf(entries, folder);
  const blobs = yield* session.read([...new Set(contents.regular.map((entry) => entry.oid))]);
  return contents.regular.map((entry): SkillFile => ({
    path: entry.relative,
    bytes: blobs.get(entry.oid) ?? new Uint8Array(),
    executable: entry.mode === "100755",
  }));
});

export type AnalysisInput = {
  readonly session: FetchSession;
  readonly folders: ReadonlyArray<DiscoveredSkillFolder>;
  readonly limits: ImportLimits;
};

/** What analysis returns: the candidates and the tree it read, so selected skills can be loaded. */
export type Analysis = {
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly tree: ReadonlyArray<TreeEntry>;
};

/**
 * Computes, for every discovered folder, its facts and the verdicts that do not depend on a
 * destination: safety limits, the catalog's own rules, and duplicate names inside the location.
 */
export const analyzeCandidates = Effect.fnUntraced(function* (
  input: AnalysisInput,
): Effect.fn.Return<Analysis, ImportFetchError, FileSystem.FileSystem | Path.Path> {
  const { session, folders, limits } = input;
  if (folders.length === 0) return { candidates: [], tree: [] };
  // A skill at the repository root needs the whole tree, which an empty pathspec list asks for.
  const tree = yield* session.list(
    folders.some((folder) => folder.path.length === 0) ? [] : folders.map((folder) => folder.path),
  );
  yield* session.prefetch(folders.map((folder) => folder.path));
  const candidates: Array<ImportCandidate> = [];
  for (const folder of folders) {
    const contents = contentsOf(tree, folder.path);
    const sizes = yield* session.sizes([...new Set(contents.regular.map((entry) => entry.oid))]);
    const sizeOf = (entry: TreeEntry) => sizes.get(entry.oid) ?? 0;
    const bytes = contents.regular.reduce((total, entry) => total + sizeOf(entry), 0);
    const base = {
      folder: folder.path,
      place: folder.place,
      hidden: false,
      files: contents.regular.length,
      bytes,
      executables: contents.regular.filter((entry) => entry.mode === "100755").length,
      nonText: 0,
      symlinks: contents.symlinks,
      submodules: contents.submodules,
      nestedSkills: nestedSkillPaths(contents.regular),
    } as const;
    const folderName = folder.path.split("/").at(-1) ?? "";
    const reject = (code: string, message: string): ImportCandidate => ({
      ...base,
      name: sanitizeForDisplay(folderName.length === 0 ? "(root)" : folderName),
      verdict: { importable: false, code, message },
    });
    const unsafe = contents.regular.find(
      (entry) => unsafeRelativePath(entry.relative) !== undefined,
    );
    const oversized = contents.regular.find((entry) => sizeOf(entry) > limits.maxFileBytes);
    const refusal =
      unsafe !== undefined
        ? reject(
            "import-path-unsafe",
            `A path in this skill is refused: ${unsafeRelativePath(unsafe.relative)}.`,
          )
        : oversized !== undefined
          ? reject(
              "import-file-too-large",
              `${sanitizeForDisplay(oversized.relative)} is ${sizeOf(oversized)} bytes, over the ${limits.maxFileBytes} byte limit per file.`,
            )
          : contents.regular.length > limits.maxFilesPerSkill
            ? reject(
                "import-too-many-files",
                `The skill has ${contents.regular.length} files, over the limit of ${limits.maxFilesPerSkill}.`,
              )
            : bytes > limits.maxBytesPerSkill
              ? reject(
                  "import-skill-too-large",
                  `The skill is ${bytes} bytes, over the limit of ${limits.maxBytesPerSkill}.`,
                )
              : undefined;
    if (refusal !== undefined) {
      candidates.push(refusal);
      continue;
    }
    const files = yield* loadSkillFiles(session, folder.path, tree);
    const skillFile = files.find((file) => file.path === "SKILL.md");
    const identity = readIdentity(skillFile?.bytes ?? new Uint8Array());
    const verdict = yield* catalogVerdict(identity, files);
    const displayName = sanitizeForDisplay(identity.name ?? folderName);
    candidates.push({
      ...base,
      name: displayName.length === 0 ? "(unnamed)" : displayName,
      ...(identity.description === undefined ? {} : { description: oneLine(identity.description) }),
      hidden: verdict.importable && identity.internal,
      verdict: verdict.importable ? { importable: true } : verdict,
      ...(verdict.importable && verdict.tack !== undefined ? { upstreamTack: verdict.tack } : {}),
      nonText: files.filter((file) => !isTextBytes(file.bytes)).length,
    });
  }
  // Duplicate names are all reported, and none is imported.
  const importable = candidates.filter((candidate) => candidate.verdict.importable);
  const duplicates = new Set(
    importable
      .filter((candidate) => importable.filter((other) => other.name === candidate.name).length > 1)
      .map((candidate) => candidate.name),
  );
  const resolved = candidates.map((candidate): ImportCandidate => {
    if (!candidate.verdict.importable || !duplicates.has(candidate.name)) return candidate;
    const paths = importable
      .filter((other) => other.name === candidate.name)
      .map((other) => other.folder || "(root)");
    return {
      ...candidate,
      hidden: false,
      verdict: {
        importable: false,
        code: "import-name-duplicate",
        message: `The name ${candidate.name} is used by ${paths.join(", ")}. Scope the location to one of these folders, for example owner/repo/${paths[0] ?? "folder"}.`,
      },
    };
  });
  return { candidates: resolved, tree };
});
