// Local startup smoke: read renderer state through Electron's own test host.
// No provider requests, credentials, external messages, or business writes.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts/m0');
fs.mkdirSync(out, { recursive: true });
const progress = message => fs.appendFileSync(path.join(out, 'desktop-progress.log'), new Date().toISOString() + ' ' + message + '\n');
progress('smoke host started');
process.env.CRAFT_CONFIG_DIR = path.join(root, '.runtime/smoke-v2/config');
process.env.RETAILPILOT_USER_DATA_DIR = path.join(root, '.runtime/smoke-v2/chromium');
process.env.CRAFT_DEEPLINK_SCHEME = 'retailpilot';
process.env.RETAILPILOT_SMOKE = '1';
const issues = [];
let finished = false;
const timer = setTimeout(() => finish({ ok: false, reason: 'startup_timeout', issues }), 60000);
function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  fs.writeFileSync(path.join(out, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
  console.log('RETAILPILOT_SMOKE ' + JSON.stringify(result));
  app.exit(result.ok ? 0 : 1);
}
app.on('web-contents-created', (_event, contents) => {
  progress('web contents created');
  contents.on('preload-error', (_event, preload, error) => issues.push({ preload, error: error.message }));
  contents.on('render-process-gone', (_event, details) => issues.push(details));
  contents.on('did-finish-load', async () => {
    progress('loaded ' + contents.getURL());
    if (!contents.getURL().includes('renderer/index.html')) return;
    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const result = await contents.executeJavaScript(`(async () => {
        const workspaces = await window.electronAPI.getWorkspaces();
        const gitBash = await window.electronAPI.checkGitBash();
        return { title: document.title, text: document.body.innerText.slice(0, 3000),
          apiReady: true, workspaceCount: workspaces.length,
          gitBash,
          workspacePaths: workspaces.map(workspace => workspace.rootPath) };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 1500));
      const screenshot = await contents.capturePage();
      fs.writeFileSync(path.join(out, 'desktop-smoke.png'), screenshot.toPNG());
      const isolated = result.workspacePaths.every(value => typeof value === 'string' && path.resolve(value).startsWith(path.resolve(process.env.CRAFT_CONFIG_DIR) + path.sep));
      finish({ ok: result.apiReady && result.gitBash.found && issues.length === 0 && isolated, isolated, ...result,
        appName: app.getName(), userData: app.getPath('userData'), configDir: process.env.CRAFT_CONFIG_DIR,
        electron: process.versions.electron, node: process.versions.node, issues });
    } catch (error) { finish({ ok: false, reason: error.message, issues }); }
  });
});
try { require(path.join(root, 'apps/electron/dist/main.cjs')); }
catch (error) { finish({ ok: false, reason: error.stack || error.message, issues }); }
