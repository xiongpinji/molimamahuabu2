import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

function reject(code, message) {
  process.stderr.write(`${JSON.stringify({ ready: false, code, message })}\n`)
  process.exit(2)
}

if (process.env.RUN_REAL_SEEDREAM_IMAGE_NODE_CHAIN !== '1') {
  reject('REAL_SEEDREAM_CONFIRMATION_REQUIRED', '设置 RUN_REAL_SEEDREAM_IMAGE_NODE_CHAIN=1 后才允许消耗真实模型额度')
}

const apiKey = String(process.env.SEEDREAM_API_KEY || '').trim()
const model = String(process.env.SEEDREAM_MODEL || '').trim()
const baseUrl = String(process.env.SEEDREAM_BASE_URL || '').trim()
if (!apiKey) reject('REAL_SEEDREAM_API_KEY_REQUIRED', '缺少 SEEDREAM_API_KEY')
if (!/^doubao-seedream-4-5(?:-\d+)?$/.test(model)) {
  reject('REAL_SEEDREAM_MODEL_INVALID', 'SEEDREAM_MODEL 必须是已审计的 Seedream 4.5 模型')
}

let parsedBaseUrl
try {
  parsedBaseUrl = new URL(baseUrl)
} catch {
  reject('REAL_SEEDREAM_BASE_URL_INVALID', 'SEEDREAM_BASE_URL 不是有效 URL')
}
if (
  parsedBaseUrl.protocol !== 'https:'
  || parsedBaseUrl.username
  || parsedBaseUrl.password
  || parsedBaseUrl.search
  || parsedBaseUrl.hash
) {
  reject('REAL_SEEDREAM_BASE_URL_UNSAFE', 'SEEDREAM_BASE_URL 必须是无凭据、无查询参数的 HTTPS 地址')
}

const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
const port = await new Promise((resolve, rejectPort) => {
  const server = net.createServer()
  server.once('error', rejectPort)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close((error) => (error ? rejectPort(error) : resolve(address.port)))
  })
})
const child = spawn(process.execPath, [
  playwrightCli,
  'test',
  'e2e/image-node-toolbar-backend-integration.spec.js',
], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`,
    PLAYWRIGHT_REUSE_SERVER: '0',
  },
  stdio: 'inherit',
  windowsHide: true,
})
child.once('error', (error) => reject('REAL_SEEDREAM_GATE_START_FAILED', error.message))
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`${JSON.stringify({ ready: false, code: 'REAL_SEEDREAM_GATE_INTERRUPTED', signal })}\n`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
