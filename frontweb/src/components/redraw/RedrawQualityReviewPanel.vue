<template>
  <section class="delivery-panel">
    <header>
      <div>
        <p class="eyebrow">候选 QA</p>
        <h3>质量审核</h3>
      </div>
      <el-tag>{{ executionMode === 'safe' ? 'A 模式' : 'B 模式' }}</el-tag>
    </header>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <ul v-if="shots.length" class="review-list">
      <li v-for="shot in shots" :key="shot.id">
        <div class="review-heading">
          <strong>镜头 {{ shot.shot_index }}</strong>
          <span>{{ currentFor(shot.id)?.decision || '暂无候选审核' }}</span>
        </div>
        <template v-if="currentFor(shot.id)">
          <p>候选 QA：{{ metricSummary(currentFor(shot.id)) }}</p>
          <p v-if="isAutomaticApproved(shot.id)" class="passed">B 自动批准证据：质量门禁全部通过</p>
          <p v-else-if="currentFor(shot.id)?.decision_source === 'automatic'" class="warning">
            B→A 原因：{{ reasonSummary(currentFor(shot.id)) }}
          </p>
          <div v-if="canHumanReview(shot.id)" class="actions">
            <el-button
              type="success"
              size="small"
              :loading="reviewingShotId === shot.id"
              @click="submit(shot.id, 'approved')"
            >人工批准</el-button>
            <el-button
              type="danger"
              size="small"
              :loading="reviewingShotId === shot.id"
              @click="submit(shot.id, 'rejected')"
            >人工驳回</el-button>
          </div>
        </template>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import { redrawAPI } from '@/api/redraw'

const props = defineProps({
  shots: { type: Array, default: () => [] },
  executionMode: { type: String, default: 'safe' },
})
const emit = defineEmits(['reviewed'])
const records = ref({})
const reviewingShotId = ref(null)
const loadError = ref('')

function currentFor(shotId) {
  return records.value[String(shotId)]?.current || null
}

function reasonSummary(review) {
  return Array.isArray(review?.reason_codes) && review.reason_codes.length
    ? review.reason_codes.join('、')
    : '需要人工核对'
}

function metricSummary(review) {
  const entries = review?.metrics && typeof review.metrics === 'object' ? Object.entries(review.metrics) : []
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(' · ') : '服务端证据已记录'
}

function isAutomaticApproved(shotId) {
  const current = currentFor(shotId)
  return current?.decision_source === 'automatic' && current?.decision === 'approved'
}

function canHumanReview(shotId) {
  const current = currentFor(shotId)
  return Boolean(current?.candidate_sha256 && current?.decision === 'needs_review')
}

async function load() {
  try {
    const entries = await Promise.all(props.shots.map(async (shot) => [
      String(shot.id),
      await redrawAPI.listCandidateReviews(shot.id),
    ]))
    records.value = Object.fromEntries(entries)
    loadError.value = ''
  } catch (error) {
    loadError.value = error?.response?.data?.error?.message || error?.message || '读取候选审核失败'
  }
}

async function submit(shotId, decision) {
  const state = records.value[String(shotId)]
  const current = state?.current
  if (!current?.candidate_sha256 || !state?.shot_updated_at) return
  reviewingShotId.value = shotId
  try {
    await redrawAPI.reviewCandidate(shotId, {
      decision,
      reason_code: decision === 'approved' ? 'manual_visual_passed' : 'human_rejected',
      candidate_sha256: current.candidate_sha256,
      expected_updated_at: state.shot_updated_at,
    })
    await load()
    emit('reviewed', shotId)
  } catch (error) {
    const message = error?.response?.data?.error?.message || error?.message || '提交候选审核失败'
    await load()
    loadError.value = message
  } finally {
    reviewingShotId.value = null
  }
}

watch(() => props.shots.map((shot) => `${shot.id}:${shot.updated_at}`).join('|'), load)
onMounted(load)
</script>

<style scoped>
.delivery-panel { display: grid; gap: 12px; padding: 14px; border: 1px solid #2d2d2d; border-radius: 10px; background: #121212; }
header, .review-heading, .actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3, p { margin: 0; }
.review-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.review-list li { display: grid; gap: 8px; padding: 10px; border: 1px solid #292929; border-radius: 8px; }
.review-list p, .review-heading span { color: #aaa; font-size: 13px; overflow-wrap: anywhere; }
.review-list .passed { color: #67c23a; }
.review-list .warning { color: #ffc66d; }
.actions { justify-content: flex-start; }
</style>
