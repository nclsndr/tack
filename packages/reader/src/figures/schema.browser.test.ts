// @vitest-environment jsdom
import { resolve } from "node:path";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { interactionContext } from "../browser.ts";
import { Schema } from "./schema.tsx";
import type { SchemaProps } from "./schema-model.ts";
import { depotSchema, domainModel } from "./schema-fixtures.ts";
import { checkFigures, staticFigures } from "./check.ts";
import { NotStatic } from "./static-props.ts";
import { testRoot, waitForReact } from "../react.test-support.ts";

const ui = testRoot();

beforeEach(() => {
  window.history.replaceState(null, "", "/schema");
});

/** Renders a `Schema` and waits until its drawing is laid out. */
async function render(input: SchemaProps = depotSchema): Promise<HTMLElement> {
  await ui.render(createElement(Schema, input));
  // The first layout loads the engine, which can take a few seconds on a busy machine.
  await waitForReact(
    () => {
      expect(ui.container.querySelector(".tack-schema svg.tack-map")).not.toBeNull();
    },
    { timeout: 15_000 },
  );
  const figure = ui.container.querySelector<HTMLElement>("figure.tack-figure");
  if (figure === null) throw new Error("no figure");
  return figure;
}

const card = (name: string): SVGGElement => {
  const found = ui.container.querySelector<SVGGElement>(`.tack-schema-card[data-box="${name}"]`);
  if (found === null) throw new Error(`no card ${name}`);
  return found;
};
const relation = (id: string): SVGPathElement => {
  const found = ui.container.querySelector<SVGPathElement>(
    `.tack-map-links .tack-map-link[data-link="${id}"]`,
  );
  if (found === null) throw new Error(`no relation ${id}`);
  return found;
};
const chip = (name: string): HTMLButtonElement => {
  const found = [...ui.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};
const click = async (element: Element): Promise<void> => {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const panel = (): string => ui.container.querySelector(".tack-figure-panel")?.textContent ?? "";

describe("Schema", () => {
  it("draws table cards with key marks, types and notes, in tinted groups on a dot grid", async () => {
    const figure = await render();
    expect(figure.dataset["figureKind"]).toBe("schema");
    expect(figure.dataset["ground"]).toBe("dot-grid");
    expect(
      [...ui.container.querySelectorAll(".tack-schema-group text")].map((text) => text.textContent),
    ).toEqual([
      "public",
      "application data",
      "auth",
      "Better Auth",
      "ops",
      "control-plane records",
    ]);
    const parcels = card("public.parcels");
    expect(parcels.dataset["tint"]).toBe("0");
    expect(parcels.querySelector(".tack-schema-name")?.textContent).toBe("parcels");
    expect(
      [...parcels.querySelectorAll(".tack-schema-row")].map((row) => [
        row.querySelector(".tack-schema-key")?.textContent ?? "",
        row.querySelector(".tack-schema-column")?.textContent,
        row.querySelector(".tack-schema-type")?.textContent,
        row.querySelector(".tack-schema-note")?.textContent ?? "",
      ]),
    ).toEqual([
      ["PK", "id", "bigserial", ""],
      ["FK", "depot", "text", ""],
      ["", "tracking_code", "text", ""],
      ["", "carrier?", "text", ""],
      ["FK", "dock_id?", "bigint", "filled by enrichment"],
      ["", "first_seen_at", "timestamptz", ""],
      ["", "last_seen_at", "timestamptz", ""],
    ]);
    expect(
      card("auth.users").querySelector(".tack-schema-key[data-key='unique']")?.textContent,
    ).toBe("UQ");
    expect(card("public.temperature_readings").textContent).toContain(
      "unique (depot, observed_at)",
    );
    // Every relation at rest, a key solid with its crow's foot, the non-key link dashed and labelled.
    expect(relation("key-1").dataset).toMatchObject({ kind: "rest", style: "solid" });
    expect(relation("link-1").dataset).toMatchObject({ kind: "rest", style: "dashed" });
    expect(
      ui.container.querySelector('.tack-map-link-label[data-link="link-1"]')?.textContent,
    ).toBe("same Temporal workflow, no FK");
    expect(ui.container.querySelectorAll(".tack-schema-marks")).toHaveLength(7);
    expect(
      [...ui.container.querySelectorAll(".tack-figure-legend li")].map((item) => item.textContent),
    ).toEqual([
      "public",
      "auth",
      "ops",
      "PKprimary key",
      "FKforeign key",
      "UQunique",
      "?nullable",
      "foreign key, many to one",
      "not a key",
      "RWread and write",
      "Rread",
      "Wwrite",
      "no access",
    ]);
  });

  it("inks a pinned table, what it references and what references it, and says so", async () => {
    await render();
    await click(card("public.parcels"));
    expect(card("public.parcels").dataset["ink"]).toBe("focus");
    expect(
      ["public.depots", "public.docks", "public.parcel_events"].map(
        (name) => card(name).dataset["ink"],
      ),
    ).toEqual(["near", "near", "near"]);
    expect(card("auth.users").dataset["ink"]).toBe("off");
    expect(relation("key-2").dataset["kind"]).toBe("out");
    expect(relation("key-4").dataset["kind"]).toBe("in");
    expect(relation("key-6").dataset["kind"]).toBe("fade");
    expect(panel()).toContain(
      "parcels references depots (depot -> code), docks (dock_id -> id). Referenced by parcel_events (parcel_id -> id).",
    );
    expect(new URL(window.location.href).searchParams.get("reader.depot-schema.pin")).toBe(
      "public.parcels",
    );
  });

  it("stamps what a role may do and hatches what it may not touch", async () => {
    const figure = await render();
    await click(chip("worker-core"));
    expect(card("public.parcels").querySelector(".tack-schema-stamp")?.textContent).toBe("RW");
    expect(card("ops.job_logs").querySelector(".tack-schema-stamp")?.textContent).toBe("W");
    expect(card("auth.users").dataset["ink"]).toBe("blocked");
    expect(card("auth.users").querySelector(".tack-map-blocked")).not.toBeNull();
    expect(card("public.parcels").dataset["ink"]).toBe("near");
    expect(figure.textContent).toContain("Reads and writes public, writes ops.job_logs.");
    await click(chip("collector"));
    expect(
      [...ui.container.querySelectorAll(".tack-schema-stamp")].map((stamp) => stamp.textContent),
    ).toEqual(["W", "W"]);
    expect(card("public.depots").dataset["ink"]).toBe("blocked");
    expect(interactionContext(figure).state).toEqual({
      "depot-schema": { pin: null, case: "collector", step: null },
    });
  });

  it("keeps the tables of a focus lens inked and fades the rest", async () => {
    await render();
    await click(chip("Enrichment"));
    expect(card("public.docks").dataset["ink"]).toBe("near");
    expect(card("public.depots").dataset["ink"]).toBe("off");
    expect(ui.container.querySelector(".tack-schema-stamp")).toBeNull();
  });

  it("replays the tables a query touches and marks the columns it names", async () => {
    await render({
      ...depotSchema,
      replays: [
        {
          label: "Weight by dock",
          steps: [
            { at: ["public.parcel_events.weight_kg"], note: "Read the weight of each event." },
            { at: ["public.parcels", "public.parcels.dock_id"], note: "Join its parcel." },
          ],
        },
      ],
    });
    await click(chip("Weight by dock"));
    expect(card("public.parcel_events").dataset["ink"]).toBe("focus");
    expect(
      card("public.parcel_events").querySelector(".tack-schema-row[data-lit]")?.textContent,
    ).toContain("weight_kg");
    expect(panel()).toContain("parcel_events.weight_kg");
    expect(panel()).not.toContain("public.parcel_events.weight_kg");
    await click(chip("Next"));
    expect(card("public.parcel_events").dataset["ink"]).toBe("visited");
    expect(card("public.parcels").dataset["ink"]).toBe("focus");
    expect(card("public.depots").dataset["ink"]).toBe("dim");
    expect(relation("key-4").dataset["kind"]).toBe("trace");
    expect(relation("key-1").dataset["kind"]).toBe("fade");
  });

  it("draws a domain model as entity cards with verb-labelled relations and crow's feet", async () => {
    const figure = await render(domainModel);
    expect(figure.querySelector(".tack-schema-drawing")?.getAttribute("data-entities")).toBe("");
    expect(card("Resource").querySelector(".tack-schema-type")).toBeNull();
    expect(card("Resource").querySelector(".tack-schema-key")).toBeNull();
    expect(card("Source").querySelector(".tack-schema-key")?.textContent).toBe("PK");
    expect(
      [...ui.container.querySelectorAll(".tack-map-link-label")].map((label) => label.textContent),
    ).toEqual(["declares", "picks"]);
    expect(relation("link-1").dataset["style"]).toBe("solid");
    expect(ui.container.querySelectorAll(".tack-schema-marks")).toHaveLength(2);
    expect(figure.dataset["readerReadable"]).toContain(
      "Source -> Resource: declares (one-to-many)",
    );
  });

  it("shows an entity's note on its card and names a pinned entity outside any group", async () => {
    const figure = await render({
      ...domainModel,
      summary: "Three terms.",
      tables: domainModel.tables.map((table) =>
        table.name === "Resource" ? { ...table, note: "one skill, command or doc" } : table,
      ),
    });
    expect(figure.querySelector(".tack-figure-summary")?.textContent).toBe("Three terms.");
    expect(card("Resource").querySelector(".tack-schema-note")?.textContent).toBe(
      "one skill, command or doc",
    );
    await click(card("Resource"));
    expect(panel()).toContain("Pinned, an entity");
    expect(panel()).not.toContain(" in ");
    expect(ui.container.querySelector(".tack-figure-panel code")?.textContent).toBe(
      "one skill, command or doc",
    );
  });

  it("leaves the primary key out of the legend of a schema without one", async () => {
    await render({
      id: "keyless",
      title: "A log table has no primary key",
      tables: [{ name: "public.log", columns: [{ name: "line", type: "text" }] }],
    });
    expect(
      [...ui.container.querySelectorAll(".tack-figure-legend li")].map((item) => item.textContent),
    ).not.toContain("primary key");
  });

  it("offers the start tables as chips that pin them", async () => {
    await render({ ...depotSchema, startWith: ["public.parcels"] });
    await click(chip("parcels"));
    expect(card("public.parcels").dataset["ink"]).toBe("focus");
  });

  it("releases a pin on the ground and on Escape", async () => {
    const figure = await render();
    await click(card("auth.users"));
    expect(panel()).toContain("Pinned, a table in auth");
    const drawing = ui.container.querySelector(".tack-schema-drawing");
    if (drawing === null) throw new Error("no drawing");
    await click(drawing);
    expect(figure.dataset["readerState"]).toBe('{"pin":null,"case":null,"step":null}');
    await click(card("auth.users"));
    await act(async () =>
      figure.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(figure.dataset["readerState"]).toBe('{"pin":null,"case":null,"step":null}');
  });

  it("lists the same issue lines as the figure check, once laid out", async () => {
    const broken = resolve(import.meta.dirname, "../../fixtures/figures/broken-figures.mdx");
    const figures = await staticFigures(broken);
    const index = figures.findIndex((figure) => figure.component === "Schema");
    const found = figures[index];
    if (found === undefined || found.props instanceof NotStatic) throw new Error("no Schema");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Statically read props are untyped by design; the component reads them leniently.
    const figure = await render(found.props as SchemaProps);
    const report = await checkFigures([broken]);
    const result = report.documents[0]?.figures[index];
    expect(result?.status).toBe("issues");
    expect(JSON.parse(figure.dataset["figureIssues"] ?? "[]")).toEqual(
      result?.status === "issues" ? result.issues : [],
    );
  });
});
