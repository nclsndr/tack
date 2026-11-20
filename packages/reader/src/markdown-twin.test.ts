import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const reader = fileURLToPath(new URL("..", import.meta.url));
const rspress = join(reader, "node_modules", ".bin", "rspress");
const config = join(reader, "fixtures", "markdown-twin", "rspress.config.ts");

let output: string;
let log: string;

/** Reads one file the build wrote. */
const built = (name: string) => readFile(join(output, name), "utf8");

// One Rspress build with Markdown twins of a page that uses the reader's figures.
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "tack-markdown-twin-"));
  const result = await promisify(execFile)(
    process.execPath,
    [rspress, "build", "--config", config],
    { cwd: reader, env: { ...process.env, TACK_MARKDOWN_TWIN_OUT: output } },
  );
  log = `${result.stdout}${result.stderr}`;
}, 120_000);

afterAll(async () => {
  await rm(output, { recursive: true, force: true });
});

describe("the Markdown twin of a page with reader figures", () => {
  it("carries each figure's text where the figure stands", async () => {
    const twin = await built("figures.md");
    expect(twin).toContain(
      [
        "Before the figures.",
        "",
        "",
        "````",
        "A release takes two steps",
        "",
        "1. Tag",
        "Tag the commit.",
        "",
        "2. Publish",
        "Publish the package.",
        "",
        "Current step: 1 of 2",
        "````",
        "",
        "",
        "````",
        "The worker writes events to the store",
        "Parts: worker, Postgres (store)",
        "worker -> Postgres: INSERT",
        "````",
        "",
        '```tree id="layout" title="The source keeps its skills in one folder"',
        "skills/",
        "  release/",
        "    SKILL.md",
        "```",
        "",
        "After the figures.",
      ].join("\n"),
    );
  });

  it("puts the page in llms-full.txt and keeps the figures in the HTML page", async () => {
    const full = await built("llms-full.txt");
    expect(full).toContain("The worker writes events to the store");
    expect(full).not.toContain("Something went wrong");
    const html = await built("figures.html");
    expect(html).toContain('class="tack-figure tack-walkthrough"');
    expect(html).toContain('class="tack-figure tack-system"');
    expect(html).toContain('class="tack-figure tack-file-tree"');
  });

  it("builds without a render error or a missing react-dom", () => {
    expect(log).not.toContain("is not defined");
    expect(log).not.toContain("react-dom not found");
  });
});
