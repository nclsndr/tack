import { Context } from "effect";
import { Command } from "effect/cli";
import type { HelpNoteSchema } from "./command-payloads.ts";

/** One titled block of `term  meaning` rows that help prints after a command's flags. */
export type HelpNote = typeof HelpNoteSchema.Type;

/** Annotates a command with the notes its help page adds, such as what each status value means. */
export class HelpNotesAnnotation extends Context.Service<
  HelpNotesAnnotation,
  ReadonlyArray<HelpNote>
>()("tack/cli/cli/commands/help-notes/HelpNotes") {}

/** Declares the notes a command's help page prints. */
export const helpNotes = (notes: ReadonlyArray<HelpNote>) =>
  Command.annotate(HelpNotesAnnotation, notes);
