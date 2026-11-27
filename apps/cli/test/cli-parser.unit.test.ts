import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Record } from "effect";
import {
  InvocationError,
  commandDeclarations,
  type Invocation,
  parseInvocation as parseInvocationEffect,
} from "../src/cli/commands/index.ts";

const parseInvocation = (arguments_: ReadonlyArray<string>) =>
  parseInvocationEffect(arguments_).pipe(Effect.provide(BunServices.layer));

const source = "00000000-0000-4000-8000-000000000001";
const runId = "0b6a3c2e-7f1d-4c55-9a0e-5d1f2b3c4d5e";

/** One accepted command line and the exact invocation it parses to. */
type Rows = ReadonlyArray<readonly [argv: ReadonlyArray<string>, invocation: Invocation]>;

const docsRows: Rows = [
  [
    ["docs", "search", "  source ownership  "],
    { _tag: "docs-search", query: "source ownership", limit: 10 },
  ],
  [
    [
      "docs",
      "--cwd",
      "/worktree",
      "--project",
      "demo",
      "search",
      "owner",
      "--type",
      "spec",
      "--status",
      "active",
      "--tag",
      "reader",
      "--limit",
      "50",
    ],
    {
      _tag: "docs-search",
      query: "owner",
      limit: 50,
      projectName: "demo",
      cwd: "/worktree",
      type: "spec",
      status: "active",
      tag: "reader",
    },
  ],
  [
    [
      "docs",
      "search",
      "owner",
      "--cwd",
      "/worktree",
      "--project",
      "demo",
      "--type",
      "spec",
      "--status",
      "active",
      "--tag",
      "reader",
      "--limit",
      "50",
    ],
    {
      _tag: "docs-search",
      query: "owner",
      limit: 50,
      projectName: "demo",
      cwd: "/worktree",
      type: "spec",
      status: "active",
      tag: "reader",
    },
  ],
  [["docs", "serve"], { _tag: "docs-serve" }],
  [
    ["docs", "serve", "--cwd", "/worktree", "--project", "demo", "--port", "0", "--no-open"],
    { _tag: "docs-serve", projectName: "demo", cwd: "/worktree", open: false, port: 0 },
  ],
  [["docs", "serve", "--open"], { _tag: "docs-serve", open: true }],
  [["docs"], { _tag: "docs-list" }],
  [["docs", "list"], { _tag: "docs-list" }],
  [["docs", "ls"], { _tag: "docs-list" }],
  [
    ["docs", "--project", "demo", "--cwd", "/work"],
    { _tag: "docs-list", projectName: "demo", cwd: "/work" },
  ],
  [
    ["docs", "list", "--project", "demo", "--cwd", "/work"],
    { _tag: "docs-list", projectName: "demo", cwd: "/work" },
  ],
  [
    ["docs", "ls", "--project", "demo", "--cwd", "/work"],
    { _tag: "docs-list", projectName: "demo", cwd: "/work" },
  ],
  [
    ["docs", "attach", `${source}:handbook`],
    { _tag: "docs-attach", resource: { reference: `${source}:handbook` } },
  ],
  [
    ["docs", "attach", `${source}:handbook`, "--project", "demo"],
    { _tag: "docs-attach", projectName: "demo", resource: { reference: `${source}:handbook` } },
  ],
  [
    ["docs", "attach", "personal-brain:handbook"],
    { _tag: "docs-attach", resource: { reference: "personal-brain:handbook" } },
  ],
  [["docs", "detach", "handbook"], { _tag: "docs-detach", resource: { reference: "handbook" } }],
  [
    ["docs", "detach", `${source}:handbook`, "--project", "demo"],
    { _tag: "docs-detach", projectName: "demo", resource: { reference: `${source}:handbook` } },
  ],
  [
    ["docs", "configure", "--default", "handbook"],
    {
      _tag: "docs-configure",
      clearDefault: false,
      defaultWritingResource: { reference: "handbook" },
    },
  ],
  [["docs", "configure", "--clear-default"], { _tag: "docs-configure", clearDefault: true }],
  [
    ["docs", "configure", "--project", "demo"],
    { _tag: "docs-configure", projectName: "demo", clearDefault: false },
  ],
  [
    [
      "docs",
      "configure",
      "--project",
      "demo",
      "--destination",
      "docs/vendor",
      "--default",
      `${source}:handbook`,
    ],
    {
      _tag: "docs-configure",
      projectName: "demo",
      clearDefault: false,
      destination: "docs/vendor",
      defaultWritingResource: { reference: `${source}:handbook` },
    },
  ],
  [
    ["docs", "configure", "--project", "demo", "--clear-default"],
    { _tag: "docs-configure", projectName: "demo", clearDefault: true },
  ],
  [["docs", "target"], { _tag: "docs-target" }],
  [
    ["docs", "target", "--name", "handbook"],
    { _tag: "docs-target", resource: { reference: "handbook" } },
  ],
  [
    ["docs", "target", "--cwd", "/work", "--name", `${source}:handbook`],
    { _tag: "docs-target", cwd: "/work", resource: { reference: `${source}:handbook` } },
  ],
  [["docs", "icons", "database"], { _tag: "docs-icons", word: "database" }],
];

const syncRows: Rows = [
  [
    ["sync"],
    {
      _tag: "sync",
      apply: false,
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "bare" },
    },
  ],
  [
    ["sync", "--cwd", "/elsewhere"],
    {
      _tag: "sync",
      apply: false,
      cwd: "/elsewhere",
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "bare" },
    },
  ],
  [
    ["sync", "--user"],
    {
      _tag: "sync",
      apply: false,
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "user" },
    },
  ],
  [
    [
      "sync",
      "--adapter",
      "cursor",
      "--adapter",
      "codex",
      "--require-capability",
      "command-links",
      "--include-optional",
      "--cwd",
      "/elsewhere",
    ],
    {
      _tag: "sync",
      apply: false,
      adapterOverride: ["codex", "cursor"],
      cwd: "/elsewhere",
      includeOptional: true,
      noDocs: false,
      requiredCapability: "command-links",
      selector: { _tag: "bare" },
    },
  ],
  [
    [
      "sync",
      "--adapter",
      "cursor",
      "--adapter",
      "codex",
      "--require-capability",
      "command-links",
      "--include-optional",
      "--cwd",
      "/elsewhere",
      "--apply",
    ],
    {
      _tag: "sync",
      apply: true,
      adapterOverride: ["codex", "cursor"],
      cwd: "/elsewhere",
      includeOptional: true,
      noDocs: false,
      requiredCapability: "command-links",
      selector: { _tag: "bare" },
    },
  ],
  [
    [
      "sync",
      "--apply",
      "--adapter",
      "cursor",
      "--adapter",
      "codex",
      "--include-optional",
      "--require-capability",
      "skill-links",
      "--cwd",
      "/elsewhere",
    ],
    {
      _tag: "sync",
      apply: true,
      adapterOverride: ["codex", "cursor"],
      cwd: "/elsewhere",
      includeOptional: true,
      noDocs: false,
      requiredCapability: "skill-links",
      selector: { _tag: "bare" },
    },
  ],
  [
    [
      "sync",
      "--require-capability",
      "skill-links",
      "--adapter",
      "codex",
      "--project",
      "workspace",
      "--apply",
      "--include-optional",
    ],
    {
      _tag: "sync",
      apply: true,
      adapterOverride: ["codex"],
      includeOptional: true,
      noDocs: false,
      requiredCapability: "skill-links",
      selector: { _tag: "project", projectName: "workspace" },
    },
  ],
  [
    ["sync", "--adapter", "claude", "--require-capability", "command-links"],
    {
      _tag: "sync",
      apply: false,
      adapterOverride: ["claude"],
      includeOptional: false,
      noDocs: false,
      requiredCapability: "command-links",
      selector: { _tag: "bare" },
    },
  ],
  [
    ["sync", "--adapter", "claude", "--user", "--apply"],
    {
      _tag: "sync",
      apply: true,
      adapterOverride: ["claude"],
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "user" },
    },
  ],
  [
    ["sync", "--no-adapters"],
    {
      _tag: "sync",
      apply: false,
      adapterOverride: [],
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "bare" },
    },
  ],
  [
    ["sync", "--no-adapters", "--project", "workspace"],
    {
      _tag: "sync",
      apply: false,
      adapterOverride: [],
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "project", projectName: "workspace" },
    },
  ],
  [
    ["sync", "--no-adapters", "--project", "demo", "--apply"],
    {
      _tag: "sync",
      apply: true,
      adapterOverride: [],
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "project", projectName: "demo" },
    },
  ],
  [
    ["sync", "--no-adapters", "--cwd", "/work", "--apply"],
    {
      _tag: "sync",
      apply: true,
      adapterOverride: [],
      cwd: "/work",
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "bare" },
    },
  ],
  [
    ["sync", "--all"],
    {
      _tag: "sync",
      apply: false,
      includeOptional: false,
      noDocs: false,
      selector: { _tag: "all" },
    },
  ],
];

const statusRows: Rows = [
  [
    ["status"],
    { _tag: "status", includeOptional: false, details: false, selector: { _tag: "bare" } },
  ],
  [
    ["status", "--cwd", "/elsewhere"],
    {
      _tag: "status",
      cwd: "/elsewhere",
      includeOptional: false,
      details: false,
      selector: { _tag: "bare" },
    },
  ],
  [
    ["status", "--user", "--include-optional"],
    { _tag: "status", includeOptional: true, details: false, selector: { _tag: "user" } },
  ],
];

const pickRows: Rows = [
  [
    ["pick", "include", "alpha", "--project", "workspace"],
    {
      _tag: "pick-include",
      reference: "alpha",
      namespace: { _tag: "project", projectName: "workspace" },
    },
  ],
  [
    ["pick", "exclude", "beta", "--user"],
    { _tag: "pick-exclude", reference: "beta", namespace: { _tag: "user" } },
  ],
  [
    ["pick", "remove", "alpha", "--user"],
    { _tag: "pick-remove", reference: "alpha", namespace: { _tag: "user" } },
  ],
  [["pick"], { _tag: "pick-list" }],
  [["pick", "list"], { _tag: "pick-list" }],
  [["pick", "ls"], { _tag: "pick-list" }],
  [
    ["pick", "--project", "workspace"],
    { _tag: "pick-list", namespace: { _tag: "project", projectName: "workspace" } },
  ],
  [
    ["pick", "list", "--project", "workspace"],
    { _tag: "pick-list", namespace: { _tag: "project", projectName: "workspace" } },
  ],
  [
    ["pick", "ls", "--project", "workspace"],
    { _tag: "pick-list", namespace: { _tag: "project", projectName: "workspace" } },
  ],
];

const adapterRows: Rows = [
  [["adapter"], { _tag: "adapter-list" }],
  [["adapter", "list"], { _tag: "adapter-list" }],
  [["adapter", "ls"], { _tag: "adapter-list" }],
  [["adapter", "enable"], { _tag: "adapter-enable", adapters: [] }],
  [["adapter", "enable", "codex"], { _tag: "adapter-enable", adapters: ["codex"] }],
  [
    ["adapter", "enable", "cursor", "codex"],
    { _tag: "adapter-enable", adapters: ["codex", "cursor"] },
  ],
  [
    ["adapter", "enable", "cursor", "claude", "codex"],
    { _tag: "adapter-enable", adapters: ["claude", "codex", "cursor"] },
  ],
  [
    ["adapter", "disable", "cursor"],
    { _tag: "adapter-disable", adapter: "cursor", apply: false, details: false },
  ],
  [["init"], { _tag: "init" }],
  [
    ["init", "--adapter", "cursor", "--adapter", "claude"],
    { _tag: "init", adapters: ["claude", "cursor"] },
  ],
  [
    ["adapter", "disable", "codex", "--apply"],
    { _tag: "adapter-disable", adapter: "codex", apply: true, details: false },
  ],
  [
    ["adapter", "disable", "claude", "--apply"],
    { _tag: "adapter-disable", adapter: "claude", apply: true, details: false },
  ],
];

const stateRows: Rows = [
  [["state", "init"], { _tag: "state-init" }],
  [
    ["state", "clean"],
    { _tag: "state-clean", apply: false, details: false, selector: { _tag: "bare" } },
  ],
  [
    ["state", "clean", "--project", "workspace", "--apply"],
    {
      _tag: "state-clean",
      apply: true,
      details: false,
      selector: { _tag: "project", projectName: "workspace" },
    },
  ],
  [
    ["state", "clean", "--cwd", "/elsewhere"],
    {
      _tag: "state-clean",
      apply: false,
      details: false,
      cwd: "/elsewhere",
      selector: { _tag: "bare" },
    },
  ],
  [
    ["state", "clean", "--pending"],
    { _tag: "state-clean-pending", apply: false, details: false, selector: { _tag: "bare" } },
  ],
  [
    ["state", "clean", "--pending", "--user"],
    { _tag: "state-clean-pending", apply: false, details: false, selector: { _tag: "user" } },
  ],
  [
    ["state", "clean", "--pending", "--project", "workspace", "--apply"],
    {
      _tag: "state-clean-pending",
      apply: true,
      details: false,
      selector: { _tag: "project", projectName: "workspace" },
    },
  ],
  [
    ["state", "clean", "--pending", "--cwd", "/elsewhere"],
    {
      _tag: "state-clean-pending",
      apply: false,
      details: false,
      cwd: "/elsewhere",
      selector: { _tag: "bare" },
    },
  ],
  [["state", "reset"], { _tag: "state-reset", apply: false, details: false }],
  [["state", "reset", "--apply"], { _tag: "state-reset", apply: true, details: false }],
  [["state", "reset", "--details"], { _tag: "state-reset", apply: false, details: true }],
  [
    ["state", "clean", "--details"],
    { _tag: "state-clean", apply: false, details: true, selector: { _tag: "bare" } },
  ],
  [
    ["adapter", "disable", "cursor", "--details"],
    { _tag: "adapter-disable", adapter: "cursor", apply: false, details: true },
  ],
];

const projectRows: Rows = [
  [["project"], { _tag: "project-list" }],
  [["project", "list"], { _tag: "project-list" }],
  [["project", "ls"], { _tag: "project-list" }],
  [["project", "add", "workspace"], { _tag: "project-add", name: "workspace" }],
  [
    ["project", "refresh"],
    { _tag: "project-refresh", apply: false, details: false, selector: { _tag: "bare" } },
  ],
  [
    ["project", "remove", "demo"],
    { _tag: "project-remove", name: "demo", apply: false, details: false },
  ],
  [
    ["project", "remove", "demo", "--apply"],
    { _tag: "project-remove", name: "demo", apply: true, details: false },
  ],
  [
    ["project", "remove", "demo", "--details"],
    { _tag: "project-remove", name: "demo", apply: false, details: true },
  ],
  [
    ["project", "refresh", "--details"],
    { _tag: "project-refresh", apply: false, details: true, selector: { _tag: "bare" } },
  ],
  [
    ["project", "refresh", "--project", "workspace", "--apply"],
    {
      _tag: "project-refresh",
      apply: true,
      details: false,
      selector: { _tag: "project", projectName: "workspace" },
    },
  ],
  [
    ["project", "refresh", "--all", "--apply"],
    { _tag: "project-refresh", apply: true, details: false, selector: { _tag: "all" } },
  ],
  [
    ["project", "refresh", "--cwd", "/worktree"],
    {
      _tag: "project-refresh",
      apply: false,
      details: false,
      cwd: "/worktree",
      selector: { _tag: "bare" },
    },
  ],
];

const sourceRows: Rows = [
  [["source"], { _tag: "source-list" }],
  [["source", "list"], { _tag: "source-list" }],
  [["source", "ls"], { _tag: "source-list" }],
  [["source", "add", "/brain"], { _tag: "source-add", sourcePath: "/brain", apply: false }],
  [
    [
      "source",
      "add",
      "/brain",
      "--config",
      '{"version":1,"name":"brain","skills":[{"path":"."}]}',
      "--apply",
    ],
    {
      _tag: "source-add",
      sourcePath: "/brain",
      apply: true,
      config: '{"version":1,"name":"brain","skills":[{"path":"."}]}',
    },
  ],
  [
    ["source", "add", "/brain", "--config", "-"],
    { _tag: "source-add", sourcePath: "/brain", apply: false, config: "-" },
  ],
  [
    ["source", "relocate", "source-id", "/source"],
    { _tag: "source-relocate", registrationId: "source-id", sourcePath: "/source" },
  ],
  [
    ["source", "remove", "brain"],
    { _tag: "source-remove", source: "brain", apply: false, details: false },
  ],
  [
    ["source", "remove", "brain", "--apply"],
    { _tag: "source-remove", source: "brain", apply: true, details: false },
  ],
];

const catalogRows: Rows = [
  [["catalog"], { _tag: "catalog", details: false }],
  [["catalog", "--details"], { _tag: "catalog", details: true }],
  [["catalog", "--kind", "script"], { _tag: "catalog", details: false, kind: "script" }],
  [
    ["catalog", "--kind", "script", "--details"],
    { _tag: "catalog", details: true, kind: "script" },
  ],
];

const exploreRows: Rows = [
  [["explore"], { _tag: "explore" }],
  [["explore", "--user"], { _tag: "explore", destination: { _tag: "user" } }],
  [
    ["explore", "--project", "demo"],
    { _tag: "explore", destination: { _tag: "project", projectName: "demo" } },
  ],
];

const importRows: Rows = [
  [["import"], { _tag: "import-list" }],
  [
    ["import", "add", "anthropics/skills"],
    {
      _tag: "import-add",
      location: "anthropics/skills",
      skills: [],
      all: false,
      fullDepth: false,
      apply: false,
    },
  ],
  [
    [
      "import",
      "add",
      "anthropics/skills#v1",
      "--into",
      "personal-brain:vendor/skills",
      "--skill",
      "pdf",
      "--skill",
      "docx",
      "--full-depth",
      "--apply",
    ],
    {
      _tag: "import-add",
      location: "anthropics/skills#v1",
      into: "personal-brain:vendor/skills",
      skills: ["pdf", "docx"],
      all: false,
      fullDepth: true,
      apply: true,
    },
  ],
  [
    ["import", "add", "a/b", "--all"],
    { _tag: "import-add", location: "a/b", skills: [], all: true, fullDepth: false, apply: false },
  ],
  [
    ["import", "remove", "pdf"],
    { _tag: "import-remove", reference: "pdf", force: false, apply: false },
  ],
  [
    ["import", "remove", "personal-brain:pdf", "--force", "--apply"],
    { _tag: "import-remove", reference: "personal-brain:pdf", force: true, apply: true },
  ],
];

const scriptRows: Rows = [
  [
    [
      "script",
      "run",
      "team:nested-run",
      "--root",
      "/work",
      "--input-json",
      "{}",
      "--input-file",
      "input.json",
      "--input-stdin",
      "--quiet",
      "--timeout",
      "100",
    ],
    {
      _tag: "script-run",
      reference: "team:nested-run",
      request: {
        selector: { _tag: "bare" },
        root: "/work",
        inputJson: "{}",
        inputFile: "input.json",
        timeoutMs: 100,
        inputStdin: true,
        quiet: true,
      },
    },
  ],
  [
    ["script", "run", "run", "--user"],
    {
      _tag: "script-run",
      reference: "run",
      request: { selector: { _tag: "user" }, inputStdin: false, quiet: false },
    },
  ],
  [
    ["script", "run", "run", "--project", "demo"],
    {
      _tag: "script-run",
      reference: "run",
      request: {
        selector: { _tag: "project", projectName: "demo" },
        inputStdin: false,
        quiet: false,
      },
    },
  ],
  [
    ["script", "run", "run", "--cwd", "/work"],
    {
      _tag: "script-run",
      reference: "run",
      request: { selector: { _tag: "bare" }, cwd: "/work", inputStdin: false, quiet: false },
    },
  ],
  [
    ["script", "run", "run", "--user", "--project", "demo"],
    {
      _tag: "script-run",
      reference: "run",
      request: {
        selector: { _tag: "user" },
        targetConflict: true,
        inputStdin: false,
        quiet: false,
      },
    },
  ],
  [
    ["script", "run", "run", "--project", "demo", "--root", "/w"],
    {
      _tag: "script-run",
      reference: "run",
      request: {
        selector: { _tag: "project", projectName: "demo" },
        targetConflict: true,
        root: "/w",
        inputStdin: false,
        quiet: false,
      },
    },
  ],
  [
    ["script", "run", "report", "--user", "--", "--repo", "nclsndr/tack", "--json", "--quiet"],
    {
      _tag: "script-run",
      reference: "report",
      request: {
        selector: { _tag: "user" },
        words: ["--repo", "nclsndr/tack", "--json", "--quiet"],
        inputStdin: false,
        quiet: false,
      },
    },
  ],
  [
    ["script", "run", "run", "--timeout", "0"],
    {
      _tag: "script-run",
      reference: "run",
      request: { selector: { _tag: "bare" }, timeoutMs: 0, inputStdin: false, quiet: false },
    },
  ],
  [
    ["script", "run", "run", "--timeout", "-1"],
    {
      _tag: "script-run",
      reference: "run",
      request: { selector: { _tag: "bare" }, timeoutMs: -1, inputStdin: false, quiet: false },
    },
  ],
  [
    ["script", "run", "run", "--timeout", "1.5"],
    {
      _tag: "script-run",
      reference: "run",
      request: { selector: { _tag: "bare" }, timeoutMs: 1.5, inputStdin: false, quiet: false },
    },
  ],
  [
    ["script", "run", "run", "--timeout", "garbage"],
    {
      _tag: "script-run",
      reference: "run",
      request: {
        selector: { _tag: "bare" },
        timeoutMs: Number.NaN,
        inputStdin: false,
        quiet: false,
      },
    },
  ],
  [["script", "history"], { _tag: "script-history-list", limit: 20, offset: 0 }],
  [["script", "history", "--limit", "5"], { _tag: "script-history-list", limit: 5, offset: 0 }],
  [
    ["script", "history", "--limit", "100", "--offset", "0"],
    { _tag: "script-history-list", limit: 100, offset: 0 },
  ],
  [
    ["script", "history", "--limit", "1", "--offset", "35"],
    { _tag: "script-history-list", limit: 1, offset: 35 },
  ],
  [["script", "history", "list"], { _tag: "script-history-list", limit: 20, offset: 0 }],
  [["script", "history", "ls"], { _tag: "script-history-list", limit: 20, offset: 0 }],
  [
    ["script", "history", "list", "--limit", "5", "--offset", "2"],
    { _tag: "script-history-list", limit: 5, offset: 2 },
  ],
  [
    ["script", "history", "ls", "--limit", "1", "--offset", "35"],
    { _tag: "script-history-list", limit: 1, offset: 35 },
  ],
  [["script", "history", "show", runId], { _tag: "script-history-show", runId: runId }],
  [["script", "history", "clear"], { _tag: "script-history-clear", apply: false }],
  [["script", "history", "clear", "--apply"], { _tag: "script-history-clear", apply: true }],
];

const profileRows: Rows = [
  [
    ["profile", "export", "tools:ci", "/artifacts/ci.tar.gz"],
    { _tag: "profile-export", reference: "tools:ci", output: "/artifacts/ci.tar.gz", apply: false },
  ],
  [
    ["profile", "inspect-bundle", "/artifacts/ci.tar.gz"],
    { _tag: "profile-inspect-bundle", file: "/artifacts/ci.tar.gz" },
  ],
  [
    [
      "profile",
      "apply-bundle",
      "/artifacts/ci.tar.gz",
      "--project",
      "ci",
      "--target-root",
      "/repo",
      "--target-root",
      "/other",
      "--force",
      "--apply",
    ],
    {
      _tag: "profile-apply-bundle",
      file: "/artifacts/ci.tar.gz",
      targetRoots: ["/repo", "/other"],
      force: true,
      apply: true,
      namespace: { _tag: "project", projectName: "ci" },
    },
  ],
  [["check", "/artifacts/ci.tar.gz"], { _tag: "check", paths: ["/artifacts/ci.tar.gz"] }],
];

const machineRows: Rows = [
  [["doctor"], { _tag: "doctor" }],
  [["upgrade"], { _tag: "upgrade" }],
  [["upgrade", "status"], { _tag: "upgrade-status" }],
];

const refusals: ReadonlyArray<readonly [ReadonlyArray<string>, string, string]> = [
  [["docs", "search"], "missing-argument", "docs search"],
  [["docs", "search", ""], "missing-argument", "docs search"],
  [["docs", "search", "  "], "missing-argument", "docs search"],
  [["docs", "search", "x".repeat(513)], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--limit", "0"], "invalid-flag", "docs search"],
  [["init", "--adapter", "claude", "--adapter", "claude"], "invalid-flag", "init"],
  [["docs", "search", "owner", "--limit", "51"], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--limit", "-1"], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--limit", "1.5"], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--limit", "abc"], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--limit", "1", "--limit", "2"], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--tag", "a", "--tag", "b"], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--tag", "  "], "invalid-flag", "docs search"],
  [["docs", "search", "owner", "--port", "0"], "invalid-flag", "docs search"],
  [["docs", "--port", "0", "search", "owner"], "invalid-flag", "docs"],
  [["docs", "search", "owner", "--no-open"], "invalid-flag", "docs search"],
  [["docs", "--no-open", "search", "owner"], "invalid-flag", "docs search"],
  [["docs", "search", "query", "--config", "reader.json"], "invalid-flag", "docs search"],
  [["docs", "serve", "--open", "--no-open"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--port", "65536"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--port", "-1"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--port", "1.5"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--port", "abc"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--port", "nope"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--port", "1", "--port", "2"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--config", "a", "--config", "b"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--config", "reader.json"], "invalid-flag", "docs serve"],
  [["docs", "serve", "--no-open", "--no-open"], "invalid-flag", "docs serve"],
  [["docs", "attach"], "missing-argument", "docs attach"],
  // The kind flags are gone: --config declares a new source.
  ...(["--skills", "--commands", "--context", "--docs"] as const).map(
    (flag) => [["source", "add", "/brain", flag, "."], "invalid-flag", "source add"] as const,
  ),
  [["source", "add", "/brain", "--config", "{}", "--config", "{}"], "invalid-flag", "source add"],
  [["docs", "attach", "--source", source], "invalid-flag", "docs attach"],
  [["docs", "detach", "--source", source], "invalid-flag", "docs detach"],
  [["docs", "attach", "handbook", "--owner", "team"], "invalid-flag", "docs attach"],
  [
    ["docs", "configure", "--project", "demo", "--source", source],
    "invalid-flag",
    "docs configure",
  ],
  [
    [
      "docs",
      "configure",
      "--project",
      "demo",
      "--clear-default",
      "--default",
      "x",
      "--source",
      source,
    ],
    "invalid-flag",
    "docs configure",
  ],
  [["docs", "target", "--source", source], "invalid-flag", "docs target"],
  [["docs", "--project", "demo", "--project", "demo"], "invalid-selector", "docs"],
  [["docs", "list", "--project", "demo", "--project", "demo"], "invalid-selector", "unknown"],
  [["pick", "include"], "missing-argument", "pick include"],
  [["pick", "include", "alpha"], "invalid-selector", "pick include"],
  [["pick", "include", "maybe", "skill", "alpha", "--user"], "invalid-flag", "pick include"],
  [["pick", "include", "shared", "tool", "alpha", "--user"], "invalid-flag", "pick include"],
  [["pick", "include", "ada", "skill", "alpha", "--user"], "invalid-flag", "pick include"],
  [
    ["pick", "remove", "alpha", "--project", "workspace", "--user"],
    "invalid-selector",
    "pick remove",
  ],
  [["pick", "--project"], "missing-argument", "pick"],
  [["pick", "list", "--project"], "missing-argument", "unknown"],
  [["pick", "--project", "not valid"], "invalid-selector", "pick"],
  [["pick", "ls", "--project", "not valid"], "invalid-selector", "unknown"],
  [["pick", "--project", "w", "--user"], "invalid-selector", "pick"],
  [["pick", "list", "--project", "w", "--user"], "invalid-selector", "pick"],
  [["pick", "pin"], "invalid-command", "pick"],
  [["adapter", "enable", "windsurf"], "invalid-flag", "adapter enable"],
  [["adapter", "enable", "claude", "claude"], "invalid-flag", "adapter enable"],
  [["adapter", "enable", "cursor", "cursor"], "invalid-flag", "adapter enable"],
  [["adapter", "list", "cursor"], "invalid-flag", "unknown"],
  [["adapter", "disable"], "missing-argument", "adapter disable"],
  [["adapter", "disable", "windsurf"], "invalid-flag", "adapter disable"],
  [["adapter", "disable", "cursor", "--apply", "--apply"], "invalid-flag", "adapter disable"],
  [["adapter", "disable", "cursor", "--user"], "invalid-flag", "adapter disable"],
  [["source", "remove"], "missing-argument", "source remove"],
  [["source", "remove", "brain", "--project", "demo"], "invalid-flag", "source remove"],
  [["project", "remove"], "missing-argument", "project remove"],
  [["project", "remove", "demo", "--project", "demo"], "invalid-flag", "project remove"],
  [["status", "--project"], "missing-argument", "status"],
  [["status", "--", "--help"], "invalid-flag", "status"],
  [["state", "clean", "--apply", "--apply"], "invalid-flag", "state clean"],
  [["state", "clean", "--project"], "missing-argument", "state clean"],
  [["state", "reset", "--apply", "--apply"], "invalid-flag", "state reset"],
  [["state", "reset", "--project", "workspace"], "invalid-flag", "state reset"],
  [["state", "reset", "--user"], "invalid-flag", "state reset"],
  [["state", "reset", "--cwd", "/elsewhere"], "invalid-flag", "state reset"],
  [["state", "clean", "--pending", "--apply", "--apply"], "invalid-flag", "state clean"],
  [["state", "clean", "--pending", "--project"], "missing-argument", "state clean"],
  [["project", "refresh", "--apply", "--apply"], "invalid-flag", "project refresh"],
  [["project", "refresh", "--project"], "missing-argument", "project refresh"],
  [["project", "refresh", "--user"], "invalid-flag", "project refresh"],
  [["project", "inspect"], "invalid-command", "project"],
  [["sync", "--project"], "missing-argument", "sync"],
  [["sync", "--adapter"], "missing-argument", "sync"],
  [["sync", "--adapter", "cursor", "--adapter", "cursor"], "invalid-flag", "sync"],
  [["sync", "--adapter", "cursor", "--no-adapters"], "invalid-flag", "sync"],
  [["sync", "--adapter", "windsurf"], "invalid-flag", "sync"],
  [["sync", "--adapter", "claude", "--adapter", "claude"], "invalid-flag", "sync"],
  [["sync", "--apply", "--apply"], "invalid-flag", "sync"],
  [["sync", "--include-optional", "--include-optional"], "invalid-flag", "sync"],
  [["sync", "--require-capability"], "missing-argument", "sync"],
  [["sync", "--require-capability", "other"], "invalid-flag", "sync"],
  [
    ["sync", "--require-capability", "skill-links", "--require-capability", "skill-links"],
    "invalid-flag",
    "sync",
  ],
  [["sync", "--no-adapters", "--project", "Not A Name"], "invalid-selector", "sync"],
  [["source", "add"], "missing-argument", "source add"],
  [["source", "add", "/source", "--accept-identity-change"], "invalid-flag", "source add"],
  [["source", "add", "/source", "--scripts", "tools"], "invalid-flag", "source add"],
  [["source", "inspect"], "invalid-command", "source"],
  [["catalog", "--user"], "invalid-flag", "catalog"],
  [["explore", "--user", "--project", "demo"], "invalid-selector", "explore"],
  [["explore", "--details"], "invalid-flag", "explore"],
  [["import", "add"], "missing-argument", "import add"],
  [["import", "add", "a/b", "--all", "--skill", "pdf"], "invalid-flag", "import add"],
  [["import", "remove"], "missing-argument", "import remove"],
  [["script", "run", "shared", "skill", "report"], "invalid-flag", "script run"],
  [["script", "run", "shared", "skill", "run", "--user"], "invalid-flag", "script run"],
  [["script", "run", "other", "script", "run", "--user"], "invalid-flag", "script run"],
  [
    ["script", "run", "run", "--input-json", "{}", "--input-json", "{}"],
    "invalid-flag",
    "script run",
  ],
  [["script", "history", "clear", "--apply", "--apply"], "invalid-flag", "script history clear"],
  [["script", "history", "--limit", "0"], "invalid-flag", "script history"],
  [["script", "history", "--limit", "101"], "invalid-flag", "script history"],
  [["script", "history", "--limit", "1.5"], "invalid-flag", "script history"],
  [["script", "history", "--limit", "many"], "invalid-flag", "script history"],
  [["script", "history", "--offset", "-1"], "invalid-flag", "script history"],
  [["script", "history", "--offset", "2.5"], "invalid-flag", "script history"],
  [["script", "history", "--limit", "5", "--limit", "6"], "invalid-flag", "script history"],
  [["script", "history", "show"], "missing-argument", "script history show"],
  [["script", "history", "show", "id"], "invalid-flag", "script history show"],
  [
    ["script", "history", "show", "0B6A3C2E-7F1D-4C55-9A0E-5D1F2B3C4D5E"],
    "invalid-flag",
    "script history show",
  ],
  [
    ["script", "history", "show", "../../state/state.json-aaaaaaaaaaaaaaaaaaaaaaa"],
    "invalid-flag",
    "script history show",
  ],
  [["wat"], "invalid-command", "unknown"],
  [["wibble"], "invalid-command", "unknown"],
  [["--state-dir"], "missing-argument", "unknown"],
  [["choice", "wibble"], "invalid-command", "unknown"],
  [["choice", "list"], "invalid-command", "unknown"],
  [["wibble", "--help"], "invalid-command", "help"],
  [["choice", "wibble", "-h"], "invalid-command", "help"],
  [["reader"], "invalid-command", "unknown"],
  [["help"], "invalid-command", "unknown"],
  [["version"], "invalid-command", "unknown"],
  [["self", "status"], "invalid-command", "unknown"],
  [["--version", "extra"], "invalid-flag", "version"],
  [["sync", "--project", "workspace", "--user"], "invalid-selector", "sync"],
  [["sync", "--project", "workspace", "--all"], "invalid-selector", "sync"],
  [["sync", "--user", "--all"], "invalid-selector", "sync"],
  [["sync", "--project", "workspace", "--cwd", "/worktree"], "invalid-selector", "sync"],
  [["sync", "--user", "--cwd", "/worktree"], "invalid-selector", "sync"],
  [["sync", "--all", "--cwd", "/worktree"], "invalid-selector", "sync"],
  [["status", "--project", "workspace", "--user"], "invalid-selector", "status"],
  [["status", "--project", "workspace", "--all"], "invalid-selector", "status"],
  [["status", "--user", "--all"], "invalid-selector", "status"],
  [["status", "--project", "workspace", "--cwd", "/worktree"], "invalid-selector", "status"],
  [["status", "--user", "--cwd", "/worktree"], "invalid-selector", "status"],
  [["status", "--all", "--cwd", "/worktree"], "invalid-selector", "status"],
  [["state", "clean", "--project", "workspace", "--user"], "invalid-selector", "state clean"],
  [["state", "clean", "--project", "workspace", "--all"], "invalid-selector", "state clean"],
  [["state", "clean", "--user", "--all"], "invalid-selector", "state clean"],
  [
    ["state", "clean", "--project", "workspace", "--cwd", "/worktree"],
    "invalid-selector",
    "state clean",
  ],
  [["state", "clean", "--user", "--cwd", "/worktree"], "invalid-selector", "state clean"],
  [["state", "clean", "--all", "--cwd", "/worktree"], "invalid-selector", "state clean"],
  [
    ["state", "clean", "--pending", "--project", "workspace", "--user"],
    "invalid-selector",
    "state clean",
  ],
  [
    ["state", "clean", "--pending", "--project", "workspace", "--all"],
    "invalid-selector",
    "state clean",
  ],
  [["state", "clean", "--pending", "--user", "--all"], "invalid-selector", "state clean"],
  [
    ["state", "clean", "--pending", "--project", "workspace", "--cwd", "/worktree"],
    "invalid-selector",
    "state clean",
  ],
  [
    ["state", "clean", "--pending", "--user", "--cwd", "/worktree"],
    "invalid-selector",
    "state clean",
  ],
  [
    ["state", "clean", "--pending", "--all", "--cwd", "/worktree"],
    "invalid-selector",
    "state clean",
  ],
  [
    ["project", "refresh", "--project", "workspace", "--all"],
    "invalid-selector",
    "project refresh",
  ],
  [
    ["project", "refresh", "--project", "workspace", "--cwd", "/worktree"],
    "invalid-selector",
    "project refresh",
  ],
  [["project", "refresh", "--all", "--cwd", "/worktree"], "invalid-selector", "project refresh"],
];

const families = {
  docs: docsRows,
  sync: syncRows,
  status: statusRows,
  pick: pickRows,
  adapter: adapterRows,
  state: stateRows,
  project: projectRows,
  source: sourceRows,
  catalog: catalogRows,
  explore: exploreRows,
  import: importRows,
  script: scriptRows,
  profile: profileRows,
  machine: machineRows,
};

/** Labels each row with its command line, which names the generated test. */
const labelled = <Row extends readonly [ReadonlyArray<string>, ...ReadonlyArray<unknown>]>(
  rows: ReadonlyArray<Row>,
) => rows.map((row) => [row[0].join(" "), row] as const);

describe.each(Object.entries(families))("the %s grammar", (_family, rows) => {
  it.effect.each(labelled(rows))("parses `%s`", ([, [argv, invocation]]) =>
    Effect.gen(function* () {
      expect(yield* parseInvocation(argv)).toEqual({ invocation });
    }),
  );
});

it.effect.each(
  labelled([
    [["--state-dir", "/state", "state", "init"], { _tag: "state-init" }],
    [
      ["sync", "--cwd", "/elsewhere", "--state-dir", "/state"],
      {
        _tag: "sync",
        apply: false,
        cwd: "/elsewhere",
        includeOptional: false,
        noDocs: false,
        selector: { _tag: "bare" },
      },
    ],
    [
      ["--state-dir", "/state", "adapter", "disable", "codex", "--apply"],
      { _tag: "adapter-disable", adapter: "codex", apply: true, details: false },
    ],
  ] as const),
)("reads --state-dir before or after the command in `%s`", ([, [argv, invocation]]) =>
  Effect.gen(function* () {
    expect(yield* parseInvocation(argv)).toEqual({ invocation, stateDirectory: "/state" });
  }),
);

/**
 * Every refused command line with its code and the operation the error names, or `unknown` when
 * no operation was recognized. Help and version are root flags, never command words.
 */
it.effect.each(labelled(refusals))("refuses `%s`", ([, [argv, code, command]]) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(parseInvocation(argv));
    expect(error).toBeInstanceOf(InvocationError);
    expect({ code: error.code, command: error.command }).toEqual({ code, command });
  }),
);

it.effect.each(
  labelled([
    ...["/work/demo", "../demo", "not valid"].map(
      (value) =>
        [
          ["status", "--project", value],
          `Invalid value for flag --project: ${JSON.stringify(value)}. --project takes the name of a registered project, not a path. Run \`tack project\` to list the registered names.`,
        ] as const,
    ),
    ...["", "  "].map(
      (query) =>
        [
          ["docs", "search", query],
          "Give at least one search term: the docs search query is empty.",
        ] as const,
    ),
    [
      ["script", "run", "report", "stray", "--", "--name", "Ada"],
      'Unexpected argument "stray". Put the script\'s own arguments after --, such as: tack script run report -- --name Ada.',
    ],
  ]),
)("explains the refusal of `%s`", ([, [argv, message]]) =>
  Effect.gen(function* () {
    expect((yield* Effect.flip(parseInvocation(argv))).message).toBe(message);
  }),
);

it.effect.each(
  labelled([
    [[], []],
    [["--state-dir", "/state"], []],
    [["--help"], []],
    [["-h"], []],
    [["pick", "--help"], ["pick"]],
    [
      ["pick", "include", "--help"],
      ["pick", "include"],
    ],
    // Missing or conflicting operands do not hide the help of the command they target.
    [
      ["pick", "include", "-h"],
      ["pick", "include"],
    ],
    [["status", "--project", "demo", "--user", "--help"], ["status"]],
    [["docs", "--help"], ["docs"]],
    [["docs", "list", "--help"], ["docs"]],
    [["docs", "ls", "--help"], ["docs"]],
    [["explore", "--user", "--help"], ["explore"]],
    [
      ["docs", "serve", "--help"],
      ["docs", "serve"],
    ],
    [
      ["docs", "search", "--help"],
      ["docs", "search"],
    ],
    [
      ["upgrade", "status", "--help"],
      ["upgrade", "status"],
    ],
    [["--help", "sync", "--apply"], ["sync"]],
  ] as const),
)("asks for help on `%s`", ([, [argv, commandPath]]) =>
  Effect.gen(function* () {
    expect(yield* parseInvocation(argv)).toEqual({ invocation: { _tag: "help", commandPath } });
  }),
);

it.effect("keeps every public command path in agreement with the declared command tree", () =>
  Effect.gen(function* () {
    const operands = {
      "state-init": [],
      "source-add": ["/source"],
      check: ["/source"],
      "profile-save": ["/source", "ci", "--project", "demo"],
      "profile-adopt": ["tools:ci", "--user"],
      "profile-export": ["tools:ci", "/artifact.tar.gz"],
      "profile-inspect-bundle": ["/artifact.tar.gz"],
      "profile-apply-bundle": ["/artifact.tar.gz", "--project", "ci", "--target-root", "/repo"],
      "profile-apply": ["tools:ci", "--project", "ci", "--target-root", "/project"],
      "source-relocate": ["source-id", "/source"],
      "source-remove": ["brain"],
      "import-add": ["owner/repo"],
      "import-list": [],
      "import-remove": ["pdf"],
      "source-list": [],
      "project-add": ["workspace"],
      "project-list": [],
      "project-refresh": [],
      "project-remove": ["demo"],
      catalog: [],
      "pick-include": ["alpha", "--user"],
      "pick-exclude": ["alpha", "--user"],
      "pick-remove": ["alpha", "--user"],
      "pick-list": [],
      "adapter-enable": ["codex"],
      "adapter-list": [],
      "adapter-disable": ["codex"],
      sync: [],
      status: [],
      "state-clean": [],
      "state-clean-pending": ["--pending"],
      "state-reset": [],
      "docs-attach": [`${source}:handbook`, "--project", "demo"],
      "docs-detach": [`${source}:handbook`, "--project", "demo"],
      "docs-list": [],
      "docs-configure": ["--project", "demo"],
      "docs-target": [],
      "docs-serve": [],
      "docs-search": ["query"],
      "docs-icons": ["database"],
      doctor: [],
      explore: [],
      "script-run": ["report"],
      "script-show": ["report"],
      types: [],
      "script-history-list": [],
      "script-history-show": [source],
      "script-history-clear": [],
      upgrade: [],
      "upgrade-status": [],
      init: [],
      guide: ["onboarding"],
    } as const satisfies Record<
      Exclude<Invocation["_tag"], "help" | "version">,
      ReadonlyArray<string>
    >;

    for (const tag of Record.keys(operands)) {
      const path = commandDeclarations[tag].path;
      const { invocation } = yield* parseInvocation([...path, ...operands[tag]]);
      expect(invocation["_tag"], path.join(" ")).toBe(tag);
    }
  }),
);
