import { describe, expect, it } from "vitest";
import { links as tackLinks } from "../../fixtures/figures/cli-imports.ts";
import { issueLine } from "./issues.ts";
import {
  architectureBudget,
  architectureReadable,
  focusOf,
  readArchitectureMap,
  tierUses,
} from "./architecture-map-model.ts";
import {
  architectureLayoutIssues,
  columnWidth,
  drawingFontSizes,
  expandedWidth,
  layoutArchitecture,
} from "./architecture-map-layout.ts";

const tierNames = {
  bootstrap: "Process",
  cli: "CLI",
  features: "Features",
  platform: "Platform",
  services: "Services",
  domain: "Domain",
} as const;

/** The Tack CLI map: every id of the generated links, grouped into its tier by prefix. */
function tackProps(overrides: Readonly<Record<string, unknown>> = {}) {
  const ids = [...new Set(tackLinks.flatMap((link) => [link.from, link.to]))].toSorted();
  const tier = (id: keyof typeof tierNames) => ({
    id,
    label: tierNames[id],
    path: id === "bootstrap" ? "bootstrap/" : `${id}/`,
    nodes: ids
      .filter((node) => node.split("-")[0] === id)
      .map((node) => ({
        id: node,
        label: node.replace("-", "/"),
        ...(id === "platform" || id === "cli" ? { detail: "adapter" } : {}),
      })),
  });
  return {
    id: "cli-architecture-map",
    title: "A feature and a platform adapter never import each other",
    rule: { title: "Imports point down", text: "An import points down the map." },
    tiers: [
      tier("bootstrap"),
      tier("cli"),
      [tier("features"), tier("platform")],
      tier("services"),
      tier("domain"),
    ],
    barriers: [{ between: ["features", "platform"], label: "never import each other" }],
    links: tackLinks,
    startWith: ["cli-host", "features-status"],
    replays: [
      {
        label: "tack status",
        steps: [
          { at: "cli-commands", note: "Parses the request." },
          { at: "cli-host", note: "Routes it." },
          { at: "features-status", note: "Runs the use case." },
          { at: "cli-host", note: "Renders the result." },
        ],
      },
    ],
    ...overrides,
  };
}

const small = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  id: "small-map",
  title: "The web app reads through the API and never touches the store",
  rule: { title: "Calls point down", text: "A box calls the boxes below it." },
  tiers: [
    { id: "web", label: "Web", nodes: [{ id: "app", label: "app" }] },
    { id: "api", label: "API", nodes: [{ id: "api", label: "api" }] },
    { id: "data", label: "Data", nodes: [{ id: "store", label: "store" }] },
  ],
  links: [
    { from: "app", to: "api", label: "fetches" },
    { from: "api", to: "store", label: "reads" },
  ],
  ...overrides,
});

const lines = (props: unknown) => readArchitectureMap(props).issues.map(issueLine);

describe("reading an architecture map", () => {
  it("reads the Tack map without issues, with features and platform as siblings", () => {
    const { model, issues } = readArchitectureMap(tackProps());
    expect(issues).toEqual([]);
    expect(model.rows.map((row) => row.map((tier) => tier.id))).toEqual([
      ["bootstrap"],
      ["cli"],
      ["features", "platform"],
      ["services"],
      ["domain"],
    ]);
    expect(model.nodes).toHaveLength(48);
    expect(model.links).toHaveLength(224);
    expect(model.cases.map((item) => [item.id, item.kind])).toEqual([["tack-status", "replay"]]);
  });

  it("renders the valid parts of broken input and names each defect once", () => {
    const { model } = readArchitectureMap(
      small({
        title: "CLI architecture",
        tiers: [
          { id: "web", label: "Web", nodes: [{ id: "app", label: "app" }] },
          {
            id: "api",
            label: "API",
            nodes: [
              { id: "api", label: "api" },
              { id: "app", label: "app again" },
            ],
          },
        ],
        links: [
          { from: "app", to: "api" },
          { from: "api", to: "cache" },
        ],
      }),
    );
    expect(
      lines(
        small({
          title: "CLI architecture",
          tiers: [
            { id: "web", label: "Web", nodes: [{ id: "app", label: "app" }] },
            {
              id: "api",
              label: "API",
              nodes: [
                { id: "api", label: "api" },
                { id: "app", label: "app again" },
              ],
            },
          ],
          links: [
            { from: "app", to: "api" },
            { from: "api", to: "cache" },
          ],
        }),
      ),
    ).toEqual([
      'input: title "CLI architecture" reads as a noun phrase; write the claim the figure proves as a sentence',
      'input: duplicate id "app": node "app again" is left out',
      'input: link api -> cache names an unknown id "cache"',
    ]);
    expect(model.nodes.map((node) => node.id)).toEqual(["app", "api"]);
    expect(model.links).toHaveLength(1);
  });

  it("flags an upward link and a link across a barrier, and still draws both", () => {
    const { model, issues } = readArchitectureMap(
      tackProps({
        links: [
          { from: "domain-state", to: "cli-host" },
          { from: "features-status", to: "platform-state" },
          { from: "features-status", to: "domain-state" },
        ],
      }),
    );
    expect(issues.map(issueLine)).toEqual([
      "input: link domain-state -> cli-host points up",
      'input: link features-status -> platform-state crosses the barrier "never import each other"',
    ]);
    expect(model.links.map((link) => link.warning)).toEqual(["up", "barrier", undefined]);
  });

  it("accepts tier ids as link ends and derives the tiers each tier uses", () => {
    const { model, issues } = readArchitectureMap(
      small({ links: [{ from: "web", to: "data", label: "may read" }] }),
    );
    expect(issues).toEqual([]);
    expect(model.links[0]?.level).toBe("tier");
    expect(tierUses(model, "web")).toEqual(["Data"]);
    expect(tierUses(model, "data")).toEqual([]);
  });

  it("reports missing fields, bad references and over-budget counts", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      id: `t${index}`,
      label: `T${index}`,
      nodes: Array.from({ length: 7 }, (_node, node) => ({ id: `n${index}-${node}`, label: "n" })),
    }));
    expect(
      lines({
        id: "Bad Id",
        title: "Every tier calls the one below it and nothing else",
        tiers: [
          ...many,
          { label: "No id", nodes: [] },
          { id: "empty", nodes: [{ id: "x" }, { label: "no id" }, "junk"] },
          [
            { id: "t0", label: "T0 again", nodes: [] },
            { id: "a", label: "A", nodes: [] },
            { id: "b", label: "B", nodes: [] },
          ],
        ],
        links: [{ from: "x" }, "junk", { from: "x", to: "nowhere" }],
        barriers: [{ between: ["t0", "t1"], label: "wall" }, { between: ["t0", "zz"] }],
        startWith: ["x", "ghost"],
        replays: [
          { steps: [] },
          {
            label: "long",
            steps: Array.from({ length: 13 }, () => ({ at: "x", note: "n" })),
          },
          { label: "lost", steps: [{ at: "ghost", note: "n" }, { note: "n" }] },
        ],
        lenses: [
          { label: "Failure", note: "Down.", focus: ["x", "ghost"], blocked: ["gone"] },
          { focus: [] },
        ],
      }),
    ).toEqual([
      'input: id "Bad Id" is not a short lowercase slug',
      "input: rule is missing; give { title, text }: the one rule the map's layout encodes",
      "input: tier 10 has no id; it is left out",
      'input: tier "empty" has no label',
      'input: node "x" has no label',
      'input: a node in tier "empty" has no id; it is left out',
      'input: a node in tier "empty" is not an object; it is left out',
      'input: duplicate id "t0": tier "T0 again" is left out',
      "input: row 12 has 3 tiers; a row holds at most two sibling tiers",
      'input: link x -> ? has no "to"; it is left out',
      "input: link 2 is not an object; it is left out",
      'input: link x -> nowhere names an unknown id "nowhere"',
      'input: barrier "wall" is between t0 and t1, which are not sibling tiers in one row',
      'input: barrier 2 names an unknown tier "zz"',
      'input: startWith names an unknown id "ghost"',
      "input: replay 1 has no label",
      "input: replay 1 has no steps",
      'input: replay "long" has 13 steps; the budget is 12',
      'input: replay "lost" step 1 names an unknown id "ghost"',
      'input: replay "lost" step 2 names an unknown id "?"',
      'input: lens "Failure" names an unknown id "ghost"',
      'input: lens "Failure" names an unknown id "gone"',
      "input: lens 2 has no label",
      "input: lens 2 has no note",
      "input: 64 boxes; the budget is 60. Split the map or raise its level",
      "input: 11 tier rows; the budget is 8. Merge tiers or split the map",
    ]);
  });

  it("names a barrier without two ends or a label and a link without a start", () => {
    expect(
      lines(
        small({
          tiers: [
            [
              { id: "a", label: "A", nodes: [{ id: "x", label: "x" }] },
              { id: "b", label: "B", nodes: [{ id: "y", label: "y" }] },
            ],
            { id: "c", label: "C", nodes: [{ id: "z", label: "z" }] },
          ],
          barriers: [{ between: ["a"] }, { between: ["a", "b"] }],
          links: [{ to: "y" }, { from: "x", to: "z", label: "calls" }],
        }),
      ),
    ).toEqual([
      'input: link ? -> y has no "from"; it is left out',
      "input: barrier 1 needs between: [tierId, tierId]",
      "input: barrier 2 has no label",
    ]);
  });

  it("gives a repeated case id a numbered suffix and an unsluggable label a fallback id", () => {
    const step = [{ at: "app", note: "n" }];
    const { model } = readArchitectureMap(
      small({
        replays: [
          { id: "dup", label: "One", steps: step },
          { id: "dup", label: "Two", steps: step },
          { label: "!!!", steps: step },
        ],
      }),
    );
    expect(model.cases.map((item) => item.id)).toEqual(["dup", "dup-2", "replay-3"]);
  });

  it("reads anything that is not an object as an empty map with issues", () => {
    expect(lines("nonsense")).toEqual([
      "input: id is required: a short lowercase slug",
      "input: title is missing; write the claim the figure proves as a sentence",
      "input: rule is missing; give { title, text }: the one rule the map's layout encodes",
      "input: tiers is empty; give at least one tier with its nodes",
    ]);
  });

  it("keeps lens ids and reads tier ids in a lens as all their boxes", () => {
    const { model } = readArchitectureMap(
      small({
        lenses: [
          { id: "store-down", label: "Store down", note: "Reads fail.", focus: ["data", "api"] },
        ],
      }),
    );
    expect(model.cases).toEqual([
      {
        kind: "lens",
        id: "store-down",
        label: "Store down",
        note: "Reads fail.",
        focus: ["store", "api"],
        blocked: [],
      },
    ]);
  });
});

describe("focus and context", () => {
  const { model } = readArchitectureMap(tackProps());

  it("lights the 18 uses and 2 users of features/status, without a second hop", () => {
    const focus = focusOf(model, "features-status");
    expect(focus.out).toHaveLength(18);
    expect(focus.incoming.map((link) => link.from)).toEqual(["cli-host", "features-doctor"]);
    expect(focus.onward).toEqual([]);
    expect(focus.bundles).toEqual([]);
    expect(focus.near.size).toBe(21);
  });

  it("bundles the 37 uses of cli/host by target tier, except the one inside its own tier", () => {
    const focus = focusOf(model, "cli-host");
    expect(focus.out).toHaveLength(37);
    expect(focus.bundles.map((bundle) => [bundle.direction, bundle.tier, bundle.count])).toEqual([
      ["out", "features", 16],
      ["out", "services", 7],
      ["out", "domain", 13],
    ]);
    // The one link inside the CLI tier, to cli/commands, stays a single link.
    expect(focus.bundles.reduce((sum, bundle) => sum + bundle.count, 0)).toBe(36);
  });

  it("adds at most two onward links per neighbour, down the map, when the first hop is small", () => {
    const { model: few } = readArchitectureMap(
      small({
        tiers: [
          { id: "web", label: "Web", nodes: [{ id: "app", label: "app" }] },
          { id: "api", label: "API", nodes: [{ id: "api", label: "api" }] },
          {
            id: "data",
            label: "Data",
            nodes: ["a", "b", "c"].map((id) => ({ id, label: id })),
          },
        ],
        links: [
          { from: "app", to: "api" },
          { from: "api", to: "a" },
          { from: "api", to: "b" },
          { from: "api", to: "c" },
          { from: "api", to: "app" },
        ],
      }),
    );
    const focus = focusOf(few, "app");
    expect(focus.onward.map((link) => link.to)).toEqual(["a", "b"]);
    expect([...focus.far]).toEqual(["a", "b"]);
    expect(focusOf(few, "missing").near.size).toBe(0);
  });
});

describe("tier layout", () => {
  const { model } = readArchitectureMap(tackProps());
  const layout = layoutArchitecture(model);

  it("wraps Features to five rows beside Platform at column width", () => {
    const features = model.tiers.find((tier) => tier.id === "features");
    const rows = new Set(features?.nodes.map((node) => layout.boxes.get(node.id)?.y));
    expect(rows.size).toBe(5);
    const featureBox = layout.boxes.get("features-status");
    const platformBox = layout.boxes.get("platform-state");
    expect(featureBox?.w).toBe(platformBox?.w);
    expect((platformBox?.x ?? 0) > (featureBox?.x ?? 0)).toBe(true);
    expect(layout.walls).toEqual([expect.objectContaining({ label: "never import each other" })]);
  });

  it("keeps every box inside the column, at least 132 px wide, without overlap", () => {
    const boxes = [...layout.boxes.values()];
    expect(boxes.every((box) => box.x >= 0 && box.x + box.w <= columnWidth)).toBe(true);
    expect(boxes.every((box) => box.w >= 132)).toBe(true);
    const overlapping = boxes.flatMap((a, index) =>
      boxes
        .slice(index + 1)
        .filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        .map((b) => `${a.id} ${b.id}`),
    );
    expect(overlapping).toEqual([]);
  });

  it("is about 950 px tall for the 48-box map, and never draws text under 11 px", () => {
    expect(layout.height).toBeGreaterThan(850);
    expect(layout.height).toBeLessThan(1050);
    expect(Math.min(...Object.values(drawingFontSizes))).toBeGreaterThanOrEqual(11);
    expect(architectureLayoutIssues(layout)).toEqual([]);
  });

  it("shortens a label that repeats its tier path and truncates what does not fit", () => {
    expect(layout.boxes.get("features-status")?.text).toBe("status");
    expect(layout.boxes.get("features-status")?.label).toBe("features/status");
    const { model: long } = readArchitectureMap(
      small({
        tiers: [
          {
            id: "web",
            label: "Web",
            nodes: [{ id: "app", label: "a-very-long-module-name-that-cannot-fit", detail: "d" }],
          },
        ],
        links: [],
      }),
    );
    const box = layoutArchitecture(long).boxes.get("app");
    expect(box?.text.endsWith("…")).toBe(true);
    expect(box?.h).toBe(46);
  });

  it("gives an empty tier a band area of its own, alone or beside a sibling", () => {
    const { model: sparse } = readArchitectureMap(
      small({
        tiers: [
          { id: "web", label: "Web", nodes: [] },
          [
            { id: "api", label: "API", nodes: [{ id: "api", label: "api" }] },
            { id: "jobs", label: "Jobs", nodes: [] },
          ],
        ],
        links: [],
      }),
    );
    const laid = layoutArchitecture(sparse);
    const area = (id: string) => laid.tiers.get(id)?.area;
    expect(area("web")?.w).toBeGreaterThan(0);
    expect(area("jobs")?.w).toBeGreaterThan(0);
    expect((area("jobs")?.x ?? 0) > (area("api")?.x ?? 0)).toBe(true);
    expect([...laid.boxes.keys()]).toEqual(["api"]);
  });

  it("uses fewer rows in the wide expanded layout", () => {
    const wide = layoutArchitecture(model, expandedWidth);
    const features = model.tiers.find((tier) => tier.id === "features");
    expect(new Set(features?.nodes.map((node) => wide.boxes.get(node.id)?.y)).size).toBe(3);
    expect(wide.height).toBeLessThan(layout.height);
  });

  it("reports a drawing taller than the limit as a layout issue", () => {
    const tall = readArchitectureMap(
      small({
        tiers: Array.from({ length: 8 }, (_, index) => ({
          id: `t${index}`,
          label: `T${index}`,
          nodes: Array.from({ length: 13 }, (_node, node) => ({
            id: `n${index}-${node}`,
            label: "n",
            detail: "d",
          })),
        })),
        links: [],
      }),
    ).model;
    expect(architectureLayoutIssues(layoutArchitecture(tall)).map(issueLine)).toEqual([
      expect.stringMatching(
        /^layout: the drawing is 1,\d{3} px tall at column width; the limit is 1,200\. Split the map or raise its level$/,
      ),
    ]);
  });
});

describe("text equivalent", () => {
  it("lists the claim, rule, tiers with boxes, every link and every case", () => {
    const { model } = readArchitectureMap(
      small({
        summary: "Three boxes.",
        lenses: [{ label: "Store down", note: "Reads fail.", focus: ["store"] }],
        replays: [{ label: "A read", steps: [{ at: "app", note: "Asks." }] }],
        tiers: [
          {
            id: "web",
            label: "Web",
            path: "web/",
            nodes: [{ id: "app", label: "app", detail: "SPA" }],
          },
          { id: "api", label: "API", nodes: [{ id: "api", label: "api" }] },
          { id: "data", label: "Data", nodes: [{ id: "store", label: "store" }] },
        ],
      }),
    );
    expect(architectureReadable(model)).toBe(
      [
        "The web app reads through the API and never touches the store",
        "Three boxes.",
        "How to read this: Calls point down. A box calls the boxes below it.",
        "Web (web/): app (SPA)",
        "API: api",
        "Data: store",
        "app -> api: fetches",
        "api -> store: reads",
        "Replay A read: 1. app: Asks.",
        "Lens Store down: store. Reads fail.",
      ].join("\n"),
    );
  });

  it("lists only the claim and tiers of a map without summary, rule or links", () => {
    const { model } = readArchitectureMap(
      small({ rule: undefined, links: [], tiers: [{ id: "c", label: "C", nodes: [{ id: "z" }] }] }),
    );
    expect(architectureReadable(model)).toBe(
      ["The web app reads through the API and never touches the store", "C: z"].join("\n"),
    );
  });

  it("counts links instead of listing them above 50", () => {
    const { model } = readArchitectureMap(tackProps());
    expect(architectureReadable(model)).toContain("224 links.");
    expect(architectureReadable(model)).not.toContain("cli-host -> features-status");
  });

  it("keeps the budgets the spec names", () => {
    expect(architectureBudget).toEqual({
      boxes: 60,
      rows: 8,
      steps: 12,
      bundleAbove: 24,
      onwardWhenAtMost: 6,
      onwardPerNeighbour: 2,
      listedLinks: 50,
    });
  });
});
