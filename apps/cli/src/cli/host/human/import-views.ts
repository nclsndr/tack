import { Option, Predicate, Schema } from "effect";
import {
  ImportApplicationSchema,
  ImportListSchema,
  ImportPlanSchema,
  ImportRemovalApplicationSchema,
  ImportRemovalPlanSchema,
  type ImportApplication,
  type ImportCandidate,
  type ImportPlan,
  type ImportReach,
  type ImportState,
  type ImportSummary,
} from "../../../domain/imports/import-schema.ts";
import { argvLine, commandLine } from "../command-line.ts";
import type { PublicEnvelope } from "../public-outcome.ts";
import { frameView } from "./frame.ts";
import type { HumanView, HumanViewRegistry } from "./render.ts";
import { uniqueHints } from "./removal-hints.ts";
import type { Style } from "./style.ts";
import { cell, flow, paragraph, table, tableRows, type Cell, type Paint } from "./text.ts";
import { factRows, plural } from "./view.ts";
import { declarationFileName } from "../../../features/sources/declaration-file.ts";

const decodePlan = Schema.decodeUnknownOption(ImportPlanSchema);
const decodeApplication = Schema.decodeUnknownOption(ImportApplicationSchema);
const decodeList = Schema.decodeUnknownOption(ImportListSchema);
const decodeRemovalPlan = Schema.decodeUnknownOption(ImportRemovalPlanSchema);
const decodeRemovalApplication = Schema.decodeUnknownOption(ImportRemovalApplicationSchema);

/** The diagnostics the views state in the body instead, so no fact appears twice. */
const bodyDiagnosticCodes: ReadonlySet<string> = new Set([
  "import-selection-required",
  "import-destination-required",
  "import-nothing-importable",
]);

const shortRevision = (revision: string) => revision.slice(0, 12);

const sizeText = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const refText = (ref: { readonly kind: string; readonly request?: string | undefined }) =>
  ref.kind === "default"
    ? "tracking the default branch"
    : ref.kind === "branch"
      ? `tracking ${ref.request ?? ""}`
      : `pinned to ${ref.kind} ${ref.kind === "commit" ? shortRevision(ref.request ?? "") : (ref.request ?? "")}`;

/** Labelled facts, each value plain text. */
const facts = (rows: ReadonlyArray<readonly [string, string]>, style: Style) =>
  factRows(
    rows.map(([key, value]) => [key, [cell(value)]] as const),
    style,
  );

/** Two aligned columns, such as a path and what happens to it. */
const pairs = (rows: ReadonlyArray<readonly [string, string]>, style: Style) =>
  table(
    rows.map(([left, right]) => [cell(left), cell(right)]),
    { width: style.width },
  );

/** A sentence wrapped under an indent. */
const indented = (text: string, style: Style, paint?: Paint, indent = 2) =>
  paragraph(text, { width: style.width, indent, ...(paint === undefined ? {} : { paint }) });

/** A sentence after a mark, such as `✗`; its continuation lines hang under the text. */
const marked = (mark: Cell, text: string, style: Style, indent: number) =>
  flow(
    [
      mark,
      ...text
        .split(/\s+/)
        .filter((word) => word !== "")
        .map((word) => cell(word)),
    ],
    { width: style.width, indent, hang: indent + 2 },
  );

const withoutBodyDiagnostics = (
  envelope: PublicEnvelope,
  refusalCode?: string,
): PublicEnvelope => ({
  ...envelope,
  diagnostics: envelope.diagnostics.filter(
    (diagnostic) => !bodyDiagnosticCodes.has(diagnostic.code) && diagnostic.code !== refusalCode,
  ),
});

/** The corrected command a refusal carries as `details.next`, the words of a `tack` command line. */
const retypedHints = (envelope: PublicEnvelope): ReadonlyArray<string> =>
  envelope.diagnostics.flatMap((diagnostic) => {
    const next = Predicate.isObject(diagnostic.details) ? diagnostic.details["next"] : undefined;
    return Array.isArray(next) && next.every((word) => typeof word === "string")
      ? [argvLine(["tack", ...next.slice(1)])]
      : [];
  });

const failureView = (envelope: PublicEnvelope, style: Style): string =>
  frameView(envelope, style, {
    body: [],
    hints: uniqueHints([
      ...retypedHints(envelope),
      ...envelope.next,
      ...envelope.diagnostics.flatMap((diagnostic): ReadonlyArray<string> =>
        diagnostic.code === "import-not-found"
          ? [commandLine("import-list")]
          : diagnostic.code === "import-destination-required"
            ? [commandLine("source-list")]
            : [],
      ),
    ]),
  });

/** Dedicated views take a failure envelope first: it carries no plan, applied or result. */
const withFailure =
  (view: HumanView): HumanView =>
  (envelope, style) =>
    envelope.status === "failure" &&
    envelope.plan === null &&
    envelope.applied === null &&
    envelope.result === null
      ? failureView(envelope, style)
      : view(envelope, style);

const candidateFacts = (candidate: ImportCandidate) =>
  [
    `${plural(candidate.files, "file")}, ${sizeText(candidate.bytes)}`,
    ...(candidate.executables > 0 ? [`${candidate.executables} executable`] : []),
    ...(candidate.nonText > 0 ? [`${candidate.nonText} not text`] : []),
    ...(candidate.symlinks > 0 ? [`${plural(candidate.symlinks, "symlink")} not imported`] : []),
    ...(candidate.submodules > 0
      ? [`${plural(candidate.submodules, "submodule")} not imported`]
      : []),
  ].join(", ");

const upstreamTackText = (tack: NonNullable<ImportCandidate["upstreamTack"]>) =>
  [
    `upstream metadata.tack: activation ${tack.activation}`,
    `user activation ${tack.userActivation}${tack.userActivation === "default" ? " (reaches the user namespace)" : ""}`,
    ...(tack.projects.length > 0 ? [`projects ${tack.projects.join(", ")}`] : []),
    ...(tack.dependencies.length > 0
      ? [plural(tack.dependencies.length, "dependency", "dependencies")]
      : []),
  ].join(" · ");

const candidateLines = (
  candidates: ReadonlyArray<ImportCandidate>,
  selected: ReadonlyArray<string>,
  style: Style,
) => {
  const rows = tableRows(
    candidates.map((candidate) => [
      candidate.verdict.importable
        ? selected.includes(candidate.name)
          ? cell("✓", style.green)
          : cell("·", style.dim)
        : cell("✗", style.red),
      cell(candidate.name),
      cell(candidate.folder === "" ? "(root)" : candidate.folder),
    ]),
    { width: style.width },
  );
  const detail = (text: string, paint: Paint) => indented(text, style, paint, 6);
  return candidates.flatMap((candidate, index) => [
    ...(rows[index] ?? []),
    ...(candidate.verdict.importable
      ? [
          ...(candidate.description === undefined ? [] : detail(candidate.description, style.dim)),
          ...detail(candidateFacts(candidate), style.dim),
          ...candidate.nestedSkills.flatMap((nested) =>
            detail(
              `nested SKILL.md in ${nested}: content of this skill, not a separate one`,
              style.dim,
            ),
          ),
          ...(candidate.upstreamTack === undefined
            ? []
            : detail(upstreamTackText(candidate.upstreamTack), style.yellow)),
        ]
      : detail(`${candidate.verdict.message} (${candidate.verdict.code})`, style.red)),
  ]);
};

/** `SOURCE:FOLDER`, or `SOURCE` alone for a skills collection, whose folder is the source. */
const intoText = (source: string, folder: string) =>
  folder === "" ? source : `${source}:${folder}`;

const intoValue = (destination: NonNullable<ImportPlan["destination"]>) =>
  intoText(destination.source, destination.folder);

/** The reach block of one skill: who receives it at the next sync, and what is not as expected. */
const reachLines = (reach: ImportReach, source: string, showName: boolean, style: Style) => {
  const receiving = reach.projects.filter((project) => project.receives);
  const missing = reach.projects.filter((project) => !project.receives);
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Projects",
      reach.projects.length === 0
        ? "none registered"
        : `${receiving.map((project) => project.project).join(", ") || "none"} · ${receiving.length} of ${plural(reach.projects.length, "registered project")}`,
    ],
    ...missing.map((project): readonly [string, string] => [
      "Not",
      `${project.project} · ${project.reason ?? "not selected"}`,
    ]),
    ["User", `${reach.user.receives ? "yes" : "no"} · ${reach.user.reason}`],
    [
      "Clashes",
      reach.collisions.length === 0
        ? "none"
        : reach.collisions
            .map(
              (clash) =>
                `${clash.namespace}: ${clash.with} has the same name, so sync delivers neither`,
            )
            .join("; "),
    ],
    ...(reach.undeclaredDependencies.length === 0
      ? []
      : [
          [
            "Dependencies",
            `${reach.undeclaredDependencies.join(", ")} not declared in depends-on of ${source}, which blocks the skill`,
          ] as const,
        ]),
  ];
  return [
    ...(showName ? [`  ${style.bold(reach.name)}`] : []),
    ...facts(rows, showName ? { ...style, width: style.width - 2 } : style).map((line) =>
      showName ? `  ${line}` : line,
    ),
  ];
};

const writeLines = (plan: ImportPlan, style: Style) => {
  const destination = plan.destination;
  if (destination === undefined) return undefined;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ...destination.newFolders.map((folder): readonly [string, string] => [
      `${folder}/`,
      "new group folder",
    ]),
    ...plan.writes.map((write): readonly [string, string] => [
      `${write.path}/`,
      `${plural(write.files, "file")}, ${sizeText(write.bytes)}${write.upstreamPath === "" || write.upstreamPath.split("/").at(-1) === write.name ? "" : ` (upstream ${write.upstreamPath})`}`,
    ]),
    [
      declarationFileName,
      `imports: ${plural(plan.writes.length, "record")} added (rest of the file unchanged)`,
    ] as const,
  ];
  return [style.bold("Will write"), ...pairs(rows, style)];
};

const destinationLines = (plan: ImportPlan, style: Style) => {
  const choices = plan.destinations ?? [];
  return [
    style.bold("Into"),
    ...indented(
      "--apply needs --into SOURCE[:FOLDER], the source that receives the skills.",
      style,
    ),
    ...(choices.length === 0
      ? indented(
          "No registered source can receive imports. Register one with `tack source add <path>`.",
          style,
        )
      : pairs(
          choices.map((choice): readonly [string, string] => [
            choice.name,
            choice.folders.length === 0
              ? "declares no skills folder: add skills: [{ path: skills }] to its tack.yaml"
              : choice.folders.map((folder) => intoText(choice.name, folder)).join(", "),
          ]),
          style,
        )),
  ];
};

const intoHint = (plan: ImportPlan): string | undefined => {
  if (plan.destination !== undefined) return intoValue(plan.destination);
  const [first] = (plan.destinations ?? []).filter((choice) => choice.folders.length > 0);
  return first === undefined
    ? undefined
    : first.folders.length === 1
      ? first.name
      : intoText(first.name, first.folders[0] ?? "");
};

const previewView = (envelope: PublicEnvelope, plan: ImportPlan, style: Style): string => {
  const visible = plan.candidates;
  const into = plan.destination;
  const body: Array<ReadonlyArray<string> | undefined> = [
    facts(
      [
        [
          "Location",
          `${plan.location.replace(/#.*$/, "")} · ${refText(plan.ref)}${
            plan.urlForm === undefined ? "" : `  (from ${plan.urlForm} URL)`
          }`,
        ],
        ["Revision", `${shortRevision(plan.revision)}  (resolved now)`],
        ...(plan.split === undefined
          ? []
          : [["Ref split", `${plan.split.ref} · explicit form ${plan.split.explicit}`] as const]),
        ...(into === undefined
          ? []
          : [
              [
                "Into",
                `${intoValue(into)} · ${style.path(into.folder === "" ? into.root : `${into.root}/${into.folder}`)}`,
              ] as const,
            ]),
      ],
      style,
    ),
    [
      style.bold(`Skills found (${visible.length})`),
      ...(visible.length === 0
        ? ["  None found in the documented places."]
        : candidateLines(visible, plan.selected, style)),
      ...(plan.hiddenInternal > 0
        ? indented(
            `${plural(plan.hiddenInternal, "internal skill")} hidden; name one with --skill to import it.`,
            style,
            style.dim,
          )
        : []),
    ],
    plan.outcome === "refused" && plan.refusal !== undefined
      ? [style.bold("Refused"), ...indented(plan.refusal.message, style, style.red)]
      : undefined,
    plan.outcome === "nothing-importable"
      ? indented(
          "Nothing in this location can be imported. Scope it to a folder, or search deeper with --full-depth.",
          style,
        )
      : undefined,
    plan.outcome === "needs-selection"
      ? indented("Nothing is selected. Choose with --skill NAME (repeatable) or --all.", style)
      : undefined,
    plan.destination === undefined &&
    plan.outcome !== "refused" &&
    plan.outcome !== "nothing-importable"
      ? destinationLines(plan, style)
      : undefined,
    plan.writes.length > 0 ? writeLines(plan, style) : undefined,
    plan.reach.length > 0 && into !== undefined
      ? [
          style.bold("Delivery at the next sync"),
          ...indented(`On by default, like every skill in ${into.source}.`, style, style.dim),
          ...plan.reach.flatMap((reach, index) => [
            ...(index > 0 && plan.reach.length > 1 ? [""] : []),
            ...reachLines(reach, into.source, plan.reach.length > 1, style),
          ]),
        ]
      : undefined,
  ];
  const target = intoHint(plan);
  const offered =
    plan.selected.length > 0
      ? plan.selected
      : visible
          .filter((candidate) => candidate.verdict.importable && !candidate.hidden)
          .slice(0, 1)
          .map((candidate) => candidate.name);
  const command = (flags: ReadonlyArray<string>) =>
    commandLine("import-add", plan.location, ...flags);
  const intoFlags = target === undefined ? [] : ["--into", target];
  const skillFlags = offered.flatMap((name) => ["--skill", name]);
  const hints =
    plan.outcome === "ready"
      ? [command([...skillFlags, ...intoFlags, "--apply"])]
      : plan.outcome === "needs-selection"
        ? [command([...skillFlags, ...intoFlags])]
        : plan.outcome === "needs-destination" && target !== undefined
          ? [command([...skillFlags, ...intoFlags, "--apply"])]
          : [];
  return frameView(withoutBodyDiagnostics(envelope, plan.refusal?.code), style, {
    scope: "preview",
    body,
    hints,
  });
};

const applyView = (envelope: PublicEnvelope, applied: ImportApplication, style: Style): string => {
  const names = applied.imported.map((write) => write.name).join(", ");
  const rows: ReadonlyArray<readonly [string, string]> = [
    ...applied.destination.newFolders.map((folder): readonly [string, string] => [
      `${folder}/`,
      "new group folder",
    ]),
    ...applied.imported.map((write): readonly [string, string] => [
      `${write.path}/`,
      plural(write.files, "file"),
    ]),
    [declarationFileName, `imports: ${plural(applied.imported.length, "record")} added`],
  ];
  return frameView(envelope, style, {
    scope: "applied",
    body: [
      [
        ...paragraph(
          `Imported ${names} into ${applied.destination.source}  ${applied.location.replace(/#.*$/, "")} · ${refText(applied.ref)} · ${shortRevision(applied.revision)}`,
          { width: style.width },
        ),
        ...pairs(rows, style),
      ],
      applied.recovered.length === 0
        ? undefined
        : [
            style.bold("Recovered first"),
            ...applied.recovered.flatMap((note) => indented(note, style)),
          ],
      applied.rejected.length === 0
        ? undefined
        : [
            style.bold(`Skipped (${applied.rejected.length})`),
            ...applied.rejected.flatMap((item) =>
              marked(cell("✗"), `${item.name}: ${item.message} (${item.code})`, style, 2),
            ),
          ],
      indented(
        "Nothing is delivered until sync; the new skills follow their source's activation.",
        style,
        style.dim,
      ),
    ],
    hints: [commandLine("sync", "--all")],
  });
};

const importAddView: HumanView = withFailure((envelope, style) => {
  const plan = Option.getOrUndefined(decodePlan(envelope.plan));
  if (plan === undefined) return undefined;
  if (envelope.applied === null) return previewView(envelope, plan, style);
  const applied = Option.getOrUndefined(decodeApplication(envelope.applied));
  return applied === undefined ? undefined : applyView(envelope, applied, style);
});

/** How many files differ from the record, each counted once. */
const changeCount = (local: ImportState) =>
  new Set([
    ...local.added,
    ...local.removed,
    ...local.changed,
    ...local.executable,
    ...local.special,
  ]).size;

const localText = (local: ImportState) =>
  local.state === "unchanged"
    ? "unchanged"
    : local.state === "missing"
      ? "folder missing"
      : `locally changed (${plural(changeCount(local), "file")})`;

/** Every local change, one line each, for the previews that say what a removal loses. */
const changeLines = (local: ImportState): ReadonlyArray<string> => [
  ...local.changed.map((file) => `${file} changed`),
  ...local.added.map((file) => `${file} added`),
  ...local.removed.map((file) => `${file} removed`),
  ...local.executable.map((file) => `${file} executable bit changed`),
  ...local.special.map((file) => `${file} is a link or special file`),
];

const summaryLines = (summary: ImportSummary, style: Style) => [
  ...flow([cell(summary.reference, style.bold), cell(summary.path, style.dim)], {
    width: style.width,
    indent: 0,
    hang: 4,
    separator: "  ",
  }),
  ...indented(
    `${summary.location} · ${refText(summary.ref)}${summary.ref.kind === "commit" ? "" : ` · ${shortRevision(summary.revision)}`} · imported ${summary.importedAt.slice(0, 10)} · ${localText(summary.local)}`,
    style,
    style.dim,
    4,
  ),
  ...summary.conditions
    .filter((condition) => condition.code !== "import-locally-changed")
    .flatMap((condition) => marked(cell("!", style.yellow), condition.message, style, 4)),
  ...(summary.local.state === "changed"
    ? changeLines(summary.local)
        .slice(0, 6)
        .flatMap((line) => indented(line, style, style.dim, 6))
    : []),
];

const importListView: HumanView = withFailure((envelope, style) =>
  Option.match(decodeList(envelope.result), {
    onNone: () => undefined,
    onSome: (list) =>
      frameView(envelope, style, {
        scope: plural(list.imports.length, "imported skill"),
        body: [
          list.imports.length === 0
            ? ["No skills have been imported."]
            : list.imports.flatMap((summary, index) => [
                ...(index > 0 ? [""] : []),
                ...summaryLines(summary, style),
              ]),
          list.problems.length === 0
            ? undefined
            : [
                style.bold(`Problems (${list.problems.length})`),
                ...list.problems.flatMap((problem) =>
                  marked(
                    cell("!", style.yellow),
                    `${problem.source}: ${problem.message}`,
                    style,
                    2,
                  ),
                ),
              ],
        ],
        hints:
          list.imports.length === 0
            ? [commandLine("import-add", "<location>", "--into", "<source>")]
            : uniqueHints(
                list.imports
                  .filter((summary) =>
                    summary.conditions.some(
                      (condition) => condition.code === "import-folder-missing",
                    ),
                  )
                  .map((summary) => commandLine("import-remove", summary.reference, "--apply")),
              ),
      }),
  }),
);

const removalHint = (reference: string, force: boolean) =>
  commandLine("import-remove", reference, ...(force ? ["--force"] : []), "--apply");

const importRemoveView: HumanView = withFailure((envelope, style) => {
  const plan = Option.getOrUndefined(decodeRemovalPlan(envelope.plan));
  // An apply that only finished an interrupted removal carries no plan.
  if (plan === undefined && envelope.applied === null) return undefined;
  if (envelope.applied !== null) {
    const applied = Option.getOrUndefined(decodeRemovalApplication(envelope.applied));
    if (applied === undefined) return undefined;
    return frameView(envelope, style, {
      scope: "applied",
      body: [
        [
          `Removed ${style.bold(applied.reference)}`,
          ...pairs(
            applied.removed.map((path): readonly [string, string] => [
              path,
              path === declarationFileName ? "imports record removed" : "deleted",
            ]),
            style,
          ),
        ],
        applied.recovered.length === 0
          ? undefined
          : [
              style.bold("Recovered first"),
              ...applied.recovered.flatMap((note) => indented(note, style)),
            ],
        indented(
          "The next sync removes its links with reason source-missing; picks that name it stay until `tack pick remove`.",
          style,
          style.dim,
        ),
      ],
      hints: [commandLine("sync", "--all")],
    });
  }
  // Coverage skip: unreachable narrowing guard; a missing plan with no application returned above.
  /* v8 ignore next -- @preserve */
  if (plan === undefined) return undefined;
  const lost = plan.local.state === "changed" ? changeLines(plan.local) : [];
  return frameView(envelope, style, {
    scope: "preview",
    body: [
      [
        ...paragraph(
          `Remove ${plan.reference}  ${plan.location} · ${shortRevision(plan.revision)}`,
          { width: style.width, paint: style.bold },
        ),
        ...pairs(
          [
            plan.folderPresent
              ? [`${plan.path}/`, `${plural(plan.files, "file")}, deleted`]
              : [`${plan.path}/`, "already gone, so only the record is removed"],
            [declarationFileName, "imports record removed (rest of the file unchanged)"],
          ],
          style,
        ),
      ],
      plan.delivered.length === 0
        ? ["  Delivered nowhere now."].map((line) => style.dim(line))
        : [
            style.bold("Delivered now"),
            ...indented(`${plan.delivered.join(", ")} — the next sync removes these links.`, style),
          ],
      plan.picks.length === 0
        ? undefined
        : [
            style.bold("Picks that name it"),
            ...pairs(
              plan.picks.map((pick): readonly [string, string] => [pick.namespace, pick.address]),
              style,
            ),
            ...indented(
              "They stay as unresolved picks until `tack pick remove` clears them.",
              style,
              style.dim,
            ),
          ],
      lost.length === 0
        ? undefined
        : [
            style.bold(`Local changes that will be lost (${lost.length})`),
            ...lost.flatMap((line) => marked(cell("✗", style.red), line, style, 2)),
            ...indented("Tack keeps no copy of what it deletes.", style, style.dim),
          ],
    ],
    hints: [removalHint(plan.reference, plan.force)],
  });
});

/** Dedicated views for the `import` group. */
export const importViews: HumanViewRegistry = {
  import: importListView,
  "import add": importAddView,
  "import remove": importRemoveView,
};
