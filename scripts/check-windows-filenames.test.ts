import {expect,test} from 'bun:test';
const {invalidWindowsPaths}=require('./check-windows-filenames.cjs');
test('raw Chinese and spaced paths are accepted without Git quoting false positives',()=>{expect(invalidWindowsPaths(['打开Merqo-经营晨会版.cmd','docs/记录-800.png','docs/my note.md'])).toEqual([]);});
test('literal Windows-illegal filename characters still fail',()=>{const names=['bad:name.md','bad"name','bad?name','a\\b.txt','bad\nname'];expect(invalidWindowsPaths(names)).toEqual(names);});
