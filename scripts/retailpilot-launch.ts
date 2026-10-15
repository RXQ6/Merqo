/** Launch compiled desktop app without killing ports or downloading optional tools. */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dir, '..');
const electron = join(root, 'node_modules/electron/dist/electron.exe');
if (process.platform !== 'win32') throw new Error('This M0 launcher currently targets Windows.');
if (!existsSync(electron) || !existsSync(join(root, 'apps/electron/dist/main.cjs'))) {
  throw new Error('Run bun install and bun run retail:build first.');
}
const runtime = join(root, '.runtime');
mkdirSync(runtime, { recursive: true });
const env: NodeJS.ProcessEnv = { ...process.env,
  CRAFT_CONFIG_DIR: join(runtime, 'config'),
  CRAFT_APP_NAME: 'RetailPilot',
  CRAFT_DEEPLINK_SCHEME: 'retailpilot',
  RETAILPILOT_USER_DATA_DIR: join(runtime, 'chromium'),
};
delete env.ELECTRON_RUN_AS_NODE;
// The desktop is explicitly interactive. Do not inherit the hidden-test mode or
// use STARTF_USESHOWWINDOW/SW_HIDE for this GUI executable on Windows.
delete env.RETAILPILOT_SMOKE;
delete env.RETAILPILOT_VERIFY_VISIBLE;
const child = spawn(electron, [join(root, 'apps/electron')], { cwd: root, env, stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
