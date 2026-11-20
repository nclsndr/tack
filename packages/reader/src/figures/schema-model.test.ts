import { describe, expect, it } from "vitest";
import { issueLine } from "./issues.ts";
import {
  accessOf,
  readSchema,
  schemaBudget,
  schemaFocus,
  schemaReadable,
  type SchemaModel,
} from "./schema-model.ts";
import { depotSchema, domainModel } from "./schema-fixtures.ts";

const lines = (props: unknown): readonly string[] => readSchema(props).issues.map(issueLine);
/** A schema with one SQL table, two entity cards and unusual cases, links and groups. */
const oddSchema = {
  id: "odd",
  title: "Odd inputs still draw what they can",
  rule: { title: "Keys point at what they need", text: "A key points at its table." },
  tables: [
    {
      name: "public.a",
      note: "The only table.",
      columns: [{ name: "id", type: "int", key: "pk" }],
      unique: [[]],
    },
    { name: "Card", columns: [{ name: "x" }] },
    { name: "Other", columns: [{ name: "y" }] },
  ],
  groups: [{ label: "no id" }],
  links: [
    { from: "nowhere", to: "Card", label: "l" },
    { from: "Card", to: "Other" },
    { from: "Other", to: "public.a", label: "owns" },
  ],
  replays: [
    { steps: [] },
    { label: "Lost", steps: [{ at: "public.zz", note: "n" }] },
    { id: "dup", label: "One", steps: [{ at: "public.a", note: "n" }] },
    { id: "dup", label: "Two", steps: [{ at: "public.a", note: "n" }] },
    { label: "!!!", steps: [{ at: "public.a", note: "n" }] },
  ],
};
const lens = (model: SchemaModel, label: string) => {
  const found = model.cases.find((item) => item.label === label);
  if (found?.kind !== "lens") throw new Error(`no lens ${label}`);
  return found;
};

describe("reading a Schema", () => {
  it("reads the parcel-hub schema without an issue, grouping tables by their schema", () => {
    const { model, issues } = readSchema(depotSchema);
    expect(issues).toEqual([]);
    expect(model.entities).toBe(false);
    expect(model.groups).toEqual([
      { id: "public", label: "public", note: "application data", tint: 0 },
      { id: "auth", label: "auth", note: "Better Auth", tint: 1 },
      { id: "ops", label: "ops", note: "control-plane records", tint: 2 },
    ]);
    expect(model.tables.map((table) => [table.name, table.short, table.group])).toEqual([
      ["public.depots", "depots", "public"],
      ["public.docks", "docks", "public"],
      ["public.parcels", "parcels", "public"],
      ["public.parcel_events", "parcel_events", "public"],
      ["public.temperature_readings", "temperature_readings", "public"],
      ["auth.users", "users", "auth"],
      ["auth.sessions", "sessions", "auth"],
      ["ops.audit_events", "audit_events", "ops"],
      ["ops.job_logs", "job_logs", "ops"],
    ]);
    expect(
      model.relations.map((relation) => [
        relation.kind,
        `${relation.from.table}.${relation.from.column ?? ""}`,
        `${relation.to.table}.${relation.to.column ?? ""}`,
        relation.cardinality,
      ]),
    ).toEqual([
      ["key", "public.docks.depot", "public.depots.code", "many-to-one"],
      ["key", "public.parcels.depot", "public.depots.code", "many-to-one"],
      ["key", "public.parcels.dock_id", "public.docks.id", "many-to-one"],
      ["key", "public.parcel_events.parcel_id", "public.parcels.id", "many-to-one"],
      ["key", "public.temperature_readings.depot", "public.depots.code", "many-to-one"],
      ["key", "auth.sessions.user_id", "auth.users.id", "many-to-one"],
      ["key", "ops.audit_events.actor_id", "auth.users.id", "many-to-one"],
      ["link", "ops.job_logs.workflow_id", "ops.audit_events.workflow_id", undefined],
    ]);
  });

  it("reads a domain model as entity cards related by verbs", () => {
    const { model, issues } = readSchema(domainModel);
    expect(issues).toEqual([]);
    expect(model.entities).toBe(true);
    expect(model.groups).toEqual([]);
    expect(
      model.relations.map((relation) => [
        relation.from.table,
        relation.to.table,
        relation.label,
        relation.cardinality,
      ]),
    ).toEqual([
      ["Source", "Resource", "declares", "one-to-many"],
      ["Project", "Resource", "picks", "many-to-many"],
    ]);
  });

  it("keeps a key to an undeclared table as a mark with no relation, and says so", () => {
    const { model, issues } = readSchema({
      ...depotSchema,
      tables: depotSchema.tables.filter((table) => table.name !== "public.docks"),
      lenses: [],
    });
    expect(issues.map(issueLine)).toEqual([
      "input: public.parcels.dock_id references undeclared table public.docks",
    ]);
    const column = model.tables
      .find((table) => table.name === "public.parcels")
      ?.columns.find((candidate) => candidate.name === "dock_id");
    expect(column).toMatchObject({ foreign: true });
    expect(model.relations.some((relation) => relation.from.column === "dock_id")).toBe(false);
  });

  it("reports every input issue the brief lists, with the same lines as the page", () => {
    expect(
      lines({
        id: "broken",
        title: "These tables are wrong in many ways",
        tables: [
          {
            name: "public.a",
            columns: [
              { name: "id", type: "int", key: "primary" },
              { name: "b_id", type: "int", ref: "public.b.nope" },
              { name: "c_id", type: "int", ref: "c_id" },
            ],
          },
          { name: "public.b", columns: [{ name: "id", type: "int" }], unique: [["id", "ghost"]] },
          { name: "public.b", columns: [{ name: "id", type: "int" }] },
          { name: "public.empty", columns: [] },
          { name: "Entity", columns: [{ name: "name" }, { type: "text" }] },
          { columns: [] },
        ],
        groups: [{ id: "lost", label: "Lost" }],
        links: [
          { from: "public.a", to: "public.zzz", label: "points" },
          { from: "public.a.id", to: "public.b.id" },
          { from: "public.a", to: "public.b", label: "joins", cardinality: "some" },
        ],
        lenses: [
          {
            label: "role",
            note: "A role.",
            focus: ["public.q"],
            access: { "public.a": "admin", "nope.*": "read", "public.nada": "none" },
          },
          { access: {} },
        ],
        replays: [{ label: "Query", steps: [{ at: ["public.a", "public.a.zz"], note: "reads" }] }],
      }),
    ).toEqual([
      'input: column "public.a.id" has unknown key "primary"; use pk or unique',
      "input: public.a.b_id references undeclared column public.b.nope",
      'input: column "public.a.c_id" has ref "c_id"; write schema.table.column',
      'input: table "public.b" lists unique (id, ghost) with an unknown column "ghost"',
      'input: duplicate table "public.b": the second one is left out',
      'input: table "public.empty" has no column',
      'input: a column of table "Entity" has no name; it is left out',
      "input: table 6 has no name; it is left out",
      "input: 2 SQL tables and 1 entity card in one figure; give every column a type, or none",
      'input: group "lost" has no table; a table joins it by its name, such as lost.users',
      'input: link public.a -> public.zzz names an undeclared table or column "public.zzz"',
      "input: link public.a.id -> public.b.id has no label; say how they relate",
      'input: link public.a -> public.b has unknown cardinality "some"; use one-to-one, one-to-many, many-to-one or many-to-many',
      'input: replay "Query" step 1 names an undeclared table or column "public.a.zz"',
      'input: lens "role" names an undeclared table or schema "public.q"',
      'input: lens "role" gives "public.a" an unknown access "admin"; use read, write, read-write or none',
      'input: lens "role" names an undeclared table or schema "nope.*"',
      'input: lens "role" names an undeclared table or schema "public.nada"',
      "input: lens 2 has no label",
      "input: lens 2 has no note",
    ]);
  });

  it("reads odd inputs: empty unique sets, unnamed groups, stepless replays and repeated case ids", () => {
    const { model, issues } = readSchema(oddSchema);
    expect(issues.map(issueLine)).toEqual([
      "input: 1 SQL table and 2 entity cards in one figure; give every column a type, or none",
      'input: link nowhere -> Card names an undeclared table or column "nowhere"',
      "input: link Card -> Other has no label; say how they relate",
      "input: replay 1 has no label",
      "input: replay 1 has no steps",
      'input: replay "Lost" step 1 names an undeclared table or column "public.zz"',
    ]);
    expect(model.tables.find((table) => table.name === "public.a")?.unique).toEqual([]);
    expect(model.groups.map((group) => group.id)).toEqual(["public"]);
    expect(model.cases.map((item) => [item.id, item.label])).toEqual([
      ["dup", "One"],
      ["dup-2", "Two"],
      ["replay-5", "!!!"],
    ]);
  });

  it("asks to split a figure over the table budget by group", () => {
    const tables = Array.from({ length: schemaBudget.tables + 1 }, (_, index) => ({
      name: `public.t${index}`,
      columns: [{ name: "id", type: "int", key: "pk" }],
    }));
    expect(lines({ id: "many", title: "Thirteen tables are too many to draw", tables })).toEqual([
      "input: 13 tables; split the figure by group (at most 12)",
    ]);
  });

  it("checks entry points and replay length, and opens a focus on a whole schema", () => {
    const { model, issues } = readSchema({
      ...depotSchema,
      startWith: ["public.parcels", "public.trucks"],
      replays: [
        {
          label: "Too long",
          steps: Array.from({ length: 13 }, () => ({ at: "public.parcels", note: "Again." })),
        },
      ],
      lenses: [{ label: "Ops", note: "Everything in ops.", focus: ["ops.*"] }],
    });
    expect(model.startWith).toEqual(["public.parcels"]);
    expect(issues.map(issueLine)).toEqual([
      'input: startWith names an undeclared table "public.trucks"',
      'input: replay "Too long" has 13 steps; the budget is 12',
    ]);
    expect(model.cases.find((item) => item.kind === "lens")).toMatchObject({
      focus: ["ops.audit_events", "ops.job_logs"],
    });
    expect(schemaReadable(model)).toContain("Start with: parcels");
  });

  it("requires tables", () => {
    expect(lines({ id: "none", title: "There is nothing in this schema" })).toEqual([
      "input: tables is empty; give the tables or the entities",
    ]);
  });
});

describe("access in a lens", () => {
  it("gives a table its own grant first, then its schema's, and none otherwise", () => {
    const { model } = readSchema(depotSchema);
    const core = lens(model, "worker-core");
    const collector = lens(model, "collector");
    expect(
      model.tables.map((table) => [table.name, accessOf(core, table), accessOf(collector, table)]),
    ).toEqual([
      ["public.depots", "read-write", "none"],
      ["public.docks", "read-write", "none"],
      ["public.parcels", "read-write", "write"],
      ["public.parcel_events", "read-write", "write"],
      ["public.temperature_readings", "read-write", "none"],
      ["auth.users", "none", "none"],
      ["auth.sessions", "none", "none"],
      ["ops.audit_events", "none", "none"],
      ["ops.job_logs", "write", "none"],
    ]);
    expect(
      accessOf(lens(model, "Enrichment"), model.tables[0] ?? model.tables[1]!),
    ).toBeUndefined();
  });
});

describe("focus on a Schema table", () => {
  it("inks the table, what it references and what references it, and says so in words", () => {
    const { model } = readSchema(depotSchema);
    const focus = schemaFocus(model, "public.parcels");
    expect([...focus.near].toSorted()).toEqual([
      "public.depots",
      "public.docks",
      "public.parcel_events",
      "public.parcels",
    ]);
    expect(focus.sentence).toBe(
      "parcels references depots (depot -> code), docks (dock_id -> id). Referenced by parcel_events (parcel_id -> id).",
    );
    expect(schemaFocus(model, "auth.users").sentence).toBe(
      "users references nothing. Referenced by sessions (user_id -> id), audit_events (actor_id -> id).",
    );
    expect(schemaFocus(model, "nope").near.size).toBe(0);
  });

  it("names a relation between whole tables by its label, or by nothing without one", () => {
    const { model } = readSchema(oddSchema);
    expect(schemaFocus(model, "Card").sentence).toBe("Card references Other.");
    expect(schemaFocus(model, "Other").sentence).toBe(
      "Other references a (owns). Referenced by Card.",
    );
  });
});

describe("the text equivalent of a Schema", () => {
  it("lists groups, tables with their columns, relations and cases", () => {
    const text = schemaReadable(readSchema(depotSchema).model);
    expect(text).toContain(
      "public (application data): depots, docks, parcels, parcel_events, temperature_readings",
    );
    expect(text).toContain(
      "parcels: id bigserial PK, depot text FK -> depots.code, tracking_code text, carrier text nullable, dock_id bigint FK -> docks.id nullable (filled by enrichment), first_seen_at timestamptz, last_seen_at timestamptz",
    );
    expect(text).toContain(
      "temperature_readings: id bigserial PK, depot text FK -> depots.code, observed_at timestamptz, temp_c smallint nullable, raw text. Unique: (depot, observed_at)",
    );
    expect(text).toContain(
      "job_logs.workflow_id -> audit_events.workflow_id: same Temporal workflow, no FK",
    );
    expect(text).toContain(
      "Lens worker-core: Reads and writes public, writes ops.job_logs. Access: depots RW, docks RW, parcels RW, parcel_events RW, temperature_readings RW, users none, sessions none, audit_events none, job_logs W",
    );
    expect(text).toContain(
      "Lens Enrichment: Fills dock_id and weight_kg. Focus: parcels, parcel_events, docks",
    );
    expect(
      schemaReadable(
        readSchema({
          ...depotSchema,
          replays: [
            {
              label: "Weight",
              steps: [{ at: ["public.parcels", "public.parcels.dock_id"], note: "Join." }],
            },
          ],
        }).model,
      ),
    ).toContain("Replay Weight: 1. parcels, parcels.dock_id: Join.");
    expect(schemaReadable(readSchema(domainModel).model)).toContain(
      "Source -> Resource: declares (one-to-many)",
    );
  });

  it("reads the rule and a table's note", () => {
    const text = schemaReadable(readSchema(oddSchema).model);
    expect(text).toContain(
      "How to read this: Keys point at what they need. A key points at its table.",
    );
    expect(text).toContain("a: id int PK. The only table.");
  });
});
