---
title: Atlas, a file-sync service for small teams
type: explanation
status: accepted
tags: [overview, onboarding]
---

# Atlas, a file-sync service for small teams

Atlas keeps one shared folder in step across a team's laptops. A desktop client watches the folder, uploads what changed and pulls what others changed. This page is the map; every other page goes deeper on one part.

## What is in this documentation

| Page                                            | Question it answers                                 |
| ----------------------------------------------- | --------------------------------------------------- |
| [Architecture](./architecture/overview.mdx)     | Where does code belong, and what may call what?     |
| [Request path](./architecture/request-path.mdx) | What happens between a save and every other laptop? |
| [Schema](./data/schema.mdx)                     | Which tables exist, and who may write them?         |
| [Onboarding](./guides/onboarding.mdx)           | How does a new engineer get a working setup?        |

## The repository on disk

```tree id="atlas-repo" title="The client, the server and the docs live in one repository"
atlas/
  tack.yaml                 # declares the docs resources [key]
  client/
    src/
      watcher.ts            # turns file events into upload jobs
      sync.ts
  server/
    src/
      api/                  # route handlers
      workers/              # queue consumers
    migrations/
  docs/                     # this documentation
  .cache/                   # never committed [temp]
  current -> docs/about.md  # what the reader opens first
```

## Ground rules

- A file is never lost: an upload is kept until the object store confirms it.
- The server never trusts a client clock; it stamps every change itself.
- Conflicts keep both copies, renamed, instead of picking a winner.

1. Read the architecture first.
2. Then follow one save through the request path.

- [x] Desktop client for macOS
- [x] Upload queue with retries
- [ ] Desktop client for Linux

```ts
// client/src/watcher.ts — every change becomes one idempotent job
export function toJob(event: FileEvent): UploadJob {
  return { path: event.path, digest: event.digest, attempt: 0 };
}
```

> Atlas is a fake project. These pages exist to exercise every part of the Tack reader.
