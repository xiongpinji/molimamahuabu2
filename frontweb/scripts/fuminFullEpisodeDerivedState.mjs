import fs from 'node:fs'
import path from 'node:path'

const HEX_64 = /^[a-f0-9]{64}$/i
const EXPECTED_CASE_ID = 'ac087bcd-latam-en-us'
const EXPECTED_SHOT6_ERROR = 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED'
const IDENTITY_IDS = ['mateo', 'diego', 'lucas', 'elena', 'rafael']

export const R4_SHOT6_ARTIFACT_SHA256 = '578519fa9be3ea5067176087cabeacee5413649d46ee7ffd941156a8b3ed4ac7'

function fail(code, message = code) {
  throw Object.assign(new Error(`${code}: ${message}`), { code })
}

export function assertR4DerivationSource({
  manifest,
  actualManifestSha256,
  expectedManifestSha256,
}) {
  if (!HEX_64.test(String(expectedManifestSha256 || ''))
    || String(actualManifestSha256).toLowerCase() !== String(expectedManifestSha256).toLowerCase()) {
    fail('FUMIN_DERIVE_SOURCE_MANIFEST_CAS_MISMATCH')
  }

  const contract = manifest?.contract
  const generation = manifest?.generation
  if (manifest?.schema_version !== 'redraw-fumin-full-episode-paid-private-v1'
    || manifest?.case_id !== EXPECTED_CASE_ID
    || manifest?.provider !== 'fumin.ai'
    || Number(contract?.expectedShots) !== 9
    || Number(contract?.maxPaidSubmits) !== 9
    || Number(contract?.spendCapUsd) !== 25
    || Number(contract?.estimatedPerShotUsd) !== 2.384848
    || Number(contract?.estimatedTotalUsd) !== 21.463632
    || Number(contract?.initialBalanceUsd) !== 60.16
    || contract?.accountId !== 'xiongpinji'
    || generation?.upstream_model !== 'seedance-2.0-mini'
    || generation?.resolution !== '480p'
    || generation?.aspect_ratio !== '9:16'
    || Number(generation?.duration_seconds) !== 8
    || generation?.generate_audio !== true) {
    fail('FUMIN_DERIVE_SOURCE_CONTRACT_INVALID')
  }

  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : []
  const tasksValid = tasks.length === 6 && tasks.every((task, index) => (
    Number(task.shot_number) === index + 1
      && Boolean(task.task_id)
      && (index < 5
        ? task.status === 'completed_verified'
        : task.status === 'failed' && task.error_code === EXPECTED_SHOT6_ERROR)
  ))
  if (!tasksValid) fail('FUMIN_DERIVE_SOURCE_TASKS_INVALID')

  return true
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function assertSourceLocks(sourceRoot) {
  for (let shotNumber = 1; shotNumber <= 6; shotNumber += 1) {
    const lockPath = path.join(
      sourceRoot,
      'locks',
      `shot-${String(shotNumber).padStart(2, '0')}-submit.lock.json`,
    )
    if (!fs.existsSync(lockPath)) fail('FUMIN_DERIVE_SOURCE_LOCK_INVALID', String(shotNumber))
    const lock = readJson(lockPath)
    if (lock.schema_version !== 'fumin-paid-submission-lock-v1'
      || Number(lock.shot_number) !== shotNumber
      || lock.scope !== 'reference_upload_and_paid_submission'
      || lock.external_actions_locked_before_network !== true
      || lock.retry_allowed !== false) {
      fail('FUMIN_DERIVE_SOURCE_LOCK_INVALID', String(shotNumber))
    }
  }

  for (let shotNumber = 7; shotNumber <= 9; shotNumber += 1) {
    const suffix = String(shotNumber).padStart(2, '0')
    if (fs.existsSync(path.join(sourceRoot, 'locks', `shot-${suffix}-submit.lock.json`))
      || fs.existsSync(path.join(sourceRoot, 'artifacts', `shot-${suffix}.mp4`))) {
      fail('FUMIN_DERIVE_LATER_SHOT_PRESENT', String(shotNumber))
    }
  }
}

function assertSourceArtifacts(sourceRoot, manifest, sha256File) {
  for (let shotNumber = 1; shotNumber <= 6; shotNumber += 1) {
    const suffix = String(shotNumber).padStart(2, '0')
    const videoPath = path.join(sourceRoot, 'artifacts', `shot-${suffix}.mp4`)
    if (!fs.existsSync(videoPath)) fail('FUMIN_DERIVE_SOURCE_FILE_MISSING', `shot-${suffix}.mp4`)
    const expected = shotNumber === 6
      ? R4_SHOT6_ARTIFACT_SHA256
      : String(manifest.tasks[shotNumber - 1]?.artifact?.sha256 || '').toLowerCase()
    if (!HEX_64.test(expected) || sha256File(videoPath) !== expected) {
      fail('FUMIN_DERIVE_SOURCE_ARTIFACT_HASH_MISMATCH', String(shotNumber))
    }
    if (shotNumber <= 5
      && (!fs.existsSync(path.join(sourceRoot, 'artifacts', `shot-${suffix}-contact-sheet.jpg`))
        || !fs.existsSync(path.join(sourceRoot, `shot-${suffix}-public-evidence.json`)))) {
      fail('FUMIN_DERIVE_SOURCE_EVIDENCE_MISSING', String(shotNumber))
    }
  }
}

function requiredRelativeFiles() {
  const files = []
  for (let shotNumber = 1; shotNumber <= 6; shotNumber += 1) {
    const suffix = String(shotNumber).padStart(2, '0')
    files.push(`artifacts/shot-${suffix}.mp4`, `locks/shot-${suffix}-submit.lock.json`)
    if (shotNumber <= 5) {
      files.push(
        `artifacts/shot-${suffix}-contact-sheet.jpg`,
        `shot-${suffix}-public-evidence.json`,
      )
    }
  }
  for (let shotNumber = 1; shotNumber <= 9; shotNumber += 1) {
    files.push(`motion/shot-${String(shotNumber).padStart(2, '0')}-motion.mp4`)
  }
  for (const identityId of IDENTITY_IDS) files.push(`runtime/identities/${identityId}.png`)
  return files
}

function copyRequiredFiles(sourceRoot, stagingRoot) {
  for (const relativePath of requiredRelativeFiles()) {
    const sourcePath = path.join(sourceRoot, relativePath)
    const targetPath = path.join(stagingRoot, relativePath)
    if (!fs.existsSync(sourcePath)) fail('FUMIN_DERIVE_SOURCE_FILE_MISSING', relativePath)
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
  }
}

function buildDerivedManifest(sourceManifest, sourceManifestSha256, nowIso) {
  const manifest = structuredClone(sourceManifest)
  manifest.created_at = nowIso
  manifest.updated_at = nowIso
  manifest.status = 'awaiting_human_review'
  manifest.references = { ...(manifest.references || {}), identities: {} }
  manifest.derived_from = {
    schema_version: 'fumin-full-episode-derived-state-v1',
    source_state_label: 'fumin-full-episode-ready-20260825-r4',
    source_manifest_sha256: sourceManifestSha256,
    source_task_count: 6,
    reason: 'local_transcript_apostrophe_false_negative',
    derived_at: nowIso,
  }
  manifest.tasks[5].status = 'awaiting_human_review'
  return manifest
}

function writeJsonExclusive(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

export function deriveFuminFullEpisodeState(options, adapters) {
  const sourceRoot = path.resolve(options.sourceStateRoot)
  const targetRoot = path.resolve(options.targetStateRoot)
  if (fs.existsSync(targetRoot)) fail('FUMIN_DERIVE_TARGET_EXISTS')

  const sourceManifestBytes = fs.readFileSync(path.join(sourceRoot, 'private-manifest.json'))
  const sourceManifestSha256 = adapters.sha256Buffer(sourceManifestBytes)
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'))
  assertR4DerivationSource({
    manifest: sourceManifest,
    actualManifestSha256: sourceManifestSha256,
    expectedManifestSha256: options.expectedSourceManifestSha256,
  })
  assertSourceLocks(sourceRoot)
  assertSourceArtifacts(sourceRoot, sourceManifest, adapters.sha256File)

  const now = adapters.now()
  const stagingRoot = `${targetRoot}.derive-${process.pid}-${now.getTime()}`
  if (fs.existsSync(stagingRoot)) fail('FUMIN_DERIVE_STAGING_EXISTS')

  try {
    fs.mkdirSync(stagingRoot, { recursive: false })
    copyRequiredFiles(sourceRoot, stagingRoot)
    const derivedManifest = buildDerivedManifest(
      sourceManifest,
      sourceManifestSha256,
      now.toISOString(),
    )
    adapters.revalidateShot6({ sourceRoot, stagingRoot, derivedManifest })
    writeJsonExclusive(path.join(stagingRoot, 'private-manifest.json'), derivedManifest)
    writeJsonExclusive(path.join(stagingRoot, 'private-runtime-secrets.json'), {
      schema_version: 'fumin-private-runtime-secrets-v1',
    })
    writeJsonExclusive(
      path.join(stagingRoot, 'public-derived-evidence.json'),
      adapters.publicEvidence(derivedManifest),
    )
    fs.renameSync(stagingRoot, targetRoot)
    return { status: 'awaiting_human_review', state_root: targetRoot }
  } catch (error) {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
}
