/**
 * `Schema` as data: the author's contract, the lenient reading that turns props into a model plus
 * input issues, the focus rule, access lenses and the text equivalent. Pure functions only, so the
 * figure check runs them without a browser and gets the same answers as the page.
 */
import {
  claimIssues,
  type FigureIssue,
  idIssues,
  inputIssue,
  list,
  record,
  text,
} from "./issues.ts";
import { oneOf } from "./authored-model.ts";

const columnKeys = ["pk", "unique"] as const;
type ColumnKey = (typeof columnKeys)[number];
export const cardinalities = ["one-to-one", "one-to-many", "many-to-one", "many-to-many"] as const;
type Cardinality = (typeof cardinalities)[number];
export const accessLevels = ["read", "write", "read-write", "none"] as const;
export type Access = (typeof accessLevels)[number];

/** One column, or one attribute of an entity when it has no type. */
export type SchemaColumnInput = {
  readonly name: string;
  readonly type?: string;
  readonly key?: ColumnKey;
  /** A foreign key: `schema.table.column` of a declared table. */
  readonly ref?: string;
  readonly nullable?: boolean;
  readonly note?: string;
};
/** One table, or one entity. A dotted name `schema.table` puts it in the group `schema`. */
export type SchemaTableInput = {
  readonly name: string;
  readonly note?: string;
  readonly columns: readonly SchemaColumnInput[];
  /** Column sets that are unique together. */
  readonly unique?: readonly (readonly string[])[];
};
export type SchemaProps = {
  readonly id: string;
  /** The claim, as a sentence. */
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  /** Table names offered as entry points. */
  readonly startWith?: readonly string[];
  readonly tables: readonly SchemaTableInput[];
  /** Names and notes for groups; a table joins a group by its dotted name. */
  readonly groups?: readonly {
    readonly id: string;
    readonly label: string;
    readonly note?: string;
  }[];
  /** Relations that are not foreign keys. Ends are columns or tables. */
  readonly links?: readonly {
    readonly from: string;
    readonly to: string;
    readonly label: string;
    readonly cardinality?: Cardinality;
  }[];
  /** A concern (`focus`) or a role (`access`), on the same drawing. */
  readonly lenses?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly note: string;
    readonly focus?: readonly string[];
    readonly access?: Readonly<Record<string, Access>>;
  }[];
  /** The tables or columns a query touches, in order. */
  readonly replays?: readonly {
    readonly id?: string;
    readonly label: string;
    readonly steps: readonly { readonly at: string | readonly string[]; readonly note: string }[];
  }[];
};

/** The limits a `Schema` is checked against. */
export const schemaBudget = { tables: 12, steps: 12 } as const;

type SchemaColumn = {
  readonly name: string;
  readonly type?: string;
  readonly key?: ColumnKey;
  /** A foreign key, drawn with its mark even when its target is not declared. */
  readonly foreign: boolean;
  readonly nullable: boolean;
  readonly note?: string;
};
export type SchemaTable = {
  readonly name: string;
  /** The name drawn inside its group: the schema prefix dropped. */
  readonly short: string;
  readonly group?: string;
  readonly note?: string;
  readonly columns: readonly SchemaColumn[];
  readonly unique: readonly (readonly string[])[];
};
type SchemaGroup = {
  readonly id: string;
  readonly label: string;
  readonly note?: string;
  /** Index among the groups, which picks the tint. */
  readonly tint: number;
};
/** One end of a relation: a table, and the column when the end is a column. */
export type SchemaEnd = { readonly table: string; readonly column?: string };
export type SchemaRelation = {
  readonly id: string;
  /** `key` for a foreign key, `link` for any other relation. */
  readonly kind: "key" | "link";
  readonly from: SchemaEnd;
  readonly to: SchemaEnd;
  readonly label?: string;
  readonly cardinality?: Cardinality;
};
export type SchemaCase =
  | {
      readonly kind: "replay";
      readonly id: string;
      readonly label: string;
      readonly steps: readonly { readonly at: readonly string[]; readonly note: string }[];
    }
  | {
      readonly kind: "lens";
      readonly id: string;
      readonly label: string;
      readonly note: string;
      readonly focus: readonly string[];
      /** By table name or `schema.*`; `undefined` for a lens without access. */
      readonly access?: ReadonlyMap<string, Access>;
    };
export type SchemaModel = {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly rule?: { readonly title: string; readonly text: string };
  readonly startWith: readonly string[];
  readonly tables: readonly SchemaTable[];
  readonly groups: readonly SchemaGroup[];
  readonly relations: readonly SchemaRelation[];
  readonly cases: readonly SchemaCase[];
  /** Entity cards: no column has a type. */
  readonly entities: boolean;
};

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `schema.table` splits into its group and its short name; an undotted name has no group. */
function splitName(name: string): { readonly group?: string; readonly short: string } {
  const dot = name.indexOf(".");
  return dot <= 0 ? { short: name } : { group: name.slice(0, dot), short: name.slice(dot + 1) };
}

type RawTable = {
  readonly index: number;
  readonly name: string | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
};

/** Reads tables in order: first every name, then each table against the others. */
function readTables(
  entries: readonly unknown[],
  issues: FigureIssue[],
): {
  readonly tables: readonly SchemaTable[];
  readonly refs: readonly { readonly from: SchemaEnd; readonly to: string }[];
} {
  const raws = entries.map((value, index): RawTable => ({
    index,
    name: text(record(value)?.["name"]),
    raw: record(value) ?? {},
  }));
  const firsts = new Map<string, RawTable>();
  raws.forEach((raw) => {
    if (raw.name !== undefined && firsts.has(raw.name) === false) firsts.set(raw.name, raw);
  });
  /** The columns each declared table names, before reading refs. */
  const columnNames = new Map(
    [...firsts].map(([name, raw]) => [
      name,
      new Set(list(raw.raw["columns"]).flatMap((column) => text(record(column)?.["name"]) ?? [])),
    ]),
  );
  const refs: { from: SchemaEnd; to: string }[] = [];
  const tables = raws.flatMap((entry): SchemaTable[] => {
    if (entry.name === undefined) {
      issues.push(inputIssue(`table ${entry.index + 1} has no name; it is left out`));
      return [];
    }
    if (firsts.get(entry.name) !== entry) {
      issues.push(inputIssue(`duplicate table "${entry.name}": the second one is left out`));
      return [];
    }
    const name = entry.name;
    const authored = list(entry.raw["columns"]);
    if (authored.length === 0) issues.push(inputIssue(`table "${name}" has no column`));
    const columns = authored.flatMap((value): SchemaColumn[] => {
      const column = record(value) ?? {};
      const columnName = text(column["name"]);
      if (columnName === undefined) {
        issues.push(inputIssue(`a column of table "${name}" has no name; it is left out`));
        return [];
      }
      const id = `${name}.${columnName}`;
      const authoredKey = text(column["key"]);
      const key = oneOf(columnKeys, authoredKey) === true ? authoredKey : undefined;
      if (authoredKey !== undefined && key === undefined)
        issues.push(
          inputIssue(`column "${id}" has unknown key "${authoredKey}"; use pk or unique`),
        );
      const ref = text(column["ref"]);
      if (ref !== undefined) {
        const dot = ref.lastIndexOf(".");
        if (dot <= 0)
          issues.push(inputIssue(`column "${id}" has ref "${ref}"; write schema.table.column`));
        else {
          const table = ref.slice(0, dot);
          const target = columnNames.get(table);
          if (target === undefined)
            issues.push(inputIssue(`${id} references undeclared table ${table}`));
          else if (target.has(ref.slice(dot + 1)) === false)
            issues.push(inputIssue(`${id} references undeclared column ${ref}`));
          else refs.push({ from: { table: name, column: columnName }, to: ref });
        }
      }
      const type = text(column["type"]);
      const note = text(column["note"]);
      return [
        {
          name: columnName,
          ...(type === undefined ? {} : { type }),
          ...(key === undefined ? {} : { key }),
          foreign: ref !== undefined,
          nullable: column["nullable"] === true,
          ...(note === undefined ? {} : { note }),
        },
      ];
    });
    const own = new Set(columns.map((column) => column.name));
    const unique = list(entry.raw["unique"]).flatMap((value) => {
      const set = list(value).flatMap((column) => text(column) ?? []);
      const unknown = set.find((column) => own.has(column) === false);
      if (unknown === undefined) return set.length === 0 ? [] : [set];
      issues.push(
        inputIssue(
          `table "${name}" lists unique (${set.join(", ")}) with an unknown column "${unknown}"`,
        ),
      );
      return [];
    });
    const note = text(entry.raw["note"]);
    return [
      {
        name,
        ...splitName(name),
        ...(note === undefined ? {} : { note }),
        columns,
        unique,
      },
    ];
  });
  return { tables, refs };
}

/** Reads a `schema.table.column` or `schema.table` end against the declared tables. */
function endOf(value: string, tables: readonly SchemaTable[]): SchemaEnd | undefined {
  if (tables.some((table) => table.name === value)) return { table: value };
  const dot = value.lastIndexOf(".");
  const table = tables.find((candidate) => candidate.name === value.slice(0, dot));
  const column = value.slice(dot + 1);
  return dot > 0 && table?.columns.some((candidate) => candidate.name === column) === true
    ? { table: table.name, column }
    : undefined;
}

/** Builds the model of a `Schema` from whatever the author passed, with every input issue. */
export function readSchema(props: unknown): {
  readonly model: SchemaModel;
  readonly issues: readonly FigureIssue[];
} {
  const raw = record(props) ?? {};
  const tableIssues: FigureIssue[] = [];
  const { tables, refs } = readTables(list(raw["tables"]), tableIssues);
  const typed = tables.filter((table) => table.columns.some((column) => column.type !== undefined));
  const untyped = tables.filter(
    (table) =>
      table.columns.length > 0 && table.columns.every((column) => column.type === undefined),
  );
  const mixIssues =
    typed.length > 0 && untyped.length > 0
      ? [
          inputIssue(
            `${typed.length} SQL ${typed.length === 1 ? "table" : "tables"} and ${untyped.length} entity ${untyped.length === 1 ? "card" : "cards"} in one figure; give every column a type, or none`,
          ),
        ]
      : [];

  const authoredGroups = list(raw["groups"]).flatMap((value) => {
    const group = record(value);
    const id = text(group?.["id"]);
    return id === undefined
      ? []
      : [{ id, label: text(group?.["label"]), note: text(group?.["note"]) }];
  });
  const used = [...new Set(tables.flatMap((table) => table.group ?? []))];
  const groups = used.map((id, index): SchemaGroup => {
    const authored = authoredGroups.find((group) => group.id === id);
    return {
      id,
      label: authored?.label ?? id,
      ...(authored?.note === undefined ? {} : { note: authored.note }),
      tint: index % 6,
    };
  });
  const groupIssues = authoredGroups
    .filter((group) => used.includes(group.id) === false)
    .map((group) =>
      inputIssue(
        `group "${group.id}" has no table; a table joins it by its name, such as ${group.id}.users`,
      ),
    );

  const keyRelations = refs.flatMap((ref, index): SchemaRelation[] => {
    const to = endOf(ref.to, tables);
    return to === undefined
      ? []
      : [{ id: `key-${index + 1}`, kind: "key", from: ref.from, to, cardinality: "many-to-one" }];
  });
  const linkIssues: FigureIssue[] = [];
  const links = list(raw["links"]).flatMap((value, index): SchemaRelation[] => {
    const link = record(value) ?? {};
    const fromText = text(link["from"]) ?? "?";
    const toText = text(link["to"]) ?? "?";
    const name = `link ${fromText} -> ${toText}`;
    const from = endOf(fromText, tables);
    const to = endOf(toText, tables);
    if (from === undefined || to === undefined) {
      linkIssues.push(
        inputIssue(
          `${name} names an undeclared table or column "${from === undefined ? fromText : toText}"`,
        ),
      );
      return [];
    }
    const label = text(link["label"]);
    if (label === undefined)
      linkIssues.push(inputIssue(`${name} has no label; say how they relate`));
    const authored = text(link["cardinality"]);
    const cardinality = oneOf(cardinalities, authored) === true ? authored : undefined;
    if (authored !== undefined && cardinality === undefined)
      linkIssues.push(
        inputIssue(
          `${name} has unknown cardinality "${authored}"; use one-to-one, one-to-many, many-to-one or many-to-many`,
        ),
      );
    return [
      {
        id: `link-${index + 1}`,
        kind: "link",
        from,
        to,
        ...(label === undefined ? {} : { label }),
        ...(cardinality === undefined ? {} : { cardinality }),
      },
    ];
  });

  const caseIssues: FigureIssue[] = [];
  const tableNames = new Set(tables.map((table) => table.name));
  const startWith = list(raw["startWith"]).flatMap((value) => {
    const name = text(value) ?? "?";
    if (tableNames.has(name) === true) return [name];
    caseIssues.push(inputIssue(`startWith names an undeclared table "${name}"`));
    return [];
  });
  const usedCaseIds = new Set<string>();
  const caseId = (authored: string | undefined, label: string, fallback: string): string => {
    const base = authored ?? (slug(label) === "" ? fallback : slug(label));
    const id = usedCaseIds.has(base) === true ? `${base}-${usedCaseIds.size + 1}` : base;
    usedCaseIds.add(id);
    return id;
  };
  const replays = list(raw["replays"]).flatMap((value, index): SchemaCase[] => {
    const replay = record(value) ?? {};
    const label = text(replay["label"]);
    const name = label === undefined ? `replay ${index + 1}` : `replay "${label}"`;
    if (label === undefined) caseIssues.push(inputIssue(`${name} has no label`));
    const authored = list(replay["steps"]);
    if (authored.length === 0) caseIssues.push(inputIssue(`${name} has no steps`));
    if (authored.length > schemaBudget.steps)
      caseIssues.push(
        inputIssue(`${name} has ${authored.length} steps; the budget is ${schemaBudget.steps}`),
      );
    const steps = authored.flatMap((entry, step) => {
      const fields = record(entry) ?? {};
      const at = (typeof fields["at"] === "string" ? [fields["at"]] : list(fields["at"])).flatMap(
        (id) => {
          const named = text(id) ?? "?";
          if (endOf(named, tables) !== undefined) return [named];
          caseIssues.push(
            inputIssue(`${name} step ${step + 1} names an undeclared table or column "${named}"`),
          );
          return [];
        },
      );
      return at.length === 0 ? [] : [{ at, note: text(fields["note"]) ?? "" }];
    });
    const shown = label ?? `Replay ${index + 1}`;
    return steps.length === 0
      ? []
      : [
          {
            kind: "replay",
            id: caseId(text(replay["id"]), shown, `replay-${index + 1}`),
            label: shown,
            steps,
          },
        ];
  });
  const knownTarget = (value: string): boolean =>
    tableNames.has(value) === true || (value.endsWith(".*") && used.includes(value.slice(0, -2)));
  const lenses = list(raw["lenses"]).map((value, index): SchemaCase => {
    const lens = record(value) ?? {};
    const label = text(lens["label"]);
    const note = text(lens["note"]);
    const name = label === undefined ? `lens ${index + 1}` : `lens "${label}"`;
    if (label === undefined) caseIssues.push(inputIssue(`${name} has no label`));
    if (note === undefined) caseIssues.push(inputIssue(`${name} has no note`));
    const focus = list(lens["focus"]).flatMap((entry) => {
      const target = text(entry) ?? "?";
      if (knownTarget(target) === true) return [target];
      caseIssues.push(inputIssue(`${name} names an undeclared table or schema "${target}"`));
      return [];
    });
    const grants = record(lens["access"]);
    const access =
      grants === undefined
        ? undefined
        : new Map(
            Object.entries(grants).flatMap(([target, level]): (readonly [string, Access])[] => {
              if (knownTarget(target) === false) {
                caseIssues.push(
                  inputIssue(`${name} names an undeclared table or schema "${target}"`),
                );
                return [];
              }
              if (oneOf(accessLevels, level) === false) {
                caseIssues.push(
                  inputIssue(
                    `${name} gives "${target}" an unknown access "${String(level)}"; use read, write, read-write or none`,
                  ),
                );
                return [];
              }
              return [[target, level]];
            }),
          );
    const shown = label ?? `Lens ${index + 1}`;
    return {
      kind: "lens",
      id: caseId(text(lens["id"]), shown, `lens-${index + 1}`),
      label: shown,
      note: note ?? "",
      focus: focus.flatMap((target) =>
        target.endsWith(".*")
          ? tables.filter((table) => table.group === target.slice(0, -2)).map((table) => table.name)
          : [target],
      ),
      ...(access === undefined ? {} : { access }),
    };
  });

  const rule = record(raw["rule"]);
  const ruleTitle = text(rule?.["title"]);
  const ruleText = text(rule?.["text"]);
  const summary = text(raw["summary"]);
  return {
    model: {
      id: text(raw["id"]) ?? "schema",
      title: text(raw["title"]) ?? "",
      ...(summary === undefined ? {} : { summary }),
      ...(ruleTitle === undefined || ruleText === undefined
        ? {}
        : { rule: { title: ruleTitle, text: ruleText } }),
      startWith,
      tables,
      groups,
      relations: [...keyRelations, ...links],
      cases: [...replays, ...lenses],
      entities: typed.length === 0 && untyped.length > 0,
    },
    issues: [
      ...idIssues(raw["id"]),
      ...claimIssues(raw["title"]),
      ...(list(raw["tables"]).length === 0
        ? [inputIssue("tables is empty; give the tables or the entities")]
        : []),
      ...tableIssues,
      ...mixIssues,
      ...groupIssues,
      ...linkIssues,
      ...caseIssues,
      ...(tables.length > schemaBudget.tables
        ? [
            inputIssue(
              `${tables.length} tables; split the figure by group (at most ${schemaBudget.tables})`,
            ),
          ]
        : []),
    ],
  };
}

/** What a lens with `access` lets its role do to `table`: its own grant, else its schema's, else none. */
export function accessOf(
  lens: Extract<SchemaCase, { readonly kind: "lens" }>,
  table: SchemaTable,
): Access | undefined {
  if (lens.access === undefined) return undefined;
  return (
    lens.access.get(table.name) ??
    (table.group === undefined ? undefined : lens.access.get(`${table.group}.*`)) ??
    "none"
  );
}

/** The short stamp of an access level: R, W, RW, or none. */
export const accessStamp: Readonly<Record<Access, string>> = {
  read: "R",
  write: "W",
  "read-write": "RW",
  none: "none",
};

export type SchemaFocus = {
  /** Relations that leave the table: what it references. */
  readonly out: readonly SchemaRelation[];
  /** Relations that enter the table: what references it. */
  readonly incoming: readonly SchemaRelation[];
  readonly near: ReadonlySet<string>;
  /** The panel's sentence: what the table references and what references it. */
  readonly sentence: string;
};

/** The short name of a table, for text. */
export function schemaLabel(model: SchemaModel, name: string): string {
  return model.tables.find((table) => table.name === name)?.short ?? name;
}

/** The short name of a table, or of a column as `table.column`, for text. */
export function schemaPlaceLabel(model: SchemaModel, id: string): string {
  if (model.tables.some((table) => table.name === id)) return schemaLabel(model, id);
  const dot = id.lastIndexOf(".");
  return `${schemaLabel(model, id.slice(0, dot))}.${id.slice(dot + 1)}`;
}

/** What stays inked around the table `name`, and the sentence the panel reads. */
export function schemaFocus(model: SchemaModel, name: string): SchemaFocus {
  const table = model.tables.find((candidate) => candidate.name === name);
  if (table === undefined) return { out: [], incoming: [], near: new Set(), sentence: "" };
  const out = model.relations.filter((relation) => relation.from.table === name);
  const incoming = model.relations.filter(
    (relation) => relation.to.table === name && relation.from.table !== name,
  );
  const pair = (relation: SchemaRelation, other: string): string =>
    `${schemaLabel(model, other)}${
      relation.from.column === undefined || relation.to.column === undefined
        ? relation.label === undefined
          ? ""
          : ` (${relation.label})`
        : ` (${relation.from.column} -> ${relation.to.column})`
    }`;
  const references =
    out.length === 0
      ? "references nothing"
      : `references ${out.map((relation) => pair(relation, relation.to.table)).join(", ")}`;
  const referenced =
    incoming.length === 0
      ? ""
      : ` Referenced by ${incoming.map((relation) => pair(relation, relation.from.table)).join(", ")}.`;
  return {
    out,
    incoming,
    near: new Set([
      name,
      ...out.map((relation) => relation.to.table),
      ...incoming.map((relation) => relation.from.table),
    ]),
    sentence: `${table.short} ${references}.${referenced}`,
  };
}

/** The plain text of a `Schema`, used by copy and search. */
export function schemaReadable(model: SchemaModel): string {
  const name = (table: string): string => schemaLabel(model, table);
  const end = (value: SchemaEnd): string =>
    value.column === undefined ? name(value.table) : `${name(value.table)}.${value.column}`;
  const column = (table: SchemaTable, value: SchemaColumn): string => {
    const key = model.relations.find(
      (relation) =>
        relation.kind === "key" &&
        relation.from.table === table.name &&
        relation.from.column === value.name,
    );
    return [
      value.name,
      value.type ?? "",
      value.key === "pk" ? "PK" : value.key === "unique" ? "UQ" : "",
      value.foreign ? (key === undefined ? "FK" : `FK -> ${end(key.to)}`) : "",
      value.nullable ? "nullable" : "",
      value.note === undefined ? "" : `(${value.note})`,
    ]
      .filter((part) => part !== "")
      .join(" ");
  };
  return [
    model.title,
    model.summary ?? "",
    model.rule === undefined ? "" : `How to read this: ${model.rule.title}. ${model.rule.text}`,
    model.startWith.length === 0 ? "" : `Start with: ${model.startWith.map(name).join(", ")}`,
    ...model.groups.map(
      (group) =>
        `${group.label}${group.note === undefined ? "" : ` (${group.note})`}: ${model.tables
          .filter((table) => table.group === group.id)
          .map((table) => table.short)
          .join(", ")}`,
    ),
    ...model.tables.map(
      (table) =>
        `${table.short}: ${table.columns
          .map((value) => column(table, value))
          .join(", ")}${table.note === undefined ? "" : `. ${table.note}`}${
          table.unique.length === 0
            ? ""
            : `. Unique: ${table.unique.map((set) => `(${set.join(", ")})`).join(", ")}`
        }`,
    ),
    ...model.relations
      .filter((relation) => relation.kind === "link")
      .map(
        (relation) =>
          `${end(relation.from)} -> ${end(relation.to)}: ${relation.label ?? ""}${
            relation.cardinality === undefined ? "" : ` (${relation.cardinality})`
          }`,
      ),
    ...model.cases.map((item) => {
      if (item.kind === "replay")
        return `Replay ${item.label}: ${item.steps
          .map(
            (step, index) =>
              `${index + 1}. ${step.at.map((id) => schemaPlaceLabel(model, id)).join(", ")}: ${step.note}`,
          )
          .join(" ")}`;
      const access =
        item.access === undefined
          ? ""
          : ` Access: ${model.tables
              .map((table) => `${table.short} ${accessStamp[accessOf(item, table) ?? "none"]}`)
              .join(", ")}`;
      const focus = item.focus.length === 0 ? "" : ` Focus: ${item.focus.map(name).join(", ")}`;
      return `Lens ${item.label}: ${item.note}${access}${focus}`;
    }),
  ]
    .filter((line) => line !== "")
    .join("\n");
}
