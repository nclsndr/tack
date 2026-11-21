import { plainAnsi } from "./landing/ansi.ts";
import { AnsiText } from "./landing/ansi-text.tsx";

type TerminalProps = {
  /** The commands typed at the prompt, one per line. */
  readonly commands: readonly string[];
  /**
   * What the commands print. Omit it for commands shown without their output. SGR style sequences
   * (`ESC[...m`) draw in Tack's colors, as in the demo terminal.
   */
  readonly output?: string;
  /** The label in the window bar. */
  readonly title?: string;
};

/** The text a terminal shows: each command after a `$` prompt, then the output. */
function terminalText({
  commands,
  output,
}: {
  readonly commands: readonly string[];
  readonly output?: string | undefined;
}) {
  return [
    ...commands.map((command) => `$ ${command}`),
    ...(output === undefined ? [] : [plainAnsi(output)]),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * A command and its output in a dark terminal window, in both themes. The Markdown twin gets the
 * same text, without styles, as a plain `text` code fence.
 */
export function Terminal({ commands, output, title = "Terminal" }: TerminalProps) {
  if (import.meta.env.SSG_MD === true)
    return <>{`\n\`\`\`text\n${terminalText({ commands, output })}\n\`\`\`\n`}</>;
  return (
    <figure className="tack-terminal">
      <figcaption className="tack-terminal-bar">
        <span className="tack-terminal-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>{title}</span>
      </figcaption>
      <pre>
        <code>
          {commands.map((command, index) => (
            <span key={index}>
              <span className="tack-terminal-prompt">$ </span>
              <span className="tack-terminal-command">{command}</span>
              {"\n"}
            </span>
          ))}
          {output === undefined ? null : (
            <span className="tack-terminal-output">
              <AnsiText text={output.trimEnd()} />
            </span>
          )}
        </code>
      </pre>
    </figure>
  );
}
