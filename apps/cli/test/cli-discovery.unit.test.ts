import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect, Record, Result, Schema } from "effect";
import type { Command } from "effect/cli";
import { tackCommand } from "../src/cli/commands/command-tree.ts";
import { isListAlias } from "../src/cli/commands/list-alias.ts";
import {
  describeHelp,
  HelpPayloadSchema,
  commandDeclarations,
  commandNameOf,
  parseInvocation as parseInvocationEffect,
} from "../src/cli/commands/index.ts";
import type { CommandContract } from "../src/cli/commands/manifest.ts";
import {
  CommandContractsSchema,
  describeContracts,
} from "../src/cli/commands/manifest.test-support.ts";
import { PortableNameSchema } from "../src/domain/identity/identity-schema.ts";

const parseInvocation = (arguments_: ReadonlyArray<string>) =>
  parseInvocationEffect(arguments_).pipe(Effect.provide(BunServices.layer));
const help = (commandPath: ReadonlyArray<string>) =>
  describeHelp(commandPath).pipe(Effect.provide(BunServices.layer));
const contracts = (commandPath: ReadonlyArray<string> = []) =>
  describeContracts(commandPath).pipe(Effect.provide(BunServices.layer));

const strict = { onExcessProperty: "error" } as const;
const decodeHelp = Schema.decodeUnknownSync(HelpPayloadSchema, strict);
const decodeContracts = Schema.decodeUnknownSync(CommandContractsSchema, strict);

/** The argv of a documented example, without the leading `tack`. */
const argvOf = (example: { readonly command: string }) => {
  const [program, ...argv] = example.command.split(" ");
  expect(program, example.command).toBe("tack");
  return argv;
};

/** A value the parser accepts for a flag, so only its name decides whether it is recognized. */
const flagArguments = (flag: CommandContract["flags"][number]): ReadonlyArray<string> => {
  if (flag.type === "boolean") return [`--${flag.name}`];
  if (flag.type === "integer") return [`--${flag.name}`, "1"];
  return [`--${flag.name}`, flag.choices?.[0] ?? "00000000-0000-4000-8000-000000000001"];
};

const tagOf = (commandPath: ReadonlyArray<string>) => {
  const name = commandPath.join(" ");
  const tag = Record.keys(commandDeclarations).find(
    (candidate) => commandNameOf(candidate) === name,
  );
  expect(tag, name).toBeDefined();
  return tag;
};

const operationNames = new Set(Record.keys(commandDeclarations).map(commandNameOf));

const isUnrecognizedFlag = (result: Result.Result<unknown, { readonly message: string }>) =>
  Result.isFailure(result) && result.failure.message.startsWith("Unrecognized flag");

const firstExample = (contract: CommandContract) => {
  const [example] = contract.examples;
  if (example === undefined) throw new Error(`${contract.command} has no example`);
  return example;
};

it.effect("publishes exactly the executable operations the parser dispatches", () =>
  Effect.gen(function* () {
    const { commands } = decodeContracts(yield* contracts());
    expect(commands.map(({ command }) => command).toSorted()).toEqual(
      [...new Set(Record.keys(commandDeclarations).map(commandNameOf))].toSorted(),
    );
    for (const contract of commands) {
      expect(contract.command).toBe(contract.commandPath.join(" "));
      expect(contract.executable).toBe(true);
    }
  }),
);

it.effect("parses every documented example as the operation it documents", () =>
  Effect.gen(function* () {
    for (const contract of (yield* contracts()).commands) {
      expect(contract.examples.length, contract.command).toBeGreaterThan(0);
      for (const example of contract.examples) {
        const { invocation } = yield* parseInvocation(argvOf(example));
        expect(invocation["_tag"], example.command).toBe(
          contract.command === "state clean" && example.command.includes("--pending")
            ? "state-clean-pending"
            : tagOf(contract.commandPath),
        );
      }
    }
  }),
);

it.effect("documents exactly the flags the parser accepts for every operation", () =>
  Effect.gen(function* () {
    const { commands } = yield* contracts();
    const everyFlag = new Map(
      commands.flatMap(({ flags }) => flags.map((flag) => [flag.name, flag] as const)),
    );
    let rejected = 0;
    for (const contract of commands) {
      const example = firstExample(contract);
      const documented = new Set(contract.flags.map(({ name }) => name));
      for (const [name, flag] of everyFlag) {
        const result = yield* Effect.result(
          parseInvocation([...argvOf(example), ...flagArguments(flag)]),
        );
        expect(isUnrecognizedFlag(result), `${contract.command} --${name}`).toBe(
          !documented.has(name),
        );
        if (!documented.has(name)) rejected += 1;
      }
    }
    // Guards the probe itself: most flags belong to only a few operations.
    expect(rejected).toBeGreaterThan(commands.length);
  }),
);

it.effect("documents the operands and required flags the parser requires", () =>
  Effect.gen(function* () {
    for (const contract of (yield* contracts()).commands) {
      const requiresInput =
        contract.arguments.some(({ required }) => required) ||
        contract.flags.some(({ required }) => required);
      const bare = yield* Effect.result(parseInvocation(contract.commandPath));
      const missing = Result.isFailure(bare) && bare.failure.code === "missing-argument";
      expect(missing, contract.command).toBe(requiresInput);

      const example = firstExample(contract);
      for (const flag of contract.flags.filter(({ required }) => required)) {
        const argv = argvOf(example);
        const index = argv.indexOf(`--${flag.name}`);
        expect(index, `${example.command} uses --${flag.name}`).toBeGreaterThan(-1);
        const withoutFlag = yield* Effect.result(
          parseInvocation([...argv.slice(0, index), ...argv.slice(index + 2)]),
        );
        expect(Result.isFailure(withoutFlag), `${example.command} without --${flag.name}`).toBe(
          true,
        );
      }

      // Operands beyond the documented ones are rejected unless the last one is variadic.
      if (contract.arguments.at(-1)?.variadic !== true) {
        const extra = yield* Effect.result(parseInvocation([...argvOf(example), "extra"]));
        expect(Result.isFailure(extra), `${example.command} extra`).toBe(true);
      }
    }
  }),
);

it.effect("publishes apply variants for preview-apply and conditional operations", () =>
  Effect.gen(function* () {
    for (const contract of (yield* contracts()).commands) {
      const applies = contract.flags.some(({ name }) => name === "apply");
      // `explore` saves only after the operator confirms a review inside the window, not on --apply.
      expect(
        contract.mutation === "preview-apply" ||
          (contract.mutation === "conditional" && contract.command !== "explore"),
        contract.command,
      ).toBe(applies);
      expect(
        contract.responses.map(({ mode }) => mode),
        contract.command,
      ).toEqual(applies ? ["default", "apply"] : ["default"]);
    }
  }),
);

it.effect("publishes --all only on scoped commands, import add and --cwd on refresh", () =>
  Effect.gen(function* () {
    // `import add --all` selects every importable skill; the others select every project.
    const scoped = new Set(["sync", "status", "state clean", "project refresh", "import add"]);
    for (const contract of (yield* contracts()).commands) {
      const flags = contract.flags.map(({ name }) => name);
      expect(flags.includes("all"), contract.command).toBe(scoped.has(contract.command));
      const helpFlags = decodeHelp(yield* help(contract.commandPath)).flags.map(({ name }) => name);
      expect(helpFlags.includes("all"), contract.command).toBe(scoped.has(contract.command));
    }
    const refresh = (yield* contracts(["project", "refresh"])).commands[0];
    expect(refresh?.flags.map(({ name }) => name)).toContain("cwd");
    expect(decodeHelp(yield* help(["project", "refresh"])).flags.map(({ name }) => name)).toContain(
      "cwd",
    );
  }),
);

it.effect("describes the root and every group with subcommands that resolve", () =>
  Effect.gen(function* () {
    const visit = (commandPath: ReadonlyArray<string>): Effect.Effect<number> =>
      help(commandPath).pipe(
        Effect.orDie,
        Effect.flatMap((payload) => {
          const node = decodeHelp(payload);
          expect(node.commandPath).toEqual(commandPath);
          expect(node.description, commandPath.join(" ")).not.toBe("");
          expect(node.executable, commandPath.join(" ")).toBe(
            operationNames.has(commandPath.join(" ")),
          );
          return Effect.forEach(node.subcommands, ({ name }) => visit([...commandPath, name])).pipe(
            Effect.map((counts) => counts.reduce((total, count) => total + count, 1)),
          );
        }),
      );
    const visited = yield* visit([]);
    // The root, every group and every executable operation have their own help.
    expect(visited).toBeGreaterThan(Object.keys(commandDeclarations).length);
  }),
);

it.effect("leads root help with source-owned resources", () =>
  Effect.gen(function* () {
    const root = decodeHelp(yield* help([]));
    expect(root.description).toMatch(
      /^Manage source-owned resources, including skills, commands, context, docs, and scripts\./,
    );
  }),
);

it.effect("lists --version among the root flags and nowhere else", () =>
  Effect.gen(function* () {
    const root = decodeHelp(yield* help([]));
    expect(root.flags.find(({ name }) => name === "version")).toEqual({
      name: "version",
      description: expect.stringContaining("version"),
      type: "boolean",
      required: false,
    });
    for (const commandPath of [["status"], ["script"], ["pick", "include"]])
      expect(
        decodeHelp(yield* help(commandPath)).flags.map(({ name }) => name),
        commandPath.join(" "),
      ).not.toContain("version");
  }),
);

it.effect("scopes help and schema to known command paths", () =>
  Effect.gen(function* () {
    const group = decodeHelp(yield* help(["pick"]));
    expect(group).toMatchObject({ executable: true, arguments: [] });
    expect(group.subcommands.map(({ name }) => name)).toEqual(["include", "exclude", "remove"]);

    const leaf = decodeHelp(yield* help(["pick", "include"]));
    expect(leaf).toMatchObject({
      kind: "help",
      commandPath: ["pick", "include"],
      executable: true,
      mutation: "immediate",
      subcommands: [],
    });
    expect(leaf.arguments.map(({ name }) => name)).toEqual(["reference"]);
    expect(leaf.flags.find(({ name }) => name === "project")).toMatchObject({ required: false });

    expect(
      decodeHelp(yield* help(["docs", "target"])).flags.some(({ name }) => name === "owner"),
    ).toBe(false);

    const scoped = yield* contracts(["adapter"]);
    expect(scoped.commands.map(({ command }) => command)).toEqual([
      "adapter",
      "adapter enable",
      "adapter disable",
    ]);
    expect((yield* contracts(["status"])).commands.map(({ command }) => command)).toEqual([
      "status",
    ]);

    for (const failure of [
      yield* Effect.flip(help(["wibble"])),
      yield* Effect.flip(help(["pick", "wibble"])),
      yield* Effect.flip(contracts(["status", "extra"])),
    ]) {
      expect(failure).toMatchObject({ code: "invalid-command" });
    }
    expect(yield* Effect.flip(contracts(["wibble"]))).toMatchObject({ code: "invalid-command" });
  }),
);

it.effect("types only the stable commands' payloads and leaves every other command untyped", () =>
  Effect.gen(function* () {
    const payload = decodeContracts(yield* contracts());
    // `status`, `sync`, `init`, `doctor` and `upgrade` carry the stable contract; `version` is not a
    // tree command.
    expect(Object.keys(payload.payloads).toSorted()).toEqual([
      "doctor-report",
      "init-application",
      "init-plan",
      "skill-status",
      "sync-application",
      "sync-plan",
      "upgrade-guide",
    ]);
    const slotsOf = (command: string) =>
      payload.commands.find((contract) => contract.command === command)?.responses;
    expect(slotsOf("help")).toBeUndefined();
    expect(slotsOf("version")).toBeUndefined();
    expect(slotsOf("doctor")).toEqual([{ mode: "default", slots: { result: "doctor-report" } }]);
    for (const command of ["upgrade", "upgrade status"])
      expect(slotsOf(command)).toEqual([{ mode: "default", slots: { result: "upgrade-guide" } }]);
    expect(slotsOf("sync")).toEqual([
      { mode: "default", slots: { plan: "sync-plan" } },
      {
        mode: "apply",
        slots: { plan: "sync-plan", applied: "sync-application" },
      },
    ]);
    // `init` embeds the `sync --user` payloads in its own, so agents read it like sync. It writes
    // at once, so one run reports both.
    expect(slotsOf("init")).toEqual([
      { mode: "default", slots: { plan: "init-plan", applied: "init-application" } },
    ]);
    expect(slotsOf("status")).toEqual([{ mode: "default", slots: { result: "skill-status" } }]);
    // Every other command still prints JSON, but no schema or stability promise comes with it.
    for (const command of ["catalog", "explore"])
      expect(slotsOf(command)).toEqual([{ mode: "default", slots: { result: "json" } }]);
    expect(slotsOf("types")).toEqual([
      { mode: "default", slots: { plan: "json" } },
      { mode: "apply", slots: { plan: "json", applied: "json" } },
    ]);
    expect(slotsOf("script list")).toBeUndefined();
    expect(slotsOf("source add")).toEqual([
      { mode: "default", slots: { plan: "json" } },
      { mode: "apply", slots: { applied: "json", plan: "json" } },
    ]);
    for (const contract of payload.commands) {
      const stable = ["status", "sync", "init", "doctor", "upgrade", "upgrade status"].includes(
        contract.command,
      );
      const kinds = contract.responses.flatMap(({ slots }) => Object.values(slots));
      expect(
        kinds.every((kind) => kind !== "json"),
        contract.command,
      ).toBe(stable);
    }
    const contractOf = (command: string) =>
      payload.commands.find((contract) => contract.command === command);
    expect(contractOf("catalog")?.mutation).toBe("read-only");
    expect(contractOf("catalog")?.flags.map(({ name }) => name)).toEqual([
      "json",
      "state-dir",
      "details",
      "kind",
    ]);
    expect(contractOf("explore")).toMatchObject({ mutation: "conditional" });
    expect(contractOf("explore")?.flags.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["project", "user"]),
    );
    expect(decodeHelp(yield* help(["catalog"])).description).toContain("tack explore");
  }),
);

it.effect("scopes payloads to command paths and keeps published schemas within size budgets", () =>
  Effect.gen(function* () {
    const full = decodeContracts(yield* contracts());
    const status = decodeContracts(yield* contracts(["status"]));
    expect(Object.keys(status.payloads)).toEqual(["skill-status"]);
    expect(status.commands.map((command) => command.command)).toEqual(["status"]);
    const plan = decodeContracts(yield* contracts(["sync"]));
    expect(Object.keys(plan.payloads)).toEqual(["sync-plan", "sync-application"]);
    expect(JSON.stringify(plan.payloads["sync-plan"])).toContain('"selection"');
    expect(JSON.stringify(full.payloads["skill-status"])).toContain('"$defs"');
    // The init payloads embed the sync payloads, which are most of their size.
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThan(175_000);
    expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(40_000);
  }),
);

/** The command path of every parent that declares a `list`/`ls` alias, found by walking the tree. */
const listAliasParents = (
  command: Command.Command.Any,
  commandPath: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> =>
  command.subcommands.flatMap((group) =>
    group.commands.flatMap((subcommand) =>
      isListAlias(subcommand)
        ? [commandPath]
        : listAliasParents(subcommand, [...commandPath, subcommand.name]),
    ),
  );

it.effect("accepts list and ls as spellings of the bare parents without publishing them", () =>
  Effect.gen(function* () {
    const parents = listAliasParents(tackCommand, []);
    expect(parents.map((path) => path.join(" ")).toSorted()).toEqual([
      "adapter",
      "docs",
      "pick",
      "project",
      "script history",
      "source",
    ]);
    const published = (yield* contracts()).commands.map(({ command }) => command);
    for (const parent of parents) {
      const parentName = parent.join(" ");
      expect(published, parentName).toContain(parentName);
      const bare = (yield* parseInvocation(parent)).invocation;
      for (const alias of ["list", "ls"]) {
        expect(published, `${parentName} ${alias}`).not.toContain(`${parentName} ${alias}`);
        expect(
          (yield* parseInvocation([...parent, alias])).invocation,
          `${parentName} ${alias}`,
        ).toEqual(bare);
        expect((yield* parseInvocation([...parent, alias, "--json"])).invocation["_tag"]).toBe(
          bare["_tag"],
        );
        const withoutAlias = yield* contracts([...parent, alias]).pipe(Effect.flip);
        expect(withoutAlias).toMatchObject({ code: "invalid-command" });
        const helpOfParent = decodeHelp(yield* help(parent));
        expect(helpOfParent.subcommands.map(({ name }) => name)).not.toContain(alias);
        expect(yield* Effect.flip(help([...parent, alias]))).toMatchObject({
          code: "invalid-command",
        });
      }
    }
    expect(Record.keys(commandDeclarations).map(commandNameOf)).not.toContain("source list");
  }),
);

it.effect("publishes no help or version command word", () =>
  Effect.gen(function* () {
    const published = (yield* contracts()).commands.map(({ command }) => command);
    for (const word of ["help", "version"]) expect(published, word).not.toContain(word);
    expect(published).toContain("doctor");
  }),
);

it.effect("documents script references whose script name passes the portable-name rule", () =>
  Effect.gen(function* () {
    const decodeName = Schema.decodeUnknownResult(PortableNameSchema);
    const examples = (yield* contracts()).commands
      .flatMap((contract) => contract.examples)
      .filter((example) => example.command.startsWith("tack script run "));
    expect(examples.length).toBeGreaterThan(0);
    for (const { command } of examples) {
      const reference = command.split(" ")[3] ?? "";
      const name = reference.slice(reference.indexOf(":") + 1);
      expect(Result.isSuccess(decodeName(name)), command).toBe(true);
    }
  }),
);
