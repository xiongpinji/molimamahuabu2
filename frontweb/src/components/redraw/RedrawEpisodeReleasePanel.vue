<template>
  <section class="release-panel">
    <header>
      <div>
        <p class="eyebrow">合并与导出</p>
        <h3>整集 readiness</h3>
      </div>
      <el-tag :type="readiness.ready ? 'success' : 'warning'">
        {{ readiness.ready ? '可发布' : '存在缺口' }}
      </el-tag>
    </header>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <ul v-if="readiness.blockers.length" class="blockers">
      <li v-for="(blocker, index) in readiness.blockers" :key="`${blocker.shot_id}-${index}`">
        <strong>镜头 {{ blocker.shot_id ?? '整集' }}</strong>
        <span>原因：{{ blocker.reason_code }}</span>
      </li>
    </ul>
    <p v-else>全部 {{ readiness.shot_count }} 个镜头已满足当前 release 证据。</p>
    <el-button :disabled="!readiness.ready" :loading="creating" type="primary" @click="create">
      创建整集 release
    </el-button>
    <div v-if="Object.keys(downloads).length" class="downloads">
      <el-button :disabled="!safeUrl('mp4')" @click="download('mp4')">MP4 下载</el-button>
      <el-button :disabled="!safeUrl('srt')" @click="download('srt')">SRT 下载</el-button>
      <el-button :disabled="!safeUrl('vtt')" @click="download('vtt')">VTT 下载</el-button>
      <el-button :disabled="!safeUrl('report')" @click="download('report')">报告下载</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'
import { controlledReleaseDownloadUrl, normalizeReleaseReadiness } from '@/utils/redrawTimelineState'

const props = defineProps({
  versionId: { type: [String, Number], default: null },
  refreshToken: { type: Number, default: 0 },
})
const readiness = ref(normalizeReleaseReadiness())
const exports = ref([])
const createdRelease = ref(null)
const creating = ref(false)
const loadError = ref('')
const idempotencyKey = ref('')

let pollTimer = null

const downloads = computed(() => {
  if (createdRelease.value?.status === 'completed') return createdRelease.value.downloads || {}
  return exports.value.find((item) => item?.status === 'completed')?.downloads || {}
})

function newIdempotencyKey() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `episode-release-${random}`
}

function safeUrl(kind) {
  return controlledReleaseDownloadUrl(downloads.value?.[kind])
}

async function load() {
  if (!props.versionId) return
  try {
    const [nextReadiness, nextExports] = await Promise.all([
      redrawAPI.getReleaseReadiness(props.versionId),
      redrawAPI.listExports(props.versionId),
    ])
    readiness.value = normalizeReleaseReadiness(nextReadiness)
    exports.value = Array.isArray(nextExports) ? nextExports : []
    if (createdRelease.value?.export_id) {
      const current = exports.value.find((item) => Number(item.id) === Number(createdRelease.value.export_id))
      if (current) createdRelease.value = { ...createdRelease.value, ...current }
      if (current && !['pending', 'processing'].includes(current.status)) stopPolling()
    }
    loadError.value = ''
  } catch (error) {
    loadError.value = error?.response?.data?.error?.message || error?.message || '读取整集 readiness 失败'
  }
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

function startPolling() {
  if (pollTimer || !createdRelease.value || !['pending', 'processing'].includes(createdRelease.value.status)) return
  pollTimer = setInterval(load, 2500)
}

async function create() {
  if (!props.versionId || !readiness.value.ready || !readiness.value.readiness_hash) return
  if (!idempotencyKey.value) idempotencyKey.value = newIdempotencyKey()
  creating.value = true
  try {
    createdRelease.value = await redrawAPI.createRelease(props.versionId, {
      idempotency_key: idempotencyKey.value,
      readiness_hash: readiness.value.readiness_hash,
    })
    await load()
    startPolling()
  } catch (error) {
    loadError.value = error?.response?.data?.error?.message || error?.message || '创建整集 release 失败'
    await load()
  } finally {
    creating.value = false
  }
}

async function download(kind) {
  const relativeUrl = safeUrl(kind)
  if (!relativeUrl) return
  const report = kind === 'report'
  const result = await redrawAPI.downloadReleaseArtifact(relativeUrl, report)
  const blob = report
    ? new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    : result
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = report ? 'redraw-release-report.json' : `redraw-release.${kind}`
  anchor.click()
  URL.revokeObjectURL(objectUrl)
}

watch(() => [props.versionId, props.refreshToken], ([versionId], [previousVersionId] = []) => {
  if (String(versionId || '') !== String(previousVersionId || '')) {
    stopPolling()
    idempotencyKey.value = ''
    createdRelease.value = null
  }
  load()
})
onMounted(load)
onBeforeUnmount(stopPolling)
</script>

<style scoped>
.release-panel { display: grid; justify-items: start; gap: 12px; padding: 14px; border: 1px solid #2d2d2d; border-radius: 10px; background: #121212; }
header { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3, p { margin: 0; }
.blockers { display: grid; gap: 7px; width: 100%; margin: 0; padding: 0; list-style: none; }
.blockers li { display: flex; justify-content: space-between; gap: 10px; padding: 9px; border-radius: 8px; background: #1c1c1c; }
.blockers span { color: #ffc66d; overflow-wrap: anywhere; }
.downloads { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
