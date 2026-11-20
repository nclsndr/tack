#!/usr/bin/env bun

import { workerCommand } from "./release.ts";

// Coverage skip: the process entrypoint runs only in CLI subprocesses, invisible to parent coverage.
/* v8 ignore start -- @preserve */
// The hidden worker argument makes this entry point the script worker, so no worker file ships
// beside a package. Each branch loads only its own module graph.
if (process.argv[2] === workerCommand) void import("./bootstrap/worker.ts");
else void import("./bootstrap/main.ts").then((cli) => cli.runMain());
/* v8 ignore stop -- @preserve */
