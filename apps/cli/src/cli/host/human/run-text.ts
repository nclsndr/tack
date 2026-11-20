import type { PublicEnvelope } from "../public-outcome.ts";
import { frameView } from "./frame.ts";
import type { Style } from "./style.ts";
import { displayWidth, truncate } from "./text.ts";

/** Text helpers shared by the reader, script run and history views. */

/** Collapses whitespace so multi-line text becomes one displayable line. */
export const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** A byte count in binary units: `812 B`, `1.2 KiB`, `10 MiB`. */
export const formatBytes = (bytes: number) => {
  const unit = (value: number, suffix: string) =>
    `${Number.isInteger(value) ? value : value.toFixed(1)} ${suffix}`;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return unit(bytes / 1024, "KiB");
  return unit(bytes / (1024 * 1024), "MiB");
};

const isoPattern = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/;

/** `2026-11-07 14:02:11 UTC` for an ISO timestamp; any other text is shown as given. */
export const instant = (iso: string) => {
  const match = isoPattern.exec(iso);
  return match === null ? iso : `${match[1]} ${match[2]} UTC`;
};

/** `14:02:11` for an ISO timestamp, or the text as given. */
export const timeOfDay = (iso: string) => isoPattern.exec(iso)?.[2] ?? iso;

/** A start, or a start and finish, in one phrase; the date repeats only when it changes. */
export const period = (startedAt: string, finishedAt: string | undefined) => {
  if (finishedAt === undefined) return instant(startedAt);
  const start = isoPattern.exec(startedAt);
  const finish = isoPattern.exec(finishedAt);
  if (start === null || finish === null) return `${instant(startedAt)} → ${instant(finishedAt)}`;
  return start[1] === finish[1]
    ? `${start[1]} ${start[2]} → ${finish[2]} UTC`
    : `${start[1]} ${start[2]} → ${finish[1]} ${finish[2]} UTC`;
};

/** The storage-safe run identifier grammar, so a hint never names an identifier the CLI rejects. */
export const isRunId = (runId: string) => /^[a-f0-9-]{36}$/.test(runId);

/** A JSON value displayed within `lines` rows: compact when it fits, else pretty and cut. */
export const valueLines = (
  value: unknown,
  style: Style,
  options: { readonly indent: string; readonly maxLines: number },
): { readonly lines: ReadonlyArray<string>; readonly truncated: boolean } => {
  const room = Math.max(10, style.width - displayWidth(options.indent));
  const compact = JSON.stringify(value) ?? String(value);
  if (displayWidth(compact) <= room)
    return { lines: [`${options.indent}${compact}`], truncated: false };
  const pretty = (JSON.stringify(value, null, 2) ?? compact).split("\n");
  const shown = pretty.slice(0, options.maxLines);
  const cut = shown.map((line) => truncate(line, room));
  return {
    lines: cut.map((line) => `${options.indent}${line}`),
    truncated: pretty.length > shown.length || cut.some((line, index) => line !== shown[index]),
  };
};

/** The view of an envelope with no payload: a failure keeps header, diagnostics and any hints. */
export const withoutPayload = (
  envelope: PublicEnvelope,
  style: Style,
  hints: ReadonlyArray<string> = [],
): string | undefined =>
  envelope.status === "failure" ? frameView(envelope, style, { body: [], hints }) : undefined;
