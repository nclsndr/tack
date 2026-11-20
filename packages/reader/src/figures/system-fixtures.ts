/** Shared `System` inputs for the tests of the model, the layout and the component. */
import type { SystemProps } from "./system-model.ts";

/** The capture path of the phase brief: the example every `System` test starts from. */
export const capturePath = {
  id: "capture-path",
  title: "An event leaves Redis only after Postgres has it",
  nodes: [
    { id: "feed", label: "Carrier tracking feed", kind: "external" },
    {
      id: "collector",
      label: "collector",
      kind: "service",
      detail: "headless browser + WebSocket",
      group: "browser",
    },
    {
      id: "redis",
      label: "Redis stream",
      kind: "queue",
      detail: "about 1 day at 3 GB",
      about: "Holds only the backlog not yet written to Postgres.",
    },
    { id: "consumer", label: "worker-core", kind: "service", detail: "consumer" },
    { id: "pg", label: "Postgres", kind: "store", lines: ["public.parcel_events"] },
  ],
  groups: [{ id: "browser", label: "worker-browser (untrusted)" }],
  links: [
    { id: "capture", from: "feed", to: "collector", label: "parcel events" },
    { id: "xadd", from: "collector", to: "redis", label: "XADD" },
    { id: "read", from: "redis", to: "consumer", label: "XREADGROUP" },
    { id: "insert", from: "consumer", to: "pg", label: "INSERT" },
    { id: "ack", from: "consumer", to: "redis", label: "ack + delete", kind: "reply" },
  ],
  replays: [
    {
      label: "One event",
      steps: [
        { at: ["feed", "capture", "collector"], note: "The collector receives the event." },
        { at: ["xadd", "redis"], note: "It waits in the stream." },
        { at: ["read", "consumer", "insert", "pg"], note: "The consumer inserts it." },
        { at: ["ack"], note: "Only then is the entry acknowledged and deleted." },
      ],
    },
  ],
  lenses: [
    {
      label: "Postgres down",
      note: "Capture continues. Events wait in Redis.",
      focus: ["collector", "xadd", "redis"],
      broken: ["pg", "insert"],
    },
  ],
} satisfies SystemProps;
