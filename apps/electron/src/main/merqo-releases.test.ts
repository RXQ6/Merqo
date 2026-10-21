import { describe, expect, test } from 'bun:test';
import { compareReleaseVersions, fetchMerqoRelease, MERQO_RELEASES_API, selectMerqoRelease } from './merqo-releases';
import { APP_VERSION } from '../../../../packages/shared/src/version';
import release from '../../../../packaging/windows-release.json';
import root from '../../../../package.json';
import desktop from '../../package.json';
import shared from '../../../../packages/shared/package.json';

function published(version: string, overrides = {}) {
  const filename = `Merqo-Setup-${version}-x64.exe`;
  return { tag_name: `v${version}`, draft: false, prerelease: version.includes('-'), published_at: '2026-10-20T05:18:37Z', assets: [{ name: filename, size: 100, browser_download_url: `https://github.com/RXQ6/Merqo/releases/download/v${version}/${filename}` }], ...overrides };
}
describe('Merqo release identity and update feed', () => {
  test('runtime, source packages and installer use the Merqo release recipe', () => {
    expect([APP_VERSION, root.version, desktop.version, shared.version]).toEqual(Array(4).fill(release.version));
    expect(MERQO_RELEASES_API).toBe('https://api.github.com/repos/RXQ6/Merqo/releases?per_page=100');
  });
  test('beta channel includes prereleases and sorts numerically rather than by API order', () => {
    expect(selectMerqoRelease([published('0.1.0-beta.3'), published('0.1.0-beta.10'), published('0.1.0-beta.5')], true).version).toBe('0.1.0-beta.10');
  });
  test('stable channel excludes beta tags even with a forged prerelease flag', () => {
    expect(selectMerqoRelease([published('0.2.0-beta.5', { prerelease: false }), published('0.1.0')], false).version).toBe('0.1.0');
  });
  test('drafts, invalid tags, missing installers, empty assets and cross-repository links are excluded', () => {
    const foreign = published('9.0.0'); foreign.assets[0]!.browser_download_url = 'https://github.com/other/product/releases/download/v9.0.0/setup.exe';
    expect(selectMerqoRelease([published('5.0.0', { draft: true }), published('4.0.0', { assets: [] }), published('3.0.0', { tag_name: 'invalid' }), foreign, published('0.1.0-beta.5')], true).version).toBe('0.1.0-beta.5');
  });
  test('no supported publication or malformed response is an error, never latest', () => {
    expect(() => selectMerqoRelease([], true)).toThrow();
    expect(() => selectMerqoRelease({ message: 'rate limit' }, true)).toThrow();
    expect(() => selectMerqoRelease([published('0.1.0-beta.5')], false)).toThrow();
  });
  test('semver handles release, prerelease, metadata and lower versions', () => {
    expect(compareReleaseVersions('0.1.0', '0.1.0-beta.10')).toBe(1);
    expect(compareReleaseVersions('0.1.0-beta.10', '0.1.0-beta.5')).toBe(1);
    expect(compareReleaseVersions('0.1.0-beta.5+source', '0.1.0-beta.5')).toBe(0);
    expect(compareReleaseVersions('0.1.0-beta.3', '0.1.0-beta.5')).toBe(-1);
    expect(() => compareReleaseVersions('0.1.0-beta.01', '0.1.0')).toThrow();
  });
  test('fetch uses the configured repository and beta channel', async () => {
    const fetcher = (async (url: string | URL | Request) => {
      expect(url).toBe(MERQO_RELEASES_API);
      return Response.json([published('0.1.0-beta.5')]);
    }) as typeof fetch;
    const result = await fetchMerqoRelease('0.1.0-beta.3', fetcher);
    expect(result.releaseUrl).toBe('https://github.com/RXQ6/Merqo/releases/tag/v0.1.0-beta.5');
  });
  test('network and HTTP failures propagate as failed checks', async () => {
    await expect(fetchMerqoRelease('0.1.0-beta.5', (async () => new Response('', { status: 403 })) as typeof fetch)).rejects.toThrow('HTTP 403');
    await expect(fetchMerqoRelease('0.1.0-beta.5', (async () => { throw new Error('offline'); }) as typeof fetch)).rejects.toThrow('offline');
  });
});
