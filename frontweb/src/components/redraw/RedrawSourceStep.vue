<template>
  <section class="redraw-source-step">
    <div class="source-card">
      <div class="section-heading">
        <div>
          <p class="eyebrow">01 · 源片输入</p>
          <h2>上传源片并锁定转绘基础设置</h2>
        </div>
        <el-tag v-if="workState?.id">作品 {{ workState.id }}</el-tag>
      </div>

      <div class="source-grid">
        <label class="field">
          <span>源片文件</span>
          <input
            ref="fileInput"
            type="file"
            accept=".mp4,.mov,.zip,video/mp4,video/quicktime,application/zip"
            @change="onFileChange"
          />
          <small>支持 MP4、MOV 或 ZIP 批量源片</small>
        </label>
        <label class="field">
          <span>语言 / 地区</span>
          <div class="inline-fields">
            <el-select v-model="locale" placeholder="语言">
              <el-option
                v-for="item in localeOptions"
                :key="`${item.locale}-${item.market}`"
                :label="item.locale"
                :value="item.locale"
              />
            </el-select>
            <el-select v-model="market" placeholder="地区">
              <el-option
                v-for="item in localeOptions"
                :key="`${item.locale}-${item.market}-market`"
                :label="item.market || '默认地区'"
                :value="item.market || ''"
              />
            </el-select>
          </div>
        </label>
        <label class="field">
          <span>输出比例</span>
          <el-segmented v-model="aspectRatio" :options="aspectRatioOptions" />
        </label>
      </div>

      <StylePresetPicker
        v-model:selected-preset="selectedPreset"
        v-model:free-style="freeStyle"
        :presets="stylePresets"
      />

      <div class="billing-row">
        <strong v-if="hasValidQuote" class="canvas-credit-callout-v1">本次预计扣除 {{ estimateCredits }} 积分</strong>
        <strong v-else class="canvas-credit-callout-v1">积分待管理员配置</strong>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!canStartAnalysis"
          @click="startAnalysis"
        >
          开始分析
        </el-button>
      </div>
    </div>

    <section v-if="taskState.task_id || workState?.task_id" class="task-card">
      <div>
        <strong>分析任务 {{ taskState.task_id || workState?.task_id }}</strong>
        <span>{{ taskState.status || workState?.status || 'processing' }}</span>
      </div>
      <el-progress :percentage="taskState.progress" :stroke-width="6" color="#ff7139" />
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { redrawAPI } from '@/api/redraw'
import StylePresetPicker from '@/components/redraw/StylePresetPicker.vue'

const props = defineProps({
  projectId: {
    type: [String, Number],
    required: true,
  },
  initialWork: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['work-updated'])

const fileInput = ref(null)
const selectedFile = ref(null)
const locale = ref('zh-CN')
const market = ref('CN')
const aspectRatio = ref('16:9')
const stylePresets = ref([])
const localeOptions = ref([])
const selectedPreset = ref(null)
const freeStyle = ref({})
const workState = ref(props.initialWork)
const submitting = ref(false)
const taskState = ref({ task_id: '', status: '', progress: 0 })

const aspectRatioOptions = ['16:9', '9:16', '1:1', '4:3']
const estimateCredits = computed(() => {
  const source = selectedPreset.value || {}
  const credits = Number(source.analysis_credits ?? source.credits ?? source.price?.credits)
  return Number.isSafeInteger(credits) && credits > 0 ? credits : null
})
const hasValidQuote = computed(() => estimateCredits.value != null)
const canStartAnalysis = computed(() => Boolean(
  hasValidQuote.value
    && (workState.value?.id || selectedFile.value)
    && (selectedPreset.value || String(freeStyle.value?.positivePrompt || '').trim()),
))

function onFileChange(event) {
  selectedFile.value = event.target.files?.[0] || null
}

async function loadCapabilities() {
  const [presets, locales] = await Promise.all([
    redrawAPI.listStylePresets(),
    redrawAPI.listLocales(),
  ])
  stylePresets.value = Array.isArray(presets) ? presets : []
  localeOptions.value = Array.isArray(locales) && locales.length
    ? locales
    : [{ locale: 'zh-CN', market: 'CN' }]
}

async function refreshWork() {
  if (!workState.value?.id) return
  const fresh = await redrawAPI.getWork(workState.value.id)
  workState.value = fresh
  taskState.value = {
    task_id: fresh.task_id || taskState.value.task_id || '',
    status: fresh.status || taskState.value.status || '',
    progress: fresh.status === 'asset_review' ? 100 : taskState.value.progress,
  }
  emit('work-updated', fresh)
}

async function ensureWork() {
  if (workState.value?.id) return workState.value
  if (!selectedFile.value) throw new Error('请先上传源片文件')
  const result = await redrawAPI.createWorks(props.projectId, selectedFile.value)
  const created = result?.items?.[0]
  if (!created?.id) throw new Error('后端未返回转绘作品')
  workState.value = created
  emit('work-updated', created)
  return created
}

async function startAnalysis() {
  if (!canStartAnalysis.value) return
  submitting.value = true
  try {
    const work = await ensureWork()
    const result = await redrawAPI.analyzeWork(work.id)
    taskState.value = {
      task_id: result.task_id,
      status: result.provider_task_id ? 'processing' : 'submitted',
      progress: 10,
    }
    await refreshWork()
    ElMessage.success('源片分析已提交')
  } catch (error) {
    ElMessage.error(error.message || '提交转绘分析失败')
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await loadCapabilities()
  await refreshWork()
})

watch(() => props.initialWork, (next) => {
  workState.value = next
})
</script>

<style scoped>
.redraw-source-step {
  display: grid;
  gap: 14px;
}

.source-card,
.task-card {
  display: grid;
  gap: 18px;
  padding: 20px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  background: #151515;
}

.section-heading,
.billing-row,
.task-card > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #ff9a6d;
  font-size: 12px;
  font-weight: 700;
}

h2 {
  margin: 0;
  font-size: 20px;
}

.source-grid {
  display: grid;
  grid-template-columns: minmax(240px, 1.2fr) minmax(240px, 1fr) 220px;
  gap: 14px;
}

.field {
  display: grid;
  align-content: start;
  gap: 8px;
  color: #d8d8d8;
  font-size: 13px;
}

.field input[type="file"] {
  padding: 10px;
  border: 1px solid #333;
  border-radius: 6px;
  color: #d8d8d8;
  background: #101010;
}

.field small {
  color: #8d8d8d;
}

.inline-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.canvas-credit-callout-v1 {
  color: #fff;
  font-size: 16px;
  font-weight: 800;
}

.task-card span {
  color: #a5a5a5;
}

@media (max-width: 920px) {
  .source-grid {
    grid-template-columns: 1fr;
  }

  .section-heading,
  .billing-row {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
