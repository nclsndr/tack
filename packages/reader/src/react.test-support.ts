import { act } from "react";

/** Waits for a synchronous React assertion, covering every elapsed wait with act. */
export async function waitForReact(
  assertion: () => void,
  options: { timeout?: number } = {},
): Promise<void> {
  const deadline = performance.now() + (options.timeout ?? 1_000);
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (performance.now() >= deadline) throw error;
    }
    // Exit act between attempts so React commits before the next DOM assertion.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}
