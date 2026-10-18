const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname,'..');
const release = require('../packaging/windows-release.json');
const out = path.join(root,'artifacts/windows/upgrade-'+Date.now());fs.mkdirSync(out,{recursive:true});
const install = path.join(out,'installed');fs.mkdirSync(install);
if (!path.resolve(install).startsWith(path.resolve(out)+path.sep)) throw new Error('Unsafe isolated install directory');
const oldInstaller=path.join(root,'artifacts/windows/0.1.0-beta.1/Merqo-Setup-0.1.0-beta.1-x64.exe');
const installer=path.join(root,`artifacts/windows/${release.version}/Merqo-Setup-${release.version}-x64.exe`);
const exe=path.join(install,'Merqo.exe'), checks=[];
async function run(file,args,name){
 const log=fs.createWriteStream(path.join(out,name+'.log'));
 const child=spawn(file,args,{cwd:root,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error(name+' timeout'));},300000);child.once('error',error=>{clearTimeout(timer);log.end();reject(error);});child.once('exit',code=>{clearTimeout(timer);log.end();code===0?resolve():reject(new Error(name+' exit '+code));});});
}
async function main(){
 // NSIS uses per-user registration: never replace an existing personal installation as a test side effect.
 const installed=execFileSync('powershell.exe',['-NoProfile','-Command',"@(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Merqo' -or $_.DisplayName -eq 'RetailPilot' }).Count"],{encoding:'utf8',windowsHide:true}).trim();
 if(installed!=='0')throw new Error('An existing personal Merqo installation prevents isolated NSIS verification');
 assert.ok(fs.existsSync(oldInstaller)&&fs.existsSync(installer));
 await run(oldInstaller,['/S',`/D=${install}`],'install-beta1');assert.ok(fs.existsSync(exe));
 await run(process.execPath,[path.join(__dirname,'merqo-legacy-packaged-smoke.cjs'),exe],'legacy-smoke');
 const prior=JSON.parse(fs.readFileSync(path.join(root,'artifacts/windows/verification/packaged-smoke.json'),'utf8'));assert.equal(prior.ok,true);
 fs.writeFileSync(path.join(out,'legacy-smoke.json'),JSON.stringify(prior,null,2));
 checks.push('beta.1 installed into isolated directory and created real persisted model-fixture investigation/execution receipt');
 await run(installer,['/S',`/D=${install}`],'upgrade-beta2');assert.ok(fs.existsSync(exe));
 const version=JSON.parse(fs.readFileSync(path.join(install,'resources/app/package.json'),'utf8')).version;assert.equal(version,release.version);
 await run(process.execPath,[path.join(__dirname,'merqo-packaged-smoke.cjs'),exe,'--restore-profile',prior.profile],'upgrade-restore');
 const restored=JSON.parse(fs.readFileSync(path.join(root,'artifacts/windows/verification/packaged-restored.json'),'utf8'));assert.equal(restored.ok,true);assert.equal(restored.receiptId,prior.receiptId);
 checks.push('actual beta.1 to beta.2 NSIS upgrade preserves original source data, settings and exact execution receipt');
 await run(process.execPath,[path.join(__dirname,'merqo-packaged-smoke.cjs'),exe],'new-full-smoke');
 const latest=JSON.parse(fs.readFileSync(path.join(root,'artifacts/windows/verification/packaged-smoke.json'),'utf8'));assert.equal(latest.ok,true);checks.push(...latest.checks);
 fs.writeFileSync(path.join(out,'new-smoke.json'),JSON.stringify(latest,null,2));
 await run(installer,['/S',`/D=${install}`],'reinstall-beta2');
 await run(process.execPath,[path.join(__dirname,'merqo-packaged-smoke.cjs'),exe,'--restore-profile',latest.profile],'reinstall-restore');
 const reinstalled=JSON.parse(fs.readFileSync(path.join(root,'artifacts/windows/verification/packaged-restored.json'),'utf8'));assert.equal(reinstalled.ok,true);assert.equal(reinstalled.receiptId,latest.receiptId);
 checks.push('same-version beta.2 reinstall preserves new-version evidence and receipt');
 const uninstaller=fs.readdirSync(install).find(f=>/^Uninstall.*\.exe$/i.test(f));assert.ok(uninstaller);
 await run(path.join(install,uninstaller),['/S'],'uninstall');
 const deadline=Date.now()+60000;while(fs.existsSync(exe)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,250));
 assert.equal(fs.existsSync(exe),false);assert.ok(fs.existsSync(path.join(latest.profile,'config/config.json')));
 checks.push('NSIS uninstall removes isolated executable and preserves isolated user data');
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({ok:true,version:release.version,from:'0.1.0-beta.1',install,checks,priorReceipt:prior.receiptId,receipt:latest.receiptId,modelFixture:true,cleanVm:false,windowsVersions:['Windows 11 build 26200'],signed:false},null,2));
 console.log(JSON.stringify({ok:true,out,checks}));
}
main().catch(error=>{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({ok:false,error:String(error),install,checks},null,2));console.error(error);process.exitCode=1;});
