import { motion } from "motion/react";
import { Fragment, type ReactNode } from "react";
import { corners, settle } from "../landing/drafting-sheet.tsx";
import { Illustration } from "../landing/illustration.tsx";
import {
  agentsFigure,
  docsFigure,
  type LensId,
  profileFigure,
  projectFigure,
  scriptFigure,
  sourceFigure,
} from "./content.ts";

/** The delay of the `index`th row of a figure, so the rows land one after another. */
const rowDelay = (index: number) => 0.18 + index * 0.07;

/** A path that may break only after a slash, never inside a name. */
function PathText({ path }: { readonly path: string }) {
  const parts = path.split("/");
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 ? (
        <>
          /<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

/**
 * One row of a link figure: a plus mark, a path and the label on its right. A `root` leads the
 * path, drawn fainter, when the rows share one path in different folders.
 */
type Row = { readonly path: string; readonly tag: string; readonly root?: string };

/** A link figure's rows, each landing after the one before it from `start`. */
function Rows({ rows, start = 0 }: { readonly rows: ReadonlyArray<Row>; readonly start?: number }) {
  return (
    <ol>
      {rows.map((row, index) => (
        <motion.li
          key={`${row.path} ${row.tag}`}
          className="links-row"
          data-intro=""
          variants={settle(rowDelay(start + index), 0)}
        >
          <span className="links-mark" aria-hidden="true" />
          <code>
            {row.root === undefined ? null : (
              <span className="fp-root">
                <PathText path={`${row.root}/`} />
              </span>
            )}
            <PathText path={row.path} />
          </code>
          <span className="links-agent">{row.tag}</span>
        </motion.li>
      ))}
    </ol>
  );
}

/** A figure's origin: the brass dot and the folder or file everything else comes from. */
function Origin({ children }: { readonly children: ReactNode }) {
  return (
    <motion.div className="links-source" data-intro="" variants={settle(0.1, 6)}>
      <span className="links-origin" aria-hidden="true" />
      <code>{children}</code>
    </motion.div>
  );
}

/**
 * A link figure: an origin with a brass dot, a spine, and one row per thing it reaches, each with
 * a plus mark and a label on the right, in the `links-*` styles of `landing-features.css`.
 */
function LinkFigure({
  origin,
  label,
  rows,
}: {
  readonly origin: string;
  readonly label: string;
  readonly rows: ReadonlyArray<Row>;
}) {
  return (
    <figure className="links-figure fp-links" aria-label={label}>
      <Origin>{origin}</Origin>
      <span className="links-spine fp-spine" aria-hidden="true" />
      <Rows rows={rows} />
    </figure>
  );
}

/** One source, with one file of each kind it can hold. */
function SourceFigure() {
  return (
    <LinkFigure
      origin={sourceFigure.root}
      label={`A source folder, ${sourceFigure.root}, holding ${sourceFigure.entries.map((entry) => entry.path).join(", ")}.`}
      rows={sourceFigure.entries.map((entry) => ({ path: entry.path, tag: entry.kind }))}
    />
  );
}

/** One skill folder and the links one sync makes from it, then the command's links. */
function AgentsFigure() {
  const skills = agentsFigure.links.map((link) => ({ path: link.path, tag: link.agent }));
  const commands = agentsFigure.commands.map((link) => ({ path: link.path, tag: link.agent }));
  return (
    <figure
      className="links-figure fp-links"
      aria-label={`One sync links ${agentsFigure.source} into ${agentsFigure.links.map((link) => link.path).join(", ")}, and the command into ${agentsFigure.commands.map((link) => link.path).join(", ")}.`}
    >
      <Origin>{agentsFigure.source}</Origin>
      <span className="links-spine fp-spine" aria-hidden="true" />
      <Rows rows={skills} />
      <motion.p className="fp-figure-note" data-intro="" variants={settle(rowDelay(5), 0)}>
        {agentsFigure.commandsLabel}
      </motion.p>
      <Rows rows={commands} start={6} />
    </figure>
  );
}

/** One project and the same link in each of its worktrees. */
function ProjectFigure() {
  return (
    <LinkFigure
      origin={projectFigure.project}
      label={`Project app links its picked skill into each worktree: ${projectFigure.worktrees.map((tree) => tree.root).join(", ")}.`}
      rows={projectFigure.worktrees.map((tree) => ({
        root: tree.root,
        path: projectFigure.link,
        tag: tree.note,
      }))}
    />
  );
}

/** A script as its author writes it: arguments, secrets and a run function. */
function ScriptFigure() {
  return (
    <figure className="links-figure fp-code" aria-label={`A script, ${scriptFigure.file}.`}>
      <Origin>{scriptFigure.file}</Origin>
      <motion.pre data-intro="" variants={settle(0.22, 8)}>
        <code>{scriptFigure.code.join("\n")}</code>
      </motion.pre>
    </figure>
  );
}

/** A profile's three steps: the reviewed file, the bundle, and the machine it sets up. */
function ProfileFigure() {
  return (
    <figure
      className="links-figure fp-flow"
      aria-label={profileFigure.steps.map((step) => step.what).join(", then ")}
    >
      <ol>
        {profileFigure.steps.map((step, index) => (
          <motion.li
            key={step.what}
            className="fp-flow-step"
            data-intro=""
            variants={settle(rowDelay(index * 2), 8)}
          >
            {"command" in step ? (
              <span className="fp-flow-command">
                <span className="fp-flow-arrow" aria-hidden="true">
                  ↓
                </span>
                {step.command}
              </span>
            ) : null}
            <span className="fp-flow-box">
              <span className="fp-step">{String(index + 1).padStart(2, "0")}</span>
              <code>
                <PathText path={step.what} />
              </code>
              <span className="fp-flow-how">{step.how}</span>
            </span>
          </motion.li>
        ))}
      </ol>
    </figure>
  );
}

/** The reader, framed on the sheet with the landing's drafting marks. */
function DocsFigure() {
  return (
    <motion.figure className="fp-shot" data-intro="" variants={settle(0.12, 16)}>
      <div className="fp-shot-frame">
        <Illustration
          name="docs-reader"
          widths={[640, 1280]}
          sizes="(max-width: 1024px) 200vw, 1100px"
          width={2268}
          height={1560}
          alt={docsFigure.alt}
        />
      </div>
      {corners.map((corner) => (
        <span key={corner.name} className="drafting-mark" data-corner={corner.name} />
      ))}
    </motion.figure>
  );
}

/** Each part's figure, by the part's id. */
export const lensFigures: Readonly<Record<LensId, () => ReactNode>> = {
  sources: SourceFigure,
  agents: AgentsFigure,
  projects: ProjectFigure,
  docs: DocsFigure,
  scripts: ScriptFigure,
  profiles: ProfileFigure,
};

/** The parts whose figure takes the whole width under their words. */
export const wideFigures: ReadonlySet<LensId> = new Set(["docs"]);
