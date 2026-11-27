# Layers and import order

The rules live in `apps/cli/test/architecture-boundaries.repo.test.ts`: `layerImports`,
`cliFolders` and `packageImports` hold the order, and the comments above them give each layer's
purpose. Read them there; this page says which test guards what, and how to read a failure.

## What each test asserts

| Rule                                                                  | Test (in the boundary file)                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| Every module sits in a layer, `release.ts`, `version.ts` or `main.ts` | `keeps every module in a named layer`                         |
| An import points down the layer list or stays in its layer            | `imports only downward`                                       |
| `@effect/platform-*` is imported only in `bootstrap`                  | `keeps Effect platform imports inside bootstrap`              |
| `@tackup/reader` and `@tackup/core` entries per layer                 | `imports the reader and core packages only from the layers …` |
| The folders of `domain` and of `features` form no cycle               | `keeps the %s folders a directed acyclic graph`               |
| `cli` folders import only the folders before them                     | `orders the cli folders`                                      |
| No text view imports `cli/human/render.ts`, the registry of views     | `keeps the text views below their registry …`                 |
| The state document is read only through the command snapshot          | `reads the state document only through the command snapshot`  |
| `cli/commands` never imports `platform`                               | `keeps CLI command declarations independent from platform …`  |
| One function builds a resource identity key                           | `builds a resource identity key in one place …`               |
| No new `throw`: failures go through the Effect error channel          | `adds no throw`                                               |
| A service identifier spells its declaring module's path               | `names every service identifier after the path …`             |

## Reading a failure

- **A cycle between two `domain` or `features` folders** means a file sits in the wrong folder.
  Move the file to the folder that owns its concept; do not merge the folders. A plan, report or
  result schema that one feature produces moves beside that feature.
- **An upward import in `cli`** means the module belongs lower. A text view goes to `human`, a
  mapping onto the public envelope goes to `envelope`. Place a module by what it is, never by who
  calls it.
- **A view that imports `render.ts`** closes a cycle through every view, because the registry
  imports them all. Take the `HumanView` types from `cli/human/human-view.ts` instead.
- **A feature that needs a CLI command line** takes it as a parameter, as `pickChoice` in
  `features/choices/pick.ts` takes the user exclude command. A feature never imports `cli`.
- **A new workspace package entry** fails until it gets a row in `packageImports`.
- **A new `throw`** fails the count. Return a typed failure instead; a plain function outside
  Effect (a codec, the script worker) raises the count with a reason in the same commit.

## Services

The comment above `layerImports` holds the service rule: add a `Context.Service` only to replace an
external action in tests, to choose a live implementation, or to share a resource lifecycle. Name it
for the feature's intent, keep it small, and put no generic infrastructure or file-operation service
in front of `FileSystem`. A service a feature implements itself, such as `Source`, keeps its tag and
live layer in that feature. `services/exclusive-lock.ts` is the one implementation in `services`.
