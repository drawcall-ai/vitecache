import { parseSync, Visitor, type ESTree } from 'vite';

/** A source range in the importer. */
export interface Range {
  start: number;
  end: number;
}

/** A function passed inline among a load's arguments, which warming repeats from its source. */
export interface InlineFunction extends Range {
  /** The specifiers it imports dynamically as string literals. */
  imports: string[];
}

/** A `loadAsync(...args)` of a cached loader that discovery found, which warming repeats on a `new` loader in Node. */
export interface Load {
  importer: string;
  /** Where in the importer the load is, as `line:column`. */
  position: string;
  source: string;
  name: string;
  /** Each argument's source: JSON written as JavaScript literals, and inline functions. */
  args: Range[];
  functions: InlineFunction[];
}

/** An AST node, walked generically by its properties. */
type Node = { type: string; start: number; end: number; [key: string]: unknown };

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** TypeScript nodes that hold a value; other TypeScript nodes are types, which name nothing at runtime. */
const values = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
  'TSParameterProperty',
]);

/** Visits every node below `node` outside types, with the parent and the property holding it. */
function walk(node: Node, visit: (node: Node, parent: Node, key: string) => void): void {
  for (const [key, child] of Object.entries(node)) {
    for (const item of [child].flat()) {
      if (!isNode(item) || (item.type.startsWith('TS') && !values.has(item.type))) continue;
      visit(item, node, key);
      walk(item, visit);
    }
  }
}

/** A root holding `node`, so that walking it visits `node` too. */
const holding = (node: Node): Node => ({ type: 'Program', start: node.start, end: node.end, body: [node] });

/** The names a binding pattern declares. */
function bound(pattern: unknown, names: Set<string>): void {
  if (!isNode(pattern)) return;
  if (pattern.type === 'Identifier') names.add(pattern.name as string);
  else if (pattern.type === 'ObjectPattern')
    for (const property of pattern.properties as Node[])
      bound(property.type === 'RestElement' ? property.argument : property.value, names);
  else if (pattern.type === 'ArrayPattern') for (const element of pattern.elements as unknown[]) bound(element, names);
  else if (pattern.type === 'AssignmentPattern') bound(pattern.left, names);
  else if (pattern.type === 'RestElement') bound(pattern.argument, names);
  else if (pattern.type === 'TSParameterProperty') bound(pattern.parameter, names);
}

/** Every name declared below `node`, in any scope. */
function declared(node: Node): Set<string> {
  const names = new Set<string>();
  walk(node, (child) => {
    if (child.type === 'VariableDeclarator') bound(child.id, names);
    else if (child.type === 'CatchClause') bound(child.param, names);
    else if (/^Import\w*Specifier$/.test(child.type)) bound(child.local, names);
    else if (/Function|Class|^TS(Enum|Module)Declaration$|^TSImportEquals/.test(child.type)) bound(child.id, names);
    if (/Function/.test(child.type)) for (const param of (child.params as unknown[]) ?? []) bound(param, names);
  });
  return names;
}

/** Whether an identifier at this place names a variable, rather than a property, label or meta property. */
function referenced(parent: Node, key: string): boolean {
  if (parent.computed !== true && key === 'key') return false;
  if (parent.type === 'MemberExpression' && key === 'property' && parent.computed !== true) return false;
  return key !== 'label' && parent.type !== 'MetaProperty';
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
  /** Names declared anywhere in the module, which an inline function must not use from outside itself. */
  const context = declared(program as unknown as Node);
  /** Checks that a function uses no variable of its module, so that warming can repeat it from its source alone. */
  const inline = (node: Node): InlineFunction => {
    const own = declared(holding(node));
    const imports: string[] = [];
    walk(holding(node), (child, parent, key) => {
      if (child.type === 'ImportExpression' && isNode(child.source) && typeof child.source.value === 'string')
        imports.push(child.source.value);
      if (child.type !== 'Identifier' || !referenced(parent, key)) return;
      const name = child.name as string;
      if (context.has(name) && !own.has(name))
        fail(`Inline functions in cached loader loads must not use ${name} from their module`, child.start);
    });
    return { start: node.start, end: node.end, imports };
  };
  /** JSON written as JavaScript literals, and inline functions, which it collects. */
  const literal = (node: Node, functions: InlineFunction[]): void => {
    const nested = (child: unknown) => literal(child as Node, functions);
    const invalid = () =>
      fail('Cached loader loadAsync arguments must be literal JSON or inline functions', node.start);
    switch (node.type) {
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return void functions.push(inline(node));
      case 'ParenthesizedExpression':
        return nested(node.expression);
      case 'Literal':
        if (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value)) return;
        return invalid();
      case 'UnaryExpression':
        if (/^[-+]$/.test(node.operator as string) && isNode(node.argument) && typeof node.argument.value === 'number')
          return;
        return invalid();
      case 'ArrayExpression':
        for (const element of node.elements as unknown[]) {
          if (!isNode(element) || element.type === 'SpreadElement') invalid();
          nested(element);
        }
        return;
      case 'ObjectExpression':
        for (const property of node.properties as Node[]) {
          const { type, kind, method, shorthand, computed } = property;
          if (type !== 'Property' || kind !== 'init' || method || shorthand || computed) invalid();
          nested(property.value);
        }
        return;
      default:
        return invalid();
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
      const functions: InlineFunction[] = [];
      for (const argument of node.arguments) literal(argument as unknown as Node, functions);
      const args = node.arguments.map(({ start, end }) => ({ start, end }));
      loads.push({ importer, position: at(node.start), ...instance, args, functions });
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
