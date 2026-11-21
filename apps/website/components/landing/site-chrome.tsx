import { useEffect, useRef, useState } from "react";
import { closing } from "./content.ts";
import { Mark } from "./mark.tsx";

/** The docs' home. */
export const docsHref = "/docs/";

/** The page that walks through every feature. */
export const featuresHref = "/features";

/** The docs page that walks through installing Tack and the first commands. */
export const gettingStartedHref = `${docsHref}getting-started`;

/**
 * Whether the page has scrolled past `marker`, a strip at its top: the header floats as a card from
 * then on. The strip's place is read at most once a frame while the page scrolls, and once at the
 * start. An observer would miss the scroll the docs router restores after a reload, which leaves
 * the header flat over the content.
 */
function useScrolledPast(marker: { readonly current: HTMLElement | null }) {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const element = marker.current;
    if (element === null) return undefined;
    let frame = 0;
    const read = () => {
      frame = 0;
      setPast(element.getBoundingClientRect().bottom <= 0);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", schedule, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
    };
  }, [marker]);
  return past;
}

/** Without JavaScript nothing watches the scroll, so the card floats from the start. */
const headerFallback =
  ".landing-header-bar::before{opacity:1!important;transform:none!important;box-shadow:var(--landing-card-shadow-raised)!important}";

/**
 * Where the header's links go. The landing page jumps within itself; every other page links back
 * to the landing page's demo and sends Get started to the docs.
 */
const headerLinks = {
  landing: { demo: "#demo", start: "#get-started" },
  features: { demo: "/#demo", start: gettingStartedHref },
} as const;

/**
 * The site header. It stays at the top of the screen as the page scrolls, as the docs navigation
 * does. At the top of the page it sits flush on the content; once the page leaves the top, a card
 * pops out behind it. `page` names the page it sits on, which its links and current link follow.
 */
export function SiteHeader({ page }: { readonly page: keyof typeof headerLinks }) {
  const marker = useRef<HTMLSpanElement>(null);
  const floating = useScrolledPast(marker);
  const links = headerLinks[page];
  return (
    <>
      <span ref={marker} className="landing-header-marker" aria-hidden="true" />
      <noscript>
        <style>{headerFallback}</style>
      </noscript>
      <header className="landing-header" data-floating={floating === true ? "true" : "false"}>
        <div className="landing-header-bar landing-shell">
          <a href="/" className="landing-wordmark" aria-label="Tack home">
            <Mark className="landing-mark" />
            <span>tack</span>
          </a>
          <nav aria-label="Main" className="landing-nav">
            <a href={links.demo}>Demo</a>
            <a href={featuresHref} aria-current={page === "features" ? "page" : undefined}>
              Features
            </a>
            <a href={docsHref}>Docs</a>
          </nav>
          <a href={links.start} className="landing-button landing-button-primary">
            Get started
          </a>
        </div>
      </header>
    </>
  );
}

/** The site footer: the wordmark, the closing line and the docs. */
export function SiteFooter() {
  return (
    <footer className="landing-footer">
      <div className="landing-shell landing-footer-row">
        <a href="/" className="landing-wordmark" aria-label="Tack home">
          <Mark className="landing-mark" />
          <span>tack</span>
        </a>
        <p>{closing.footerLine}</p>
        <a href={docsHref}>Docs</a>
      </div>
    </footer>
  );
}
