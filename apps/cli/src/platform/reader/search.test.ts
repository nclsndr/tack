import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { makeReaderCorpusService } from "./search.ts";
const input = { project: { name: "demo", root: "/project" }, resources: [], issues: [] };
it.effect("loads one registered input lazily and returns shared completeness", () =>
  Effect.gen(function* () {
    let called = false;
    const result = { documents: [], resources: [], issues: [], complete: true };
    const service = makeReaderCorpusService({
      checkFigures: () => Promise.reject(new Error("unused")),
      loadProject: async (received) => {
        called = true;
        expect(received).toBe(input);
        return result;
      },
    });
    const operation = service.loadProject(input);
    expect(called).toBe(false);
    expect(yield* operation).toBe(result);
    expect(called).toBe(true);
  }),
);
it.effect("classifies configuration and unexpected corpus failures", () =>
  Effect.gen(function* () {
    for (const [error, kind] of [
      [
        Object.assign(new Error("bad config"), { name: "ReaderConfigurationError" }),
        "configuration",
      ],
      [new Error("read failed"), "read"],
      [undefined, "read"],
    ] as const) {
      const service = makeReaderCorpusService({
        loadProject: () => Promise.reject(error),
        checkFigures: () => Promise.reject(error),
      });
      expect(yield* Effect.flip(service.loadProject(input))).toMatchObject({ kind });
    }
  }),
);

it.effect("checks figures lazily and names a missing path apart from a failed read", () =>
  Effect.gen(function* () {
    const report = {
      documents: [],
      figures: 0,
      failing: 0,
      unchecked: 0,
      icons: 0,
      unknownIcons: 0,
      components: 0,
      failingComponents: 0,
    };
    let called = false;
    const service = makeReaderCorpusService({
      loadProject: () => Promise.reject(new Error("unused")),
      checkFigures: async (paths) => {
        called = true;
        expect(paths).toEqual(["docs"]);
        return report;
      },
    });
    const operation = service.checkFigures(["docs"]);
    expect(called).toBe(false);
    expect(yield* operation).toBe(report);
    for (const [error, kind] of [
      [Object.assign(new Error("no such file"), { code: "ENOENT" }), "path"],
      [new Error("unreadable"), "read"],
      ["not an error", "read"],
    ] as const) {
      const failing = makeReaderCorpusService({
        loadProject: () => Promise.reject(error),
        checkFigures: () => Promise.reject(error),
      });
      expect(yield* Effect.flip(failing.checkFigures(["x"]))).toMatchObject({ kind });
    }
  }),
);
