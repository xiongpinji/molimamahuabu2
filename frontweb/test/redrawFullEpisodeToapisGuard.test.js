import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { assertPaidSubmissionAuthorization } from '../scripts/toapisFullEpisodeGuard.mjs'

test('requires the exact nine-submission confirmation flag', () => {
  assert.throws(
    () => assertPaidSubmissionAuthorization({ argv: [], manifestPath: 'missing.json' }),
    /--confirm-nine-submissions/,
  )
})

test('refuses to run when the manifest already contains accepted tasks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redraw-toapis-guard-'))
  const manifestPath = path.join(dir, 'submission-manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify({ tasks: [{ task_id: 'existing-task' }] }))
  assert.throws(
    () => assertPaidSubmissionAuthorization({
      argv: ['--confirm-nine-submissions'],
      manifestPath,
    }),
    /already contains 1 generation task/,
  )
})

test('allows the exact flag when no prior task exists', () => {
  assert.doesNotThrow(() => assertPaidSubmissionAuthorization({
    argv: ['--confirm-nine-submissions'],
    manifestPath: 'missing.json',
  }))
})
