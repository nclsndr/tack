import { expect, it } from "vitest";
import { renderHuman } from "../src/cli/host/human/render.ts";
import { runViews } from "../src/cli/host/human/run-views.ts";
import { makeStyle } from "../src/cli/host/human/style.ts";
import { ScriptShowPayloadSchema } from "../src/domain/execution/execution-schema.ts";
import { resultAs, resultOutcome } from "../src/cli/host/outcomes.ts";
import { createPublicEnvelope, type PublicEnvelope } from "../src/cli/host/public-outcome.ts";

const style = makeStyle({ color: false, width: 80, homeDirectory: "/Users/ada" });
const render = (envelope: PublicEnvelope) => renderHuman(envelope, style);
const shown = (overrides: object = {}) =>
  createPublicEnvelope(
    "script show",
    resultAs(ScriptShowPayloadSchema)({
      address: {
        kind: "script",
        name: "report",
        sourceRegistrationId: "00000000-0000-4000-8000-000000000001",
      },
      description: "Summarize open pull requests.",
      filePath: "/Users/ada/source/scripts/report.ts",
      sourcePath: "/Users/ada/source",
      arguments: [
        { name: "repo", type: "string", description: "The repository, such as nclsndr/tack" },
        { name: "limit", type: "number", default: 20 },
        { name: "state", type: "string", choices: ["open", "closed"], default: "open" },
        { name: "labels", type: "string", multiple: true, optional: true },
        { name: "dryRun", type: "boolean", optional: true },
      ],
      secrets: ["GITHUB_TOKEN"],
      ...overrides,
    }),
  );

it("lists a script's arguments in declaration order, its secrets and how to run it", () => {
  const output = render(shown());

  expect(output.split("\n")[0]).toBe("tack script show · ✓ success");
  expect(output).toContain("Description  Summarize open pull requests.");
  expect(output).toContain(
    [
      "Arguments",
      "  --repo <string>        required      The repository, such as nclsndr/tack",
      "  --limit <number>       default 20",
      "  --state open|closed    default open",
      "  --labels <string> ...  optional",
      "  --dryRun               optional",
    ].join("\n"),
  );
  expect(output).toContain("Secrets\n  GITHUB_TOKEN  from TACK_GITHUB_TOKEN");
  expect(output).toContain("tack script run report -- --repo REPO");
});

it("says when a script takes no arguments and reads no secrets", () => {
  const output = render(shown({ arguments: [], secrets: [] }));

  expect(output).toContain("Arguments\n  none");
  expect(output).not.toContain("Secrets");
  expect(output).toContain("tack script run report\n");
});

it("names a camel-case argument's placeholder in upper snake case", () => {
  expect(
    render(
      shown({
        arguments: [
          { name: "baseRef", type: "string" },
          { name: "force", type: "boolean" },
        ],
      }),
    ),
  ).toContain("tack script run report -- --baseRef BASE_REF --force");
});

it("declines an undecodable payload and frames a failure without one", () => {
  expect(
    runViews["script-show"](
      createPublicEnvelope("script show", resultOutcome({ kind: "script-show" })),
      style,
    ),
  ).toBeUndefined();
  const failed = createPublicEnvelope("script show", {
    classification: "invalid-configuration",
    diagnostics: [
      {
        code: "invalid_args",
        message: 'Missing --repo (string).\n--limit must be a number, got "lots".',
        severity: "error",
      },
    ],
  });
  const output = render(failed);

  expect(output).toContain("  ✗ Missing --repo (string).\n    --limit must be a number");
});
