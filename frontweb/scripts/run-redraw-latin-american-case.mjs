import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  redrawLatinAmericanCase,
  validateSourceProbe,
} from '../e2e/fixtures/redraw-latin-american-case.js'

const require = createRequire(import.meta.url)
const frontwebRoot = fileURLToPath(new URL('../', import.meta.url))
const backendRoot = fileURLToPath(new URL('../../backend-node/', import.meta.url))
const { getFfprobePath } = require(path.join(backendRoot, 'src', 'utils', 'ffmpegPath'))

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) return null
  return process.argv[index + 1]
}

function parseRate(value) {
  const [numerator, denominator = '1'] = String(value || '').split('/')
  const result = Number(numerator) / Number(denominator)
  return Number.isFinite(result) ? result : 0
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}

const sourceOption = readOption('--source')
if (!sourceOption) {
  fail('缺少 --source <本地源视频路径>')
} else {
  const sourcePath = path.resolve(sourceOption)
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    fail(`源视频不存在：${sourcePath}`)
  } else {
    const probeResult = spawnSync(getFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,channels,sample_rate',
      '-of', 'json',
      sourcePath,
    ], { encoding: 'utf8', timeout: 30_000 })

    if (probeResult.status !== 0) {
      fail(`FFprobe 失败：${probeResult.stderr || probeResult.error?.message || probeResult.status}`)
    } else {
      try {
        const raw = JSON.parse(probeResult.stdout)
        const video = raw.streams.find((stream) => stream.codec_type === 'video')
        const audio = raw.streams.find((stream) => stream.codec_type === 'audio')
        const sourceProbe = validateSourceProbe({
          sha256: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
          duration_ms: Number(raw.format?.duration) * 1000,
          video: video && {
            width: Number(video.width),
            height: Number(video.height),
            codec: video.codec_name,
            frame_rate: parseRate(video.avg_frame_rate),
          },
          audio: audio && {
            codec: audio.codec_name,
            channels: Number(audio.channels),
            sample_rate: Number(audio.sample_rate),
          },
        })
        const outputDir = path.resolve(
          readOption('--output-dir') || path.join(frontwebRoot, 'output', 'playwright', 'ac087bcd-case'),
        )
        fs.mkdirSync(outputDir, { recursive: true })
        console.log(JSON.stringify({
          case_id: redrawLatinAmericanCase.id,
          source_path: sourcePath,
          source_probe: sourceProbe,
          output_dir: outputDir,
        }, null, 2))

        const playwrightCli = path.join(frontwebRoot, 'node_modules', '@playwright', 'test', 'cli.js')
        const result = spawnSync(process.execPath, [
          playwrightCli,
          'test',
          'e2e/redraw-backend-integration.spec.js',
        ], {
          cwd: frontwebRoot,
          env: {
            ...process.env,
            REDRAW_E2E_CASE: 'latam-real-source',
            REDRAW_E2E_SOURCE_VIDEO: sourcePath,
            REDRAW_E2E_CASE_OUTPUT_DIR: outputDir,
            PLAYWRIGHT_REUSE_SERVER: '0',
          },
          stdio: 'inherit',
        })
        if (result.error) throw result.error
        process.exitCode = result.status ?? 1
      } catch (error) {
        fail(error?.message || String(error))
      }
    }
  }
}
