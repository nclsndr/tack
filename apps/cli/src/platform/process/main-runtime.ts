import { Runtime } from "effect";

/**
 * The signals that interrupt the CLI: Ctrl-C, a termination request, and a hang-up, which a
 * terminal sends when it closes.
 */
export const interruptSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Runs the CLI program as the process's main fiber and interrupts it on any of
 * {@link interruptSignals}, so its finalizers run before the process exits. An interrupted program
 * exits 130, as the default teardown reports it; a successful one leaves the exit to the event loop.
 */
export const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  const interrupt = () => fiber.interruptUnsafe(fiber.id);
  fiber.addObserver((exit) => {
    interruptSignals.forEach((signal) => process.off(signal, interrupt));
    teardown(exit, (code) => {
      if (code !== 0) process.exit(code);
    });
  });
  interruptSignals.forEach((signal) => process.on(signal, interrupt));
});
