import { Popover } from "@base-ui/react/popover";
import { createContext, useContext, type ReactNode, type RefObject } from "react";

/**
 * Where the reader's floating panels render: the reader root, so the element defaults scoped to
 * `.tack-reader` style the controls inside them. Outside a reader, panels render on the body.
 */
export const ReaderPortalContainer = createContext<RefObject<HTMLElement | null> | undefined>(
  undefined,
);

/**
 * A button that opens a panel floating over the page, built on Base UI's popover. The panel moves
 * keyboard focus inside, closes on an outside pointer, on Escape (which returns focus to the
 * trigger) and when focus leaves it, so opening another reader popover closes this one. The panel
 * renders in a portal in the reader root, positioned against its trigger and kept in the viewport.
 * The caller styles both parts; the trigger carries `data-popup-open` while the panel is open.
 *
 * @param side - The trigger's side the panel opens on.
 * @param align - How the panel lines up with the trigger along that side.
 * @param label - Accessible name of the trigger when its visible content does not name it.
 */
export function ReaderPopover({
  summary,
  children,
  summaryClassName,
  panelClassName,
  side = "bottom",
  align = "end",
  label,
}: {
  summary: ReactNode;
  children: ReactNode;
  summaryClassName: string;
  panelClassName: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  label?: string;
}) {
  const container = useContext(ReaderPortalContainer);
  return (
    <Popover.Root>
      <Popover.Trigger className={summaryClassName} aria-label={label}>
        {summary}
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Positioner className="z-70" side={side} align={align} sideOffset={6}>
          <Popover.Popup className={panelClassName}>{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The trigger look shared by the reader's toolbar popovers, with the disclosure chevron. */
export const menuTrigger =
  "flex min-h-8 items-center gap-1.5 rounded-sm border border-transparent bg-transparent whitespace-nowrap text-body after:chevron after:ml-0.5 after:-translate-y-0.5 after:rotate-45 hover:border-rule-strong hover:bg-hover data-popup-open:border-rule-strong data-popup-open:bg-hover data-popup-open:after:translate-y-px data-popup-open:after:rotate-225";

/** The panel look shared by the reader's popovers. */
export const menuPanel =
  "grid rounded-md border border-rule-strong bg-sheet text-sm text-body shadow-lg outline-none";
