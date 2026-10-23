const {execFileSync}=require('node:child_process');
function invalidWindowsPaths(paths){return paths.filter(name=>/[\\<>:"|?*\u0000-\u001f]/.test(name));}
if(require.main===module){const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean),bad=invalidWindowsPaths(files);if(bad.length){console.error('Files with characters illegal on Windows:');for(const name of bad)console.error(JSON.stringify(name));process.exitCode=1;}else console.log('Windows filename characters checked using raw NUL-separated paths');}
module.exports={invalidWindowsPaths};
