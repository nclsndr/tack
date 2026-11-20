# Tack agent evals

Internal Docker-only experiments through existing Claude Code and Codex subscriptions. This directory is a private Bun workspace, never a Tack release dependency. Root checks include its TypeScript and fake-agent tests; ordinary checks never call a model or require Docker login.

## Build and sign in

Run from the Tack checkout. Docker Desktop must be running. The image pins Bun 1.4.2, Claude Code 2.1.322 and Codex 0.167.1. The image builds the Linux release with the normal release builder; its final stage has no CLI implementation checkout, task definitions, graders, host state or credentials.

```sh
bun run evals image
bun run evals auth claude
bun run evals doctor --suite /absolute/path/index.ts
```

`doctor` proves container containment on the suite's first task. The checkout's own suite, `tasks/index.ts`, holds one neutral example task, `report-version`, which exercises the harness rather than a Tack behaviour.

Codex is paused: `doctor <campaign.json>` checks only that campaign's drivers, so a campaign that selects only Claude needs no Codex sign-in. The Codex driver, image install and auth checks stay in place. It takes one prompt and enforces neither a turn nor a budget limit, so the planner refuses a Codex trial whose task sends follow-up messages or whose limits set `maxTurns` or `budgetUsd`. To use Codex, run `bun run evals auth codex` and add a `{ "driver": "codex", "model": "gpt-6-luna", "effort": "low" }` profile to a campaign. `doctor` without a campaign still checks every driver.

The operator completes each CLI's own sign-in with the existing subscription. Claude prints its own sign-in URL; open it in a browser and return the resulting code to the container terminal if the callback cannot connect. This is the [official manual login flow](https://support.claude.com/en/articles/14552646-troubleshoot-claude-code-installation-and-authentication). Codex uses device authentication. Each command runs inside Docker and persists only in `tack-evals-auth-claude` or `tack-evals-auth-codex`. Never copy host auth files, use the macOS keychain, set API keys, or create a separate account for these runs. The CLI detects subscription mode before inference. `auth` and live runs share a per-CLI container name lock, so concurrent refreshes are refused. A failed sign-in is not a failed Tack task.

There is no scheduler. Build, sign-in and campaigns happen only on an explicit operator command. A subscription's allowance is not a token balance. The runner cannot infer remaining allowance or promise a hard dollar/token cap.

## Plan and run

Write a campaign JSON outside the checkout. Only `seed` and `profiles` are required:

```json
{
  "seed": 42,
  "profiles": [{ "driver": "claude", "model": "sonnet", "effort": "low" }],
  "repetitions": 1,
  "limits": { "trials": 12, "budgetUsd": 3 },
  "families": { "example": { "budgetUsd": 0.15 } },
  "tasks": {
    "report-version": { "profiles": [{ "driver": "claude", "model": "haiku", "effort": "low" }] }
  },
  "arms": [
    { "id": "baseline" },
    {
      "id": "short-guide",
      "prompt": { "harness": "getting-started" },
      "skills": { "use-tack/references/onboarding.md": { "file": "onboarding.md" } }
    }
  ],
  "stages": [
    { "id": "smoke", "tags": ["smoke"], "arms": ["baseline"] },
    { "id": "full", "repetitions": 3 }
  ]
}
```

```sh
bun run evals list
bun run evals plan /absolute/path/campaign.json --stage smoke
bun run evals run /absolute/path/campaign.json --stage smoke
```

- **Baseline.** A trial's first user message is the task's harness prompt from `@tackup/harness/prompts/evals` (`task`, the task's own request, unless the task names another such as `getting-started`). The agent's system prompt gets the harness environment frame: its one tool, the task's working directory and the delivered skills, each with its front-matter description and path, as a native skill listing shows them. The delivered skills are the image's shipped built-ins, unchanged.
- **Arms** override the baseline. `prompt` is `{ "harness": name }`, `{ "text": ... }` or `{ "file": path }`; text may use `{{request}}` and `{{cwd}}`. `skills` maps a path under the built-ins' `skills/` folder to `{ "text" }` or `{ "file" }`, replacing that file or adding it. A relative `file` resolves against the campaign file's folder. The plan inlines every file's bytes, so the confirmation token, the trial record and the evidence carry the exact text and its SHA-256. Without `arms`, the campaign runs one `baseline` arm.
- **Profiles.** `profiles` is the campaign default; a stage's `profiles` replaces it for that stage, and `tasks.<id>.profiles` replaces both for one task. Model IDs and effort pass unchanged to the native CLI; a campaign file does not prove account availability.
- **Stages, tags and filters.** A stage selects tasks by `taskIds` or `tags`, or every task when it names neither, with its own `arms`, `profiles` and `repetitions`. Without `stages`, the campaign is one stage, `all`. `--stage`, `--tag` and `--task` narrow `plan`, `run` and `doctor` further; each repeats or takes a comma-separated list. The filters change the trials, so they change the confirmation token: pass the same ones to `plan` and `run`.
- **Limits.** Each task belongs to a suite family whose limits apply to its trials: `wallSeconds`, `toolCalls`, `outputBytes`, and optionally `maxTurns` and `budgetUsd`, which Claude enforces through `--max-turns` and `--max-budget-usd`. A campaign's `families` changes those limits for its run. `limits` caps the campaign: `trials` (default 12, at most 200), `wallSeconds` (default: the trials' wall time plus 120 s each) and `budgetUsd`. Once the reported spend reaches `budgetUsd`, the remaining cells stay unstarted; a trial that reports no cost is charged its own `budgetUsd`. A trial its turn or budget limit stops ends `limit-reached`: it is scored, and it fails. Each limit has a ceiling (`wallSeconds` 3600, `toolCalls` 500, `maxTurns` 500, `budgetUsd` 50, `outputBytes` 64 MiB) so a typo cannot plan an unbounded trial.
- **Follow-up messages.** A task's `followUps` are sent in order, each after the agent's previous answer; the input closes after the last one or after a failed turn. They are fixed: no responder reads the agent's reply, so write each one to stand whatever the agent asked.

`plan` is the dry run. It resolves the immutable Docker image, native CLI versions, compiled Tack version, complete task-code digest and full matrix, then prints every trial (stage, task, profile, arm, seed, prompt source and digest, skill overrides, user turns and limits), an estimate and the confirmation token. It performs no login, inference, fixture setup or Tack state mutation. `--json` prints the plan as JSON instead. The estimate is an uncalibrated 30k–150k input tokens per user turn, the sum of the per-trial budgets and the campaign budget. Subscription allowance depletion is unknown, and API-equivalent USD is not subscription allowance.

`run` prints that plan again and asks the operator to type its confirmation token. A noninteractive explicit order uses `--confirm <token>`. A missing or stale token refuses all launches. `--output` accepts a new absolute directory outside the checkout; by default a private temporary directory is retained. No previous answer is silently reused or treated as a fresh sample.

One trial runs at a time, with no automatic retries or fallback models. Paired repetitions share seeds and alternate arm order. All fixtures and independent oracle solutions must pass before the first paid trial; an arm that changes the built-in skills gets its own oracle proof. Run the cheap stages first: a `smoke` stage on one task and one arm, then the full stages once it passes, each planned and confirmed on its own. Pass `--codex-sandbox off-in-container` to both `plan` and `run` only when that mode is required.

## Isolation and evidence

Each trial uses two containers. The task container mounts only a fresh synthetic `/world`, has no network, a read-only root filesystem, dropped Linux capabilities, process/memory/CPU limits, and controlled HOME/Tack/XDG/Git state. The control container holds the native CLI and its eval-only auth volume. Native execution and unrelated agent integrations are disabled. Its only task tool is a small stdio MCP relay to the runner's authenticated command endpoint. That endpoint accepts bounded argv and contained cwd only, then executes in the already selected task container. It never runs an agent-supplied host command, mounts the Docker socket, or exposes graders/results. The trusted MCP bridge is an explicit exception to the early proposal's no-MCP restriction; no external MCP server is enabled.

Docker Desktop must resolve `host.docker.internal` from the agent container. The host bridge uses an ephemeral port and a random 256-bit bearer token, is closed after the trial, and does not expose credentials. Task subprocesses cannot reach it because their container has network `none`. Agent tools cannot inspect the control container's auth. The runner's Docker control process needs the host Docker context, but forwards no provider environment secrets to either container.

Containment probes use synthetic files only. Every task container verifies permitted fixture writes, denied image writes, unavailable host socket/source/auth, and denied outbound transport before preparation. Native permissions are defense in depth; the separate task container enforces command containment. All task descendants, including background jobs, are stopped before grading, then the clean container is restarted for trusted observations. SIGINT/deadlines stop launches and preserve unstarted cells. Unexpected host crashes leave inspectable partial files and never resume a conversation automatically; remove a stale eval lock container only after inspecting ownership and confirming its process has stopped.

The result directory retains the manifest, each trial envelope, the image's shipped built-ins, each fixture with its delivered built-ins, prepared public facts, the agent input (system frame and every user message), trusted command evidence, raw native JSONL, stderr and a Markdown report. It never copies auth volumes into artifacts. Keep this directory private: prompts/transcripts can contain fixture data. Each record identifies model requests, observed model when reported, native versions, immutable image, compiled Tack build, complete suite digest, seed, arm, the SHA-256 of the prompt template, each sent message, the system frame, each skill override and each delivered file, and enforcement. Unknown usage is never zero. Codex input already includes cached input; Claude's uncached/read/write cache categories are normalized to total input. Final authoritative usage avoids duplicate assistant-record counting. Claude reports one result per user turn; usage, cost and native turns are summed over them. If Claude reports them cumulatively, the sum overstates spend, which keeps the campaign budget conservative: check this on the first live multi-turn smoke. CLI API-equivalent cost is not subscription depletion.

```sh
bun run evals report /absolute/path/saved-campaign
bun run evals regrade /absolute/path/saved-campaign
```

Regrading starts only a networkless task container on the retained world with the original image and suite digest. It never calls a model or logs in. It writes separate `regraded.json` and `regraded.md`; original records remain intact. Required criterion failures or any invariant violation fail a task even when the native process exited zero. Infrastructure failures and unstarted cells are excluded. Every result remains visible; one pair is only a smoke signal. Use at least three fresh paired repetitions before drawing tentative comparisons.

## Extend and verify

See [CONTRACT.md](CONTRACT.md) and [src/contract.ts](src/contract.ts) for the versioned task interface. A suite exports `suite` from `tasks/index.ts`; reviewed local development suites can use `--suite /absolute/path/index.ts`. Never load downloaded task code or an agent-authored grader. Tasks and graders have no provider imports. Add OpenCode or Pi by implementing the `AgentDriver` contract in `src/drivers.ts`, supplying verified native login/launch behavior, event normalization, its capabilities and containment checks. Do not assume they report usage or native turn limits.

```sh
bun run check
bun --bun vitest run evals
```

Provider flags were verified against the pinned CLIs' help. The [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) describes shell-tool and integration settings; the [official MCP reference](https://learn.chatgpt.com/docs/extend/mcp) describes stdio servers and tool policies. Model availability belongs to the operator's account; an unavailable explicit model fails visibly.

Real acceptance requires one successful container trial for each signed-in CLI. Fake-process tests, config probes and container relay tests do not count as these acceptance smokes. Do not merge before both pass.

The runner copies the selected image's built-ins once per campaign, applies the trial arm's skill overrides to a per-fixture copy and mounts it read-only twice in the task container: at `/instructions`, for the agent to read, and over `/opt/tack/builtins`, so that `tack` itself links the same files. It creates no instruction files inside `/world`, so the instructions do not change the logical fixture snapshot. Every delivered file receives a SHA-256 digest in the trial evidence.

Native Codex sandboxing remains the default. When Docker's namespace policy prevents that native sandbox from starting, an operator can explicitly choose `--codex-sandbox off-in-container` for one campaign. Pass that option to both `plan` and `run`; the mode is displayed and bound to the confirmation token. `doctor` accepts the same option. Only Codex's eval-container invocation receives its documented sandbox-bypass flag. It is never written to the host, the operator's normal CLI configuration, or a persisted eval config. The next invocation defaults to native sandboxing again.

In this opt-in mode, Docker is Codex's isolation boundary. Codex's own filesystem/network restrictions are disabled inside its control container, which contains the CLI runtime, scratch storage and the eval-only auth volume. This broadens what Codex can access inside that container. Docker's default seccomp filter, read-only root, dropped capabilities, no-new-privileges and resource limits remain; no privileged mode, extra capability, host sysctl, Docker daemon change or host config edit is used. Task commands still execute only in the separate networkless task container, with no host home, credentials, graders or Docker socket mounted. Shell, browser, app and subagent integrations remain disabled. The no-model preflight validates the selected mode without mounting auth.

The eval image records each Tack process inside a tool call, including expanded argv, cwd, exit code and output before pipeline truncation. Tool calls still count bridge requests, not the Tack processes inside them. Budget denials distinguish tool-call exhaustion, command-output exhaustion and a busy command; the report also records native transcript-output exhaustion separately. Login shells retain /opt/tack/bin through the image profile.
