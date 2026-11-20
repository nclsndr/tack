/** Shared `Schema` inputs for the tests of the model, the layout and the component. */
import type { SchemaProps } from "./schema-model.ts";

/** An invented parcel-hub schema: nine tables in three schemas. */
export const depotSchema = {
  id: "depot-schema",
  title: "Every public table chains back to depots; one key leaves its schema",
  groups: [
    { id: "public", label: "public", note: "application data" },
    { id: "auth", label: "auth", note: "Better Auth" },
    { id: "ops", label: "ops", note: "control-plane records" },
  ],
  tables: [
    {
      name: "public.depots",
      columns: [
        { name: "code", type: "text", key: "pk" },
        { name: "name", type: "text" },
        { name: "timezone", type: "text" },
      ],
    },
    {
      name: "public.docks",
      columns: [
        { name: "id", type: "bigserial", key: "pk" },
        { name: "depot", type: "text", ref: "public.depots.code" },
        { name: "designator", type: "text" },
        { name: "door_count", type: "smallint" },
      ],
    },
    {
      name: "public.parcels",
      columns: [
        { name: "id", type: "bigserial", key: "pk" },
        { name: "depot", type: "text", ref: "public.depots.code" },
        { name: "tracking_code", type: "text" },
        { name: "carrier", type: "text", nullable: true },
        {
          name: "dock_id",
          type: "bigint",
          ref: "public.docks.id",
          nullable: true,
          note: "filled by enrichment",
        },
        { name: "first_seen_at", type: "timestamptz" },
        { name: "last_seen_at", type: "timestamptz" },
      ],
    },
    {
      name: "public.parcel_events",
      columns: [
        { name: "id", type: "bigserial", key: "pk" },
        { name: "parcel_id", type: "bigint", ref: "public.parcels.id", note: "on delete cascade" },
        { name: "kind", type: "text" },
        { name: "observed_at", type: "timestamptz" },
        { name: "weight_kg", type: "numeric(5,1)", nullable: true },
        { name: "payload", type: "jsonb" },
      ],
    },
    {
      name: "public.temperature_readings",
      unique: [["depot", "observed_at"]],
      columns: [
        { name: "id", type: "bigserial", key: "pk" },
        { name: "depot", type: "text", ref: "public.depots.code" },
        { name: "observed_at", type: "timestamptz" },
        { name: "temp_c", type: "smallint", nullable: true },
        { name: "raw", type: "text" },
      ],
    },
    {
      name: "auth.users",
      columns: [
        { name: "id", type: "text", key: "pk" },
        { name: "email", type: "text", key: "unique" },
        { name: "role", type: "text" },
      ],
    },
    {
      name: "auth.sessions",
      columns: [
        { name: "id", type: "text", key: "pk" },
        { name: "user_id", type: "text", ref: "auth.users.id" },
        { name: "expires_at", type: "timestamptz" },
      ],
    },
    {
      name: "ops.audit_events",
      columns: [
        { name: "id", type: "bigserial", key: "pk" },
        { name: "actor_id", type: "text", ref: "auth.users.id" },
        { name: "action", type: "text" },
        { name: "workflow_id", type: "text" },
        { name: "outcome", type: "text", nullable: true },
      ],
    },
    {
      name: "ops.job_logs",
      columns: [
        { name: "id", type: "bigserial", key: "pk" },
        { name: "workflow_id", type: "text" },
        { name: "line", type: "text" },
      ],
    },
  ],
  links: [
    {
      from: "ops.job_logs.workflow_id",
      to: "ops.audit_events.workflow_id",
      label: "same Temporal workflow, no FK",
    },
  ],
  lenses: [
    {
      label: "worker-core",
      note: "Reads and writes public, writes ops.job_logs.",
      access: { "public.*": "read-write", "ops.job_logs": "write" },
    },
    {
      label: "collector",
      note: "Inserts parcels and their events, nothing else.",
      access: { "public.parcels": "write", "public.parcel_events": "write" },
    },
    {
      label: "Enrichment",
      note: "Fills dock_id and weight_kg.",
      focus: ["public.parcels", "public.parcel_events", "public.docks"],
    },
  ],
} satisfies SchemaProps;

/** A domain model: entities without types, related by verbs. */
export const domainModel = {
  id: "tack-terms",
  title: "A source declares resources, and a project picks some of them",
  tables: [
    { name: "Source", columns: [{ name: "name", key: "pk" }, { name: "path" }] },
    { name: "Resource", columns: [{ name: "name" }, { name: "kind" }] },
    { name: "Project", columns: [{ name: "root" }] },
  ],
  links: [
    { from: "Source", to: "Resource", label: "declares", cardinality: "one-to-many" },
    { from: "Project", to: "Resource", label: "picks", cardinality: "many-to-many" },
  ],
} satisfies SchemaProps;
