---
title: Queue uploads instead of streaming them in the request
type: decision
status: review
tags: [architecture, decision]
---

# Queue uploads instead of streaming them in the request

## Context

Large saves held a request open for minutes, and a store outage failed every save.

## Decision

The API records the version and enqueues an upload job. A worker uploads and marks the version uploaded.

## Consequences

- Saves return quickly whatever the store does.
- The queue becomes something to watch: a growing queue means the store is unhealthy.
