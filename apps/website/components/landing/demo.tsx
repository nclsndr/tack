import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  doneStatus,
  liveStatus,
  spinnerVerbs,
  withCall,
  withCallOutput,
  withReplyShown,
  wordCount,
  type AgentEntry,
} from "../../demo/agent-screen.ts";
import {
  agentPacing,
  agentTypingDelay,
  agentWalkthrough,
  beatFigures,
  nextStep,
  pastes,
  replyPause,
  resumeStep,
  runAgentCall,
  spinnerFigures,
} from "../../demo/agent-walkthrough.ts";
import {
  loadHistory,
  recordCommand,
  saveHistory,
  stepHistory,
} from "../../demo/command-history.ts";
import {
  acceptMenu,
  menuLine,
  moveMenu,
  openMenu,
  type CompletionMenu,
} from "../../demo/completion-menu.ts";
import type { DemoSession } from "../../demo/demo-shell.ts";
import { demoWalkthrough } from "../../demo/demo-walkthrough.ts";
import { atBottom, followAfter, following } from "../../demo/scroll-follow.ts";
import { parseAnsi } from "./ansi.ts";
import { demo } from "./content.ts";
import { AgentScreen } from "./demo-agent.tsx";
import { DemoWorkspace } from "./demo-workspace.tsx";
import { WindowEntrance } from "./hero-intro.tsx";

/** One line on the terminal: a typed command with its prompt, a line of output, or a note. */
type ScreenLine =
  | {
      readonly id: number;
      readonly kind: "command";
      readonly prompt: string;
      readonly text: string;
    }
  | { readonly id: number; readonly kind: "output"; readonly text: string }
  | { readonly id: number; readonly kind: "note"; readonly text: string };

/** A screen line before it gets its id, one variant at a time. */
type NewLine = ScreenLine extends infer Line
  ? Line extends ScreenLine
    ? Omit<Line, "id">
    : never
  : never;

/**
 * Where the demo is: loading Tack, ready to play the agent session, playing or paused, done, or
 * handed over to the visitor in the terminal.
 */
type Mode = "loading" | "ready" | "playing" | "paused" | "finished" | "terminal";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** The visit's storage, or `undefined` where the browser blocks it. */
const visitStorage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One output line with Tack's colors. */
function OutputText({ text }: { readonly text: string }) {
  return parseAnsi(text).map((span, index) => (
    <span
      key={index}
      className={[
        span.bold === true ? "demo-bold" : "",
        span.dim === true ? "demo-dim" : "",
        span.color === undefined ? "" : `demo-${span.color}`,
      ]
        .filter((name) => name !== "")
        .join(" ")}
    >
      {span.text}
    </span>
  ));
}

/**
 * Measures how many monospace columns fit `screen`, so Tack wraps its views to it. It measures
 * again when `present` turns on, which puts the element on the page.
 */
function useColumns(screen: RefObject<HTMLDivElement | null>, present: boolean) {
  const [columns, setColumns] = useState(80);
  useEffect(() => {
    const element = screen.current;
    if (element === null) return undefined;
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(50);
    probe.className = "demo-probe";
    element.append(probe);
    const measure = () => {
      const character = probe.getBoundingClientRect().width / 50;
      const style = getComputedStyle(element);
      const inner =
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (character > 0 && inner > 0)
        setColumns(Math.max(44, Math.min(100, Math.floor(inner / character) - 1)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      probe.remove();
    };
  }, [screen, present]);
  return columns;
}

/**
 * The landing page's live demo. It loads the browser build of Tack and, once its window has
 * landed, plays a coding agent setting Tack up from the landing page's prompt. Every `tack` command
 * the agent runs goes through the real CLI on one machine, which the explorer shows. At any point
 * the visitor can open a terminal on that machine: the agent stops after its running command, and
 * the terminal offers the CLI walkthrough's next step from where the agent left off.
 */
export function CliDemo() {
  const [mode, setMode] = useState<Mode>("loading");
  const [entries, setEntries] = useState<ReadonlyArray<AgentEntry>>([]);
  const [spinner, setSpinner] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [lines, setLines] = useState<ReadonlyArray<ScreenLine>>([]);
  /** The CLI walkthrough step the terminal offers next. */
  const [suggested, setSuggested] = useState(0);
  const [caption, setCaption] = useState<string>(demo.agent.intro);
  const [step, setStep] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<CompletionMenu>();
  const session = useRef<DemoSession>(undefined);
  const run = useRef(0);
  /** The agent's call running now, which opening the terminal lets finish. */
  const inFlight = useRef<Promise<number>>(undefined);
  /** How many of the agent's calls have run on the machine, which sets where the terminal resumes. */
  const callsDone = useRef(0);
  const paused = useRef(false);
  const nextId = useRef(0);
  const history = useRef<ReadonlyArray<string>>([]);
  const historyAt = useRef(0);
  const agentLog = useRef<HTMLDivElement>(null);
  const [follow, dispatchFollow] = useReducer(followAfter, following);
  const followRef = useRef(follow);
  followRef.current = follow;
  /** How many messages the agent's log held when it last grew, so a change counts what it added. */
  const shownEntries = useRef(0);
  const screen = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const agentColumns = useColumns(agentLog, mode !== "loading");
  const terminalColumns = useColumns(screen, terminalOpen);
  const agentColumnsRef = useRef(agentColumns);
  agentColumnsRef.current = agentColumns;

  const append = useCallback((line: NewLine) => {
    nextId.current += 1;
    const id = nextId.current;
    setLines((current) => [...current.slice(-600), { ...line, id }]);
  }, []);

  /** Waits out a pause; false once a newer play, a replay or the terminal has replaced `token`. */
  const holdWhilePaused = useCallback(async (token: number) => {
    while (paused.current === true) {
      await sleep(120);
      if (token !== run.current) return false;
    }
    return token === run.current;
  }, []);

  /**
   * Plays one beat of the agent walkthrough: the person's message goes through the input box, then
   * the agent's turn plays event by event under its spinner, and its tool calls run on the machine.
   * A call that started always finishes and shows its output. False when the run was replaced.
   */
  const playBeat = useCallback(
    async (index: number, token: number, animated: boolean) => {
      const beat = agentWalkthrough[index];
      if (beat === undefined) return false;
      setCaption(beat.caption);
      const figures = beatFigures(beat);
      const verbs = spinnerVerbs[index % spinnerVerbs.length] ?? spinnerVerbs[0];
      const alive = () => token === run.current;
      for (const [position, event] of beat.events.entries()) {
        if ((await holdWhilePaused(token)) === false) return false;
        if (position > 0)
          setSpinner(liveStatus(verbs.live, spinnerFigures(figures, position, beat.events.length)));
        if (event.kind === "user") {
          if (animated === true && pastes(event.text) === false) {
            for (let length = 1; length <= event.text.length; length += 1) {
              setDraft(event.text.slice(0, length));
              await sleep(agentTypingDelay(Math.random()));
              if (alive() === false) return false;
            }
          } else setDraft(event.text);
          await sleep(agentPacing.beforeSend);
          if (alive() === false) return false;
          setDraft(undefined);
          setEntries((current) => [...current, { kind: "user", text: event.text }]);
        }
        if (event.kind === "thinking") await sleep(agentPacing.thinking);
        if (event.kind === "tool-call") {
          setEntries((current) => withCall(current, event));
          await sleep(agentPacing.beforeOutput);
          const shared = session.current;
          if (alive() === false || shared === undefined) return false;
          // The agent's indented output block is a few columns narrower than its screen.
          const running = runAgentCall(shared, event, agentColumnsRef.current - 6);
          inFlight.current = running.then((result) => {
            callsDone.current += 1;
            return result.exitCode;
          });
          const result = await running;
          inFlight.current = undefined;
          setRevision((value) => value + 1);
          setEntries((current) => withCallOutput(current, result.output, agentPacing.outputLines));
          await sleep(agentPacing.afterOutput);
        }
        if (event.kind === "assistant") {
          const words = wordCount(event.text);
          setEntries((current) => [
            ...current,
            { kind: "assistant", text: event.text, shown: animated === true ? 0 : words },
          ]);
          if (animated === true)
            for (let count = 1; count <= words; count += 1) {
              await sleep(agentPacing.word);
              if (alive() === false) return false;
              setEntries((current) => withReplyShown(current, count));
            }
        }
        if (alive() === false) return false;
      }
      setSpinner(undefined);
      setEntries((current) => [
        ...current,
        { kind: "status", text: doneStatus(verbs.done, figures.seconds) },
      ]);
      const last = beat.events.at(-1);
      await sleep(replyPause(last?.kind === "assistant" ? wordCount(last.text) : 0));
      return alive();
    },
    [holdWhilePaused],
  );

  /** Plays the agent walkthrough from the start; a replay or opening the terminal stops it. */
  const play = useCallback(async () => {
    run.current += 1;
    const token = run.current;
    const animated = prefersReducedMotion() === false;
    setMode("playing");
    for (let index = 0; index < agentWalkthrough.length; index += 1) {
      if ((await holdWhilePaused(token)) === false) return;
      setStep(index);
      if ((await playBeat(index, token, animated)) === false) return;
    }
    setStep(agentWalkthrough.length);
    setCaption(demo.agent.done);
    setMode("finished");
  }, [holdWhilePaused, playBeat]);

  // Loads the browser build of Tack once the component is on screen in a browser.
  useEffect(() => {
    let cancelled = false;
    void import("../../demo/demo-shell.ts").then((loaded) => {
      if (cancelled === true) return;
      session.current = loaded.makeDemoSession();
      setMode("ready");
    });
    return () => {
      cancelled = true;
      run.current += 1;
    };
  }, []);

  // The window counts as in place once its entrance has landed.
  const [inPlace, setInPlace] = useState(false);
  const landed = useCallback(() => setInPlace(true), []);

  // The agent plays once the window is in place. Under reduced motion it waits for Play.
  useEffect(() => {
    if (mode !== "ready" || inPlace === false) return;
    if (prefersReducedMotion() === true) return;
    void play();
  }, [inPlace, mode, play]);

  // Picks up the commands this visit already ran, from before a reload.
  useEffect(() => {
    history.current = loadHistory(visitStorage());
    historyAt.current = history.current.length;
  }, []);

  // The agent's log follows its newest row while the reader is at the bottom. A reader who scrolled
  // up keeps their place while the agent goes on, and new rows below them are flagged instead.
  useEffect(() => {
    const element = agentLog.current;
    if (element !== null && followRef.current.follow === true)
      element.scrollTop = element.scrollHeight;
  }, [entries, spinner]);
  useEffect(() => {
    const added = entries.length - shownEntries.current;
    shownEntries.current = entries.length;
    if (added > 0) dispatchFollow({ kind: "grew", added });
  }, [entries]);

  /** Scrolls the agent's log to its newest row, and follows it again. */
  const jumpToNewest = () => {
    const element = agentLog.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
    dispatchFollow({ kind: "jumped" });
  };

  // The terminal always shows its newest line.
  useEffect(() => {
    const element = screen.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [lines, menu]);

  // The prompt takes the keyboard once the terminal is open and idle, without moving the page.
  useEffect(() => {
    if (mode === "terminal" && busy === false) field.current?.focus({ preventScroll: true });
  }, [mode, busy]);

  /** The caption and the typed-in line for the CLI walkthrough step `at`, once it is offered. */
  const offer = (at: number) => {
    setSuggested(at);
    const next = demoWalkthrough[at];
    setInput(next?.command ?? "");
    // A step without a caption continues the one before it, so the caption stays.
    if (next === undefined) setCaption(demo.yourTurn);
    else if (next.caption !== "") setCaption(`${demo.terminal.next} ${next.caption}`);
  };

  /**
   * Opens the terminal on the machine as the agent left it. The agent stops: a call that is running
   * finishes first, with its output; the rest of the beat does not play. The terminal then offers the
   * CLI walkthrough's step that comes next from that state.
   */
  const openTerminal = async () => {
    const stopped = mode === "playing" || mode === "paused";
    run.current += 1;
    paused.current = false;
    setDraft(undefined);
    setBusy(true);
    setMode("terminal");
    setTerminalOpen(true);
    await inFlight.current;
    setSpinner(undefined);
    if (stopped === true)
      setEntries((current) => [...current, { kind: "status", text: demo.agent.interrupted }]);
    append({ kind: "note", text: demo.terminal.note });
    offer(resumeStep(callsDone.current));
    setBusy(false);
  };

  /** Starts the agent over on a fresh machine, once any running call has finished. */
  const replay = async () => {
    run.current += 1;
    await inFlight.current;
    await session.current?.run("reset", terminalColumns);
    callsDone.current = 0;
    paused.current = false;
    setEntries([]);
    setSpinner(undefined);
    setDraft(undefined);
    setLines([]);
    setTerminalOpen(false);
    dispatchFollow({ kind: "cleared" });
    setInput("");
    setMenu(undefined);
    setCaption(demo.agent.intro);
    setRevision((value) => value + 1);
    void play();
  };

  const togglePause = () => {
    paused.current = paused.current === false;
    setMode(paused.current === true ? "paused" : "playing");
  };

  /** Runs one line the visitor typed; the walkthrough's step moves on when it was the one offered. */
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const line = input.trim();
    setInput("");
    setMenu(undefined);
    const current = session.current;
    if (busy === true || current === undefined) return;
    setBusy(true);
    append({ kind: "command", prompt: current.prompt(), text: line });
    history.current = recordCommand(history.current, line);
    historyAt.current = history.current.length;
    saveHistory(visitStorage(), history.current);
    const result = await current.run(line, terminalColumns);
    setRevision((value) => value + 1);
    if (result.clear === true) setLines([]);
    if (result.output !== "")
      result.output
        .replace(/\n$/u, "")
        .split("\n")
        .forEach((text) => append({ kind: "output", text }));
    const next = nextStep(suggested, line);
    if (next !== suggested) offer(next);
    setBusy(false);
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const moved = stepHistory(
        history.current,
        historyAt.current,
        event.key === "ArrowUp" ? -1 : 1,
      );
      historyAt.current = moved.at;
      setInput(moved.line);
      setMenu(undefined);
    }
    // With a menu listed, Tab and Shift+Tab move through it as zsh's menu does; Enter takes the
    // selection without running the line, and Escape puts back what was typed.
    if (menu !== undefined && event.key === "Tab") {
      event.preventDefault();
      const moved = moveMenu(menu, event.shiftKey === true ? -1 : 1);
      setMenu(moved);
      setInput(menuLine(moved));
      return;
    }
    if (menu !== undefined && menu.index !== -1 && event.key === "Enter") {
      event.preventDefault();
      setInput(acceptMenu(menu));
      setMenu(undefined);
      return;
    }
    if (menu !== undefined && event.key === "Escape") {
      event.preventDefault();
      setInput(menu.typed);
      setMenu(undefined);
      return;
    }
    // Tab completes what is typed; on an empty line it moves focus on, as Tab does elsewhere.
    if (event.key === "Tab" && event.shiftKey === false && input !== "") {
      event.preventDefault();
      const typed = input;
      void session.current?.complete(typed).then((completion) => {
        if (field.current?.value !== typed) return;
        setInput(completion.line);
        setMenu(completion.options.length > 1 ? openMenu(completion) : undefined);
      });
    }
    if (event.key === "l" && event.ctrlKey) {
      event.preventDefault();
      setLines([]);
    }
  };

  const total = agentWalkthrough.length;
  const handedOver = mode === "terminal";
  const prompt = session.current?.prompt() ?? "~";
  const machine = session.current?.machine();
  const controls = (
    <>
      {mode === "playing" || mode === "paused" ? (
        <button type="button" className="demo-window-button" onClick={togglePause}>
          {mode === "paused" ? demo.resume : demo.pause}
        </button>
      ) : null}
      {mode === "ready" ? (
        <button type="button" className="demo-window-button" onClick={() => void play()}>
          {demo.play}
        </button>
      ) : null}
      {mode === "finished" || mode === "terminal" ? (
        <button type="button" className="demo-window-button" onClick={() => void replay()}>
          {demo.replay}
        </button>
      ) : null}
    </>
  );

  const agent = (
    <div className="demo-terminal-area">
      <AgentScreen
        log={agentLog}
        entries={entries}
        spinner={spinner}
        draft={draft}
        output={(text) => <OutputText text={text} />}
        onScroll={(box) => dispatchFollow({ kind: "scrolled", atBottom: atBottom(box) })}
        unseen={follow.unseen}
        onJump={jumpToNewest}
      />
      {handedOver === false && mode !== "loading" ? (
        <button type="button" className="demo-takeover" onClick={() => void openTerminal()}>
          <span className="demo-takeover-key" aria-hidden="true">
            ⌨
          </span>
          {demo.openTerminal}
        </button>
      ) : null}
    </div>
  );

  const terminal = (
    <div
      className="demo-terminal-area"
      onClick={() => field.current?.focus({ preventScroll: true })}
    >
      <div ref={screen} className="demo-screen" role="log" aria-label={demo.screenLabel}>
        {lines.map((line) =>
          line.kind === "command" ? (
            <div key={line.id} className="demo-line demo-command-line">
              <span className="demo-prompt">{line.prompt} $ </span>
              <span className="demo-command">{line.text}</span>
            </div>
          ) : line.kind === "note" ? (
            <div key={line.id} className="demo-line demo-note">
              {line.text}
            </div>
          ) : (
            <div key={line.id} className="demo-line">
              <OutputText text={line.text} />
            </div>
          ),
        )}
        <form className="demo-line demo-command-line demo-input-line" onSubmit={submit}>
          <label className="demo-prompt" htmlFor="demo-input">
            {prompt} ${" "}
          </label>
          <input
            id="demo-input"
            ref={field}
            className="demo-input"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setMenu(undefined);
            }}
            onKeyDown={onInputKey}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={demo.inputLabel}
            disabled={busy}
          />
        </form>
        {menu === undefined ? null : (
          <ul className="demo-line demo-choices" role="listbox" aria-label="Completions">
            {menu.options.map((choice, index) => (
              <li
                key={choice.value}
                role="option"
                aria-selected={index === menu.index}
                title={choice.description}
                onClick={(event) => {
                  event.stopPropagation();
                  setInput(acceptMenu({ ...menu, index }));
                  setMenu(undefined);
                  field.current?.focus({ preventScroll: true });
                }}
              >
                {choice.value}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  return (
    <div id="demo" className="demo">
      <WindowEntrance onLanded={landed}>
        <DemoWorkspace
          volume={machine?.volume}
          home={machine?.home ?? "/home/you"}
          prompt={prompt}
          sessions={{
            agent: { label: demo.agent.tab, content: agent },
            terminal:
              terminalOpen === true ? { label: `zsh — ${prompt}`, content: terminal } : undefined,
          }}
          front={terminalOpen === true ? "terminal" : "agent"}
          revision={revision}
          run={handedOver === true ? { kind: "live" } : { kind: "walkthrough", step, total }}
          caption={caption}
          controls={controls}
        />
      </WindowEntrance>
    </div>
  );
}
