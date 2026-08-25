const HEX_64 = /^[a-f0-9]{64}$/i
const EXPECTED_CASE_ID = 'ac087bcd-latam-en-us'
const EXPECTED_SHOT6_ERROR = 'FUMIN_FULL_EPISODE_EXACT_DIALOGUE_FAILED'

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
