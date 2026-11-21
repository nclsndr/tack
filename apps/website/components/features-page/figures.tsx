import { motion } from "motion/react";
import type { ReactNode } from "react";
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
const rowDelay = (index: number) => 0.18 + index * 0.08;

/**
 * A figure in the landing's link manner: an origin with a brass dot, a spine, and one row per
 * thing it reaches, each with a plus mark and a label on the right. It reuses the landing's
 * `links-*` styles, so the page and the landing draw links the same way.
 */
function LinkRows({
  origin,
  label,
  rows,
}: {
  readonly origin: string;
  readonly label: string;
  readonly rows: ReadonlyArray<{
    readonly key: string;
    readonly path: ReactNode;
    readonly tag: string;
  }>;
}) {
  return (
    <figure className="links-figure fp-links" aria-label={label}>
      <motion.div className="links-source" data-intro="" variants={settle(0.1, 6)}>
        <span className="links-origin" aria-hidden="true" />
        <code>{origin}</code>
      </motion.div>
      <span className="links-spine fp-spine" aria-hidden="true" />
      <ol>
        {rows.map((row, index) => (
          <motion.li
            key={row.key}
            className="links-row"
            data-intro=""
            variants={settle(rowDelay(index), 0)}
          >
            <span className="links-mark" aria-hidden="true" />
            <code>{row.path}</code>
            <span className="links-agent">{row.tag}</span>
          </motion.li>
        ))}
      </ol>
    </figure>
  );
}

/** One source, with one file of each kind it can hold. */
function SourceFigure() {
  return (
    <LinkRows
      origin={sourceFigure.root}
      label={`A source folder, ${sourceFigure.root}, holding ${sourceFigure.entries.map((entry) => entry.path).join(", ")}.`}
      rows={sourceFigure.entries.map((entry) => ({
        key: entry.path,
        path: entry.path,
        tag: entry.kind,
      }))}
    />
  );
}

/** One skill folder and the links one sync makes from it into each agent's folder. */
function AgentsFigure() {
  return (
    <LinkRows
      origin={agentsFigure.source}
      label={`One sync links ${agentsFigure.source} into ${agentsFigure.links.map((link) => link.path).join(", ")}.`}
      rows={agentsFigure.links.map((link) => ({
        key: link.path,
        path: link.path,
        tag: link.agent,
      }))}
    />
  );
}

/** One project and the same link in each of its worktrees. */
function ProjectFigure() {
  return (
    <LinkRows
      origin={projectFigure.project}
      label={`Project app links its picked skill into each worktree: ${projectFigure.worktrees.map((tree) => tree.root).join(", ")}.`}
      rows={projectFigure.worktrees.map((tree) => ({
        key: tree.root,
        path: (
          <>
            <span className="fp-root">{tree.root}/</span>
            {tree.link}
          </>
        ),
        tag: tree.note,
      }))}
    />
  );
}

/** A script as its author writes it: arguments, secrets and a run function. */
function ScriptFigure() {
  return (
    <figure className="links-figure fp-code" aria-label={`A script, ${scriptFigure.file}.`}>
      <motion.div className="links-source" data-intro="" variants={settle(0.1, 6)}>
        <span className="links-origin" aria-hidden="true" />
        <code>{scriptFigure.file}</code>
      </motion.div>
      <motion.pre data-intro="" variants={settle(0.22, 8)}>
        <code>{scriptFigure.code.join("\n")}</code>
      </motion.pre>
    </figure>
  );
}

/** A profile file, the bundle it packs into, and the machine that bundle sets up. */
function ProfileFigure() {
  return (
    <figure
      className="links-figure fp-steps"
      aria-label={`${profileFigure.file} packs into ${profileFigure.steps[0].what}, which sets up ${profileFigure.steps[1].what}.`}
    >
      <motion.div className="links-source" data-intro="" variants={settle(0.1, 6)}>
        <span className="links-origin" aria-hidden="true" />
        <code>{profileFigure.file}</code>
      </motion.div>
      <span className="links-spine fp-spine" aria-hidden="true" />
      <ol>
        {profileFigure.steps.map((step, index) => (
          <motion.li
            key={step.what}
            className="links-row fp-flow-row"
            data-intro=""
            variants={settle(rowDelay(index * 2), 0)}
          >
            <span className="links-mark" aria-hidden="true" />
            <span className="fp-step-text">
              <span className="fp-step-how">{step.how}</span>
              <code>{step.what}</code>
            </span>
            <span className="links-agent">{step.note}</span>
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
      <Illustration
        name="docs-reader"
        widths={[640, 1280]}
        sizes="(max-width: 1024px) 100vw, 640px"
        width={2268}
        height={1560}
        alt={docsFigure.alt}
      />
      {corners.map((corner) => (
        <span key={corner.name} className="drafting-mark" data-corner={corner.name} />
      ))}
    </motion.figure>
  );
}

/** Each lens's figure, by the lens's id. */
export const lensFigures: Readonly<Record<LensId, () => ReactNode>> = {
  "set-up-once": SourceFigure,
  "every-agent": AgentsFigure,
  "per-project": ProjectFigure,
  docs: DocsFigure,
  scripts: ScriptFigure,
  profiles: ProfileFigure,
};
