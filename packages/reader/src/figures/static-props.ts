/**
 * Reads a figure's props without running the page. Literal data (strings, numbers, arrays,
 * objects, template strings) is evaluated, and so are names bound to literal data in the
 * document or in a local module it imports, such as a generated data file. Anything computed at
 * runtime (a call, an operator, a package import) is reported as not static, with the reason.
 * No author code runs: modules are transpiled and parsed, never executed.
 */
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { Parser } from "acorn";
import { transpile } from "../host.ts";
import type {
  Expression,
  ModuleDeclaration,
  Node,
  Pattern,
  Program,
  SpreadElement,
  Statement,
} from "estree";

/** Why a value cannot be known without running the page. */
export class NotStatic extends Error {
  override readonly name = "NotStatic";
}

/** Stands in for a rendered node (JSX) inside data: its presence is known, its content is not. */
export const renderedNode = Object.freeze({ rendered: true });

type Binding =
  | { readonly kind: "value"; readonly node: Expression; readonly scope: ModuleScope }
  | { readonly kind: "import"; readonly path: string; readonly name: string }
  | { readonly kind: "namespace"; readonly path: string }
  | { readonly kind: "data"; readonly value: unknown }
  | { readonly kind: "unsupported"; readonly reason: string };

/** The names a document or module binds at its top level, and the names it exports. */
export type ModuleScope = {
  readonly path: string;
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly exports: ReadonlyMap<string, Binding>;
};

/** Every module reachable from a document, loaded once. */
export type ModuleGraph = Map<string, ModuleScope | NotStatic>;

const scriptExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"] as const;
const loaders = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
} as const;

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/** The file a relative specifier names, trying the extensions an import may leave out. */
async function resolveLocal(from: string, specifier: string): Promise<string | undefined> {
  if (specifier.startsWith(".") === false) return undefined;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...[...scriptExtensions, ".json"].map((extension) => `${base}${extension}`),
    ...scriptExtensions.map((extension) => resolve(base, `index${extension}`)),
  ];
  const found = await Promise.all(candidates.map((candidate) => exists(candidate)));
  return candidates[found.indexOf(true)];
}

const parser = Parser;

/** Parses a script module after Bun strips its types. */
function parseScript(path: string, source: string): Program {
  const loader = new Map<string, "ts" | "tsx" | "js" | "jsx">(Object.entries(loaders)).get(
    extname(path),
  );
  const javascript = transpile(source, loader ?? "ts");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- acorn's tree is ESTree; its own type names differ from `@types/estree`.
  return parser.parse(javascript, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as Program;
}

const isPattern = (pattern: Pattern): pattern is Extract<Pattern, { type: "Identifier" }> =>
  pattern.type === "Identifier";

/**
 * Collects the top-level bindings and exports of `body`. Imports from a relative path are queued
 * on `pending` so the graph can load them; any other import binds an unsupported name.
 */
async function scopeOf(
  path: string,
  body: readonly (Statement | ModuleDeclaration)[],
  pending: string[],
): Promise<ModuleScope> {
  const bindings = new Map<string, Binding>();
  const exports = new Map<string, Binding>();
  const scope: ModuleScope = { path, bindings, exports };
  const declare = (statement: Statement | ModuleDeclaration): readonly string[] => {
    if (statement.type !== "VariableDeclaration") return [];
    return statement.declarations.flatMap((declaration) => {
      if (
        isPattern(declaration.id) === false ||
        declaration.init === null ||
        declaration.init === undefined
      )
        return [];
      const name = (declaration.id as { name: string }).name;
      bindings.set(name, { kind: "value", node: declaration.init, scope });
      return [name];
    });
  };
  const imports = body.flatMap((statement) =>
    statement.type === "ImportDeclaration" && typeof statement.source.value === "string"
      ? [{ statement, specifier: statement.source.value }]
      : [],
  );
  const resolved = await Promise.all(
    imports.map(async (entry) => ({ ...entry, path: await resolveLocal(path, entry.specifier) })),
  );
  resolved.forEach(({ statement, specifier, path: target }) => {
    if (target !== undefined) pending.push(target);
    statement.specifiers.forEach((specifierNode) => {
      const local = specifierNode.local.name;
      if (target === undefined) {
        bindings.set(local, {
          kind: "unsupported",
          reason: `"${local}" comes from "${specifier}", which is not a local file`,
        });
        return;
      }
      if (specifierNode.type === "ImportNamespaceSpecifier")
        bindings.set(local, { kind: "namespace", path: target });
      else
        bindings.set(local, {
          kind: "import",
          path: target,
          name:
            specifierNode.type === "ImportDefaultSpecifier"
              ? "default"
              : specifierNode.imported.type === "Identifier"
                ? specifierNode.imported.name
                : String(specifierNode.imported.value),
        });
    });
  });
  const reexports = body.flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" &&
    statement.source !== null &&
    statement.source !== undefined &&
    typeof statement.source.value === "string"
      ? [{ statement, specifier: statement.source.value }]
      : [],
  );
  const reexported = await Promise.all(
    reexports.map(async (entry) => ({ ...entry, path: await resolveLocal(path, entry.specifier) })),
  );
  reexported.forEach(({ statement, path: target }) => {
    if (target === undefined) return;
    pending.push(target);
    statement.specifiers.forEach((specifier) => {
      const exported =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : String(specifier.exported.value);
      const local =
        specifier.local.type === "Identifier"
          ? specifier.local.name
          : String(specifier.local.value);
      exports.set(exported, { kind: "import", path: target, name: local });
    });
  });
  body.forEach((statement) => {
    if (statement.type === "VariableDeclaration") declare(statement);
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration !== null &&
      statement.declaration !== undefined
    ) {
      declare(statement.declaration).forEach((name) => {
        const binding = bindings.get(name);
        if (binding !== undefined) exports.set(name, binding);
      });
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      exports.set(
        "default",
        declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration"
          ? { kind: "unsupported", reason: "the default export is not data" }
          : { kind: "value", node: declaration, scope },
      );
    }
  });
  // `export { a, b as c }` names bindings declared anywhere in the module.
  body.forEach((statement) => {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      (statement.source !== null && statement.source !== undefined)
    )
      return;
    statement.specifiers.forEach((specifier) => {
      const local =
        specifier.local.type === "Identifier"
          ? specifier.local.name
          : String(specifier.local.value);
      const exported =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : String(specifier.exported.value);
      const binding = bindings.get(local);
      if (binding !== undefined) exports.set(exported, binding);
    });
  });
  return scope;
}

/** Loads one imported file into the graph: JSON as data, scripts as parsed bindings. */
async function loadModule(path: string, graph: ModuleGraph, pending: string[]): Promise<void> {
  try {
    const source = await readFile(path, "utf8");
    if (extname(path) === ".json") {
      const value: unknown = JSON.parse(source);
      const exports = new Map<string, Binding>([["default", { kind: "data", value }]]);
      graph.set(path, { path, bindings: new Map(), exports });
      return;
    }
    graph.set(path, await scopeOf(path, parseScript(path, source).body, pending));
  } catch (error) {
    graph.set(
      path,
      new NotStatic(
        `${path} cannot be read as data: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/** Builds the scope of a document from its ESM blocks, and loads every local module it reaches. */
export async function documentScope(
  path: string,
  body: readonly (Statement | ModuleDeclaration)[],
): Promise<{ readonly scope: ModuleScope; readonly graph: ModuleGraph }> {
  const graph: ModuleGraph = new Map();
  const pending: string[] = [];
  const scope = await scopeOf(path, body, pending);
  const drain = async (): Promise<void> => {
    const next = pending.splice(0).filter((target) => graph.has(target) === false);
    if (next.length === 0) return;
    await Promise.all([...new Set(next)].map((target) => loadModule(target, graph, pending)));
    await drain();
  };
  await drain();
  return { scope, graph };
}

const describe = (node: Node): string => {
  switch (node.type) {
    case "CallExpression":
    case "NewExpression":
      return "a function call";
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return "a function";
    case "BinaryExpression":
    case "LogicalExpression":
    case "ConditionalExpression":
      return "an expression";
    default:
      return `a ${node.type}`;
  }
};

/** Evaluates literal data in `scope`, following names into imported modules. */
export function staticValue(
  node: Node,
  scope: ModuleScope,
  graph: ModuleGraph,
  visiting: ReadonlySet<Binding> = new Set(),
): unknown {
  const evaluate = (child: Node): unknown => staticValue(child, scope, graph, visiting);
  const spread = (element: Expression | SpreadElement): readonly unknown[] => {
    if (element.type !== "SpreadElement") return [evaluate(element)];
    const value = evaluate(element.argument);
    if (Array.isArray(value) === false)
      throw new NotStatic("a spread of something that is not a list");
    return value as readonly unknown[];
  };
  switch (node.type) {
    case "Literal":
      if ("regex" in node) throw new NotStatic("a regular expression");
      return node.value;
    case "TemplateLiteral":
      return node.quasis
        .map(
          (quasi, index) =>
            `${quasi.value.cooked ?? quasi.value.raw}${
              index < node.expressions.length
                ? String(evaluate(node.expressions[index] ?? node))
                : ""
            }`,
        )
        .join("");
    case "ArrayExpression":
      return node.elements.flatMap((element) => (element === null ? [undefined] : spread(element)));
    case "ObjectExpression":
      return node.properties.reduce<Record<string, unknown>>((object, property) => {
        if (property.type === "SpreadElement") {
          const value = evaluate(property.argument);
          if (typeof value !== "object" || value === null || Array.isArray(value) === true)
            throw new NotStatic("a spread of something that is not an object");
          return { ...object, ...value };
        }
        if (property.kind !== "init" || property.method === true)
          throw new NotStatic("an object method or accessor");
        const key =
          property.computed === true
            ? String(evaluate(property.key))
            : property.key.type === "Identifier"
              ? property.key.name
              : String(evaluate(property.key));
        return { ...object, [key]: evaluate(property.value) };
      }, {});
    case "UnaryExpression": {
      const value = evaluate(node.argument);
      if (node.operator === "-" && typeof value === "number") return -value;
      if (node.operator === "+" && typeof value === "number") return value;
      throw new NotStatic(`the operator ${node.operator}`);
    }
    case "MemberExpression": {
      const object = evaluate(node.object);
      const key =
        node.computed === true
          ? String(evaluate(node.property))
          : node.property.type === "Identifier"
            ? node.property.name
            : "";
      if (typeof object !== "object" || object === null)
        throw new NotStatic(`a property of something that is not data`);
      return new Map(Object.entries(object)).get(key);
    }
    case "Identifier": {
      if (node.name === "undefined") return undefined;
      const binding = scope.bindings.get(node.name);
      if (binding === undefined)
        throw new NotStatic(`"${node.name}" is not defined in the document`);
      return bindingValue(binding, graph, visiting, node.name);
    }
    case "JSXElement":
    case "JSXFragment":
      return renderedNode;
    default:
      throw new NotStatic(`it is computed at runtime (${describe(node)})`);
  }
}

function bindingValue(
  binding: Binding,
  graph: ModuleGraph,
  visiting: ReadonlySet<Binding>,
  name: string,
): unknown {
  if (visiting.has(binding) === true) throw new NotStatic(`"${name}" refers to itself`);
  const next = new Set([...visiting, binding]);
  switch (binding.kind) {
    case "data":
      return binding.value;
    case "value":
      return staticValue(binding.node, binding.scope, graph, next);
    case "unsupported":
      throw new NotStatic(binding.reason);
    case "namespace": {
      const module = graph.get(binding.path);
      if (module === undefined || module instanceof NotStatic)
        throw module ?? new NotStatic(`${binding.path} was not loaded`);
      return Object.fromEntries(
        [...module.exports].map(([exported, inner]) => [
          exported,
          bindingValue(inner, graph, next, exported),
        ]),
      );
    }
    case "import": {
      const module = graph.get(binding.path);
      if (module === undefined || module instanceof NotStatic)
        throw module ?? new NotStatic(`${binding.path} was not loaded`);
      const exported = module.exports.get(binding.name);
      if (exported === undefined)
        throw new NotStatic(`${binding.path} exports no "${binding.name}"`);
      return bindingValue(exported, graph, next, binding.name);
    }
    // Coverage skip: an exhaustive guard; every binding kind has its own case above.
    /* v8 ignore next -- @preserve */
    default: {
      const exhaustive: never = binding;
      return exhaustive;
    }
  }
}
