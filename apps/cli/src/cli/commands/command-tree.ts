import { checkCommand } from "./check.ts";
import { guideCommand } from "./guide.ts";
import { typesCommand } from "./types.ts";
import { Command } from "effect/cli";
import { pickCommand } from "./pick.ts";
import { docsCommand } from "./docs.ts";
import { importCommands } from "./imports.ts";
import { scriptCommand } from "./script.ts";
import { stateCommand } from "./state.ts";
import { statusCommand } from "./status.ts";
import { projectCommand } from "./projects.ts";
import { doctorCommand } from "./doctor.ts";
import { exploreCommand } from "./explore.ts";
import { adapterCommand } from "./adapter.ts";
import { syncCommand } from "./sync.ts";
import { upgradeCommand } from "./upgrade.ts";
import { rootCommand } from "./root-command.ts";
import { sourceCommands } from "./sources.ts";
import { initCommand } from "./init.ts";
import { profileCommand } from "./profiles.ts";

/**
 * The complete Tack command grammar. The parser runs it, and help describes it, so the published grammar cannot drift from the accepted one.
 */
export const tackCommand = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    guideCommand,
    checkCommand,
    doctorCommand,
    docsCommand,
    scriptCommand,
    typesCommand,
    ...sourceCommands,
    exploreCommand,
    profileCommand,
    ...importCommands,
    projectCommand,
    pickCommand,
    adapterCommand,
    syncCommand,
    statusCommand,
    stateCommand,
    upgradeCommand,
  ]),
);
