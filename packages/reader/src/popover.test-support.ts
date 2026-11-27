import { act } from "react";

/**
 * Lets Base UI's floating and focus effects, which run on timers and frames, settle. 20 ms covers
 * one 16 ms animation frame.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Presses on `target` the way a pointer does: down, up and click, each bubbling. */
export async function press(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await settle();
}

/** Presses one key on the focused element, or on the document when nothing is focused. */
export async function pressKey(target: Element | null, key: string): Promise<void> {
  await act(async () => {
    (target ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

/**
 * Tabs forward out of an open floating panel. jsdom does not move focus on Tab, so this focuses
 * what a browser reaches next: the focus guard Base UI places after the panel in its portal.
 */
export async function tabOut(panel: Element): Promise<void> {
  const guard = Array.from(
    document.querySelectorAll<HTMLElement>("[data-base-ui-focus-guard]"),
  ).find(
    (candidate) =>
      (panel.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 &&
      panel.contains(candidate) === false,
  );
  if (guard === undefined) throw new Error("Missing focus guard after the panel");
  await act(async () => guard.focus());
  await settle();
}
