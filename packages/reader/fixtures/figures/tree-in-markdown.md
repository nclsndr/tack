---
title: A tree in plain Markdown
type: reference
status: draft
---

# A tree in plain Markdown

The same fence draws a `FileTree` in a `.md` document as in an `.mdx` one.

```tree id="docs-on-disk" title="A docs resource is a folder the reader serves as it is"
handbook/
  tack.yaml                 # declares the docs resource [key]
  docs/
    index.md                # the landing page
    guide.mdx               # may import components
    _drafts/                # left out of the reader [temp]
  latest -> docs/index.md   # a link the reader resolves
```
