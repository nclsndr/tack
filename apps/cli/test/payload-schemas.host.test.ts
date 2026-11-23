import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Ajv2020 from "ajv/dist/2020.js";
import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  CommandContractsSchema,
  describeContracts,
} from "../src/cli/commands/manifest.test-support.ts";
import { runTackInProcess } from "./support/host-runner.ts";

const contracts = (commandPath: ReadonlyArray<string> = []) =>
  describeContracts(commandPath).pipe(Effect.provide(BunServices.layer));

const strict = { onExcessProperty: "error" } as const;
const decodeContracts = Schema.decodeUnknownSync(CommandContractsSchema, strict);

it.effect("decodes real JSON stdout against the payload schemas of its slots", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "tack-schema-stdout-"));
    const state = join(directory, "state");
    const project = join(directory, "project");
    mkdirSync(project);
    const run = Effect.fnUntraced(function* (command: ReadonlyArray<string>, git = false) {
      if (git) {
        const child = Bun.spawnSync({
          cmd: ["git", ...command],
          cwd: project,
          env: { ...process.env, HOME: directory },
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        return {};
      }
      const child = yield* runTackInProcess([...command, "--state-dir", state, "--json"], {
        cwd: project,
        home: directory,
      });
      const value: unknown = JSON.parse(child.stdout);
      return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value);
    });
    try {
      yield* run(["state", "init"]);
      yield* run(["init", "-q"], true);
      yield* run(["project", "add", "demo", "--repository-cwd", project]);
      const published = decodeContracts(yield* contracts());
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      for (const [command, slots] of [
        [["doctor"], { result: "doctor-report" }],
        [["upgrade", "status"], { result: "upgrade-guide" }],
        [["upgrade"], { result: "upgrade-guide" }],
        [["status", "--user"], { result: "skill-status" }],
        [["init"], { plan: "init-plan", applied: "init-application" }],
        [["sync", "--user"], { plan: "sync-plan" }],
        [
          ["sync", "--user", "--apply"],
          {
            plan: "sync-plan",
            applied: "sync-application",
          },
        ],
        [
          ["sync", "--no-adapters", "--project", "demo", "--apply"],
          {
            plan: "sync-plan",
            applied: "sync-application",
          },
        ],
      ] as const) {
        const output: Record<string, unknown> = yield* run(command);
        for (const [slot, kind] of Object.entries(slots)) {
          const schema = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
            published.payloads[kind],
          );
          const validate = ajv.compile(schema);
          expect(
            validate(output[slot]),
            `${command.join(" ")} ${slot}: ${ajv.errorsText(validate.errors)}`,
          ).toBe(true);
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);
