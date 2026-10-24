// Convert the supplied artwork without redrawing or cropping it.
const fs=require('node:fs'),path=require('node:path'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),resources=path.join(root,'apps/electron/resources');
async function main(){
 const source=path.join(resources,'merqo-logo-source.png');
 const png=await sharp(source).resize(512,512,{fit:'contain',background:'#ffffff'}).png().toBuffer();
 fs.writeFileSync(path.join(resources,'icon.png'),png);
 const sizes=[16,24,32,48,64,128,256],images=await Promise.all(sizes.map(size=>sharp(source).resize(size,size,{fit:'contain',background:'#ffffff'}).png().toBuffer()));
 const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
 sizes.forEach((size,i)=>{const at=6+16*i;header[at]=size===256?0:size;header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(images[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=images[i].length;});
 fs.writeFileSync(path.join(resources,'icon.ico'),Buffer.concat([header,...images]));
 const chunks=[];for(const [type,size] of [['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]]){const image=await sharp(source).resize(size,size).png().toBuffer(),head=Buffer.alloc(8);head.write(type,0,4,'ascii');head.writeUInt32BE(8+image.length,4);chunks.push(head,image);}const icns=Buffer.alloc(8);icns.write('icns');icns.writeUInt32BE(8+chunks.reduce((n,b)=>n+b.length,0),4);fs.writeFileSync(path.join(resources,'icon.icns'),Buffer.concat([icns,...chunks]));
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image width="512" height="512" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
 fs.writeFileSync(path.join(resources,'icon.svg'),svg);fs.writeFileSync(path.join(resources,'icon.icon/Assets/icon.svg'),svg);
 fs.copyFileSync(path.join(resources,'icon.png'),path.join(root,'apps/electron/src/renderer/assets/merqo-logo.png'));
 console.log('Generated PNG, SVG, ICNS and Windows ICO sizes: '+sizes.join(', '));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
