import ts from 'typescript';
import type { ComplexityFacts, EdgeKind, ExportEntry, FileDiagnostic } from '../types.ts';

export interface ImportRecord {
  specifier: string;
  kind: EdgeKind;
  symbols: string[];
  line: number;
  typeOnly: boolean;
}

export interface ParseResult {
  imports: ImportRecord[];
  exports: ExportEntry[];
  diagnostics: FileDiagnostic[];
  /** Leading directives such as 'use client' / 'use server', with their line. */
  directives: { value: string; line: number }[];
  /** True if the file contains JSX elements. */
  hasJsx: boolean;
  /** Names of exported functions/variables, used by the classifier's content rules. */
  exportedHttpMethods: string[];
  /** Import/parse errors reported by the TypeScript parser. */
  parseErrorCount: number;
  /** True if an exported declaration (including a default export) has a capitalized name, e.g. `export default function App`. */
  capitalizedExport: boolean;
  complexity: ComplexityFacts;
}

export function emptyComplexity(): ComplexityFacts {
  return { functions: 0, max: 0, decisions: 0 };
}

const DECISION_OPERATORS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function isDecision(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.ConditionalExpression:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.CatchClause:
      return true;
    case ts.SyntaxKind.BinaryExpression:
      return DECISION_OPERATORS.has((node as ts.BinaryExpression).operatorToken.kind);
    default:
      return false;
  }
}

function functionName(node: ts.SignatureDeclaration, sf: ts.SourceFile): string {
  if (node.name) return node.name.getText(sf);
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(sf);
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return '(anonymous)';
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function scriptKindFor(language: string, fileName: string): ts.ScriptKind {
  if (language === 'tsx') return ts.ScriptKind.TSX;
  if (language === 'jsx') return ts.ScriptKind.JSX;
  if (language === 'typescript') return ts.ScriptKind.TS;
  if (/\.(js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JSX; // JS files may contain JSX (CRA, Vite).
  return ts.ScriptKind.TS;
}

/**
 * Extract imports/exports from JS/TS source using the TypeScript compiler's parser.
 * `lineOffset` is added to every reported line (for script blocks inside .vue/.svelte files).
 */
export function parseScript(text: string, fileName: string, language: string, lineOffset = 0): ParseResult {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(language, fileName));
  const imports: ImportRecord[] = [];
  const exports: ExportEntry[] = [];
  const diagnostics: FileDiagnostic[] = [];
  const directives: { value: string; line: number }[] = [];
  const exportedHttpMethods: string[] = [];
  let hasJsx = false;
  let capitalizedExport = false;
  const complexity = emptyComplexity();
  const moduleUnit = { name: '(module)', line: 1 + lineOffset, c: 1 };
  const fnStack: { name: string; line: number; c: number }[] = [];
  const closeUnit = (u: { name: string; line: number; c: number }) => {
    complexity.functions++;
    if (u.c > complexity.max) {
      complexity.max = u.c;
      complexity.maxName = u.name;
      complexity.maxLine = u.line;
    }
  };

  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + lineOffset;

  for (const stmt of sf.statements) {
    if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) {
      directives.push({ value: stmt.expression.text, line: lineOf(stmt) });
      continue;
    }
    break;
  }

  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
    ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

  function bindingNames(name: ts.BindingName): string[] {
    if (ts.isIdentifier(name)) return [name.text];
    const out: string[] = [];
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      out.push(...bindingNames(el.name));
    }
    return out;
  }

  /** Symbols pulled from a require()/import() result, e.g. `const { a, b: c } = require('x')` → [a, b]. */
  function consumedSymbols(call: ts.Expression): string[] {
    let node: ts.Node = call;
    if (ts.isAwaitExpression(node.parent)) node = node.parent;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return [parent.name.text];
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
      return parent.name.elements.map((el) => {
        const key = el.propertyName ?? el.name;
        return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : key.getText(sf);
      });
    }
    if (ts.isExpressionStatement(parent)) return [];
    return ['*'];
  }

  function recordExportedDeclaration(node: ts.Node) {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) return;
    const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    const line = lineOf(node);
    const push = (name: string, kind: ExportEntry['kind']) => {
      if (/^[A-Z]/.test(name) && kind !== 'interface' && kind !== 'type') capitalizedExport = true;
      exports.push({ name: isDefault ? 'default' : name, kind: isDefault ? 'default' : kind, line });
    };
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? 'default';
      push(name, 'function');
      if (HTTP_METHODS.has(name)) exportedHttpMethods.push(name);
    } else if (ts.isClassDeclaration(node)) push(node.name?.text ?? 'default', 'class');
    else if (ts.isInterfaceDeclaration(node)) push(node.name.text, 'interface');
    else if (ts.isTypeAliasDeclaration(node)) push(node.name.text, 'type');
    else if (ts.isEnumDeclaration(node)) push(node.name.text, 'enum');
    else if (ts.isModuleDeclaration(node)) push(node.name.getText(sf), 'namespace');
    else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        for (const name of bindingNames(decl.name)) {
          if (/^[A-Z]/.test(name)) capitalizedExport = true;
          exports.push({ name, kind: 'variable', line });
          if (HTTP_METHODS.has(name)) exportedHttpMethods.push(name);
        }
      }
    }
  }

  function visit(node: ts.Node) {
    const fn = ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body !== undefined ? node : null;
    if (fn) fnStack.push({ name: functionName(fn, sf), line: lineOf(fn), c: 1 });
    if (isDecision(node)) {
      complexity.decisions++;
      (fnStack[fnStack.length - 1] ?? moduleUnit).c++;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const symbols: string[] = [];
      let allTypeOnly = !!clause?.isTypeOnly;
      if (clause) {
        if (clause.name) symbols.push('default');
        const nb = clause.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) symbols.push('*');
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) symbols.push((el.propertyName ?? el.name).text);
          if (!clause.isTypeOnly && !clause.name && nb.elements.length > 0 && nb.elements.every((el) => el.isTypeOnly)) allTypeOnly = true;
        }
      }
      imports.push({ specifier: node.moduleSpecifier.text, kind: 'static', symbols, line: lineOf(node), typeOnly: allTypeOnly });
    } else if (ts.isExportDeclaration(node)) {
      const line = lineOf(node);
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const from = node.moduleSpecifier.text;
        const symbols: string[] = [];
        if (!node.exportClause) {
          symbols.push('*');
          exports.push({ name: '*', kind: 're-export', line, from });
        } else if (ts.isNamespaceExport(node.exportClause)) {
          symbols.push('*');
          exports.push({ name: node.exportClause.name.text, kind: 're-export', line, from });
        } else {
          for (const el of node.exportClause.elements) {
            symbols.push((el.propertyName ?? el.name).text);
            exports.push({ name: el.name.text, kind: 're-export', line, from });
          }
        }
        imports.push({ specifier: from, kind: 're-export', symbols, line, typeOnly: node.isTypeOnly });
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          if (/^[A-Z]/.test((el.propertyName ?? el.name).text)) capitalizedExport = true;
          exports.push({ name: el.name.text, kind: 'named', line });
          if (HTTP_METHODS.has(el.name.text)) exportedHttpMethods.push(el.name.text);
        }
      }
    } else if (ts.isExportAssignment(node)) {
      if (ts.isIdentifier(node.expression) && /^[A-Z]/.test(node.expression.text)) capitalizedExport = true;
      exports.push({ name: node.isExportEquals ? 'export=' : 'default', kind: 'default', line: lineOf(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteral(expr)) {
        imports.push({ specifier: expr.text, kind: 'require', symbols: ['*'], line: lineOf(node), typeOnly: node.isTypeOnly });
      }
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        const symbols = node.qualifier ? [node.qualifier.getText(sf).split('.')[0]] : ['*'];
        imports.push({ specifier: arg.literal.text, kind: 'static', symbols, line: lineOf(node), typeOnly: true });
      }
    } else if (ts.isCallExpression(node)) {
      handleCall(node);
    } else if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      hasJsx = true;
    } else if (ts.isExpressionStatement(node) && node.parent === sf) {
      handleCommonJsExport(node);
    }
    if (node.parent === sf) recordExportedDeclaration(node);
    ts.forEachChild(node, visit);
    if (fn) closeUnit(fnStack.pop()!);
  }

  function literalArg(call: ts.CallExpression): string | undefined {
    const arg = call.arguments[0];
    if (!arg) return undefined;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
    return undefined;
  }

  function handleCall(call: ts.CallExpression) {
    const callee = call.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = literalArg(call);
      if (spec !== undefined) {
        imports.push({ specifier: spec, kind: 'dynamic', symbols: consumedSymbols(call), line: lineOf(call), typeOnly: false });
      } else {
        diagnostics.push({ line: lineOf(call), code: 'non-literal-dynamic-import', message: 'Dynamic import with a computed path — the target cannot be determined statically, so no edge was created.' });
      }
      return;
    }
    if (ts.isIdentifier(callee) && callee.text === 'require' && call.arguments.length === 1) {
      const spec = literalArg(call);
      if (spec !== undefined) {
        imports.push({ specifier: spec, kind: 'require', symbols: consumedSymbols(call), line: lineOf(call), typeOnly: false });
      } else {
        diagnostics.push({ line: lineOf(call), code: 'non-literal-require', message: 'require() with a computed path — the target cannot be determined statically, so no edge was created.' });
      }
      return;
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'glob' &&
      ts.isMetaProperty(callee.expression) &&
      callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      diagnostics.push({ line: lineOf(call), code: 'glob-import', message: 'import.meta.glob() pattern — matched files are not expanded into edges.' });
    }
  }

  function handleCommonJsExport(stmt: ts.ExpressionStatement) {
    const expr = stmt.expression;
    if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = expr.left;
    if (!ts.isPropertyAccessExpression(left)) return;
    const text = left.getText(sf);
    if (text === 'module.exports') {
      exports.push({ name: 'module.exports', kind: 'commonjs', line: lineOf(stmt) });
    } else if (/^(module\.)?exports\.[A-Za-z_$][\w$]*$/.test(text)) {
      exports.push({ name: left.name.text, kind: 'commonjs', line: lineOf(stmt) });
    }
  }

  ts.forEachChild(sf, visit);
  if (moduleUnit.c > 1) closeUnit(moduleUnit);

  // parseDiagnostics is internal but stable; it's the parser's own syntax error list.
  const parseErrorCount = ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
  if (parseErrorCount > 0) {
    diagnostics.push({ line: 1 + lineOffset, code: 'parse-error', message: `The TypeScript parser reported ${parseErrorCount} syntax error(s); imports after an error may be incomplete.` });
  }

  return { imports, exports, diagnostics, directives, hasJsx, exportedHttpMethods, parseErrorCount, capitalizedExport, complexity };
}
