import { Schema } from "effect";
import { PortableNameSchema } from "../../../../domain/identity/identity-schema.ts";
import type { ExplorerState, ExplorerStep, ExplorerKey } from "./model.ts";
import type {
  ProfileCopyInput,
  ProfileCopyMember,
} from "../../../../features/profiles/profile-copy.ts";
import type { ChoiceNamespace } from "../../../../domain/choices/choice-schema.ts";

/** A profile edits only its publication and manifest, independently of daily selections. */
export type ProfileDestination = {
  readonly _tag: "profile";
  readonly sourcePath: string;
  readonly profileName: string;
  readonly create: boolean;
  readonly seed?: ReadonlyArray<ProfileCopyMember>;
};
export type CopyDestination = { readonly _tag: "copy"; readonly input: ProfileCopyInput };
export type ExplorerDestination = ChoiceNamespace | ProfileDestination | CopyDestination;
/** No destination: the window only reads, as `explore` does before one is chosen. */
type BrowseOnly = { readonly _tag: "browse" };
/** What the chooser can open: a destination to edit, or none. */
export type OpenableDestination = ExplorerDestination | BrowseOnly;
export type DestinationOption = {
  readonly label: string;
  /** The heading the chooser lists the option under; absent options lead the list. */
  readonly group?: string;
  /** A fact printed after the label, such as which profile fixes a selection. */
  readonly note?: string;
  readonly destination:
    | OpenableDestination
    | {
        readonly _tag: "new-profile";
        readonly sourcePath: string;
        readonly seed?: ReadonlyArray<ProfileCopyMember>;
      };
};
export type DestinationMenu =
  | {
      readonly phase: "choose";
      readonly cursor: number;
      readonly options?: ReadonlyArray<DestinationOption>;
      readonly title?: string;
    }
  | { readonly phase: "pending" }
  | {
      readonly phase: "name";
      readonly sourcePath: string;
      readonly text: string;
      readonly seed?: ReadonlyArray<ProfileCopyMember>;
    };

/** The destination chooser lives inside the same catalog window. */
export const destinationMenuLines = (
  menu: DestinationMenu,
  options: ReadonlyArray<DestinationOption>,
  height = Number.POSITIVE_INFINITY,
): ReadonlyArray<string> =>
  menu.phase === "pending"
    ? [
        "Pending edits",
        "",
        "s: save (review first)",
        "d: discard and choose destination",
        "Esc: cancel destination change",
      ]
    : menu.phase === "name"
      ? [
          "Create profile",
          `Source: ${menu.sourcePath}`,
          "",
          `Name: ${menu.text}▏`,
          "Enter: edit positive members  Esc: cancel",
          "Nothing is written until save.",
        ]
      : [
          menu.title ?? "Choose destination",
          "",
          ...chooserWindow(menu.options ?? options, menu.cursor, Math.max(1, height - 4)),
          "",
          "↑↓ choose  Enter open  Esc cancel",
        ];

/**
 * The chooser's option lines under their group headings, scrolled so the cursor stays in a
 * window of `size` lines. A heading is not an option: the cursor counts options only.
 */
const chooserWindow = (
  options: ReadonlyArray<DestinationOption>,
  cursor: number,
  size: number,
): ReadonlyArray<string> => {
  const width = (group: string | undefined) =>
    Math.max(
      0,
      ...options.filter((option) => option.group === group).map((option) => option.label.length),
    );
  const lines = options.flatMap((option, index) => {
    const marker = index === cursor ? "›" : " ";
    const indent = option.group === undefined ? "" : "  ";
    const text =
      option.note === undefined
        ? option.label
        : `${option.label.padEnd(width(option.group))}  ${option.note}`;
    const heading =
      option.group !== undefined && options[index - 1]?.group !== option.group
        ? [{ text: option.group, option: false }]
        : [];
    return [...heading, { text: `${indent}${marker} ${text}`, option: index === cursor }];
  });
  const at = Math.max(
    0,
    lines.findIndex((line) => line.option),
  );
  const start = Math.max(0, Math.min(at - Math.floor(size / 2), lines.length - size));
  return lines.slice(start, start + size).map((line) => line.text);
};

const next = (state: ExplorerState): ExplorerStep => ({ _tag: "next", state });

/** Handles chooser input before ordinary catalog shortcuts. */
export const stepDestination = (
  state: ExplorerState,
  key: ExplorerKey,
): ExplorerStep | undefined => {
  const menu = state.destinationMenu;
  if (menu !== undefined) {
    const { destinationMenu: _menu, ...closed } = state;
    if (key.name === "escape" || (key.input === "q" && menu.phase !== "name")) return next(closed);
    if (menu.phase === "pending") {
      if (key.input === "s") return { _tag: "review", state: closed };
      if (key.input === "d")
        return next({
          ...closed,
          ...(state.edit === undefined ? {} : { edit: { ...state.edit, pending: new Map() } }),
          destinationMenu: { phase: "choose", cursor: 0 },
        });
      return next(state);
    }
    if (menu.phase === "name") {
      if (key.name === "return" && Schema.is(PortableNameSchema)(menu.text))
        return {
          _tag: "destination",
          state: closed,
          destination: {
            _tag: "profile",
            sourcePath: menu.sourcePath,
            profileName: menu.text,
            create: true,
            ...(menu.seed === undefined ? {} : { seed: menu.seed }),
          },
        };
      if (key.name === "backspace")
        return next({ ...state, destinationMenu: { ...menu, text: menu.text.slice(0, -1) } });
      return key.ctrl === false && key.input !== undefined && key.input >= " "
        ? next({ ...state, destinationMenu: { ...menu, text: menu.text + key.input } })
        : next(state);
    }
    const options = menu.options ?? state.destinations ?? [];
    if (key.name === "return") {
      const destination = options[menu.cursor]?.destination;
      if (destination === undefined) return next(state);
      return destination._tag === "new-profile"
        ? next({
            ...state,
            destinationMenu: {
              phase: "name",
              sourcePath: destination.sourcePath,
              text: "",
              ...(destination.seed === undefined ? {} : { seed: destination.seed }),
            },
          })
        : { _tag: "destination", state: closed, destination };
    }
    const delta = key.name === "up" ? -1 : key.name === "down" ? 1 : 0;
    return next({
      ...state,
      destinationMenu: {
        ...menu,
        cursor: Math.max(0, Math.min(options.length - 1, menu.cursor + delta)),
      },
    });
  }
  return undefined;
};
