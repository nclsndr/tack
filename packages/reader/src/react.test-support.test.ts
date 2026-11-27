// @vitest-environment jsdom
import { createElement, useEffect, useState } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testRoot, waitForReact } from "./react.test-support.ts";

const ui = testRoot();

/** Renders `text`, and records its mount and unmount. */
function Probe(props: { readonly text: string; readonly log: string[] }): string {
  useEffect(() => {
    props.log.push(`mount ${props.text}`);
    return () => {
      props.log.push(`unmount ${props.text}`);
    };
  }, [props]);
  return props.text;
}

describe("testRoot", () => {
  let previous: HTMLDivElement | undefined;

  it("renders into a container attached to the document, with the act environment declared", async () => {
    expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(true);
    expect(ui.container.isConnected).toBe(true);
    const log: string[] = [];
    await ui.render(createElement(Probe, { text: "one", log }));
    expect(ui.container.textContent).toBe("one");
    expect(log).toEqual(["mount one"]);
    previous = ui.container;
  });

  it("gives the next test a new container and removes the previous one", () => {
    expect(previous?.isConnected).toBe(false);
    expect(previous?.textContent).toBe("");
    expect(ui.container).not.toBe(previous);
    expect(ui.container.childElementCount).toBe(0);
  });

  it("unmounts once when called twice, and renders again in a new root", async () => {
    const log: string[] = [];
    await ui.render(createElement(Probe, { text: "one", log }));
    await ui.unmount();
    await ui.unmount();
    expect(ui.container.textContent).toBe("");
    await ui.render(createElement(Probe, { text: "two", log }));
    expect(ui.container.textContent).toBe("two");
    expect(log).toEqual(["mount one", "unmount one", "mount two"]);
  });

  afterAll(() => {
    expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBeUndefined();
    expect(() => ui.container).toThrow("No test is running");
  });
});

describe("waitForReact", () => {
  it("returns immediately when the assertion already passes", async () => {
    const assertion = vi.fn();
    await waitForReact(assertion);
    expect(assertion).toHaveBeenCalledOnce();
  });

  it("rethrows the assertion error when its deadline expires", async () => {
    const error = new Error("still waiting");
    await expect(
      waitForReact(
        () => {
          throw error;
        },
        { timeout: 0 },
      ),
    ).rejects.toBe(error);
  });

  it("flushes asynchronous React updates before retrying the DOM assertion", async () => {
    function Delayed(): string {
      const [text, setText] = useState("waiting");
      useEffect(() => {
        const timer = setTimeout(() => setText("ready"), 10);
        return () => clearTimeout(timer);
      }, []);
      return text;
    }
    await ui.render(createElement(Delayed));
    expect(ui.container.textContent).toBe("waiting");
    await waitForReact(() => expect(ui.container.textContent).toBe("ready"));
  });
});
