// Normal-quit restoration after the complete isolated desktop regression.
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');const out=path.join(root,'artifacts/m1');
const initial=JSON.parse(fs.readFileSync(path.join(out,'e2e-initial.json'),'utf8'));const restart=JSON.parse(fs.readFileSync(path.join(out,'e2e-restart.json'),'utf8'));
if(!initial.ok||!restart.ok||initial.profile!==restart.profile)throw new Error('A successful matching full regression is required');
const profile=path.resolve(initial.profile);if(!profile.startsWith(path.join(root,'.runtime')+path.sep))throw new Error('Isolated profile outside project runtime');
async function run(phase){
 const env={...process.env,RETAILPILOT_M1_PROFILE:profile,RETAILPILOT_M1_PHASE:phase};delete env.ELECTRON_RUN_AS_NODE;
 const log=fs.createWriteStream(path.join(out,'process-'+phase+'.log'));
 const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[path.join(root,'scripts/retailpilot-m1-host.cjs')],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Window lifecycle timeout'));},90000);child.on('error',e=>{clearTimeout(timer);log.end();reject(e);});child.on('exit',code=>{clearTimeout(timer);log.end();code===0?resolve():reject(new Error(phase+' failed'));});});
 const result=JSON.parse(fs.readFileSync(path.join(out,'e2e-'+phase+'.json'),'utf8'));if(!result.ok||result.error||result.profile!==profile||result.phase!==phase||result.failures.length)throw new Error('Lifecycle result mismatch');
 console.log(JSON.stringify({phase,ok:result.ok,checks:result.checks}));
}
(async()=>{
 if(process.argv.includes('--navigation')){await run('navigation');return;}
 if(process.argv.includes('--evidence')){await run('evidence');return;}
 await run('window-save');
 // Upgrade fixture: the old app saved a second surface=retail window.
 const statePath=path.join(profile,'config/window-state.json');
 const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
 if(state.windows.length!==1||!state.windows[0].url?.includes('view=retail'))throw new Error('Expected one saved window with analysis view');
 const legacyUrl=new URL(state.windows[0].url);legacyUrl.searchParams.delete('view');legacyUrl.searchParams.set('surface','retail');
 state.windows.push({...state.windows[0],url:legacyUrl.toString()});fs.writeFileSync(statePath,JSON.stringify(state,null,2));
 await run('window-restore');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
