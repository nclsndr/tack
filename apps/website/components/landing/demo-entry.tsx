import { homeRelative, type EntryDetails } from "../../demo/machine-view.ts";
import { entryView } from "./content.ts";
import { Icon } from "./demo-explorer.tsx";

/** A path the view can open in its own tab, shown from the home. */
function PathButton({
  path,
  home,
  onOpen,
  label = homeRelative(path, home),
}: {
  readonly path: string;
  readonly home: string;
  readonly onOpen: (path: string) => void;
  readonly label?: string;
}) {
  return (
    <button type="button" className="demo-entry-path" onClick={() => onOpen(path)}>
      {label}
    </button>
  );
}

/** The names inside a folder, each opening in its own tab. */
function Listing({
  folder,
  names,
  home,
  onOpen,
}: {
  readonly folder: string;
  readonly names: ReadonlyArray<string>;
  readonly home: string;
  readonly onOpen: (path: string) => void;
}) {
  return names.length === 0 ? (
    <p className="demo-entry-note">{entryView.empty}</p>
  ) : (
    <ul className="demo-entry-listing">
      {names.map((name) => (
        <li key={name}>
          <PathButton path={`${folder}/${name}`} home={home} onOpen={onOpen} label={name} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One entry of the demo machine, read-only: a file's text with line numbers, a folder's names, or
 * where a link points, where it resolves and what it reaches. Every path in it opens in a tab.
 */
export function DemoEntry({
  details,
  home,
  onOpen,
}: {
  readonly details: EntryDetails;
  readonly home: string;
  readonly onOpen: (path: string) => void;
}) {
  const icon =
    details.kind === "link" ? "link" : details.kind === "directory" ? "open" : ("file" as const);
  return (
    <article className="demo-entry" aria-label={homeRelative(details.path, home)}>
      <header className="demo-entry-header">
        <Icon name={icon} />
        <span className="demo-entry-title">{homeRelative(details.path, home)}</span>
        <span className="demo-entry-badge">{entryView.readOnly}</span>
      </header>
      {details.kind === "file" ? (
        <>
          <pre className="demo-entry-text">
            {details.text
              .replace(/\n$/, "")
              .split("\n")
              .map((line, index) => (
                <span key={index} className="demo-entry-line">
                  <span className="demo-entry-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  {line}
                </span>
              ))}
          </pre>
          <p className="demo-entry-note">{`${details.size} bytes`}</p>
        </>
      ) : details.kind === "directory" ? (
        <Listing folder={details.path} names={details.entries} home={home} onOpen={onOpen} />
      ) : details.kind === "link" ? (
        <>
          <dl className="demo-entry-facts">
            <dt>{entryView.pointsTo}</dt>
            <dd>
              <code>{details.target}</code>
            </dd>
            <dt>{entryView.resolvesTo}</dt>
            <dd>
              {details.resolved === undefined ? (
                <span className="demo-entry-dangling">{entryView.dangling}</span>
              ) : (
                <PathButton path={details.resolved} home={home} onOpen={onOpen} />
              )}
            </dd>
            <dt>{entryView.reaches}</dt>
            <dd>
              {details.reaches === undefined
                ? "—"
                : details.reaches === "directory"
                  ? entryView.folder
                  : entryView.file}
            </dd>
          </dl>
          {details.resolved === undefined ? null : (
            <>
              <p className="demo-entry-note">{entryView.notACopy}</p>
              {details.reaches === "directory" ? (
                <Listing
                  folder={details.resolved}
                  names={details.entries}
                  home={home}
                  onOpen={onOpen}
                />
              ) : null}
            </>
          )}
        </>
      ) : (
        <p className="demo-entry-note">{entryView.missing}</p>
      )}
    </article>
  );
}
