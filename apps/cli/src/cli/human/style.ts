import {
  referenceFor,
  sourceQualifier,
  type ReferenceIndex,
} from "../../features/sources/resource-reference.ts";

type Paint = (text: string) => string;

/** A resource address as the views receive it: always an exact identity. */
export type ReferenceAddress = {
  readonly sourceRegistrationId: string;
  readonly kind: string;
  readonly name: string;
};

/** Shared presentation settings for dedicated and generic human views. */
export type Style = {
  readonly bold: Paint;
  readonly dim: Paint;
  readonly red: Paint;
  readonly yellow: Paint;
  readonly green: Paint;
  readonly cyan: Paint;
  readonly width: number;
  readonly path: (absolutePath: string) => string;
  /** The shortest unambiguous reference for a resource: `review`, or `brain:review` on a clash. */
  readonly reference: (address: ReferenceAddress) => string;
  /** The source's label when it names it unambiguously, otherwise its registration ID. */
  readonly source: (registrationId: string) => string;
  /** Called with the commands a view lists under Next, so a caller can read what a view suggests. */
  readonly hint: (commands: ReadonlyArray<string>) => void;
};

const paint =
  (enabled: boolean, open: number, close: number): Paint =>
  (value) =>
    enabled ? `\u001b[${open}m${value}\u001b[${close}m` : value;

/** The same style with its references read from another catalog, such as one a report carries. */
export const withReferences = (style: Style, references: ReferenceIndex): Style => ({
  ...style,
  reference: (address) => referenceFor(references, address),
  source: (registrationId) => sourceQualifier(references, registrationId),
});

/** Builds style values once, leaving view functions pure. */
export const makeStyle = (options: {
  readonly color: boolean;
  readonly homeDirectory: string | undefined;
  readonly width: number;
  /** The catalog the references are read from; without it a reference keeps the registration ID. */
  readonly references?: ReferenceIndex;
}): Style => {
  const index = options.references;
  const home = options.homeDirectory;
  return {
    bold: paint(options.color, 1, 22),
    dim: paint(options.color, 2, 22),
    red: paint(options.color, 31, 39),
    yellow: paint(options.color, 33, 39),
    green: paint(options.color, 32, 39),
    cyan: paint(options.color, 36, 39),
    width: Math.max(40, Math.min(options.width, 160)),
    path: (absolutePath) =>
      home !== undefined && home !== "" && absolutePath.startsWith(`${home}/`)
        ? `~${absolutePath.slice(home.length)}`
        : absolutePath,
    reference: (address) =>
      index === undefined
        ? `${address.sourceRegistrationId}:${address.name}`
        : referenceFor(index, address),
    source: (registrationId) =>
      index === undefined ? registrationId : sourceQualifier(index, registrationId),
    hint: () => undefined,
  };
};
