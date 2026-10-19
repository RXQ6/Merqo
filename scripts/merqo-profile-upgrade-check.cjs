// Verify migration of a copied historical test profile; never open or alter the original.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'artifacts/windows/verification');
const original=path.resolve(process.argv[2]||''),expectedReceipt=process.argv[3];
if(!original.startsWith(out+path.sep)||!expectedReceipt)throw Error('Usage: node scripts/merqo-profile-upgrade-check.cjs <isolated historical profile> <expected receipt id>');
const profile=fs.mkdtempSync(path.join(out,'profile-upgrade-'));
const databases=[];function walk(dir,visit){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f,visit);else visit(f);}}
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
walk(path.join(original,'config'),f=>{if(f.endsWith('.sqlite'))databases.push({file:f,hash:hash(f)});});
fs.cpSync(path.join(original,'config'),path.join(profile,'config'),{recursive:true});
// Workspace roots in configuration must point to the copy. Domain records remain byte-for-byte copied.
walk(path.join(profile,'config'),f=>{if(path.basename(f)==='config.json'){const v=JSON.parse(fs.readFileSync(f,'utf8'));const rewrite=x=>typeof x==='string'?x.replaceAll(original,profile):Array.isArray(x)?x.map(rewrite):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,rewrite(v)])):x;fs.writeFileSync(f,JSON.stringify(rewrite(v),null,2));}});
const version=require('../packaging/windows-release.json').version,exe=path.join(root,`artifacts/windows/${version}/win-unpacked/Merqo.exe`);
const r=spawnSync(process.execPath,[path.join(__dirname,'merqo-packaged-smoke.cjs'),exe,'--restore-profile',profile],{cwd:root,env:process.env,windowsHide:true,encoding:'utf8',timeout:120000});
fs.writeFileSync(path.join(out,'profile-upgrade.log'),(r.stdout||'')+(r.stderr||''));assert.equal(r.status,0,r.stderr);
const restored=JSON.parse(fs.readFileSync(path.join(out,'packaged-restored.json'),'utf8'));assert.equal(restored.ok,true);assert.equal(restored.receiptId,expectedReceipt);
for(const d of databases)assert.equal(hash(d.file),d.hash,'Original database must remain unchanged');
const report={ok:true,version,from:'historical beta.2 isolated profile',original,profile,receiptId:expectedReceipt,sourceDatabaseHashes:databases,checks:['new packaged app migrates copied beta.2 data and retains exact execution receipt and connection settings','original beta.2 databases remain unchanged'],limits:['profile migration; not an NSIS cross-version upgrade','isolated synthetic test data; no real user profile touched']};
fs.writeFileSync(path.join(out,'profile-upgrade.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
