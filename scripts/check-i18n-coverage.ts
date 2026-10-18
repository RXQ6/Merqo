import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { translationKeys, hasTranslation } from './i18n-coverage';

const root = resolve(import.meta.dir, '..');
const locale = JSON.parse(readFileSync(resolve(root, 'packages/shared/src/i18n/locales/en.json'), 'utf8')) as Record<string, unknown>;
const missing: string[] = []; let calls = 0, dynamic = 0, files = 0;
for (const folder of ['apps/electron/src', 'packages/shared/src', 'packages/ui/src']) {
  for (const file of new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: resolve(root, folder), absolute: true, onlyFiles: true })) {
    if (/[/\\](?:__tests__|fixtures)[/\\]|\.(?:test|spec|isolated)\./.test(file)) continue;
    const found = translationKeys(readFileSync(file, 'utf8'), file); files++; dynamic += found.dynamic;
    for (const key of found.keys) { calls++; if (!hasTranslation(key, locale)) missing.push(`${relative(root, file)}: ${key}`); }
  }
}
if (missing.length) { console.error('Static i18n keys missing from en.json:\n' + missing.join('\n')); process.exitCode = 1; }
else console.log(`i18n static key coverage OK (${calls} distinct calls per file across ${files} files; ${dynamic} dynamic calls need runtime review). Hardcoded UI copy is outside this check.`);
