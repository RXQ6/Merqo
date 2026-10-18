import { expect, test } from 'bun:test';
import { translationKeys, hasTranslation } from './i18n-coverage';

test('translation coverage finds real hook/import/instance calls, ignoring comments and unrelated calls', () => {
  const result = translationKeys(`import { useTranslation as useT } from 'react-i18next'; import {t as tr} from 'i18next'; import i18n from './i18n';
    const {t: translate} = useT(); translate('known.key'); tr('missing.key'); i18n.t('instance.key');
    // translate('comment.key');
    const text="translate('string.key')"; other.t('unrelated.key'); translate(dynamic); translate(\`template.key\`);`, 'fixture.tsx');
  expect([...result.keys]).toEqual(['known.key', 'missing.key', 'instance.key', 'template.key']); expect(result.dynamic).toBe(1);
});
test('translation coverage preserves plural and missing-key failures', () => {
  const locale = { plain: 'yes', count_one: 'one', count_other: 'many', broken_one: 'one' };
  expect(hasTranslation('plain', locale)).toBe(true); expect(hasTranslation('count', locale)).toBe(true);
  expect(hasTranslation('broken', locale)).toBe(false); expect(hasTranslation('absent', locale)).toBe(false);
  expect(translationKeys(`function t(key:string){return key} t('not.i18n')`, 'fixture.ts').keys.size).toBe(0);
});
