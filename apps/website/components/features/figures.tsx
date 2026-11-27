import { motion } from "motion/react";
import { Fragment, type ReactNode } from "react";
import { settle } from "../landing/drafting-sheet.tsx";
import { profileFigure, projectFigure } from "./content.ts";

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

/** A link figure's rows, each landing after the one before it. */
function Rows({ rows }: { readonly rows: ReadonlyArray<Row> }) {
  return (
    <ol>
      {rows.map((row, index) => (
        <motion.li
          key={`${row.path} ${row.tag}`}
          className="links-row"
          data-intro=""
          variants={settle(rowDelay(index), 0)}
        >
          <span className="links-mark" aria-hidden="true" />
          <code>
            {row.root === undefined ? null : (
              <span className="fig-root">
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
 * A figure in the landing's link manner: an origin with a brass dot, a spine, and one row per
 * thing it reaches, each with a plus mark and a label on the right. It reuses the agents figure's
 * `links-*` styles, so every figure on the landing draws links the same way.
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
    <figure className="links-figure fig-links" aria-label={label}>
      <Origin>{origin}</Origin>
      <span className="links-spine fig-spine" aria-hidden="true" />
      <Rows rows={rows} />
    </figure>
  );
}

/** One project and the same link in each of its worktrees. */
export function ProjectFigure() {
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

/** A profile's three steps: the reviewed file, the bundle, and the machine it sets up. */
export function ProfileFigure() {
  return (
    <figure
      className="links-figure fig-flow"
      aria-label={profileFigure.steps.map((step) => step.what).join(", then ")}
    >
      <ol>
        {profileFigure.steps.map((step, index) => (
          <motion.li
            key={step.what}
            className="fig-flow-step"
            data-intro=""
            variants={settle(rowDelay(index * 2), 8)}
          >
            {"command" in step ? (
              <span className="fig-flow-command">
                <span className="fig-flow-arrow" aria-hidden="true">
                  ↓
                </span>
                {step.command}
              </span>
            ) : null}
            <span className="fig-flow-box">
              <span className="fig-step">{String(index + 1).padStart(2, "0")}</span>
              <code>
                <PathText path={step.what} />
              </code>
              <span className="fig-flow-how">{step.how}</span>
            </span>
          </motion.li>
        ))}
      </ol>
    </figure>
  );
}
