import { BundleError } from "./bundle-error.ts";

/** Refuses nonportable paths and known operator/configuration/credential content. */
export const validateBundlePath = (path: string): void => {
  if (path.length > 256 || new TextEncoder().encode(path).length > 256)
    throw new BundleError({
      code: "profile-bundle-invalid",
      message: "Bundle paths must fit 256 UTF-8 bytes; shorten the authored layout before export.",
    });
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes(":") ||
    Array.from({ length: path.length }, (_, index) => path.charCodeAt(index)).some(
      (code) => code < 32 || code === 127,
    ) ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  )
    throw new BundleError({
      code: "profile-bundle-invalid",
      message: `Unsafe relative bundle path: ${path}`,
    });
  if (
    parts.some((part) =>
      /^(?:\.env(?:\..*)?|\.git|\.git-credentials|\.tack|\.local|\.config|\.ssh|\.aws|\.codex|\.claude|\.cursor|\.npmrc|\.netrc|credentials?(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?|state\.json|journal(?:\..*)?|history(?:\..*)?)$/i.test(
        part,
      ),
    )
  )
    throw new BundleError({
      code: "profile-bundle-sensitive",
      message: `Refused sensitive operator/configuration path: ${path}. Remove it from resource/support content before export.`,
    });
};
