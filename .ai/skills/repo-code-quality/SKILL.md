---
name: repo-code-quality
description: Code quality rules for this repo - test-first loop, explicit comparisons, strict types, deriving facts instead of recomputing them, JSDoc, near-100% coverage. Use when writing, reviewing or editing TypeScript or tests here, and when one value or label is computed in two places.
---

# Code quality

All TypeScript and tests in this repo comply with these rules.

> Most code here is written by LLMs. The defence against silent regressions is twofold: the **strictest possible TypeScript** and the **best possible test coverage**. Both sections below are load-bearing, not aspirational.

## Explicit comparisons only

```typescript
// ✅
if (value === undefined)
if (value === null)
if (array.length === 0)
if (isEnabled === true)

// ❌
if (!value)
if (value)
if (!array.length)
if (isEnabled)
```

The lint config agrees: `typescript/no-unnecessary-boolean-literal-compare` is off and `eslint/no-underscore-dangle` allows `_tag`, so neither needs a suppression comment.

## Prefer declarative array transformations

Return the array transformation directly, never a synchronous `for` loop that populates a result array:

- Use `map` when every input produces one output.
- Use `filter` when selecting unchanged inputs.
- Use `flatMap` (or `filter` followed by `map`) when an input may produce zero or one output.
- Use `reduce` when folding many inputs into one accumulated value or structure.
- Keep a loop when iteration requires asynchronous sequencing, early termination, or state that cannot
  be expressed clearly as an array transformation.

```typescript
// ✅ — every artifact produces one result
return value.artifacts.map((artifact) => toResult(artifact));

// ✅ — only escaping artifacts produce violations
return value.artifacts.flatMap((artifact) =>
  escapesWorkdir(artifact)
    ? [{ gate: "paths-inside-workdir", message: `"${artifact}" points outside the workdir` }]
    : [],
);

// ✅ — many results folded into one summary
return results.reduce<{ passed: number; failed: number }>(
  (acc, result) => ({
    passed: acc.passed + (result.passed === true ? 1 : 0),
    failed: acc.failed + (result.passed === false ? 1 : 0),
  }),
  { passed: 0, failed: 0 },
);

// ❌ — imperative synchronous accumulation
const violations: GateViolation[] = [];
for (const artifact of value.artifacts) {
  if (escapesWorkdir(artifact) === true) {
    violations.push(toViolation(artifact));
  }
}
return violations;
```

## Type system

Core rules:

- Prefer `type` over `interface`
- Prefer `unknown` over `any` — `unknown` forces validation and prevents type leakage at boundaries
- No implicit `any` — TypeScript strict mode is enforced

Strict compiler options stay on (full set in `tsconfig.base.json`); `noUnusedLocals` and `noUnusedParameters` run in `tsc`, which CI gates, not just the linter.

### Let inference work, don't over-annotate

Annotating values that infer cleanly widens types and adds maintenance overhead.

```typescript
// ✅
const name = "Ada";

// ❌
const name: string = "Ada";
```

### Prefer `satisfies` over `as`

`satisfies` validates the value against a type **without** discarding the narrow inferred type. `as` silences the checker.

```typescript
// ✅ — values stay literal, shape still checked
const routes = { home: "/", about: "/about" } satisfies Record<string, string>;

// ❌ — widens, can mask mistakes
const routes = { home: "/", about: "/about" } as Record<string, string>;
```

Reserve `as` for genuinely unavoidable narrowing; each one is a smell.

### Derive types from values, never duplicate

Manual sync between runtime values and their types drifts over time. Derive instead.

```typescript
const roles = ["admin", "user", "guest"] as const;
type Role = (typeof roles)[number];
```

Use `as const` for config/constant objects so members keep their literal types.

### Model state with discriminated unions

Discriminated unions beat optional-property blobs and make future refactors compile-time errors.

In Effect modules, prefer `Match` for exhaustive dispatch. It provides compile-time exhaustiveness
without a `default` arm. Use the `switch` plus `const exhaustive: never` guard below for modules
that do not depend on Effect.

```typescript
type State =
  { status: "loading" } | { status: "success"; data: User } | { status: "error"; error: Error };

function render(state: State) {
  switch (state.status) {
    case "loading":
      return "…";
    case "success":
      return state.data;
    case "error":
      return state.error;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
```

### Type predicates for reusable narrowing

```typescript
function isUser(value: unknown): value is User {
  return typeof value === "object" && value !== null && "id" in value;
}
```

### Build types from existing types

Think transformations, not duplication: `Pick`, `Omit`, `Partial`, `Required`, indexed access, and template literal types (e.g. `` type Route = `/api/${string}` ``).

### Prefer literal unions over `enum`

Literal unions serialize cleanly, refactor easily, and avoid `enum` runtime surprises.

```typescript
const roles = ["admin", "user"] as const; // ✅  over  enum Role { Admin, User }
```

### Type-safe ≠ runtime-safe

TypeScript does **not** validate external data. `await response.json() as User` compiles and can still explode. Validate data at every runtime boundary (e.g. a schema check) — types end where untyped input begins.

## Derive, don't recompute

The runtime twin of _Derive types from values, never duplicate_, and the one that actually bites: **the same fact computed in two places from different inputs will drift** — as soon as something affects the fact and only one computation learns about it. Neither gate can catch it: both sides stay well-typed and fully covered while they disagree.

In order of preference:

1. **Delete one side.** Derive the fact from whatever already produces it — one computation cannot disagree with itself. Almost always available, almost always cheaper than it looks.
2. **If you genuinely cannot** (different lifecycles, a cache, an external shape you must mirror), make the agreement itself a test: one assertion comparing the two, over a fixture matrix wide enough to contain the case that will break it.
3. **Never** ship two computations guarded only by their own unit tests. Both keep passing while the answer is wrong.

### A name is a claim

`unused`, `complete`, `failed`, `total`, `count` each assert something. Check the inputs can guarantee the claim; if they cannot see everything that would falsify it, either derive the value from what can, or weaken the name.

For Tack, apply this to CLI results, package APIs, and install plans. For example, a plan's
summary must derive its counts and status from the same selected-skill results it displays.

Scope: mandatory in `apps/` and `packages/`. For scripts, keep a single source of truth for
reported values and assert any required duplicate representation in the script's test.

## JSDoc

Types live in TypeScript signatures — JSDoc documents intent, not shapes.

### When to write JSDoc

- **Exported functions** — always. Public API surface must be documented.
- **Internal functions** — only when the logic is complex enough that a short phrase saves a reader a trip through the implementation.

Skip JSDoc on trivial internal helpers (`const double = (n: number) => n * 2`).

### Document, don't re-type

Never repeat argument or return types in JSDoc. TypeScript already owns the contract.

```typescript
// ✅ — types in the signature; JSDoc explains behavior
/**
 * Resolves the effective locale for a document, falling back to the default
 * locale when the requested one is not published.
 */
export function resolveDocumentLocale(
  document: Document,
  requestedLocale: string,
): string { ... }

// ✅ — complex param/return: describe semantics, not shapes
/**
 * @param filters - Admin-panel query filters; relation keys are dot-paths (e.g. `author.name`).
 * @returns Populated entries keyed by document id; missing relations are omitted, not `null`.
 */
export function fetchEntries(
  uid: ContentTypeUID,
  filters: AdminFilters,
): Promise<Record<string, Entry>> { ... }

// ❌ — duplicates types TypeScript already enforces
/**
 * @param {string} requestedLocale
 * @returns {Promise<User>}
 */
export function loadUser(requestedLocale: string): Promise<User> { ... }
```

Use `@param` / `@returns` for **what** a value means or **how** it is interpreted — especially when the type alone is not enough (union semantics, optional behavior, invariants).

## Lint and format

The repo uses `oxlint` and `oxfmt`, configured at the root in `.oxlintrc.json` and
`.oxfmtrc.json`.

The `package.json` scripts list the commands (`check`, `format`, `lint`, `typecheck`).

- Run the relevant commands before committing, and `bun run check` when a change affects more than
  one quality gate.
- CI's `static` job also runs `bun run deadcode` (`knip`, configured in `knip.json`). It fails on a
  file nothing imports, an unused or unlisted dependency, an unresolved import, and an export or
  exported type that no other file imports. `check` does not run it, so run it after deleting or
  moving files or exports, or changing dependencies.
- Export only what another file imports. A helper that only tests need lives in a
  `*.test-support.ts` file next to the module it serves (for example `route.test-support.ts`), so
  production code never carries it; coverage skips those files.
- The configuration makes correctness and suspicious findings errors and enables type-aware linting.
- Suppress a lint rule only with `// oxlint-disable-next-line <rule> -- <reason>`; a suppression
  without a reason is a bug.

## Test-driven loop

The default implementation loop in this repo is test-first — **red → green → refactor**:

1. **Red** — write the test that expresses the intended behavior, then **run it and watch it fail**. A test that passes immediately means the test is wrong or the behavior already exists — stop and investigate before writing any implementation.
   - If you catch yourself having written the implementation before observing red, a green suite proves nothing. **Prove the tests bite**: mutate the implementation (invert a comparison, weaken an `every` to `some`, delete an early return) and confirm the _specific_ test you expect fails, then restore. Do this per non-obvious branch, not once for the file. Skipping red and then trusting green is the exact failure test-first exists to prevent.
2. **Green** — write the minimal implementation that makes it pass. This is "make it work".
3. **Refactor** — clean up under green tests. This is "make it great". "Make it fast" comes only after profiling shows a need.

Bug fixes follow the same loop: first a failing test that reproduces the bug, then the fix.

Why test-first and not tests-in-the-same-change: most code here is written by LLMs, and tests written after an implementation tend to assert what the code _does_, not what it _should do_ — coverage numbers cannot detect that inversion. A test written first encodes intent, and the coverage standard below becomes a byproduct instead of a chore.

Scope:

- **Mandatory** for production code in `apps/` and `packages/`, including thin adapters.
- **Exempt**: a short-lived exploratory spike. Promoting it into the product means restarting
  test-first. The spike is a draft of the specification, not the deliverable.

## Testing

Place tests beside or near the source they cover, with names that state the observable behavior.
Run them with `bun run test:unit`; measure coverage with `bun run test:coverage` when the change adds
meaningful branching or a new package boundary. It runs the same tests as CI's shards, in one process,
and enforces the same gate. Add `--coverage.reporter=html` to see which lines are uncovered. Do not pass
`--coverage` to `bun run test`: the flag only reaches its last command, the release system tests.

**Coverage must stay very close to 100%.** New code ships with tests in the same change. A drop in coverage is treated like a failing test.

The gate is an uncovered-items budget: `maxUncovered` in `vitest.config.mts` caps how many statements,
branches, functions and lines of production source (`apps/*/src`, `packages/*/src`, `evals/src`) may stay
uncovered, including files no test imports. CI's `coverage` job fails when any count exceeds it.
Keep the budget tight by hand:

- A change that lowers an uncovered count lowers the matching budget number by the same amount.
- Raising a number needs a stated reason in the PR.

### One home per tested rule

Each rule is asserted once per test level, in one home. A second test of the same rule at the same
level is duplication to delete, after naming the test that still asserts it.

1. A schema or codec rejection is asserted once, in the schema or codec test of its domain module
   (`domain/**/*-schema.test.ts`, `domain/state/state-codec.test.ts`). A feature test does not
   re-assert it.
2. A store failure mode (busy lock, corrupt file, nothing mutated) is asserted in
   `platform/state/state.test.ts` and `services/exclusive-lock.test.ts`. A feature keeps at most one
   wiring test that the failure reaches its outcome.
3. A caller's test uses one representative input of the callee's matrix and asserts what the caller
   adds: selector resolution, classification, rendering. It does not re-run the callee's cases.
4. Two tests that differ by one literal or one fixture slot are one `it.each` table.
5. Fixtures and fakes come from the shared support modules. A new local `withFixture`, skill-text
   builder, `evidenceFor`, process spawner or host harness is a review rejection.
6. A test enters through the function production calls. A function that only tests call is deleted,
   not tested.

### Test support

Shared test code lives in two places, and nowhere else:

- `apps/cli/test/support/` holds the CLI's shared support modules: the process runner
  (`tack-process.ts`), the in-process host runner (`host-runner.ts`), the source-tree builder
  (`source-tree.ts`: `write`, `skillText`, `seedSource`), state and link-evidence builders
  (`state-fixture.ts`: `withStateFixture`, `evidenceFor`), file-system faults and stalls
  (`faults.ts`), the Git fake (`fake-git.ts`) and the live test layer (`live-test-layer.ts`). Extend
  the module that owns a helper instead of copying it into a test file.
- A helper that only one module's tests need lives in a `*.test-support.ts` file beside that
  module, as § _Lint and format_ says.

Coverage is necessary, not sufficient: it measures whether a line ran, never whether two answers agree. When a change leaves two places responsible for one fact, the test that matters is the one comparing them — see § _Derive, don't recompute_.

The only acceptable uncovered code is code that is genuinely impractical to exercise — e.g. a technical choice or a setup too complex/costly to reproduce (permission failures, immutable filesystem, unreachable defensive branches). Every such gap **must** be:

1. Annotated with the coverage tool's smallest supported ignore directive around the minimal region.
2. Preceded by a one-line rationale comment explaining **why** it is skipped.

Example:

```typescript
// Coverage skip: the process termination path cannot run in the test process.
/* v8 ignore next -- @preserve */
process.exitCode = 1;
```

The v8 provider only reads directives that start with `v8`, `c8`, `istanbul` or `node:coverage`; keep
`-- @preserve` so the transform does not strip the comment.

A skip without a real rationale is a bug, not a passing test.
