import { Icon } from "@tackup/reader";

const labels = { healthy: "Healthy", degraded: "Degraded", down: "Down" } as const;

/**
 * A service's state as an icon and a word. `Icon` names are checked by the compiler, and written
 * literally so the reader can find and bundle them.
 */
export function ServiceState({ state }: { state: keyof typeof labels }) {
  return (
    <span className="inline-flex items-center gap-1 font-sans text-sm">
      {state === "healthy" ? (
        <Icon name="circle-check" />
      ) : state === "degraded" ? (
        <Icon name="triangle-alert" />
      ) : (
        <Icon name="circle-x" />
      )}
      {labels[state]}
    </span>
  );
}

export const components = { ServiceState };
