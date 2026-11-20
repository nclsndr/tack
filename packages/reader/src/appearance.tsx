import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Glyph } from "./glyph.tsx";
import { ReaderTooltip } from "./tooltip.tsx";

const storageKey = "rspress-theme-appearance";
const choices = [
  { value: "auto", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

function storedPreference() {
  const stored = typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
  return choices.find((choice) => choice.value === stored)?.value ?? "auto";
}

/** Keeps the explicit appearance preference in sync with Rspress and other reader tabs. */
export function AppearanceControl() {
  const [preference, setPreference] = useState(storedPreference);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey) setPreference(storedPreference());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return (
    <div
      className="inline-flex shrink-0 gap-px rounded-sm border border-rule-strong bg-index p-px"
      role="group"
      aria-label="Appearance"
    >
      {choices.map((choice) => (
        <ReaderTooltip key={choice.value} label={choice.label}>
          <button
            type="button"
            className="min-h-5 w-5.5 justify-center rounded-xs border-transparent bg-transparent p-0 text-muted hover:bg-hover hover:text-ink aria-pressed:border-rule-strong aria-pressed:bg-sheet aria-pressed:text-ink"
            aria-label={choice.label}
            aria-pressed={preference === choice.value}
            onClick={() => {
              const oldValue = localStorage.getItem(storageKey);
              localStorage.setItem(storageKey, choice.value);
              // Rspress owns the DOM classes, resolved theme context and system-theme listener.
              // Notify its storage subscriber in this tab as well as the browser's other tabs.
              window.dispatchEvent(
                new StorageEvent("storage", {
                  key: storageKey,
                  oldValue,
                  newValue: choice.value,
                  storageArea: localStorage,
                }),
              );
            }}
          >
            <Glyph icon={choice.icon} size={13} />
          </button>
        </ReaderTooltip>
      ))}
    </div>
  );
}
