# @tackup/website

The Tack landing page and public docs, in one [Rspress](https://rspress.rs) 2.1 site, served at
https://tackup.dev. It is a private workspace package: it is deployed, never published to npm.

```sh
bun run website:dev     # local dev server
bun run website:build   # static site in apps/website/dist
```

## Layout

| Path                       | Content                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `docs/index.tsx`           | The landing page, a custom TSX route without the docs chrome               |
| `docs/docs/*.mdx`          | The docs pages                                                             |
| `docs/public/`             | Static files: illustrations, favicon, `robots.txt` and the `_headers` file |
| `components/landing/`      | Landing sections, copy (`content.ts`), its Markdown twin and the mark      |
| `components/site.ts`       | The site's origin and the canonical address of each page                   |
| `components/llms-txt.ts`   | How `llms.txt` lists the pages, the landing page first                     |
| `components/audience.tsx`  | `<Agent>` and `<Human>`                                                    |
| `components/terminal.tsx`  | `<Terminal>`, a command and its output in a terminal frame                 |
| `styles/tokens.css`        | Brand tokens: the only file to change for a new palette, type or corners   |
| `functions/_middleware.ts` | The Cloudflare Pages Function for `Accept: text/markdown`                  |

## Writing docs for people and agents

Every build writes `llms.txt`, `llms-full.txt` and a Markdown twin beside each HTML page, such as
`docs/getting-started.md` beside `docs/getting-started.html`. Their links are absolute, on the
site's origin, so they still lead somewhere when an agent keeps the text without its address. The
landing and features pages write their twins in `markdown.ts` beside their copy, with the facts their
figures draw.

- `<Human>` content appears only in the HTML page.
- `<Agent>` content appears only in the Markdown twin and the `llms` files.
- `<Terminal commands={[...]} output="...">` draws a terminal window in HTML and a `text` fence in
  Markdown. Keep multi-line output with leading spaces in an `export const` at the top of the MDX
  file: MDX strips indentation inside JSX attribute expressions.

## Illustrations

Only optimised web assets are committed: AVIF and WebP at 768, 1280 and 1916 px for the story
plate, `hero-saddle`. The source PNGs stay outside the repository, and no illustration has baked-in text. The one screenshot, `docs-reader` at 640 and 1280 px, is the real
docs reader serving the Atlas example (`bun run reader:example`).

## Hosting on Cloudflare Pages

The site deploys through a Cloudflare Pages project connected with the Git integration. Each push to
`main` deploys to production. Each pull request from a branch of this repository gets a preview
deployment; Cloudflare builds no preview for pull requests from forks, as its
[preview deployments](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
documentation describes. The project builds with `bun install --frozen-lockfile && bun run build`,
with `apps/website` as the root directory and `dist` as the output directory, so Pages also picks up
`functions/`.

- `docs/public/_headers` serves `.md` files as `text/markdown` and sets `Vary: Accept`.
- `docs/public/robots.txt` lets every crawler read every page and names the sitemap. Keep
  Cloudflare's managed `robots.txt` and its AI crawler block off for the zone: either one would
  replace or prepend rules that shut agents out.
- `functions/_middleware.ts` answers a request whose `Accept` header names `text/markdown` with the
  page's Markdown twin, so `curl -H 'Accept: text/markdown' https://<site>/docs/getting-started`
  returns Markdown while browsers keep getting HTML.
