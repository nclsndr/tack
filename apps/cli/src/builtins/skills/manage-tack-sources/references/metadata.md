# Resource metadata and dependencies in detail

The main skill says where Tack reads metadata and why a dependency may block a resource. This
reference holds the metadata keys and the rules that decide where a dependency edge resolves.

Skills and commands may carry Tack metadata in the `metadata.tack` YAML string of their
frontmatter:

```yaml
metadata:
  tack: |
    version: 1
    activation: opt-in
    user-activation: opt-in
    projects: [PROJECT]
    dependencies:
      - kind: skill
        name: git
      - kind: skill
        name: lint
        source: base-skills
        optional: true
```

`activation` sets default selection for projects and `user-activation` for the user. Both accept
`default` or `opt-in`; omitted, projects get `default` and the user gets `opt-in`. `projects` limits
default selection to the named projects and does not restrict the user. An explicit pick wins in
its own namespace. Context items carry no metadata: they are always opt-in, selected only by
`pick include`, and have no delivery adapter yet.

Dependencies are declared per resource, in `metadata.tack.dependencies`. `depends-on` in the
source's `tack.yaml` is the source-level allow list: a resource may always depend on its own
source, and on another source only when its source lists that source's label in `depends-on`. Declare the source relationship explicitly before adding a cross-source edge.
See [the worked source](worked-source.md) for matching declarations and skill frontmatter.

An edge names a `kind` (`skill` or `command`) and a `name`. These rules decide where it resolves:

1. A resource may depend on a resource in its own source.
2. It may depend on another source's resource only when its own source lists that source's label in
   `depends-on`.
3. An edge without `source` looks in its own source first, then in the declared sources. Several
   matches block the requester: add `source: LABEL` to the edge.
4. An edge with `source` must name its own source or a declared one.
5. A declared source that is not registered, or not healthy, blocks a required edge and skips an
   optional one. An unregistered source is `source-unregistered`: fix it with `tack source add`.
   While a registered source cannot be read, its label is unknown, so the reason is
   `source-unhealthy` and lists that source's path: fix it with `tack check <path>`.
