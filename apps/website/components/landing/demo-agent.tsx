import type { ReactNode, RefObject } from "react";
import {
  replyBlocks,
  streamedText,
  toolSummary,
  type AgentEntry,
  type ReplySpan,
} from "../../demo/agent-screen.ts";
import { unseenLabel } from "../../demo/scroll-follow.ts";
import { demo } from "./content.ts";

/** A summary with its counts in bold, as "Ran **2** shell commands". */
const counted = (summary: string) =>
  summary.split(/(\d+)/u).map((part, index) =>
    /^\d+$/u.test(part) ? (
      <strong key={index} className="demo-agent-count">
        {part}
      </strong>
    ) : (
      part
    ),
  );

const Span = ({ span }: { readonly span: ReplySpan }) =>
  span.kind === "code" ? (
    <code className="demo-agent-code">{span.text}</code>
  ) : span.kind === "bold" ? (
    <strong className="demo-agent-bold">{span.text}</strong>
  ) : (
    span.text
  );

/** A reply as far as it has streamed. */
function Reply({ text, shown }: { readonly text: string; readonly shown: number }) {
  return (
    <div className="demo-agent-reply">
      <span className="demo-agent-bullet" aria-hidden="true">
        ●
      </span>
      <div className="demo-agent-reply-body">
        {replyBlocks(streamedText(text, shown)).map((block, index) => (
          <div key={index} className={`demo-agent-${block.kind}`}>
            {block.kind === "item" ? <span className="demo-dim">- </span> : null}
            {block.spans.map((span, at) => (
              <Span key={at} span={span} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One entry of the agent screen. */
function Entry({
  entry,
  output,
}: {
  readonly entry: AgentEntry;
  readonly output: (text: string) => ReactNode;
}) {
  if (entry.kind === "user")
    return (
      <div className="demo-agent-user">
        <span className="demo-agent-marker" aria-hidden="true">
          ›
        </span>
        <span>{entry.text}</span>
      </div>
    );
  if (entry.kind === "assistant") return <Reply text={entry.text} shown={entry.shown} />;
  if (entry.kind === "status")
    return (
      <div className="demo-agent-status">
        <span aria-hidden="true">✻ </span>
        {entry.text}
      </div>
    );
  return (
    <div className="demo-agent-tools" data-running={entry.running}>
      <div className="demo-agent-summary">
        {counted(toolSummary(entry.calls.length, entry.running))}
      </div>
      {entry.calls.map((shown, index) => (
        <div key={index} className="demo-agent-call">
          <div className="demo-agent-detail">
            <span className="demo-agent-elbow" aria-hidden="true">
              └
            </span>
            <span>{`$ ${shown.call.command}`}</span>
          </div>
          {shown.output === undefined || shown.output.lines.length === 0 ? null : (
            <div className="demo-agent-output">
              {shown.output.lines.map((line, at) => (
                <div key={at} className="demo-line">
                  {output(line)}
                </div>
              ))}
              {shown.output.more === 0 ? null : (
                <div className="demo-dim">{`… +${shown.output.more} lines`}</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The agent mode's screen, a simplified coding agent's terminal: the session's rows over the live
 * spinner, then the input box and the mode line. `log` is the scrolling part, which the demo
 * measures and keeps at its newest row.
 */
export function AgentScreen({
  log,
  entries,
  spinner,
  draft,
  output,
  onScroll,
  unseen,
  onJump,
}: {
  readonly log: RefObject<HTMLDivElement | null>;
  readonly entries: ReadonlyArray<AgentEntry>;
  /** The live status while the agent works, or `undefined` while it waits. */
  readonly spinner: string | undefined;
  /** What is being typed into the input box. */
  readonly draft: string | undefined;
  /** Renders one line of Tack's output with its colours. */
  readonly output: (text: string) => ReactNode;
  /** Reports where the reader scrolled the log to. */
  readonly onScroll: (box: HTMLDivElement) => void;
  /** How many messages arrived below a reader who scrolled up. */
  readonly unseen: number;
  /** Takes the reader to the newest message, which the log then follows again. */
  readonly onJump: () => void;
}) {
  return (
    <div className="demo-agent">
      <div
        ref={log}
        className="demo-screen demo-agent-log"
        role="log"
        aria-label={demo.agent.screenLabel}
        onScroll={(event) => onScroll(event.currentTarget)}
      >
        <p className="demo-agent-header">{demo.agent.header}</p>
        {entries.map((entry, index) => (
          <Entry key={index} entry={entry} output={output} />
        ))}
        {spinner === undefined ? null : (
          <div className="demo-agent-status demo-agent-live" aria-hidden="true">
            <span className="demo-agent-spark">✻</span> {spinner}
          </div>
        )}
      </div>
      <div className="demo-agent-bottom">
        {unseen === 0 ? null : (
          <button type="button" className="demo-agent-unseen" onClick={onJump}>
            {unseenLabel(unseen)}
          </button>
        )}
        <div className="demo-agent-input" aria-hidden="true">
          <span className="demo-agent-marker">›</span>
          <span className="demo-command">{draft}</span>
          <span className="demo-cursor" />
        </div>
        <div className="demo-agent-footer" aria-hidden="true">
          <span className="demo-agent-mode">{demo.agent.footerMode}</span>
          <span className="demo-dim demo-agent-hint">{demo.agent.footerHint}</span>
        </div>
      </div>
    </div>
  );
}
