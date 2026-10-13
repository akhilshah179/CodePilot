import { ANALYZABLE_LANGUAGES } from '../languages.ts';
import { emptyComplexity, parseScript, type ParseResult } from './typescript.ts';

export type { ImportRecord, ParseResult } from './typescript.ts';

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Parse the `<script>` blocks of a Vue/Svelte single-file component, preserving original line numbers. */
function parseComponentFile(text: string, fileName: string): ParseResult {
  const merged: ParseResult = { imports: [], exports: [], diagnostics: [], directives: [], hasJsx: false, exportedHttpMethods: [], parseErrorCount: 0, capitalizedExport: false, complexity: emptyComplexity() };
  for (const match of text.matchAll(SCRIPT_BLOCK)) {
    const attrs = match[1];
    const body = match[2];
    const bodyStart = match.index + match[0].indexOf('>') + 1;
    const lineOffset = text.slice(0, bodyStart).split('\n').length - 1;
    const isTs = /\blang=["']ts["']/.test(attrs);
    const r = parseScript(body, fileName + (isTs ? '.ts' : '.js'), isTs ? 'typescript' : 'javascript', lineOffset);
    merged.imports.push(...r.imports);
    merged.exports.push(...r.exports);
    merged.diagnostics.push(...r.diagnostics);
    merged.parseErrorCount += r.parseErrorCount;
    merged.capitalizedExport ||= r.capitalizedExport;
    merged.complexity.functions += r.complexity.functions;
    merged.complexity.decisions += r.complexity.decisions;
    if (r.complexity.max > merged.complexity.max) {
      merged.complexity.max = r.complexity.max;
      merged.complexity.maxName = r.complexity.maxName;
      merged.complexity.maxLine = r.complexity.maxLine;
    }
  }
  merged.hasJsx = true; // Components render markup by definition.
  return merged;
}

export function canParse(language: string): boolean {
  return ANALYZABLE_LANGUAGES.has(language);
}

export function parseSource(text: string, fileName: string, language: string): ParseResult {
  if (language === 'vue' || language === 'svelte') return parseComponentFile(text, fileName);
  return parseScript(text, fileName, language);
}
