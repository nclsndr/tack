# Decisions and non-goals

The current shape comes from one restructuring, recorded with its design questions in
[pull request #65](https://github.com/nclsndr/tack/pull/65). Its cause: the layers held, but each new
capability was built beside the existing ones rather than through them, so a command was wired in up
to seven places joined by strings, and "project or user" was resolved in nine places with three
wordings for one refusal. The rule it left: **add a capability through the existing structure, not
beside it.** Structure and readability come before line count.

## Decisions to keep

- **One declaration per command, and only the declaration.** A row holds the payload schema of each
  slot, plus a path or mode only where they cannot be derived. Routes and views stay in their own
  tables that the compiler checks against the tags. Putting the route in the row moves lines without
  removing any; putting the view there would make `commands` import `human` and break the `cli` order.
- **A failed payload decode falls back to the generic view.** It is not a defect: a defect would turn
  a successful `--json` run into an internal error. Drift is caught by the decode tests instead.
- **The mode is read from the slots,** with an explicit mode for the three commands it misreads. The
  help map still names each mode by hand, and its test compares the two, so a command that writes at
  once but carries a plan cannot silently become preview-and-apply.
- **A tag spells its command path.** The operator's word names the tag, the family files and the
  route table. A path is declared only for `state clean --pending` and the hyphenated profile words.
- **One refusal for a bare selector outside every project.** `bareSelectionRefusal` names the flags
  each command accepts. Target selection returns the selector it resolved beside the one requested;
  only the requested one reaches `--json`.
- **One target shape is reused, not unified.** `ManagedTarget` reuses `ManagedLinkTarget`. A new
  `Target` type beside the stored schemas would add a shape; `RunTarget` is its own persisted contract
  and `AgentLayoutTarget` stays narrow because `domain/links` imports `domain/agents`.
- **A module's folder is what it is, not who calls it.** `envelope` holds the public envelope and
  every mapping onto it, failures and successes alike; `routes` holds only routes.
- **The explorer runs the commands' use cases.** It checks its whole batch before the first write and
  refuses what `pick` refuses, in its preview as well as on apply.
- **A use case that spans several features gets its own folder.** `source add` lives in
  `features/registration`, because `features/sources` is a leaf that many folders read and the flow
  needs the snapshot, which imports `sources`. `source remove` sits in `features/removal` for the
  same reason.
- **A pending link journal is an input to the profile preflight.** `recoverAfterPreflight` recovers
  it only after the plan passes; it is not folded into `previewOrApply`, whose callers recover
  before they plan.

## Weighed and declined

| Idea                                                   | Why not                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The state location as an Effect service                | It is read at render time, in the error handler and by `docs serve` after the route returns. A forgotten provide would replace an argument that cannot be forgotten. `StateOptions` carries one directory value instead. |
| One plan type for agent links and docs mounts          | The two differ in meaning (docs has no adapter, `keep` has no agent counterpart), and it would reshape `sync`, `status` and removal `--json`. Only the lossless field renames were taken.                                |
| One list of every diagnostic code                      | It adds a large module and a runtime failure for a code built from a template. Worth doing as its own change before a stable release.                                                                                    |
| One shared YAML parser for the CLI and `packages/core` | It needs an exception to the layer rule or a new package; a contract test (`yaml-parsers-agree`) guards the two copies.                                                                                                  |
| Generating the help map or wrapping `Command.make`     | The help map's hand-written modes are the check on the derived ones.                                                                                                                                                     |

## Non-goals

These stay out unless a concrete problem asks for them:

- splitting long files for length alone;
- re-cutting the CLI by capability instead of by layer;
- porting the docs reader to Effect;
- a service in front of `FileSystem`;
- fewer tests, or a looser coverage budget, to make a change fit.
