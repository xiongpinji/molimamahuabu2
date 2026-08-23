const sharp = require('sharp');

const args = process.argv.slice(2);

if (args.includes('-h')) {
  process.stderr.write('Usage: fake-realesrgan -i infile -o outfile -s scale -m model-path -n model-name\n');
  process.exit(0);
}

if (args.includes('--fail')) {
  process.stderr.write('fake Real-ESRGAN processing failure\n');
  process.exit(2);
}

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

async function main() {
  const input = argument('-i');
  const output = argument('-o');
  const scale = Number(argument('-s'));
  if (!input || !output || ![2, 3, 4].includes(scale)) process.exit(3);
  const metadata = await sharp(input).metadata();
  await sharp(input)
    .resize(metadata.width * scale, metadata.height * scale, { kernel: 'lanczos3' })
    .png()
    .toFile(output);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(4);
});
