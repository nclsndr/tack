/** Root flags that take a value, so the next argument is theirs and never a request. */
const rootValueFlags: ReadonlySet<string> = new Set(["--state-dir"]);
const rootInlineFlags = ["--state-dir="] as const;
const rootBooleanFlags: ReadonlySet<string> = new Set(["--json"]);
const helpFlags: ReadonlySet<string> = new Set(["--help", "-h"]);

/**
 * How root help lists `--version`. The flag is read before Effect CLI parses, so the help document
 * Effect CLI derives does not have it; the root help payload adds this entry.
 */
export const versionFlagHelp = {
  name: "version",
  description: "Print the running Tack version; combines only with --json and --state-dir",
  type: "boolean",
  required: false,
} as const;

/** The result of reading `--version` out of the arguments before the operand terminator. */
export type VersionRequest =
  | {
      /** Whether a help request accompanies it, which asks for the root's help instead. */
      readonly help: boolean;
    }
  | { readonly message: string };

/**
 * Reads the root `--version` flag. When `--version` is the only thing besides root flags and a help
 * request, it is the version request, so `tack --json --version` and `tack --version --json` are one
 * operation. Next to any other command, operand, or a second `--version`, it returns the message of
 * the failure. Arguments without `--version` before `--` return `undefined`.
 */
export const readVersionRequest = (
  arguments_: ReadonlyArray<string>,
): VersionRequest | undefined => {
  const terminator = arguments_.indexOf("--");
  const end = terminator === -1 ? arguments_.length : terminator;
  let requests = 0;
  let help = false;
  let foreign = false;
  for (let index = 0; index < end; index += 1) {
    const argument = arguments_[index] ?? "";
    if (rootValueFlags.has(argument)) {
      index += 1;
    } else if (argument === "--version") {
      requests += 1;
    } else if (helpFlags.has(argument)) {
      help = true;
    } else if (
      !rootBooleanFlags.has(argument) &&
      !rootInlineFlags.some((prefix) => argument.startsWith(prefix))
    ) {
      foreign = true;
    }
  }
  if (requests === 0) return undefined;
  if (requests > 1 || foreign || end !== arguments_.length)
    return { message: "--version cannot be combined with another command, operand or flag." };
  return { help };
};
