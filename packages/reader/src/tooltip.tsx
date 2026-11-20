import { Tooltip } from "@base-ui/react/tooltip";
import { useContext, type ReactElement, type ReactNode } from "react";
import { ReaderPortalContainer } from "./menu.tsx";

/**
 * Names an icon-only control on hover and keyboard focus, with the shortcut when it has one. The
 * tooltip is a visual label only: the control keeps its own `aria-label`, which should say the
 * same thing. Built on Base UI's tooltip, it renders in the reader root like the reader's popovers.
 *
 * @param label - The visible label; the trigger also carries it as `data-reader-tooltip-trigger`.
 * @param children - The control itself, which keeps its props, ref and handlers.
 */
export function ReaderTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}): ReactNode {
  const container = useContext(ReaderPortalContainer);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} data-reader-tooltip-trigger={label} />
      <Tooltip.Portal container={container}>
        <Tooltip.Positioner className="z-80" sideOffset={6}>
          <Tooltip.Popup
            data-reader-tooltip=""
            className="rounded-sm bg-ink px-2 py-1 font-sans text-xs whitespace-nowrap text-paper shadow-lg"
          >
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
