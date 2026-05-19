const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const svg = fs.readFileSync(path.join(__dirname, '../public/icon.svg'));

async function gen(size, name) {
    await sharp(svg)
        .resize(size, size)
        .png()
        .toFile(path.join(__dirname, `../public/${name}`));
    console.log(`✓ ${name} (${size}x${size})`);
}

(async () => {
    await gen(192, 'icon-192.png');
    await gen(512, 'icon-512.png');
    await gen(180, 'apple-touch-icon.png');
})();
