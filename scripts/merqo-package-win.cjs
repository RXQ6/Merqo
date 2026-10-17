// Explicit allowlisted staging: never include .runtime, credentials or the source checkout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { build, Platform } = require('electron-builder');
const root = path.resolve(__dirname, '..');
const release = require('../packaging/windows-release.json');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 build host required');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', windowsHide: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const output = path.join(root, 'artifacts/windows', release.version);
const stage = path.join(root, 'artifacts/windows', `stage-${release.version}-${Date.now()}`);
const app = path.join(stage, 'app');
const cache = path.join(root, 'artifacts/windows/cache');
fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
function copy(source, destination) {
  const from = path.resolve(root, source); const to = path.join(app, destination || source);
  if (!fs.existsSync(from)) throw new Error(`Required package input missing: ${source}`);
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, dereference: true });
}
function bundle(source, destination) {
  const target = path.join(app, destination); fs.mkdirSync(path.dirname(target), { recursive: true });
  run('bun', ['build', source, '--target=bun', '--format=esm', '--outfile', target]);
}
async function main() {
  // Build-time providers/telemetry are deliberately empty in this public preview.
  for (const name of ['SLACK_OAUTH_CLIENT_ID', 'SLACK_OAUTH_CLIENT_SECRET', 'MICROSOFT_OAUTH_CLIENT_ID', 'MICROSOFT_OAUTH_CLIENT_SECRET', 'SENTRY_ELECTRON_INGEST_URL', 'CRAFT_DEV_RUNTIME']) delete process.env[name];
  if (fs.existsSync(path.join(root, '.env'))) throw new Error('Public packaging requires a checkout without .env; configure credentials only at runtime');
  if (!process.argv.includes('--skip-build')) run('bun', ['run', 'retail:build']);
  copy('apps/electron/dist', 'dist');
  for (const name of ['LICENSE', 'NOTICE', 'TRADEMARK.md']) copy(name);
  copy('packages/retail-domain/skills');
  bundle('scripts/retailpilot-data-worker.ts', 'scripts/retailpilot-data-worker.ts');
  bundle('scripts/merqo-retail-mcp.ts', 'scripts/merqo-retail-mcp.ts');
  copy('packages/session-mcp-server/dist/index.js', 'resources/session-mcp-server/index.js');
  copy('packages/pi-agent-server/dist/index.js', 'resources/pi-agent-server/index.js');
  copy('packages/messaging-whatsapp-worker/dist/worker.cjs', 'resources/messaging-whatsapp-worker/worker.cjs');
  const sdk = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk');
  const sdkBinary = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64');
  const rg = path.join(root, 'node_modules/@vscode/ripgrep');
  for (const entry of [path.join(sdk, 'sdk.mjs'), path.join(sdkBinary, 'claude.exe'), path.join(rg, 'bin/rg.exe')]) if (!fs.existsSync(entry)) throw new Error(`Required runtime missing: ${entry}`);
  const asset = 'bun-windows-x64-baseline.zip';
  const zip = path.join(cache, `bun-${release.bunVersion}-${asset}`);
  const sums = path.join(cache, `bun-${release.bunVersion}-SHASUMS256.txt`);
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${release.bunVersion}/`;
  for (const [url, dest] of [[base + 'SHASUMS256.txt', sums], [base + asset, zip]]) {
    if (!fs.existsSync(dest)) run('curl.exe', ['--fail', '--location', '--retry', '2', '--connect-timeout', '20', '--max-time', '240', '--output', dest, url]);
  }
  const line = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find(line => line.trim().endsWith(asset));
  if (!line || hash(zip) !== line.trim().split(/\s+/)[0].toLowerCase()) throw new Error('Bun baseline SHA-256 mismatch');
  const unpack = path.join(stage, 'bun'); fs.mkdirSync(unpack, { recursive: true });
  run('tar.exe', ['-xf', zip, '-C', unpack]);
  const bun = path.join(unpack, 'bun-windows-x64-baseline/bun.exe');
  if (!fs.existsSync(bun)) throw new Error('Downloaded Bun baseline missing');
  const bunVersion = execFileSync(bun, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  if (bunVersion !== release.bunVersion) throw new Error('Bundled Bun version mismatch');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: 'merqo-desktop', version: release.version, productName: 'Merqo', main: 'dist/main.cjs',
    description: 'Evidence-backed retail analysis desktop preview', author: 'RXQ6', license: 'Apache-2.0',
  }, null, 2));
  fs.writeFileSync(path.join(app, 'THIRD_PARTY_NOTICES.txt'), 'Merqo derives from Craft Agents (Apache-2.0). See LICENSE, NOTICE and TRADEMARK.md.\nBundled Electron/Chromium notices: LICENSE.electron.txt and LICENSES.chromium.html.\nBun: https://github.com/oven-sh/bun/blob/main/LICENSE.md\nClaude Agent SDK and binary: resources/app/node_modules/@anthropic-ai/ (included license files).\nRipgrep: resources/app/node_modules/@vscode/ripgrep/ (included license files).\n');
  const config = {
    appId: release.appId, productName: release.productName, electronVersion: release.electronVersion,
    electronDist: path.join(root, 'node_modules/electron/dist'),
    directories: { app, output, buildResources: path.join(root, 'apps/electron/resources') },
    files: ['**/*', '!**/*.map', '!**/node_modules/**/*', '!dist/renderer/src/**'],
    asar: false, npmRebuild: false, forceCodeSigning: false, publish: null,
    extraResources: [
      { from: sdk, to: 'app/node_modules/@anthropic-ai/claude-agent-sdk' },
      { from: sdkBinary, to: 'app/node_modules/@anthropic-ai/claude-agent-sdk-binary' },
      { from: rg, to: 'app/node_modules/@vscode/ripgrep' },
      { from: bun, to: 'vendor/bun/bun.exe' },
    ],
    win: { icon: path.join(root, 'apps/electron/resources/icon.ico'), target: [{ target: 'nsis', arch: ['x64'] }], artifactName: 'Merqo-Setup-${version}-${arch}.${ext}' },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false,
      runAfterFinish: false, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'Merqo', uninstallDisplayName: 'Merqo', artifactName: 'Merqo-Setup-${version}-${arch}.${ext}' },
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'build-inputs.json'), JSON.stringify({ ...release, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), bunSha256: hash(bun), stage, signed: false }, null, 2));
  await build({ targets: Platform.WINDOWS.createTarget(['nsis'], 1), config, publish: 'never' });
  const installer = `Merqo-Setup-${release.version}-x64.exe`;
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${hash(path.join(output, installer))}  ${installer}\n`);
  console.log(`Installer ready: ${path.join(output, installer)}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
