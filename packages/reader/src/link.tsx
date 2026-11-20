import { pathnameToRouteService, useNavigate } from "@rspress/core/runtime";
import { startTransition } from "react";
import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";

/**
 * Decides whether a click on a reader link can stay inside the client router.
 * @returns The in-app destination, or `undefined` when the browser must handle the click itself:
 * a modified or non-primary click, a new browsing context, a download, another origin or scheme, a
 * jump within the current page, or a same-origin address that is no reader page.
 */
function routedDestination(
  anchor: HTMLAnchorElement,
  event: Pick<
    MouseEvent,
    "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
  >,
): string | undefined {
  if (
    event.defaultPrevented === true ||
    event.button !== 0 ||
    [event.metaKey, event.ctrlKey, event.shiftKey, event.altKey].includes(true) === true ||
    (anchor.target !== "" && anchor.target !== "_self") ||
    anchor.hasAttribute("download") === true
  )
    return undefined;
  const destination = new URL(anchor.href);
  const here = window.location;
  if (destination.origin !== here.origin) return undefined;
  if (
    destination.hash !== "" &&
    destination.pathname === here.pathname &&
    destination.search === here.search
  )
    return undefined;
  if (pathnameToRouteService(destination.pathname) === undefined) return undefined;
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

/**
 * Renders an ordinary anchor that opens reader pages through the Rspress client router, so moving
 * between documents keeps the loaded reader instead of starting it again. Every other click keeps
 * its browser behavior.
 */
export function ReaderLink({ onClick, ...props }: ComponentPropsWithoutRef<"a">): ReactNode {
  const navigate = useNavigate();
  return (
    <a
      {...props}
      onClick={(event) => {
        onClick?.(event);
        const destination = routedDestination(event.currentTarget, event);
        if (destination === undefined) return;
        event.preventDefault();
        startTransition(() => {
          void navigate(destination);
        });
      }}
    />
  );
}
