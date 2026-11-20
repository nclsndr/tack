import { Check } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { useContext, useState } from "react";
import { Glyph } from "./glyph.tsx";
import { menuPanel, menuTrigger, ReaderPortalContainer } from "./menu.tsx";

const storageKey = "tack-reader-editor";
const editors = [
  { value: "zed", label: "Zed" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VSCode" },
] as const;

function storedEditor() {
  try {
    const stored = typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
    return editors.find((editor) => editor.value === stored) ?? editors[0];
  } catch {
    return editors[0];
  }
}

/**
 * Opens the current document in the last chosen editor, defaulting to Zed. The editors are a menu
 * of radio items: arrow keys move between them, and choosing one closes the menu on its trigger.
 */
export function EditorControl({ path }: { path: string | undefined }) {
  const [editor, setEditor] = useState(storedEditor);
  const container = useContext(ReaderPortalContainer);
  const encodedPath = path
    ?.split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return (
    <div className="flex items-center" role="group" aria-label="Open in editor">
      <a
        className="tack-editor-link inline-flex min-h-8 items-center gap-1.5 rounded-sm px-2.5 py-1 whitespace-nowrap text-body hover:bg-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50 max-md:pl-0"
        href={encodedPath === undefined ? undefined : `${editor.value}://file${encodedPath}:1`}
        aria-disabled={path === undefined ? true : undefined}
      >
        Open in {editor.label}
      </a>
      <Menu.Root modal={false}>
        <Menu.Trigger className={`${menuTrigger} min-w-7 justify-center px-2 py-1`}>
          <span className="sr-only">Choose editor</span>
        </Menu.Trigger>
        <Menu.Portal container={container}>
          <Menu.Positioner className="z-70" side="bottom" align="end" sideOffset={6}>
            <Menu.Popup className={`${menuPanel} w-40 gap-0.5 p-1`}>
              <Menu.RadioGroup
                value={editor.value}
                onValueChange={(value: unknown) => {
                  const choice = editors.find((candidate) => candidate.value === value);
                  // Coverage skip: the group only reports the values of the items it renders.
                  /* v8 ignore next -- @preserve */
                  if (choice === undefined) return;
                  setEditor(choice);
                  try {
                    window.localStorage.setItem(storageKey, choice.value);
                  } catch {
                    // Keep the editor usable when the browser disallows preference storage.
                  }
                }}
              >
                {editors.map((choice) => (
                  <Menu.RadioItem
                    key={choice.value}
                    value={choice.value}
                    closeOnClick
                    className="flex min-h-8 cursor-pointer items-center justify-between rounded-sm px-2.5 py-1 text-sm text-body outline-none select-none data-checked:text-pen data-highlighted:bg-hover"
                  >
                    {choice.label}
                    <Menu.RadioItemIndicator className="inline-flex">
                      <Glyph icon={Check} />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
