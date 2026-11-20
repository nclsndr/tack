import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TerminalContext } from "../cli/host/human/terminal-context.ts";
import { Source } from "../features/sources/source.ts";
import { Destination } from "../services/destination.ts";
import { ExecutionPlatform } from "../services/execution-platform.ts";
import { Git } from "../services/git.ts";
import { ImportRemote } from "../services/import-remote.ts";
import { Reader } from "../services/reader.ts";
import { ReaderCorpus } from "../services/reader-corpus.ts";
import { StateStore } from "../services/state-store.ts";
import { ApplicationLive } from "./application-layer.ts";

it.effect("builds every capability the CLI resolves from the one production graph", () =>
  Effect.gen(function* () {
    const state = yield* StateStore;
    const terminal = yield* TerminalContext;
    const services = [
      yield* Destination,
      yield* Git,
      yield* ImportRemote,
      yield* Source,
      yield* Reader,
      yield* ReaderCorpus,
      yield* ExecutionPlatform,
    ];

    expect(
      yield* state.resolveDirectory({
        environment: { TACK_STATE_DIR: "/tack-application-layer-state" },
        homeDirectory: "/unused-home",
      }),
    ).toBe("/tack-application-layer-state");
    expect(terminal.columns).toBeGreaterThan(0);
    expect(services.every((service) => typeof service === "object")).toBe(true);
  }).pipe(Effect.provide(ApplicationLive)),
);
