import { agentPrompt } from "@tackup/harness/prompts/landing";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { demoWalkthrough } from "../../demo/demo-walkthrough.ts";
import { Terminal } from "../terminal.tsx";
import { closing, demo, features, getStarted, hero, questions, story } from "./content.ts";
import { CliDemo } from "./demo.tsx";
import { DemoLinksProvider } from "./demo-links.tsx";
import { DraftingSheet } from "./drafting-sheet.tsx";
import { Features } from "./features.tsx";
import { HeroField } from "./hero-field.tsx";
import {
  HeroCopy,
  HeroFollow,
  HeroHeadline,
  HeroPin,
  HeroSheet,
  IntroFallback,
} from "./hero-intro.tsx";
import { InlineCode } from "./inline-code.tsx";
import { Mark } from "./mark.tsx";
import { Story } from "./story.tsx";

const docsHref = "/docs/";

/** Copies text to the clipboard and reports the result in a live region. */
function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [status, setStatus] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied.");
    } catch {
      setStatus("Select the text to copy it.");
    }
  };
  return (
    <span className="landing-copy">
      <button type="button" className="landing-button landing-button-quiet" onClick={copy}>
        {label}
      </button>
      <span role="status" aria-live="polite" className="landing-copy-status">
        {status}
      </span>
    </span>
  );
}

/** Moves the selection through a tab list with the arrow, Home and End keys. */
function nextTab(event: KeyboardEvent, index: number, count: number) {
  if (event.key === "ArrowRight" || event.key === "ArrowDown") return (index + 1) % count;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") return (index - 1 + count) % count;
  if (event.key === "Home") return 0;
  if (event.key === "End") return count - 1;
  return undefined;
}

/** A labelled set of tabs, each showing one panel. */
function Tabs({
  label,
  tabs,
  className,
}: {
  readonly label: string;
  readonly tabs: readonly { id: string; title: string; panel: ReactNode }[];
  readonly className: string;
}) {
  const [selected, setSelected] = useState(0);
  const select = (index: number) => {
    setSelected(index);
    document.getElementById(`${tabs[index]?.id}-tab`)?.focus();
  };
  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="landing-tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${tab.id}-tab`}
            type="button"
            role="tab"
            aria-selected={index === selected}
            aria-controls={`${tab.id}-panel`}
            tabIndex={index === selected ? 0 : -1}
            className="landing-tab"
            onClick={() => setSelected(index)}
            onKeyDown={(event) => {
              const next = nextTab(event, index, tabs.length);
              if (next === undefined) return;
              event.preventDefault();
              select(next);
            }}
          >
            {tab.title}
          </button>
        ))}
      </div>
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          id={`${tab.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${tab.id}-tab`}
          hidden={index !== selected}
          className="landing-tabpanel"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}

function Header() {
  return (
    <header className="landing-header landing-shell">
      <a href="/" className="landing-wordmark" aria-label="Tack home">
        <Mark className="landing-mark" />
        <span>tack</span>
      </a>
      <nav aria-label="Main" className="landing-nav">
        <a href="#demo">Demo</a>
        <a href="#features">Features</a>
        <a href={docsHref}>Docs</a>
      </nav>
      <a href="#get-started" className="landing-button landing-button-primary">
        Get started
      </a>
    </header>
  );
}

/**
 * The opening, on a blueprint sheet: the headline beside one line and the two buttons, centred in
 * the first screen over a strip of the demo window. As the page scrolls, the hero holds the screen
 * while the copy rises toward the top and the window rises to meet it and comes upright under a
 * drafting lamp; then the page scrolls on. The links the demo makes are drawn on the sheet around
 * the window. The intro and the scroll are timed in `hero-intro-timeline.ts`.
 */
function Hero() {
  return (
    <section className="landing-hero" aria-labelledby="hero-title">
      <IntroFallback />
      <HeroPin>
        <DemoLinksProvider>
          <HeroSheet />
          <HeroField />
          <HeroCopy>
            <div className="landing-shell landing-hero-grid">
              <HeroHeadline id="hero-title" text={hero.headline} />
              <div className="landing-hero-aside">
                <HeroFollow part="lead">
                  <p className="landing-lead">{hero.subhead}</p>
                </HeroFollow>
                <HeroFollow part="actions" className="landing-actions">
                  <a href="#get-started" className="landing-button landing-button-primary">
                    Get started
                  </a>
                  <CopyButton text={agentPrompt} label="Copy the agent prompt" />
                </HeroFollow>
              </div>
            </div>
          </HeroCopy>
          <div className="landing-shell">
            <CliDemo />
          </div>
        </DemoLinksProvider>
      </HeroPin>
    </section>
  );
}

/**
 * The two sections after the hero, on one blueprint sheet that carries on from the hero's: the
 * features, one lens each, then the pinned story plate, the metaphor of what they said.
 */
function AfterHero() {
  return (
    <DraftingSheet>
      <Features />
      <Story />
    </DraftingSheet>
  );
}

function GetStarted() {
  return (
    <section id="get-started" className="landing-section" aria-labelledby="start-title">
      <div className="landing-shell landing-start">
        <div>
          <p className="landing-label">Get started</p>
          <h2 id="start-title">{getStarted.heading}</h2>
          <p className="landing-note">{getStarted.note}</p>
        </div>
        <Tabs
          label="Ways to start"
          className="landing-start-tabs"
          tabs={[
            {
              id: "start-agent",
              title: "Ask your agent",
              panel: (
                <>
                  <blockquote className="landing-prompt">
                    <InlineCode text={agentPrompt} />
                  </blockquote>
                  <CopyButton text={agentPrompt} label="Copy the prompt" />
                </>
              ),
            },
            {
              id: "start-manual",
              title: "Do it yourself",
              panel: (
                <>
                  <p>{getStarted.manualIntro}</p>
                  <Terminal commands={getStarted.commands} />
                  <CopyButton text={getStarted.commands.join("\n")} label="Copy the commands" />
                </>
              ),
            },
          ]}
        />
      </div>
    </section>
  );
}

function Questions() {
  return (
    <section className="landing-section" aria-labelledby="questions-title">
      <div className="landing-shell landing-questions">
        <h2 id="questions-title">Questions</h2>
        <div>
          {questions.map((item) => (
            <details key={item.question}>
              <summary>{item.question}</summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="landing-section landing-closing" aria-labelledby="closing-title">
      <div className="landing-shell">
        <h2 id="closing-title">{closing.heading}</h2>
        <p>{closing.text}</p>
        <a href="#get-started" className="landing-button landing-button-primary">
          Get started
        </a>
      </div>
    </section>
  );
}

function Footer() {
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

/** The Markdown twin of the landing page: the same copy, without layout or illustrations. */
function LandingMarkdown() {
  const walkthrough = demoWalkthrough.map((step) => `$ ${step.command}`).join("\n");
  const metaphor = story.beats
    .map((beat) => `- **${beat.title}** ${beat.text} \`${beat.proof}\``)
    .join("\n");
  const lens = (block: {
    readonly title: string;
    readonly lines: ReadonlyArray<string>;
    readonly note?: string;
    readonly proof: string;
  }) =>
    `### ${block.title}\n\n${[...block.lines, ...(block.note === undefined ? [] : [block.note])].join(" ")}\n\n\`\`\`sh\n${block.proof}\n\`\`\``;
  const featureList = [features.agents, features.team, features.docs].map(lens).join("\n\n");
  const also = features.also.items
    .map((item) => `- **${item.title}** ${item.text} \`${item.proof}\``)
    .join("\n");
  const answers = questions.map((item) => `- **${item.question}** ${item.answer}`).join("\n");
  return (
    <>
      {`# Tack: ${hero.headline}

${hero.subhead}

## ${demo.heading}

${demo.agent.intro}

${demo.markdown}

\`\`\`sh
${walkthrough}
\`\`\`

## ${features.heading}

${features.intro}

${featureList}

### ${features.also.heading}

${also}

## ${story.heading}

${story.intro}

${metaphor}

## Get started

Paste this prompt into your coding agent:

> ${agentPrompt}

Or run the commands yourself. ${getStarted.manualIntro}

\`\`\`sh
${getStarted.commands.join("\n")}
\`\`\`

${getStarted.note}

## Questions

${answers}

Read the docs: [${docsHref}](${docsHref})
`}
    </>
  );
}

/** The Tack landing page. It is always dark, whatever theme the docs use. */
export function Landing() {
  if (import.meta.env.SSG_MD === true) return <LandingMarkdown />;
  return (
    <div className="tack-theme-dark landing">
      <a href="#main" className="landing-skip">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <Hero />
        <AfterHero />
        <GetStarted />
        <Questions />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
