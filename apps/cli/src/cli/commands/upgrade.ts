import { Command } from "effect/cli";
import { receive } from "./invocation-receiver.ts";

const guide =
  "Tack never upgrades itself: report how this Tack was installed and the command that upgrades it, such as npm install --global @tackup/cli@latest. Uses no network and changes nothing";

const upgradeStatusCommand = Command.make("status", {}, () =>
  receive({ _tag: "upgrade-status" }),
).pipe(Command.withDescription(guide), Command.withExamples([{ command: "tack upgrade status" }]));

/** How to upgrade the running Tack, which its package manager owns. */
export const upgradeCommand = Command.make("upgrade", {}, () => receive({ _tag: "upgrade" })).pipe(
  Command.withSubcommands([upgradeStatusCommand]),
  Command.withDescription(guide),
  Command.withExamples([{ command: "tack upgrade" }]),
);
