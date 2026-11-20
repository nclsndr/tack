import { describe, expect, it } from "vitest";
import { issueLine } from "./issues.ts";
import { readSystem, systemBudget, systemFocus, systemReadable } from "./system-model.ts";
import { capturePath } from "./system-fixtures.ts";

const lines = (props: unknown): readonly string[] => readSystem(props).issues.map(issueLine);

describe("reading a System", () => {
  it("reads the capture path of the brief without an issue", () => {
    const { model, issues } = readSystem(capturePath);
    expect(issues).toEqual([]);
    expect(model.nodes.map((node) => [node.id, node.kind, node.group])).toEqual([
      ["feed", "external", undefined],
      ["collector", "service", "browser"],
      ["redis", "queue", undefined],
      ["consumer", "service", undefined],
      ["pg", "store", undefined],
    ]);
    expect(model.links.map((link) => [link.id, link.kind])).toEqual([
      ["capture", "call"],
      ["xadd", "call"],
      ["read", "call"],
      ["insert", "call"],
      ["ack", "reply"],
    ]);
    expect(model.cases).toEqual([
      {
        kind: "replay",
        id: "one-event",
        label: "One event",
        steps: [
          {
            at: ["feed", "capture", "collector"],
            note: "The collector receives the event.",
            broken: [],
          },
          { at: ["xadd", "redis"], note: "It waits in the stream.", broken: [] },
          {
            at: ["read", "consumer", "insert", "pg"],
            note: "The consumer inserts it.",
            broken: [],
          },
          { at: ["ack"], note: "Only then is the entry acknowledged and deleted.", broken: [] },
        ],
      },
      {
        kind: "lens",
        id: "postgres-down",
        label: "Postgres down",
        note: "Capture continues. Events wait in Redis.",
        focus: ["collector", "xadd", "redis"],
        broken: ["pg", "insert"],
      },
    ]);
  });

  it("tints groups in order and nests a group inside one other group", () => {
    const { model, issues } = readSystem({
      ...capturePath,
      groups: [
        { id: "vps", label: "VPS" },
        { id: "browser", label: "worker-browser", parent: "vps" },
      ],
      nodes: capturePath.nodes.map((node) =>
        node.id === "redis" ? { ...node, group: "vps" } : node,
      ),
    });
    expect(issues).toEqual([]);
    expect(model.groups).toEqual([
      { id: "vps", label: "VPS", tint: 0 },
      { id: "browser", label: "worker-browser", parent: "vps", tint: 1 },
    ]);
  });

  it("repairs an unknown node kind and an unknown link kind, and says so", () => {
    const { model } = readSystem({
      ...capturePath,
      nodes: capturePath.nodes.map((node) =>
        node.id === "redis" ? { ...node, kind: "memcache" } : node,
      ),
      links: capturePath.links.map((link) =>
        link.id === "read" ? { ...link, kind: "stream" } : link,
      ),
    });
    expect(model.nodes.find((node) => node.id === "redis")?.kind).toBe("service");
    expect(model.links.find((link) => link.id === "read")?.kind).toBe("call");
    expect(
      lines({
        ...capturePath,
        nodes: capturePath.nodes.map((node) =>
          node.id === "redis" ? { ...node, kind: "memcache" } : node,
        ),
        links: capturePath.links.map((link) =>
          link.id === "read" ? { ...link, kind: "stream" } : link,
        ),
      }),
    ).toEqual([
      'input: node "redis" has unknown kind "memcache"; drawn as a service',
      'input: link redis -> consumer has unknown kind "stream"; drawn as a call',
    ]);
  });

  it("reports every input issue the brief lists, with the same lines as the page", () => {
    expect(
      lines({
        id: "Broken System",
        title: "Data flow",
        nodes: [
          { id: "a", label: "A", kind: "service", group: "nowhere" },
          { id: "a", label: "A again", kind: "service" },
          { id: "b", kind: "store", lines: ["1", "2", "3", "4", "5", "6", "7"] },
          { id: "c", label: "C", kind: "service" },
          { label: "no id" },
        ],
        groups: [
          { id: "outer", label: "Outer" },
          { id: "inner", label: "Inner", parent: "outer" },
          { id: "deep", label: "Deep", parent: "inner" },
          { id: "lost", label: "Lost", parent: "missing" },
        ],
        links: [
          { from: "a", to: "b" },
          { from: "a", to: "a" },
          { from: "a", to: "ghost", label: "sends" },
          { id: "dup", from: "b", to: "a", label: "reads" },
          { id: "dup", from: "b", to: "a", label: "reads again" },
        ],
        startWith: ["ghost"],
        replays: [
          { label: "Lost", steps: [{ at: ["a", "nowhere"], note: "?" }] },
          { label: "Empty", steps: [] },
        ],
        lenses: [{ label: "Down", focus: ["a", "nope"], broken: ["dup"] }],
      }),
    ).toEqual([
      'input: id "Broken System" is not a short lowercase slug',
      'input: title "Data flow" reads as a noun phrase; write the claim the figure proves as a sentence',
      'input: group "deep" sits inside "inner", which sits inside another group; a group sits inside at most one other group. Drawn inside "outer"',
      'input: group "lost" sits inside an unknown group "missing"; drawn on its own',
      'input: node "a" is in an unknown group "nowhere"; drawn outside any group',
      'input: duplicate id "a": node "A again" is left out',
      'input: node "b" has no label',
      'input: node "b" has 7 lines; at most 6 are drawn',
      "input: node 5 has no id; it is left out",
      "input: link a -> b has no label; say what moves or what is done",
      'input: link a -> a starts and ends on "a"; give it a label that explains why',
      'input: link a -> ghost names an unknown id "ghost"',
      'input: duplicate link id "dup": link b -> a "reads again" is left out',
      'input: node "c" is in no link; link it or leave it out',
      'input: startWith names an unknown id "ghost"',
      'input: replay "Lost" step 1 names an unknown id "nowhere"',
      'input: replay "Empty" has no steps',
      'input: lens "Down" has no note',
      'input: lens "Down" names an unknown id "nope"',
    ]);
  });

  it("reports groups it cannot draw, a node with no kind and a link that is not one", () => {
    expect(
      lines({
        ...capturePath,
        groups: [
          { label: "no id" },
          { id: "browser", label: "worker-browser (untrusted)" },
          { id: "browser", label: "again" },
          { id: "plain" },
          { id: "a", label: "A", parent: "b" },
          { id: "b", label: "B", parent: "a" },
        ],
        nodes: [...capturePath.nodes, { id: "extra", label: "extra", group: "plain" }],
        links: [...capturePath.links, { from: "extra", to: "pg", label: "writes" }, "not a link"],
      }),
    ).toEqual([
      "input: group 1 has no id; it is left out",
      'input: duplicate group id "browser": the second one is left out',
      'input: group "plain" has no label',
      'input: groups "a" and "b" sit inside each other; drawn on its own',
      'input: groups "b" and "a" sit inside each other; drawn on its own',
      'input: node "extra" has no kind; drawn as a service. Use service, store, queue, external, actor, artifact',
      "input: link 7 needs from and to; it is left out",
    ]);
  });

  it("names unnamed cases, keeps a step that only breaks parts, and checks the step budget", () => {
    const { model, issues } = readSystem({
      ...capturePath,
      replays: [
        { steps: Array.from({ length: 13 }, () => ({ at: "feed", note: "again" })) },
        { label: "Postgres fails", steps: [{ broken: ["pg"], note: "It stops." }] },
      ],
      lenses: [{ note: "Only the feed.", focus: ["feed"] }],
    });
    expect(issues.map(issueLine)).toEqual([
      "input: replay 1 has no label",
      "input: replay 1 has 13 steps; the budget is 12",
      "input: lens 1 has no label",
    ]);
    expect(model.cases.map((item) => [item.kind, item.id, item.label])).toEqual([
      ["replay", "replay-1", "Replay 1"],
      ["replay", "postgres-fails", "Postgres fails"],
      ["lens", "lens-1", "Lens 1"],
    ]);
    expect(model.cases[1]).toMatchObject({
      steps: [{ at: [], broken: ["pg"], note: "It stops." }],
    });
    expect(systemReadable(model)).toContain(
      "Replay Postgres fails: 1. broken: Postgres: It stops.",
    );
  });

  it("drops non-text lines, a repeated link id and a replay whose steps name nothing", () => {
    const step = [{ at: "a", note: "n" }];
    const { model, issues } = readSystem({
      id: "s",
      title: "Two parts send one message",
      nodes: [
        { id: "a", label: "A", kind: "service", lines: ["one", 2, "three"] },
        { id: "b", label: "B", kind: "store" },
      ],
      links: [
        { id: "m", from: "a", to: "b", label: "writes" },
        { id: "m", from: "b", to: "a" },
      ],
      replays: [
        { label: "!!!", steps: step },
        { id: "dup", label: "One", steps: step },
        { id: "dup", label: "Two", steps: step },
        { label: "Nowhere", steps: [{ note: "nothing" }] },
      ],
    });
    expect(issues.map(issueLine)).toEqual([
      'input: duplicate link id "m": link b -> a is left out',
    ]);
    expect(model.nodes[0]?.lines).toEqual(["one", "three"]);
    expect(model.cases.map((item) => item.id)).toEqual(["replay-1", "dup", "dup-3"]);
  });

  it("reads nothing as an empty figure with a default id", () => {
    expect(readSystem(undefined).model).toMatchObject({ id: "system", title: "", nodes: [] });
  });

  it("asks to split a drawing over the node budget", () => {
    const nodes = Array.from({ length: systemBudget.nodes + 1 }, (_, index) => ({
      id: `n${index}`,
      label: `Node ${index}`,
      kind: "service",
    }));
    const links = nodes.slice(1).map((node, index) => ({
      from: `n${index}`,
      to: node.id,
      label: "sends",
    }));
    expect(lines({ ...capturePath, nodes, links, replays: [], lenses: [] })).toEqual([
      "input: 13 nodes; the budget is 12. Split the figure or raise its level",
    ]);
  });

  it("requires nodes and links", () => {
    expect(lines({ id: "empty", title: "Nothing runs here at all" })).toEqual([
      "input: nodes is empty; give the parts that run",
      "input: links is empty; give what the parts send each other",
    ]);
  });
});

describe("the text equivalent of a System without groups", () => {
  it("lists its parts on one line", () => {
    const { model } = readSystem({
      ...capturePath,
      groups: [],
      nodes: capturePath.nodes.map(({ group: _group, ...node }) => node),
    });
    expect(systemReadable(model)).toContain(
      "Parts: Carrier tracking feed (external), collector (headless browser + WebSocket),",
    );
  });
});

describe("the text equivalent of an empty System", () => {
  it("is the claim alone", () => {
    expect(systemReadable(readSystem({ id: "e", title: "Nothing runs" }).model)).toBe(
      "Nothing runs",
    );
  });
});

describe("focus on a System node", () => {
  it("inks the node, the nodes it sends to and receives from, and their links", () => {
    const { model } = readSystem(capturePath);
    const focus = systemFocus(model, "consumer");
    expect(focus.out.map((link) => link.id)).toEqual(["insert", "ack"]);
    expect(focus.incoming.map((link) => link.id)).toEqual(["read"]);
    expect([...focus.near].toSorted()).toEqual(["consumer", "pg", "redis"]);
  });

  it("is empty for an unknown id", () => {
    const { model } = readSystem(capturePath);
    expect(systemFocus(model, "nope")).toEqual({ out: [], incoming: [], near: new Set() });
  });
});

describe("the text equivalent of a System", () => {
  it("lists the claim, groups, links with their kind, and every case", () => {
    const { model } = readSystem({
      ...capturePath,
      summary: "Redis holds only what Postgres does not have yet.",
      rule: { title: "Links follow the data", text: "A link points the way an event moves." },
      startWith: ["redis"],
    });
    expect(systemReadable(model)).toBe(
      [
        "An event leaves Redis only after Postgres has it",
        "Redis holds only what Postgres does not have yet.",
        "How to read this: Links follow the data. A link points the way an event moves.",
        "Start with: Redis stream",
        "worker-browser (untrusted): collector (headless browser + WebSocket)",
        "Outside any group: Carrier tracking feed (external), Redis stream (queue; about 1 day at 3 GB), worker-core (consumer), Postgres (store; public.parcel_events)",
        "Carrier tracking feed -> collector: parcel events",
        "collector -> Redis stream: XADD",
        "Redis stream -> worker-core: XREADGROUP",
        "worker-core -> Postgres: INSERT",
        "worker-core -> Redis stream: ack + delete (reply)",
        "Replay One event: 1. Carrier tracking feed, parcel events, collector: The collector receives the event. 2. XADD, Redis stream: It waits in the stream. 3. XREADGROUP, worker-core, INSERT, Postgres: The consumer inserts it. 4. ack + delete: Only then is the entry acknowledged and deleted.",
        "Lens Postgres down: collector, XADD, Redis stream. Broken: Postgres, INSERT. Capture continues. Events wait in Redis.",
      ].join("\n"),
    );
  });
});
