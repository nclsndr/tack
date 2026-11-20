---
title: On-call handbook
type: reference
status: active
tags: [operations]
---

# On-call handbook

## When the upload queue grows

1. Check the object store's status page.
2. If the store is healthy, restart one upload worker and watch the queue drain.
3. Never delete queued jobs: each one is a version a teammate saved.

## Escalation

Page the storage owner when the queue has grown for more than fifteen minutes.
