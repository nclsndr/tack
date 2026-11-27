import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync, readdirSync } from "node:fs";
import { nextCommandsOf, renderHuman } from "../src/cli/human/render.ts";
import { makeStyle } from "../src/cli/human/style.ts";
import {
  PublicEnvelopeSchema,
  createPublicEnvelope,
  renderPublicEnvelope,
  type PublicEnvelope,
} from "../src/cli/envelope/public-outcome.ts";
import { hintsIn } from "./support/hints.ts";

const fixtures = new URL("./fixtures/human/", import.meta.url);
const decode = Schema.decodeUnknownSync(PublicEnvelopeSchema);
const fixture = (name: string): PublicEnvelope =>
  decode(JSON.parse(readFileSync(new URL(name, fixtures), "utf8")));
const style = makeStyle({ color: false, homeDirectory: "/fx/home", width: 160 });

it("gives every envelope a `next` list, empty unless a command supplies one", () => {
  const envelope = createPublicEnvelope("version", { classification: "success", diagnostics: [] });
  expect(envelope.next).toEqual([]);
  expect(Object.keys(JSON.parse(renderPublicEnvelope(envelope)))).toEqual([
    "applied",
    "classification",
    "command",
    "diagnostics",
    "next",
    "plan",
    "result",
    "status",
    "version",
  ]);
});

it("requires `next` to be a list of command strings", () => {
  const envelope = createPublicEnvelope("version", { classification: "success", diagnostics: [] });
  expect(() => decode({ ...envelope, next: [1] })).toThrow();
  const { next: _next, ...withoutNext } = envelope;
  expect(() => decode(withoutNext)).toThrow();
});

it.each(readdirSync(fixtures).filter((name) => name.endsWith(".json")))(
  "%s: `next` is exactly the commands the text view prints under Next",
  (name) => {
    const envelope = fixture(name);
    expect(nextCommandsOf(envelope, style)).toEqual(hintsIn(renderHuman(envelope, style)));
    // The captured envelope publishes the same list.
    expect(envelope.next).toEqual(nextCommandsOf(envelope, style));
  },
);

it("lists the sync preview and apply for a status with links to create", () => {
  expect(nextCommandsOf(fixture("status-before.json"), style)).toEqual([
    "tack sync --project demo",
    "tack sync --project demo --apply",
    "tack catalog",
  ]);
});

it("is empty when the view offers no next step", () => {
  expect(nextCommandsOf(fixture("status-after.json"), style)).toEqual(["tack catalog"]);
  expect(
    nextCommandsOf(
      createPublicEnvelope("version", { classification: "success", diagnostics: [] }),
      style,
    ),
  ).toEqual([]);
});
