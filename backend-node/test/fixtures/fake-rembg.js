const path = require('node:path');
const fs = require('node:fs');
const sharp = require('sharp');

if (process.argv.includes('--version')) {
  process.stdout.write('rembg 2.0.77\n');
  process.exit(0);
}

if (process.argv.includes('--fail')) {
  process.stderr.write('fake rembg processing failure');
  process.exit(2);
}

const inputPath = process.argv.at(-2);
const outputPath = process.argv.at(-1);

if (process.argv.includes('--invalid')) {
  fs.writeFileSync(path.resolve(outputPath), 'not an image');
  process.exit(0);
}

if (process.argv.includes('--truncated')) {
  sharp(inputPath)
    .ensureAlpha()
    .png()
    .toBuffer()
    .then((buffer) => {
      fs.writeFileSync(path.resolve(outputPath), buffer.subarray(0, buffer.length - 20));
    })
    .catch((error) => {
      process.stderr.write(error.message);
      process.exitCode = 1;
    });
  return;
}

if (process.argv.includes('--oversized')) {
  sharp({
    create: {
      width: 6500,
      height: 6500,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toFile(path.resolve(outputPath))
    .catch((error) => {
      process.stderr.write(error.message);
      process.exitCode = 1;
    });
  return;
}

const delayArg = process.argv.find((value) => value.startsWith('--delay-ms='));
const delayMs = Math.max(0, Number(delayArg?.split('=')[1]) || 0);
const writeOutput = () => {
  sharp(inputPath)
    .ensureAlpha()
    .png()
    .toFile(path.resolve(outputPath))
    .catch((error) => {
      process.stderr.write(error.message);
      process.exitCode = 1;
    });
};

if (delayMs) setTimeout(writeOutput, delayMs);
else writeOutput();
