// Real renderer/preload/main RPC; GitHub HTTP is replaced only inside this isolated process.
const { _electron: electron } = require(process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright');
const { expect } = require((process.env.MERQO_PLAYWRIGHT_MODULE || 'playwright') + '/test');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),profile=path.resolve(process.env.MERQO_PREVIEW_PROFILE||'');
assert(profile.startsWith(path.join(root,'.runtime','ingestion-ui-')),'isolated synthetic profile required');
const config=JSON.parse(fs.readFileSync(path.join(profile,'config/config.json'),'utf8')),version=require('../packaging/windows-release.json').version;
const out=path.join(root,'artifacts/update-ui',new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(out,{recursive:true});
let app,page;const checks=[];
const mockRelease=version=>{const name=`Merqo-Setup-${version}-x64.exe`;return{tag_name:`v${version}`,draft:false,prerelease:true,published_at:'2026-10-20T05:18:37Z',assets:[{name,size:100,browser_download_url:`https://github.com/RXQ6/Merqo/releases/download/v${version}/${name}`}]};};
async function fixture(payload,status=200){await app.evaluate((_electron,{payload,status})=>{globalThis.fetch=async url=>{if(String(url)!=='https://api.github.com/repos/RXQ6/Merqo/releases?per_page=100')throw Error('Unexpected update source');return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json'}});};},{payload,status});}
async function run(){
 const env={...process.env,CRAFT_CONFIG_DIR:path.join(profile,'config'),RETAILPILOT_USER_DATA_DIR:path.join(profile,'chromium'),RETAILPILOT_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
 app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(root,'apps/electron')],cwd:root,env,timeout:60000});
 await app.firstWindow();
 await expect.poll(()=>app.windows().some(p=>{try{return new URL(p.url()).searchParams.get('workspaceId')===config.workspaces[0].id;}catch{return false;}}),{timeout:30000}).toBe(true);
 page=app.windows().find(p=>{try{return new URL(p.url()).searchParams.get('workspaceId')===config.workspaces[0].id;}catch{return false;}});page.setDefaultTimeout(30000);
 await page.context().tracing.start({screenshots:true,snapshots:true});
 await expect.poll(async()=>await page.getByTestId('retail-workspace').isVisible()||await page.locator('[data-focus-zone="sidebar"]').isVisible(),{timeout:30000}).toBe(true);
 if(await page.getByTestId('retail-workspace').isVisible())await page.getByRole('button',{name:'高级工作台',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 const check=page.getByRole('button',{name:'立即检查',exact:true});await expect(check).toBeVisible();
 const w=await app.browserWindow(page);await w.evaluate(w=>w.setSize(1440,1000));
 const about=page.getByRole('heading',{name:'关于',exact:true});await about.scrollIntoViewIfNeeded();
 await expect(page.getByText('源码开发版',{exact:true})).toBeVisible();await expect(page.getByText(version,{exact:true})).toBeVisible();
 await fixture([mockRelease(version)]);await check.click();await expect(page.getByRole('status').filter({hasText:`GitHub：${version}`})).toBeVisible();
 let info=await page.evaluate(()=>window.electronAPI.getUpdateInfo());assert.equal(info.currentVersion,version);assert.equal(info.latestVersion,version);assert.equal(info.checkStatus,'development');assert.equal(info.available,false);assert.equal(info.error,undefined);checks.push('current version uses Merqo recipe; matching GitHub beta is displayed as development build, not latest installer');
 await page.screenshot({path:path.join(out,'matching-beta.png')});
 await fixture({message:'rate limit'},403);await check.click();await expect(page.getByText('检查失败，请重试',{exact:true})).toBeVisible();info=await page.evaluate(()=>window.electronAPI.getUpdateInfo());assert.equal(info.checkStatus,'error');assert.equal(info.latestVersion,null);assert(info.error.includes('HTTP 403'));await expect(page.getByText(/版本 .*已是最新|已是最新版本/)).toHaveCount(0);checks.push('HTTP 403 propagates through real main IPC into persistent failure UI, with no latest-version success');await page.screenshot({path:path.join(out,'failed-check.png')});
 const future='0.1.0-beta.999';await fixture([mockRelease(future)]);await check.click();await expect(page.getByRole('status').filter({hasText:`GitHub：${future}`})).toBeVisible();info=await page.evaluate(()=>window.electronAPI.getUpdateInfo());assert.equal(info.available,true);assert.equal(info.error,undefined);assert.equal(info.downloadState,'idle');assert.equal(info.releaseUrl,`https://github.com/RXQ6/Merqo/releases/tag/v${future}`);checks.push('synthetic future beta appears as available, clears old error, and stays manual download without install-ready state');
 await fixture([mockRelease(version)]);await check.click();await expect(page.getByRole('status').filter({hasText:`GitHub：${version}`})).toBeVisible();await page.screenshot({path:path.join(out,'restored-check.png')});
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:true,version,checks,githubHttpMocked:true,realDownloads:0,realInstalls:0},null,2));console.log(JSON.stringify({ok:true,out,checks}));
}
run().catch(async error=>{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({ok:false,checks,error:error.stack},null,2));await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{await page?.context().tracing.stop({path:path.join(out,'trace.zip')}).catch(()=>{});await app?.close();});
