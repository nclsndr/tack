import { Yaml } from "../../domain/runtime-neutral.ts";
import {
  acquireExclusiveLock,
  LockBusyError,
  type LockProtocol,
} from "../../services/exclusive-lock.ts";
import { profileHasErrors } from "../../domain/profiles/profile-policy.ts";
import { Effect, FileSystem, Path, Schema } from "effect";
import {
  ProfileSchema,
  type Profile,
  type ProfileCheckReport,
} from "../../domain/profiles/profile-schema.ts";
import { resolveProfile } from "../../domain/profiles/profile-resolution.ts";
import { publishProfileText } from "../../domain/profiles/publication-text.ts";
import type { StateOptions } from "../../services/state-store.ts";
import { profileContext } from "./profile-check.ts";
import { readProfileFile } from "../sources/profile-files.ts";
import { profilePublications, profileStructureFinding } from "../sources/profile-publications.ts";
import {
  declarationFileName,
  decodeDeclaration,
  readDeclarationText,
} from "../sources/declaration-file.ts";

const saveLockProtocol: LockProtocol = {
  record: (pid) => `${pid}:${crypto.randomUUID()}\n`,
  holder: (record) => {
    const matched = /^([1-9]\d*):[0-9a-f-]+\n$/.exec(record);
    if (matched === null) return undefined;
    const pid = Number(matched[1]);
    return Number.isSafeInteger(pid) ? { pid, expired: false } : undefined;
  },
  fileMode: 0o600,
  directoryMode: 0o700,
};

/** Validates complete linkage, then writes only the manifest and its explicit publication. */
export const saveProfile = Effect.fnUntraced(function* (
  options: StateOptions,
  request: {
    readonly sourcePath: string;
    readonly profile: Profile;
    readonly expectedContent?: string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* profileContext(options, request.sourcePath);
  const sourcePath = context.source.canonicalPath;
  const profile = yield* Schema.decodeUnknownEffect(ProfileSchema, { onExcessProperty: "error" })(
    request.profile,
  ).pipe(Effect.orDie);
  const published = profilePublications(sourcePath, context.source.declaration);
  const existing = published.publications.find((entry) => entry.name === profile.name);
  const publication = existing ?? { name: profile.name, path: `profiles/${profile.name}.yaml` };
  const file = path.join(sourcePath, publication.path);
  const resolution = resolveProfile(profile, context.registration.id, context.catalog, file);
  const report: ProfileCheckReport = {
    kind: "profile-check",
    sourcePath,
    profileName: profile.name,
    structural: published.findings.length === 0 ? "valid" : "invalid",
    ...resolution,
    findings: [...published.findings, ...resolution.findings],
  };
  const refused = (code: string, message: string) => ({
    saved: false,
    report: {
      ...report,
      structural: "invalid" as const,
      findings: [
        ...report.findings,
        profileStructureFinding(
          file,
          code,
          message,
          "Reload the profile and resolve this conflict before saving.",
        ),
      ],
    },
  });
  if (context.registration.bundle !== undefined)
    return refused(
      "profile-bundle-immutable",
      "Verified bundle projections are retained content. Copy members into an authored source instead of editing artifact bytes.",
    );
  if (profileHasErrors(report.findings) === true) return { saved: false, report };
  return yield* Effect.acquireUseRelease(
    acquireExclusiveLock(path.join(sourcePath, ".tack-profile-save.lock"), saveLockProtocol).pipe(
      Effect.result,
    ),
    (acquired) => {
      if (acquired._tag === "Failure")
        return Effect.succeed(
          refused(
            "profile-save-conflict",
            acquired.failure instanceof LockBusyError
              ? "The source is locked by another save. Reload and retry after it finishes."
              : `Cannot safely lock this source: ${acquired.failure.message}`,
          ),
        );
      return Effect.scoped(
        Effect.gen(function* () {
          let profileBefore: string | undefined;
          if (existing !== undefined) {
            const loaded = yield* readProfileFile(sourcePath, context.source.declaration, existing);
            if (loaded.profile === undefined)
              return {
                saved: false,
                report: { ...report, structural: "invalid" as const, findings: loaded.findings },
              };
            profileBefore = yield* fs.readFileString(file);
            if (request.expectedContent !== undefined && profileBefore !== request.expectedContent)
              return refused("profile-save-conflict", "The profile changed after editing began.");
          } else if (yield* fs.exists(file))
            return refused("profile-save-conflict", "The unpublished destination already exists.");
          const declarationFile = path.join(sourcePath, declarationFileName);
          const declarationBefore = yield* readDeclarationText(sourcePath);
          const observed = yield* decodeDeclaration(Yaml.parse(declarationBefore)).pipe(
            Effect.orDie,
          );
          if (JSON.stringify(observed) !== JSON.stringify(context.source.declaration))
            return refused(
              "profile-save-conflict",
              "The source declaration changed after validation.",
            );
          const publishedText = publishProfileText(declarationBefore, [
            ...published.publications,
            publication,
          ]);
          if (existing === undefined && publishedText.error !== undefined)
            return refused("profile-publication-layout", publishedText.error);
          // Resolve the parent before writing: scratch HOME/state do not make source paths safe.
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          const parent = yield* fs.realPath(path.dirname(file));
          if (parent !== sourcePath && parent.startsWith(`${sourcePath}${path.sep}`) === false)
            return refused(
              "profile-path-outside-source",
              "The profile directory resolves outside its owning source.",
            );
          const temporary = yield* fs.makeTempFileScoped({
            directory: parent,
            prefix: ".profile-",
          });
          yield* fs.writeFileString(temporary, `${Yaml.stringify(profile).trimEnd()}\n`);
          yield* fs.chmod(
            temporary,
            existing === undefined ? 0o644 : (yield* fs.stat(file)).mode & 0o777,
          );
          const staged =
            existing === undefined
              ? yield* fs.makeTempFileScoped({ directory: sourcePath, prefix: ".publication-" })
              : undefined;
          if (staged !== undefined) {
            yield* fs.writeFileString(staged, publishedText.text ?? declarationBefore);
            yield* fs.chmod(staged, (yield* fs.stat(declarationFile)).mode & 0o777);
          }
          if ((yield* readDeclarationText(sourcePath)) !== declarationBefore)
            return refused("profile-save-conflict", "The source declaration changed during save.");
          if (
            profileBefore === undefined
              ? yield* fs.exists(file)
              : (yield* fs.readFileString(file)) !== profileBefore
          )
            return refused("profile-save-conflict", "The profile changed during save.");
          yield* fs.rename(temporary, file);
          if (staged !== undefined) yield* fs.rename(staged, declarationFile);
          return { saved: true, report };
        }),
      );
    },
    (acquired) => {
      return acquired._tag === "Success"
        ? acquired.success.release.pipe(Effect.orDie)
        : Effect.void;
    },
  );
});
