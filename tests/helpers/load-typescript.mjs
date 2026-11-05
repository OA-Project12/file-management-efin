import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);
// Isolated module cache per harness; overrides replace external dependencies only.
export function createLoader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (file.endsWith('.mjs')) return require(file);
    if (cache.has(file)) return cache.get(file).exports;
    const mod = {exports:{}}; cache.set(file, mod);
    const js = ts.transpileModule(readFileSync(file,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const resolve = name => {
      if (Object.hasOwn(overrides,name)) return overrides[name];
      if (name === './pool' && file.includes(`${path.sep}database${path.sep}`) && overrides['@/infrastructure/database/pool']) return overrides['@/infrastructure/database/pool'];
      if (name === 'server-only') return {};
      if (name.startsWith('@/')) return load(path.join('src', name.slice(2)+(name.endsWith('.mjs')?'':'.ts')));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file),name+(name.endsWith('.mjs')?'':'.ts')));
      return require(name);
    };
    new Function('require','module','exports',js)(resolve,mod,mod.exports);
    return mod.exports;
  }
  return load;
}
