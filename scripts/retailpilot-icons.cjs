const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
async function main() {
  const dir = path.resolve(__dirname, '../apps/electron/resources');
  const svg = fs.readFileSync(path.join(dir, 'retailpilot.svg'));
  const png = await sharp(svg).resize(256, 256).png().toBuffer();
  fs.writeFileSync(path.join(dir, 'icon.png'), png);
  fs.writeFileSync(path.join(dir, 'icon.svg'), svg);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, png]));
  console.log('RetailPilot Windows icon generated');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
