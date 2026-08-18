import { test, expect } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import { runBlockedWriteProbe, runSmoke } from '../scripts/run-platform-zero-cost-smoke.mjs'

const artifactDirectory = new URL('../platform-smoke-artifacts/', import.meta.url)

test.use({ trace: 'off' })

test('本地五分钟冒烟仅读首屏且生成写请求为零', async () => {
  const previous = Object.fromEntries([
    'PLATFORM_SMOKE_BASE_URL',
    'PLATFORM_SMOKE_EMAIL',
    'PLATFORM_SMOKE_PASSWORD',
  ].map((name) => [name, process.env[name]]))

  process.env.PLATFORM_SMOKE_BASE_URL = 'http://127.0.0.1:4173'
  process.env.PLATFORM_SMOKE_EMAIL = 'monitor@example.test'
  process.env.PLATFORM_SMOKE_PASSWORD = 'local-test-only'
  try {
    const result = await runSmoke({ localFixture: true })
    expect(result.generationWriteCount).toBe(0)
    expect(result.nonLoginWriteCount).toBe(0)
    expect(result.safeTrace.at(-1)).toMatchObject({ result: 'passed' })
    expect(result.safeTrace.filter((entry) => entry.step === 'allowed-api')).toEqual([
      { step: 'allowed-api', method: 'POST', pathname: '/api/v1/auth/login', status: 200 },
      { step: 'allowed-api', method: 'GET', pathname: '/api/v1/auth/me', status: 200 },
      { step: 'allowed-api', method: 'GET', pathname: '/api/v1/canvas/model-catalog', status: 200 },
    ])

    const artifactNames = await readdir(artifactDirectory)
    expect(artifactNames.sort()).toEqual([
      'safe-trace.json',
      'sanitized-canvas.png',
      'sanitized-factory.png',
      'sanitized-home.png',
      'sanitized-script-analysis.png',
    ])
    const forbiddenArtifactText = /monitor@example\.test|local-test-only|fixture-session|Authorization|Cookie|Bearer/i
    for (const name of artifactNames) {
      const contents = await readFile(new URL(name, artifactDirectory))
      expect(contents.toString('latin1')).not.toMatch(forbiddenArtifactText)
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('禁止生成 POST 在到达本地 fixture 前被拦截', async () => {
  const previous = Object.fromEntries([
    'PLATFORM_SMOKE_BASE_URL',
    'PLATFORM_SMOKE_EMAIL',
    'PLATFORM_SMOKE_PASSWORD',
  ].map((name) => [name, process.env[name]]))

  process.env.PLATFORM_SMOKE_BASE_URL = 'http://127.0.0.1:4173'
  process.env.PLATFORM_SMOKE_EMAIL = 'monitor@example.test'
  process.env.PLATFORM_SMOKE_PASSWORD = 'local-test-only'
  try {
    const result = await runBlockedWriteProbe()
    expect(result.blockedRequestCount).toBe(1)
    expect(result.fixtureWriteCount).toBe(0)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
