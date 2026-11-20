import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { staticFigures } from "./check.ts";
import { crossesBox, type Rect } from "./curves.ts";
import { issueLine } from "./issues.ts";
import { loadLayoutEngine } from "./layout-engine.ts";
import { readSchema } from "./schema-model.ts";
import {
  anchorY,
  layoutSchema,
  packingOrder,
  schemaCardSize,
  schemaDrawingSizes,
  schemaLayoutIssues,
  schemaRelationCurves,
} from "./schema-layout.ts";
import { depotSchema, domainModel } from "./schema-fixtures.ts";

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w &&
  inner.y + inner.h <= outer.y + outer.h;

async function laid(props: unknown, room?: number) {
  const { model } = readSchema(props);
  return { model, layout: await layoutSchema(model, await loadLayoutEngine(), room) };
}

/** `tables` tables of `columns` columns, spread over `groups` schemas, each referencing the one before. */
const synthetic = (tables: number, groups: number, columns = 4) => ({
  id: "synthetic",
  title: "Each table references the table before it",
  tables: Array.from({ length: tables }, (_, index) => ({
    name: `s${index % groups}.table_${index}`,
    columns: [
      { name: "id", type: "bigserial", key: "pk" },
      ...(index === 0
        ? []
        : [
            {
              name: "previous_id",
              type: "bigint",
              ref: `s${(index - 1) % groups}.table_${index - 1}.id`,
            },
          ]),
      ...Array.from({ length: columns - 2 }, (_unused, column) => ({
        name: `value_${column}`,
        type: "text",
      })),
    ],
  })),
});

describe("sizing a Schema card", () => {
  it("derives the size from the columns, the notes and the keys, never from a measurement", () => {
    const { model } = readSchema(depotSchema);
    const size = (name: string) => {
      const table = model.tables.find((candidate) => candidate.name === name);
      if (table === undefined) throw new Error(name);
      return schemaCardSize(table);
    };
    expect(size("public.depots")).toMatchObject({ w: 140, h: 94, head: 28, gutter: 32 });
    expect(size("public.parcels")).toMatchObject({ w: 220, h: 188 });
    expect(size("public.parcels").rows[4]).toEqual({ y: 108, h: 34, mid: 118 });
    expect(size("public.temperature_readings").h).toBe(150);
    const entity = readSchema(domainModel).model.tables.find((table) => table.name === "Project");
    if (entity === undefined) throw new Error("Project");
    expect(schemaCardSize(entity)).toMatchObject({ w: 140, h: 54, gutter: 10 });
  });

  it("draws no text under 11 px", () => {
    expect(Math.min(...Object.values(schemaDrawingSizes))).toBeGreaterThanOrEqual(11);
  });
});

describe("the packing order", () => {
  it("starts at the edge of the relations and walks along them, so a hub sits between", () => {
    const order = (props: unknown) => {
      const { model } = readSchema(props);
      return packingOrder(model.tables, model.relations).map((table) => table.short);
    };
    expect(order(domainModel)).toEqual(["Source", "Resource", "Project"]);
    expect(
      order({
        ...domainModel,
        tables: [{ name: "Loose", columns: [{ name: "note" }] }, ...domainModel.tables],
      }),
    ).toEqual(["Source", "Resource", "Project", "Loose"]);
    expect(order(depotSchema)).toEqual([
      "parcel_events",
      "parcels",
      "depots",
      "docks",
      "temperature_readings",
      "users",
      "audit_events",
      "job_logs",
      "sessions",
    ]);
  });
});

describe("laying out a Schema", () => {
  it("packs the parcel-hub schema in the column, at most 900 px tall, groups as blocks", async () => {
    const { model, layout } = await laid(depotSchema);
    expect(layout.fits).toBe(true);
    expect(layout.width).toBe(728);
    expect(layout.height).toBeLessThanOrEqual(900);
    expect(schemaLayoutIssues(layout)).toEqual([]);
    for (const table of model.tables) {
      const card = layout.cards.get(table.name);
      const group = layout.groups.get(table.group ?? "");
      expect(card !== undefined && group !== undefined).toBe(true);
      if (card === undefined || group === undefined) return;
      expect(contains(group, card)).toBe(true);
      expect(card.tint).toBe(model.groups.find((candidate) => candidate.id === table.group)?.tint);
    }
    const groups = [...layout.groups.values()];
    groups.forEach((group, index) =>
      groups.slice(index + 1).forEach((other) => expect(overlaps(group, other)).toBe(false)),
    );
  });

  it("keeps the acceptance page's schema at most 900 px tall, every relation clear of the cards", async () => {
    const [figure] = await staticFigures(
      resolve(import.meta.dirname, "../../fixtures/figures/depot-schema.mdx"),
    );
    const { layout } = await laid(figure?.props);
    expect(layout.height).toBeLessThanOrEqual(900);
    expect(layout.crossings).toBe(0);
  });

  it("keeps schemas of 3 to 12 tables in 1 to 4 groups under the height limit, in the column and free of overlap", async () => {
    for (const [tables, groups] of [
      [3, 1],
      [6, 2],
      [9, 3],
      [12, 3],
      [12, 4],
      [12, 1],
    ] as const) {
      const { layout } = await laid(synthetic(tables, groups));
      const cards = [...layout.cards.values()];
      expect(layout.fits, `${tables}/${groups}`).toBe(true);
      expect(schemaLayoutIssues(layout), `${tables}/${groups}`).toEqual([]);
      for (const card of cards)
        expect(contains({ x: 0, y: 0, w: layout.width, h: layout.height }, card)).toBe(true);
      cards.forEach((card, index) =>
        cards.slice(index + 1).forEach((other) => expect(overlaps(card, other)).toBe(false)),
      );
    }
  });

  it("reports a figure that does not fit, or is too tall, and scrolls instead of shrinking", async () => {
    const narrow = await laid(domainModel, 120);
    expect(narrow.layout.fits).toBe(false);
    expect(narrow.layout.width).toBeGreaterThan(120);
    expect(schemaLayoutIssues(narrow.layout).map(issueLine)).toEqual([
      "layout: does not fit the column at a legible size; shorten the column names or split the figure by group",
    ]);
    const tall = await laid(synthetic(12, 1, 40));
    expect(schemaLayoutIssues(tall.layout).map(issueLine)).toEqual([
      expect.stringMatching(
        /^layout: the drawing is [\d,]+ px tall at column width; the limit is 1,200\. Split the figure by group$/,
      ),
    ]);
  });

  it("reads only the positions the engine gives, and leaves out a card it did not place", async () => {
    const { model } = readSchema(domainModel);
    const layout = await layoutSchema(model, {
      layout: async () => ({ id: "root", children: [{ id: "t:Source" }] }),
    });
    expect([...layout.cards.keys()]).toEqual(["Source"]);
    expect(layout).toMatchObject({ fits: true, width: 728, height: 0 });
  });

  it("leaves out a group whose block the engine did not place", async () => {
    const { model } = readSchema(depotSchema);
    const layout = await layoutSchema(model, {
      layout: async () => ({
        id: "root",
        children: [{ id: "g:auth", children: [{ id: "t:auth.users" }] }],
      }),
    });
    expect([...layout.groups.keys()]).toEqual(["auth"]);
    expect([...layout.cards.keys()]).toEqual(["auth.users"]);
  });
});

describe("the relations of a Schema", () => {
  it("leaves and enters each card at the row of its column, with a crow's foot at the many end", async () => {
    const { model, layout } = await laid(depotSchema);
    const curves = schemaRelationCurves(model, layout);
    expect(curves.map((curve) => curve.id)).toEqual(model.relations.map((relation) => relation.id));
    for (const relation of model.relations) {
      const curve = curves.find((candidate) => candidate.id === relation.id);
      const from = layout.cards.get(relation.from.table);
      const to = layout.cards.get(relation.to.table);
      if (curve === undefined || from === undefined || to === undefined)
        throw new Error(relation.id);
      expect(curve.curve[1]).toBe(anchorY(from, model, relation.from));
      expect(curve.curve[7]).toBe(anchorY(to, model, relation.to));
      expect([from.x, from.x + from.w]).toContain(curve.curve[0]);
      expect([to.x, to.x + to.w]).toContain(curve.curve[6]);
      if (relation.kind === "key") {
        // Three prongs at the referencing end, one bar at the referenced end.
        expect(curve.marks.match(/M /g)).toHaveLength(4);
        const starts = [...curve.marks.matchAll(/M ([\d.-]+) ([\d.-]+)/g)].map((match) => [
          Number(match[1]),
          Number(match[2]),
        ]);
        const near = (x: number, y: number) =>
          starts.filter(([px, py]) => Math.abs((px ?? 0) - x) <= 14 && Math.abs((py ?? 0) - y) <= 7)
            .length;
        expect(near(curve.curve[0], curve.curve[1])).toBe(3);
        expect(near(curve.curve[6], curve.curve[7])).toBe(1);
        expect(curve.label).toBeUndefined();
      } else {
        expect(curve.marks).toBe("");
        expect(curve.label).toBeDefined();
      }
    }
  });

  it("attaches a key at the middle of the rows of its two columns", async () => {
    const { model, layout } = await laid(depotSchema);
    const dock = schemaRelationCurves(model, layout).find(
      (curve) => curve.tables.join(">") === "public.parcels>public.docks",
    );
    const parcels = layout.cards.get("public.parcels");
    const docks = layout.cards.get("public.docks");
    if (dock === undefined || parcels === undefined || docks === undefined)
      throw new Error("no dock key");
    // dock_id is the fifth row of parcels: header 28, four rows of 20, then half a row.
    expect(dock.curve[1]).toBe(parcels.y + 28 + 4 * 20 + 10);
    // id is the first row of docks.
    expect(dock.curve[7]).toBe(docks.y + 28 + 10);
  });

  it("crosses a group border only for the key that leaves its schema", async () => {
    const { model, layout } = await laid(depotSchema);
    const crossing = schemaRelationCurves(model, layout).filter((curve) => {
      const [from, to] = curve.tables.map(
        (name) => model.tables.find((table) => table.name === name)?.group,
      );
      return from !== to;
    });
    expect(crossing.map((curve) => curve.tables)).toEqual([["ops.audit_events", "auth.users"]]);
  });

  it("runs no relation through a card, its own two included, away from its ends", async () => {
    for (const props of [depotSchema, domainModel, synthetic(9, 3)]) {
      const { model, layout } = await laid(props);
      expect(layout.crossings).toBe(0);
      for (const curve of schemaRelationCurves(model, layout)) {
        expect(
          [...layout.cards.values()]
            .filter((card) => crossesBox(curve.curve, card))
            .map((card) => card.table),
          curve.id,
        ).toEqual([]);
      }
    }
  });

  it("draws a bar at both ends of a one-to-one link, and no mark without a cardinality", async () => {
    const { model, layout } = await laid({
      ...domainModel,
      links: [
        { from: "Project", to: "Source", label: "names", cardinality: "one-to-one" },
        { from: "Source", to: "Resource", label: "declares" },
      ],
    });
    const [names, declares] = schemaRelationCurves(model, layout);
    expect(names?.marks.match(/M /g)).toHaveLength(2);
    expect(declares?.marks).toBe("");
  });

  it("draws the cardinality of a link at both ends", async () => {
    const { model, layout } = await laid(domainModel);
    const [declares, picks] = schemaRelationCurves(model, layout);
    expect(declares?.marks.match(/M /g)).toHaveLength(4);
    expect(picks?.marks.match(/M /g)).toHaveLength(6);
  });
});
