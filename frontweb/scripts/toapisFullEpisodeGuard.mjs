import fs from 'node:fs'

export function assertPaidSubmissionAuthorization({ argv, manifestPath }) {
  if (!argv.includes('--confirm-nine-submissions')) {
    throw new Error('真实付费执行必须显式传入 --confirm-nine-submissions')
  }
  if (!fs.existsSync(manifestPath)) return
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const taskCount = Array.isArray(manifest?.tasks) ? manifest.tasks.length : 0
  if (taskCount > 0) {
    throw new Error(`refusing rerun: manifest already contains ${taskCount} generation task(s)`)
  }
}
