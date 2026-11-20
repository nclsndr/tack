import { Schema } from "effect";
import { publishedPackageName } from "../execution/published-name.ts";

/** How the running Tack was installed, which decides how it upgrades. */
const InstallKindSchema = Schema.Literals(["npm", "bun", "source"]);
export type InstallKind = typeof InstallKindSchema.Type;

/**
 * The `upgrade` and `upgrade status` result: what is running, how it was installed, and the command
 * that upgrades it. Tack never upgrades itself: the package manager that installed it does.
 */
export const UpgradeGuideSchema = Schema.Struct({
  kind: Schema.Literal("upgrade-guide"),
  version: Schema.String.annotate({ description: "The plain 0.y.z version that is running." }),
  stamp: Schema.String.annotate({
    description: "The version plus build metadata, as tack --version reports it.",
  }),
  install: InstallKindSchema.annotate({
    description: "How this Tack was installed: npm or bun for a package, source for a checkout.",
  }),
  command: Schema.NullOr(Schema.Array(Schema.String)).annotate({
    description:
      "The command that upgrades this Tack, as argv; null for a checkout, which upgrades by pulling.",
  }),
  message: Schema.String.annotate({ description: "What to do, in one sentence or two." }),
});
export type UpgradeGuide = typeof UpgradeGuideSchema.Type;

const npmUpgrade = ["npm", "install", "--global", `${publishedPackageName}@latest`] as const;
const bunUpgrade = ["bun", "add", "--global", `${publishedPackageName}@latest`] as const;

/** The step after a package upgrade: the agents' built-in skills still point at the old version. */
const relink = "tack init to point the built-in skills at the new version";

/** Per install kind: the command that upgrades it, and what to tell the operator. */
const guides: Record<
  InstallKind,
  { readonly command: ReadonlyArray<string> | null; readonly message: (stamp: string) => string }
> = {
  npm: {
    command: npmUpgrade,
    message: (stamp) =>
      `Tack ${stamp} was installed with npm, which owns its upgrades. Run ${npmUpgrade.join(" ")}, then ${relink}.`,
  },
  bun: {
    command: bunUpgrade,
    message: (stamp) =>
      `Tack ${stamp} was installed with Bun, which owns its upgrades. Run ${bunUpgrade.join(" ")}, then ${relink}.`,
  },
  source: {
    command: null,
    message: (stamp) =>
      `Tack ${stamp} runs from a checkout: pull it and run bun install. To install the checkout as the global tack, run bun run install:local in it.`,
  },
};

/** The upgrade guide for one install kind of one version. */
export const upgradeGuide = (
  install: InstallKind,
  version: string,
  stamp: string,
): UpgradeGuide => ({
  kind: "upgrade-guide",
  version,
  stamp,
  install,
  command: guides[install].command,
  message: guides[install].message(stamp),
});
