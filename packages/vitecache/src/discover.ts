import JSON5 from 'json5';
import { parseSync, Visitor, type ESTree } from 'vite';
import type { JsonValue } from './entry.js';

/** A `loadAsync(...args)` of a cached loader that discovery found, which warming repeats on a `new` loader in Node. */
export interface Load {
  importer: string;
  /** Where in the importer the load is, as `line:column`. */
  position: string;
  source: string;
  name: string;
  args: JsonValue[];
}

/**
 * The convention that marks a class as a cached loader: its loadAsync computes a result once and saves it. Warming
 * constructs it without arguments, so only loadAsync's arguments, and in a public file its path, may select the result.
 */
const loader = /^Cached\w*Loader$/;

/**
 * The cached loader loads in a module: `new Loader(...).loadAsync(...)`, or `loadAsync(...)` on a variable initialized
 * with `new Loader(...)`. Any other use of a loader or such a variable fails, since warming could not repeat it.
 */
export function discover(code: string, importer: string): Load[] {
  const at = (offset: number) => {
    const lines = code.slice(0, offset).split('\n');
    return `${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`;
  };
  const fail = (message: string, offset: number): never => {
    throw new Error(`${message} at ${importer}:${at(offset)}`);
  };
  // .glts asset scripts are TypeScript.
  const { program, errors } = parseSync(importer, code, importer.endsWith('.glts') ? { lang: 'ts' } : undefined);
  if (errors[0]) fail(errors[0].message, errors[0].labels[0]?.start ?? 0);
  const imports = new Map<string, { source: string; name: string }>();
  const namespaces = new Map<string, string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') namespaces.set(specifier.local.name, statement.source.value);
      if (specifier.type !== 'ImportSpecifier') continue;
      const name = specifier.imported.type === 'Literal' ? specifier.imported.value : specifier.imported.name;
      if (loader.test(name)) imports.set(specifier.local.name, { source: statement.source.value, name });
    }
  }
  /** Nodes that name a loader or loader variable without using its value. */
  const allowed = new Set<ESTree.Node>();
  // JSON5 is the literal subset of JavaScript: unquoted keys, single quotes, signed numbers.
  const literal = (node: ESTree.Argument) => {
    try {
      return JSON5.parse<JsonValue>(code.slice(node.start, node.end));
    } catch {
      return fail('Cached loader loadAsync arguments must be literal JSON', node.start);
    }
  };
  const target = (node: ESTree.Node) => {
    if (node.type === 'Identifier') return imports.get(node.name);
    if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier') return undefined;
    const source = namespaces.get(node.object.name);
    return source !== undefined && loader.test(node.property.name) ? { source, name: node.property.name } : undefined;
  };
  const created = (node: ESTree.NewExpression) => {
    const loaded = target(node.callee);
    if (loaded) allowed.add(node.callee);
    return loaded;
  };
  // A first pass, since a variable can be used above its declaration, as in a function declared earlier.
  const instances = new Map<string, { source: string; name: string }>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier' || node.init?.type !== 'NewExpression') return;
      const instance = created(node.init);
      if (!instance) return;
      instances.set(node.id.name, instance);
      allowed.add(node.id);
    },
  }).visit(program);
  const member = (node: { computed: boolean; key: ESTree.Node }) => {
    if (!node.computed) allowed.add(node.key);
  };
  const misused = (node: ESTree.Node) =>
    fail('Use cached loaders only as new Loader().loadAsync(), or a variable of one', node.start);
  const loads: Load[] = [];
  new Visitor({
    ImportSpecifier: (node) => allowed.add(node.local).add(node.imported),
    // Loads through an exported loader variable happen in other modules, out of discovery's reach.
    ExportSpecifier(node) {
      if (node.local.type === 'Identifier' && instances.has(node.local.name)) misused(node);
      allowed.add(node.local).add(node.exported);
    },
    ExportNamedDeclaration(node) {
      if (node.declaration?.type !== 'VariableDeclaration') return;
      for (const { id } of node.declaration.declarations)
        if (id.type === 'Identifier' && instances.has(id.name)) misused(id);
    },
    Property(node) {
      if (!node.shorthand) member(node);
    },
    MethodDefinition: member,
    PropertyDefinition: member,
    CallExpression(node) {
      const { callee } = node;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'loadAsync') return;
      const { object } = callee;
      const instance =
        object.type === 'NewExpression'
          ? created(object)
          : object.type === 'Identifier'
            ? instances.get(object.name)
            : undefined;
      if (!instance) return;
      allowed.add(object);
      loads.push({ importer, position: at(node.start), ...instance, args: node.arguments.map(literal) });
    },
    MemberExpression(node) {
      if (!node.computed) allowed.add(node.property);
      if (target(node) && !allowed.has(node)) misused(node);
    },
    Identifier(node) {
      if ((imports.has(node.name) || instances.has(node.name)) && !allowed.has(node)) misused(node);
    },
  }).visit(program);
  return loads;
}
