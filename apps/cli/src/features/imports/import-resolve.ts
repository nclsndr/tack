import { Result } from "effect";
import type { RefListing } from "../../services/import-remote.ts";
import { canonicalLocationText, type ParsedImportLocation } from "./import-location.ts";
import { ImportError } from "./import-error.ts";

/** A ref request resolved against the remote to one commit, with where a URL's path was split. */
export type ResolvedRef = {
  readonly kind: "default" | "branch" | "tag" | "commit";
  /** The branch, tag or commit as typed; absent for the default branch. */
  readonly request?: string;
  readonly commit: string;
  readonly scope?: string;
  /** A default or branch request follows the remote; a tag or commit request is pinned. */
  readonly tracking: boolean;
  /** For a tree or blob URL: the ref the remote matched and the equivalent explicit form. */
  readonly split?: { readonly ref: string; readonly explicit: string };
};

const fullCommit = /^[0-9a-f]{40}$/;

const nearby = (refs: RefListing, wanted: string): ReadonlyArray<string> => {
  const names = [...refs.branches.keys(), ...refs.tags.keys()];
  const head = wanted.split("/")[0] ?? wanted;
  const close = [...new Set(names)]
    .filter((name) => name.startsWith(head) || head.startsWith(name) || name.includes(wanted))
    .sort();
  return (close.length > 0 ? close : [...new Set(names)].sort()).slice(0, 8);
};

const notFound = (wanted: string, refs: RefListing) => {
  const candidates = nearby(refs, wanted);
  return new ImportError({
    code: "import-ref-not-found",
    message: `The remote has no branch or tag named ${JSON.stringify(wanted.slice(0, 120))}.${
      candidates.length === 0 ? "" : ` Refs that exist: ${candidates.join(", ")}.`
    }`,
    details: { candidates: [...candidates] },
  });
};

/** Classifies one typed ref name against the remote's branches and tags. */
const classify = (
  name: string,
  refs: RefListing,
): Result.Result<{ kind: "branch" | "tag" | "commit"; commit: string }, ImportError> => {
  if (fullCommit.test(name)) return Result.succeed({ kind: "commit", commit: name });
  const branch = refs.branches.get(name);
  const tag = refs.tags.get(name);
  if (branch !== undefined && tag !== undefined)
    return Result.fail(
      new ImportError({
        code: "import-ref-ambiguous",
        message: `${JSON.stringify(name)} is both a branch and a tag on the remote. Rename one of them, or pin the full commit ID after #.`,
      }),
    );
  if (branch !== undefined) return Result.succeed({ kind: "branch", commit: branch });
  if (tag !== undefined) return Result.succeed({ kind: "tag", commit: tag });
  return Result.fail(notFound(name, refs));
};

/**
 * Resolves the ref request of a parsed location to a commit. A tree or blob URL's ref is the
 * longest leading run of path segments that names a branch or tag on the remote, then a full
 * commit ID; the folder is the rest. The command that prints the result states the split.
 */
export const resolveRef = (
  parsed: ParsedImportLocation,
  refs: RefListing,
): Result.Result<ResolvedRef, ImportError> => {
  const base = { provider: parsed.provider, repository: parsed.repository };
  if (parsed.browse !== undefined) {
    const { kind, segments } = parsed.browse;
    // A blob URL keeps at least its file name outside the ref.
    const longest = kind === "blob" ? segments.length - 1 : segments.length;
    for (let length = longest; length >= 1; length -= 1) {
      const name = segments.slice(0, length).join("/");
      const matched = classify(name, refs);
      if (Result.isFailure(matched)) {
        if (matched.failure.code === "import-ref-ambiguous") return Result.fail(matched.failure);
        continue;
      }
      if (matched.success.kind === "commit" && length !== 1) continue;
      const rest = segments.slice(length);
      const folder = kind === "blob" ? rest.slice(0, -1).join("/") : rest.join("/");
      const scope = folder.length === 0 ? undefined : folder;
      return Result.succeed({
        kind: matched.success.kind,
        request: name,
        commit: matched.success.commit,
        ...(scope === undefined ? {} : { scope }),
        tracking: matched.success.kind === "branch",
        split: {
          ref: name,
          explicit: canonicalLocationText({
            ...base,
            ...(scope === undefined ? {} : { scope }),
            ref: name,
          }),
        },
      });
    }
    return Result.fail(notFound(segments[0] ?? "", refs));
  }
  const scope = parsed.scope;
  if (parsed.ref === undefined) {
    if (refs.headBranch === undefined || refs.headCommit === undefined)
      return Result.fail(
        new ImportError({
          code: "import-ref-not-found",
          message:
            "The remote reports no default branch. Name a branch, a tag or a full commit ID after #.",
        }),
      );
    return Result.succeed({
      kind: "default",
      commit: refs.headCommit,
      ...(scope === undefined ? {} : { scope }),
      tracking: true,
    });
  }
  return Result.map(classify(parsed.ref, refs), (matched) => ({
    kind: matched.kind,
    request: parsed.ref ?? "",
    commit: matched.commit,
    ...(scope === undefined ? {} : { scope }),
    tracking: matched.kind === "branch",
  }));
};
