const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ERROR_CODE = 'REDRAW_FULL_FRAME_OUTPUT_INVALID';

function outputInvalid() {
  const error = new Error(ERROR_CODE);
  error.code = ERROR_CODE;
  return error;
}

function assertSafeOutputPath(outputPath) {
  if (typeof outputPath !== 'string' || outputPath.length === 0 || outputPath.includes('\0')) throw outputInvalid();
  if (/^(https?|file):\/\//i.test(outputPath)) throw outputInvalid();
  if (/(api[_-]?key|access[_-]?token|authorization|bearer|client[_-]?secret|secret|token)=/i.test(outputPath)) throw outputInvalid();
}

function assertProjection(fixture) {
  if (fixture.case_id !== 'ac087bcd-latam-en-us') throw outputInvalid();
  if (!fixture.source || fixture.source.duration_ms !== 68733 || !fixture.source.sha256 || !fixture.source.video) throw outputInvalid();
  if (fixture.target?.language !== 'en' || fixture.target?.locale !== 'en-US' || fixture.target?.market !== 'US') throw outputInvalid();
  if (!Array.isArray(fixture.cast) || fixture.cast.length !== 5) throw outputInvalid();
  if (!Array.isArray(fixture.shots) || fixture.shots.length !== 9) throw outputInvalid();
  const castIds = new Set(fixture.cast.map((item) => item.id));
  for (let index = 0; index < fixture.shots.length; index += 1) {
    const shot = fixture.shots[index];
    if (shot.id !== `shot-${index + 1}`) throw outputInvalid();
    if (index === 0 && shot.start_ms !== 0) throw outputInvalid();
    if (index > 0 && shot.start_ms !== fixture.shots[index - 1].end_ms) throw outputInvalid();
    if (index === fixture.shots.length - 1 && shot.end_ms !== 68733) throw outputInvalid();
    for (const speakerId of shot.speaking_character_ids) {
      if (!castIds.has(speakerId)) throw outputInvalid();
    }
    for (const region of shot.text_regions) {
      if (!['text_subtitle', 'text_screen'].includes(region.kind)) throw outputInvalid();
      if (region.kind === 'text_subtitle' && region.treatment !== 'translate_subtitle') throw outputInvalid();
      if (region.kind === 'text_screen' && region.treatment !== 'localize_screen') throw outputInvalid();
    }
  }
  const serialized = JSON.stringify(fixture);
  if (/[\u3400-\u9fff]/.test(serialized)) throw outputInvalid();
  if (/https?:\/\/|file:\/\/|[A-Za-z]:\\|authorization|api[_-]?key|client_secret|access-token|bearer|source_name|target_name|dialogue|screen_text|ocr/i.test(serialized)) {
    throw outputInvalid();
  }
}

async function buildAuditCaseFixture() {
  const fixturePath = path.resolve(__dirname, '..', '..', 'frontweb', 'e2e', 'fixtures', 'redraw-latin-american-case.js');
  const mod = await import(pathToFileURL(fixturePath).href);
  const source = mod.redrawLatinAmericanCase;
  const projected = {
    case_id: source.id,
    source: JSON.parse(JSON.stringify(source.source)),
    target: JSON.parse(JSON.stringify(source.target)),
    cast: source.cast.map(({ id, role, age_min }) => ({ id, role, age_min })),
    shots: source.sourceFacts.shots.map(({
      id,
      start_ms,
      end_ms,
      speaking_character_ids,
      text_regions,
    }) => ({
      id,
      start_ms,
      end_ms,
      speaking_character_ids: [...speaking_character_ids],
      text_regions: text_regions.map(({ region_key, kind, time_ranges }) => ({
        region_key,
        kind,
        time_ranges: JSON.parse(JSON.stringify(time_ranges)),
        treatment: kind === 'text_subtitle' ? 'translate_subtitle' : 'localize_screen',
      })),
    })),
  };
  assertProjection(projected);
  return projected;
}

async function writeAtomicJson(filePath, value) {
  const parent = path.dirname(filePath);
  const temp = path.join(parent, `.tmp-redraw-full-frame-audit-${process.pid}-${Date.now()}.json`);
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fsp.rename(temp, filePath);
}

async function writeAuditCaseFile({ outputPath }) {
  assertSafeOutputPath(outputPath);
  const target = path.resolve(outputPath);
  if (fs.existsSync(target)) throw outputInvalid();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const fixture = await buildAuditCaseFixture();
  await writeAtomicJson(target, fixture);
  return { ok: true };
}

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  if (argv.length !== 2 || argv[0] !== '--output') throw outputInvalid();
  assertSafeOutputPath(argv[1]);
  return { outputPath: argv[1] };
}

async function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('Usage: node scripts/export-redraw-full-frame-audit-case.js --output <missing-file>\n');
      return;
    }
    await writeAuditCaseFile(args);
    process.stdout.write('REDRAW_FULL_FRAME_AUDIT_CASE_OK\n');
  } catch (_) {
    process.stderr.write(`${ERROR_CODE}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  buildAuditCaseFixture,
  writeAuditCaseFile,
  parseArgs,
  runCli,
};
