import { Schema, SchemaAST } from "effect";

// Effect 4 rc.115 treats Struct({}) like TypeScript's {} type. The stricter
// input check must participate in union decoding, before a branch is selected.
const emptyObject = Schema.makeFilter<unknown>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0,
  { expected: "an empty JSON object" },
).abort();
const normalized = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

function normalize(ast: SchemaAST.AST): SchemaAST.AST {
  const cached = normalized.get(ast);
  if (cached !== undefined) return cached;
  const result = normalizeNode(ast);
  normalized.set(ast, result);
  return result;
}

function normalizeNode(ast: SchemaAST.AST): SchemaAST.AST {
  if (ast.encoding !== undefined) {
    // Only the outer encoded side consumes input. Preserve all authored
    // transformations and their decoded-side validation without rewriting them.
    const [first, ...rest] = ast.encoding;
    const rewrite = (link: SchemaAST.Link) =>
      new SchemaAST.Link(normalize(link.to), link.transformation);
    const encoding: SchemaAST.Encoding = [
      rest.length === 0 ? rewrite(first) : first,
      ...rest.map((link, index) => (index === rest.length - 1 ? rewrite(link) : link)),
    ];
    const descriptors = Object.getOwnPropertyDescriptors(ast);
    const copy: unknown = Object.create(Object.getPrototypeOf(ast), {
      ...descriptors,
      encoding: { ...descriptors.encoding, value: encoding },
    });
    // Coverage skip: a copy with the AST's own prototype and descriptors is always an AST.
    /* v8 ignore next -- @preserve */
    if (!SchemaAST.isAST(copy)) throw new Error("Could not preserve the input schema AST.");
    return copy;
  }
  if (SchemaAST.isObjects(ast)) {
    const checks: SchemaAST.Checks | undefined =
      ast.propertySignatures.length === 0 && ast.indexSignatures.length === 0
        ? [emptyObject, ...(ast.checks ?? [])]
        : ast.checks;
    return new SchemaAST.Objects(
      ast.propertySignatures.map(
        (property) => new SchemaAST.PropertySignature(property.name, normalize(property.type)),
      ),
      ast.indexSignatures.map(
        (index) => new SchemaAST.IndexSignature(index.parameter, normalize(index.type)),
      ),
      ast.annotations,
      checks,
      undefined,
      ast.context,
      ast.encodingChecks,
    );
  }
  if (SchemaAST.isArrays(ast))
    return new SchemaAST.Arrays(
      ast.isMutable,
      ast.elements.map((element) => normalize(element)),
      ast.rest.map((element) => normalize(element)),
      ast.annotations,
      ast.checks,
      undefined,
      ast.context,
      ast.encodingChecks,
    );
  if (SchemaAST.isUnion(ast))
    return new SchemaAST.Union(
      ast.types.map((member) => normalize(member)),
      ast.options,
      ast.annotations,
      ast.checks,
      undefined,
      ast.context,
      ast.encodingChecks,
    );
  if (SchemaAST.isSuspend(ast))
    return new SchemaAST.Suspend(
      () => normalize(ast.thunk()),
      ast.annotations,
      undefined,
      undefined,
      ast.context,
    );
  if (SchemaAST.isDeclaration(ast))
    return new SchemaAST.Declaration(
      ast.typeParameters.map((parameter) => normalize(parameter)),
      ast.run,
      ast.annotations,
      ast.checks,
      undefined,
      ast.context,
      ast.encodingChecks,
      ast.encodingRun,
    );
  return ast;
}

/** Builds the strict input codec without changing the author's schema or other boundaries. */
export function strictInputSchema(schema: Schema.Codec<unknown>) {
  return Schema.make<Schema.Codec<unknown>>(normalize(schema.ast));
}
