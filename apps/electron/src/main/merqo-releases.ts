import release from '../../../../packaging/windows-release.json';

export const MERQO_RELEASES_URL = `https://github.com/${release.repository}/releases`;
export const MERQO_RELEASES_API = `https://api.github.com/repos/${release.repository}/releases?per_page=100`;

function parseVersion(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error(`无效的 Merqo 版本号：${value}`);
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') ?? [];
  if (core.some(n => !Number.isSafeInteger(n)) || pre.some(p => /^\d+$/.test(p) && (p.length > 1 && p.startsWith('0')))) throw new Error('无效的版本号');
  return { core, pre };
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export interface MerqoRelease { version: string; releaseUrl: string }
export function selectMerqoRelease(payload: unknown, includePrerelease: boolean): MerqoRelease {
  if (!Array.isArray(payload)) throw new Error('GitHub 发布列表格式异常');
  const candidates: MerqoRelease[] = [];
  for (const item of payload) {
    if (!item || item.draft !== false || typeof item.prerelease !== 'boolean' || (!includePrerelease && item.prerelease) || typeof item.tag_name !== 'string' || !item.published_at) continue;
    const version = item.tag_name.replace(/^v/, '');
    try { parseVersion(version); } catch { continue; }
    if (!includePrerelease && parseVersion(version).pre.length) continue;
    const filename = `Merqo-Setup-${version}-x64.exe`;
    const downloadUrl = `https://github.com/${release.repository}/releases/download/${item.tag_name}/${filename}`;
    if (!Array.isArray(item.assets) || !item.assets.some((asset: { name?: unknown; browser_download_url?: unknown; size?: unknown } | null) => asset?.name === filename && asset.browser_download_url === downloadUrl && typeof asset.size === 'number' && asset.size > 0)) continue;
    candidates.push({ version, releaseUrl: `${MERQO_RELEASES_URL}/tag/${encodeURIComponent(item.tag_name)}` });
  }
  candidates.sort((a, b) => compareReleaseVersions(b.version, a.version));
  if (!candidates[0]) throw new Error('未找到当前发布通道可用的 Merqo Windows x64 安装包');
  return candidates[0];
}

export async function fetchMerqoRelease(currentVersion: string, fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<MerqoRelease> {
  const response = await fetcher(MERQO_RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Merqo-Desktop' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`GitHub 更新检查失败（HTTP ${response.status}），请稍后重试`);
  return selectMerqoRelease(await response.json(), parseVersion(currentVersion).pre.length > 0);
}
