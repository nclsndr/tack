import { skillText } from "./support/source-tree.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { runTackInProcess } from "./support/host-runner.ts";
import { decodeEnvelope, git } from "./support/tack-process.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const decodeRegistration = Schema.decodeUnknownSync(
  Schema.Struct({ registration: Schema.Struct({ id: Schema.String }) }),
);
const AddressSchema = Schema.Struct({
  kind: Schema.String,
  name: Schema.String,
  sourceRegistrationId: Schema.optionalKey(Schema.String),
});
const decodeChoices = Schema.decodeUnknownSync(
  Schema.Struct({
    choices: Schema.Array(
      Schema.Struct({ address: AddressSchema, decision: Schema.String, namespace: Schema.Unknown }),
    ),
  }),
);

type Address = {
  readonly kind: string;
  readonly name: string;
  readonly sourceRegistrationId?: string | undefined;
};

const skill = (directory: string, name: string) => {
  mkdirSync(join(directory, "skills", name), { recursive: true });
  writeFileSync(
    join(directory, "skills", name, "SKILL.md"),
    skillText(name, { description: `The ${name} skill.` }),
  );
};

/**
 * A throwaway HOME and state directory with two sources that both declare `review`, and one that
 * alone declares `solo`. State is initialized and the sources are registered with the real CLI.
 * State holds only picks that name their source. Tack runs in process.
 */
const fixture = async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tack-source-qualified-picks-test-")));
  roots.push(root);
  const home = join(root, "home");
  const stateDirectory = join(root, "state");
  mkdirSync(home);
  const sources = { alpha: join(root, "alpha"), beta: join(root, "beta") };
  for (const [label, directory] of Object.entries(sources)) {
    mkdirSync(directory);
    writeFileSync(
      join(directory, "tack.yaml"),
      `version: 1\nname: ${label}\nskills:\n  - path: skills\n`,
    );
    skill(directory, "review");
  }
  skill(sources.alpha, "solo");

  const run = async (args: ReadonlyArray<string>) => {
    const result = await Effect.runPromise(
      runTackInProcess(["--json", "--state-dir", stateDirectory, ...args], { cwd: root, home }),
    );
    return { envelope: decodeEnvelope(result.stdout), exitCode: result.exitCode };
  };

  expect((await run(["state", "init"])).exitCode).toBe(0);
  const ids: Record<string, string> = {};
  for (const [label, directory] of Object.entries(sources)) {
    const added = await run(["source", "add", directory, "--apply"]);
    expect(added.exitCode).toBe(0);
    ids[label] = decodeRegistration(added.envelope.applied).registration.id;
  }

  const statePath = join(stateDirectory, "state.json");
  const picks = async (): Promise<ReadonlyArray<{ address: Address; decision: string }>> =>
    decodeChoices((await run(["pick", "--user"])).envelope.result).choices;

  return { ids, picks, root, run, statePath, stateDirectory, home };
};

const userPick = (id: string | undefined, name: string, decision = "include") => ({
  address: { kind: "skill", name, ...(id === undefined ? {} : { sourceRegistrationId: id }) },
  decision,
  namespace: { _tag: "user" },
});

describe("source-qualified picks", () => {
  it("pins a unique bare name to its source and keeps the other source's pick apart", async () => {
    const { ids, picks, run } = await fixture();

    expect((await run(["pick", "include", "solo", "--user"])).exitCode).toBe(0);
    expect((await run(["pick", "include", "alpha:review", "--user"])).exitCode).toBe(0);
    expect((await run(["pick", "exclude", "beta:review", "--user"])).exitCode).toBe(0);

    // The order follows the source registration IDs, which are random, so the picks are unordered.
    expect(await picks()).toHaveLength(3);
    expect(await picks()).toEqual(
      expect.arrayContaining([
        userPick(ids["alpha"], "review"),
        userPick(ids["beta"], "review", "exclude"),
        userPick(ids["alpha"], "solo"),
      ]),
    );
  });

  it("replaces the decision of the same source's pick", async () => {
    const { ids, picks, run } = await fixture();
    expect((await run(["pick", "include", "alpha:review", "--user"])).exitCode).toBe(0);

    expect((await run(["pick", "exclude", "alpha:review", "--user"])).exitCode).toBe(0);

    expect(await picks()).toEqual([userPick(ids["alpha"], "review", "exclude")]);
  });

  it("still names a working command when two picks share a name", async () => {
    const { ids, picks, run } = await fixture();
    for (const label of ["alpha", "beta"]) {
      expect((await run(["pick", "include", `${label}:review`, "--user"])).exitCode).toBe(0);
    }

    const failed = await run(["pick", "remove", "review", "--user", "--kind", "skill"]);
    expect(failed.envelope.diagnostics[0]).toMatchObject({ code: "resource-ambiguous" });
    const [command] = /tack pick remove (alpha:review --kind skill)/.exec(
      failed.envelope.diagnostics[0]?.message ?? "",
    ) ?? [undefined];
    expect(command).toBeDefined();

    expect(
      (await run(["pick", "remove", "alpha:review", "--kind", "skill", "--user"])).exitCode,
    ).toBe(0);
    expect((await picks()).map(({ address }) => address.sourceRegistrationId)).toEqual([
      ids["beta"],
    ]);
  });
});

describe("release-owned picks", () => {
  it("allows a registered skill with a built-in name to keep its own picks", async () => {
    const { root, run } = await fixture();
    skill(join(root, "alpha"), "use-tack");
    for (const operation of ["include", "exclude", "remove"]) {
      expect((await run(["pick", operation, "alpha:use-tack", "--user"])).exitCode).toBe(0);
    }
  });

  it("refuses include, exclude and remove at user and project scope without writing picks", async () => {
    const { root, run, statePath } = await fixture();
    const repository = join(root, "demo");
    mkdirSync(repository);
    await git(repository, ["init", "--quiet"]);
    expect((await run(["project", "add", "demo", "--repository-cwd", repository])).exitCode).toBe(
      0,
    );
    const before = readFileSync(statePath, "utf8");
    const references = [
      "use-tack",
      "tack:manage-tack-sources",
      "98a032d9-b6da-4f82-89ed-782fcd821af6:write-reader-figures",
      "98a032d9-b6da-4f82-89ed-782fcd821af6:author-tack-profiles",
    ];
    for (const scope of [["--user"], ["--project", "demo"]]) {
      for (const operation of ["include", "exclude", "remove"]) {
        for (const reference of references) {
          const result = await run(["pick", operation, reference, ...scope]);
          expect(result.exitCode).not.toBe(0);
          expect(result.envelope.diagnostics).toMatchObject([
            {
              code: "builtin-skill-locked",
              message: expect.stringContaining("managed by the release"),
            },
          ]);
          expect(readFileSync(statePath, "utf8")).toBe(before);
        }
      }
    }
  });
});
