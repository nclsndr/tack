#!/usr/bin/env bun

import { runMain as runEffectMain } from "@effect/platform-node-shared/NodeRuntime";
import { Effect } from "effect";
import { runCli } from "../cli/host/run.ts";
import { ApplicationLive } from "./application-layer.ts";

// Coverage skip: the process entrypoint runs only in CLI subprocesses, invisible to parent coverage.
/* v8 ignore start -- @preserve */
const program = runCli().pipe(Effect.provide(ApplicationLive));

/** Runs the CLI through its single production Layer graph. */
export const runMain = () => runEffectMain(program, { disableErrorReporting: true });
/* v8 ignore stop -- @preserve */
