import { readdirSync, writeFileSync } from 'node:fs';
import { render } from './render.js';

export function build(dir) {
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md'));
  writeFileSync('index.html', render(pages));
}
