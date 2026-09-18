// 📁 backend/scripts/resize-product-images.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = path.join(__dirname, '..', 'assets', 'products');
const SIZE = 300;

(async () => {
  const files = fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));
  let count = 0;

  for (const file of files) {
    const fullPath = path.join(DIR, file);
    const before = fs.statSync(fullPath).size;

    // Skip files already small and square
    if (before < 60 * 1024) {
      console.log(`⏭  ${file} (already ${(before/1024).toFixed(1)} KB) — skipped`);
      continue;
    }

    const buffer = await sharp(fullPath)
      .resize(SIZE, SIZE, { fit: 'cover', position: 'center' })
      .png({ quality: 85, compressionLevel: 9 })
      .toBuffer();

    const outName = file.replace(/\.(jpe?g|png)$/i, '.png');
    const outPath = path.join(DIR, outName);
    fs.writeFileSync(outPath, buffer);
    if (outPath !== fullPath) fs.unlinkSync(fullPath);

    const after = fs.statSync(outPath).size;
    console.log(
      `✅ ${file} → ${outName}  ${(before/1024).toFixed(1)} KB → ${(after/1024).toFixed(1)} KB`
    );
    count++;
  }
  console.log(`\nResized ${count} files.`);
})();