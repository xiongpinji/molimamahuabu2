<template>
  <div v-if="visible" class="director-stage" role="dialog" aria-modal="true" aria-label="3D 导演台">
    <header class="director-stage__header">
      <div>
        <strong>3D 导演台</strong>
        <span class="director-stage__hint">镜头序列 · 角色轨道 · 动作片段</span>
      </div>
      <div class="director-stage__header-actions">
        <span class="director-stage__save-state" :class="{ dirty }">{{ dirty ? '有修改' : '已保存' }}</span>
        <button type="button" :class="{ active: viewMode === 'director' }" @click="setView('director')">导演视角</button>
        <button type="button" :class="{ active: viewMode === 'camera' }" @click="setView('camera')">机位视角</button>
        <button type="button" class="close-button" aria-label="关闭导演台" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="director-stage__body">
      <aside class="director-stage__sidebar">
        <section class="stage-section">
          <div class="stage-section__title">场景</div>
          <button
            v-for="(scene, index) in scenes"
            :key="`scene-${scene.id || index}`"
            type="button"
            class="stage-item"
            @click="focusItem(`scene:${scene.id || index}`)"
          >
            <span class="stage-dot stage-dot--scene" />
            {{ scene.location || scene.name || `场景 ${index + 1}` }}
          </button>
          <div v-if="!scenes.length" class="stage-empty">暂无场景</div>
        </section>

        <section class="stage-section">
          <div class="stage-section__title">角色</div>
          <button
            v-for="character in characterEntries"
            :key="`character-${character.id}`"
            type="button"
            class="stage-item"
            :class="{ selected: selectedCharacterId === character.id }"
            @click="selectCharacter(character.id)"
          >
            <span class="stage-dot stage-dot--character" />
            {{ character.name }}
          </button>
          <div v-if="!characterEntries.length" class="stage-empty">暂无角色</div>
        </section>

        <section class="stage-section">
          <div class="stage-section__title">镜头序列</div>
          <div class="sequence-toolbar">
            <span>{{ shots.length }} 镜 · {{ formatSeconds(duration) }}</span>
            <button type="button" class="small-button" @click="addShot">+ 镜头</button>
          </div>
          <button
            v-for="(shot, index) in shots"
            :key="shot.id"
            type="button"
            class="shot-list-item"
            :class="{ selected: selectedShotId === shot.id }"
            @click="selectShot(shot)"
          >
            <span class="shot-index">{{ index + 1 }}</span>
            <span class="shot-list-copy">
              <strong>{{ shot.name }}</strong>
              <small>{{ formatSeconds(shot.duration) }} · {{ cameraLabel(shot.camera) }}</small>
            </span>
            <span class="transition-badge">{{ transitionLabel(shot.transition) }}</span>
          </button>
        </section>

        <section v-if="selectedShot" class="stage-section shot-editor">
          <div class="stage-section__title">镜头实体</div>
          <label>名称<input :value="selectedShot.name" @input="updateSelectedShot('name', $event.target.value)" /></label>
          <label>时长（秒）<input type="number" min="0.25" step="0.25" :value="selectedShot.duration" @change="updateSelectedShot('duration', $event.target.value)" /></label>
          <label>机位
            <select :value="selectedShot.camera" @change="updateSelectedShot('camera', $event.target.value)">
              <option v-for="camera in SHOT_CAMERA_TYPES" :key="camera.value" :value="camera.value">{{ camera.label }}</option>
            </select>
          </label>
          <label>转场
            <select :value="selectedShot.transition" @change="updateSelectedShot('transition', $event.target.value)">
              <option v-for="transition in TRANSITION_TYPES" :key="transition.value" :value="transition.value">{{ transition.label }}</option>
            </select>
          </label>
          <label>转场时长（秒）<input type="number" min="0" step="0.1" :value="selectedShot.transitionDuration" @change="updateSelectedShot('transitionDuration', $event.target.value)" /></label>
          <label v-if="scenes.length">场景
            <select :value="selectedShot.sceneId" @change="updateSelectedShot('sceneId', $event.target.value)">
              <option value="">不绑定场景</option>
              <option v-for="scene in scenes" :key="scene.id" :value="String(scene.id)">{{ scene.location || scene.name || `场景 ${scene.id}` }}</option>
            </select>
          </label>
          <button v-if="shots.length > 1" type="button" class="danger-button" @click="removeSelectedShot">删除镜头</button>
        </section>

        <section class="stage-section action-editor">
          <div class="stage-section__title">角色动作编排</div>
          <div v-if="characterEntries.length" class="action-add-row">
            <select v-model="selectedCharacterId" aria-label="选择角色">
              <option v-for="character in characterEntries" :key="character.id" :value="character.id">{{ character.name }}</option>
            </select>
            <select v-model="actionToAdd" aria-label="选择动作">
              <option v-for="action in ACTION_LIBRARY" :key="action" :value="action">{{ action }}</option>
            </select>
            <button type="button" class="small-button" @click="addActionClip">添加</button>
          </div>
          <div v-else class="stage-empty">先创建角色，再编排动作</div>
        </section>

        <section v-if="selectedCharacter" class="stage-section resource-editor">
          <div class="stage-section__title">真实模型与动作资源</div>
          <div class="resource-character">当前角色：{{ selectedCharacter.name }}</div>
          <label>角色模型 URL
            <input :value="selectedCharacterAsset.modelUrl" placeholder="https://…/character.glb" @change="updateCharacterAsset('modelUrl', $event.target.value)" />
          </label>
          <div class="resource-upload-row">
            <input type="file" accept=".glb,.vrm,model/gltf-binary" aria-label="上传角色模型" @change="onModelFileChange" />
            <button type="button" class="small-button" :disabled="modelLoading" @click="loadSelectedCharacterModel">加载模型</button>
          </div>
          <label>动作资源 URL（{{ actionToAdd }}）
            <input :value="selectedActionAsset.url" placeholder="可选：动作 GLB URL" @change="updateActionAssetUrl(actionToAdd, $event.target.value)" />
          </label>
          <div class="resource-upload-row">
            <input type="file" accept=".glb,.vrm,model/gltf-binary" aria-label="上传动作资源" @change="onActionFileChange" />
            <span class="resource-tip">GLB/VRM</span>
          </div>
          <div class="resource-library">
            <label>项目三维资产
              <select v-model="selectedLibraryAssetId" :disabled="libraryLoading || !libraryAssets.length">
                <option value="">{{ libraryLoading ? '正在读取资产…' : (libraryAssets.length ? '选择已上传资源' : '暂无已上传资源') }}</option>
                <option v-for="asset in libraryAssets" :key="asset.id" :value="String(asset.id)">{{ asset.name }}</option>
              </select>
            </label>
            <div class="resource-upload-row">
              <button type="button" class="small-button" :disabled="!selectedLibraryAsset" @click="applyLibraryAsset('model')">应用为模型</button>
              <button type="button" class="small-button" :disabled="!selectedLibraryAsset" @click="applyLibraryAsset('action')">应用为动作</button>
            </div>
          </div>
          <label>模型缩放
            <input type="number" min="0.01" max="100" step="0.01" :value="selectedCharacterAsset.scale" @change="updateCharacterAsset('scale', $event.target.value)" />
          </label>
          <div class="resource-status resource-status--row" :data-status="selectedModelResourceState.status">
            <span>模型：{{ directorResourceStatusLabel(selectedModelResourceState) }}<template v-if="selectedModelResourceState.message"> · {{ selectedModelResourceState.message }}</template></span>
            <button v-if="selectedModelResourceState.status === 'error'" type="button" class="small-button" :disabled="modelLoading" @click="loadSelectedCharacterModel">重试</button>
          </div>
          <div class="resource-status resource-status--row" :data-status="selectedActionResourceState.status">
            <span>动作：{{ directorResourceStatusLabel(selectedActionResourceState) }}<template v-if="selectedActionResourceState.message"> · {{ selectedActionResourceState.message }}</template></span>
            <button v-if="selectedActionResourceState.status === 'error'" type="button" class="small-button" @click="retrySelectedActionResource">重试</button>
          </div>
          <div v-if="assetStatus" class="resource-status">{{ assetStatus }}</div>
        </section>
      </aside>

      <main class="director-stage__viewport">
        <canvas ref="canvasRef" class="director-stage__canvas" aria-label="3D 导演台预览" />
        <div class="director-stage__legend">
          <span><i class="stage-dot stage-dot--scene" />场景</span>
          <span><i class="stage-dot stage-dot--character" />角色</span>
          <span><i class="stage-dot stage-dot--prop" />道具</span>
          <span v-if="activeShot">当前：{{ activeShot.name }}</span>
        </div>
        <div v-if="initializing" class="director-stage__loading">正在初始化导演台…</div>
        <div v-else-if="errorMessage" class="director-stage__error">{{ errorMessage }}</div>

        <section class="timeline-panel" aria-label="导演时间线">
          <div class="timeline-toolbar">
            <div class="timeline-controls">
              <button type="button" :aria-label="playing ? '暂停' : '播放'" @click="togglePlayback">{{ playing ? 'Ⅱ' : '▶' }}</button>
              <button type="button" aria-label="停止" @click="stopPlayback">■</button>
              <span class="timeline-time">{{ formatSeconds(currentTime) }} / {{ formatSeconds(duration) }}</span>
              <span class="timeline-fps">{{ timeline.sequence.fps }} fps</span>
            </div>
            <input class="timeline-scrubber" type="range" min="0" :max="duration || 0.25" step="0.01" :value="currentTime" aria-label="时间线位置" @input="setCurrentTime(Number($event.target.value))" />
          </div>

          <div class="timeline-ruler"><span>0s</span><span>{{ formatSeconds(duration / 2) }}</span><span>{{ formatSeconds(duration) }}</span></div>
          <div class="timeline-track shot-track">
            <div class="track-label">镜头序列</div>
            <div class="track-lane">
              <button
                v-for="shot in shots"
                :key="`timeline-shot-${shot.id}`"
                type="button"
                class="timeline-block timeline-shot"
                :class="{ selected: selectedShotId === shot.id }"
                :style="blockStyle(shot)"
                @click="selectShot(shot)"
              >
                <strong>{{ shot.name }}</strong>
                <small>{{ transitionLabel(shot.transition) }}</small>
              </button>
            </div>
          </div>
          <div v-for="track in timeline.tracks" :key="track.id" class="timeline-track">
            <div class="track-label">{{ characterName(track.characterId) }}</div>
            <div class="track-lane">
              <button
                v-for="clip in track.clips"
                :key="clip.id"
                type="button"
                class="timeline-block timeline-action"
                :style="blockStyle(clip)"
                @click="setCurrentTime(clip.start)"
              >
                <strong>{{ clip.action }}</strong>
                <small>{{ formatSeconds(clip.duration) }}</small>
              </button>
            </div>
          </div>
          <div v-if="!timeline.tracks.length" class="timeline-empty">暂无角色轨道</div>
        </section>
      </main>
    </div>

    <footer class="director-stage__footer">
      <span>镜头实体决定机位与转场；角色轨道决定动作片段。拖动时间线可预览当前编排。</span>
      <div class="director-stage__footer-actions">
        <button type="button" :disabled="exporting || initializing" @click="exportTimelineVideo">
          {{ exporting ? `导出中 ${exportProgress}%` : '导出 WebM 视频' }}
        </button>
        <button type="button" :disabled="exporting || initializing || !drama?.id" @click="exportTimelineMp4">
          {{ exporting ? `服务端处理中 ${exportProgress}%` : '服务端导出 MP4' }}
        </button>
        <button type="button" @click="resetCamera">重置视角</button>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  AnimationMixer,
  DirectionalLight,
  EditorViewWidgetPlugin,
  GeometryGeneratorPlugin,
  GridHelper,
  HemisphereLight,
  Group,
  Object3DGeneratorPlugin,
  Object3DWidgetsPlugin,
  PickingPlugin,
  ThreeViewer,
  TransformControlsPlugin,
} from 'threepipe'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { assetsAPI } from '@/api/assets'
import { directorExportAPI } from '@/api/directorExport'
import { taskAPI } from '@/api/task'
import { uploadAPI } from '@/api/upload'
import {
  ACTION_LIBRARY,
  SHOT_CAMERA_TYPES,
  TRANSITION_TYPES,
  appendActionClip,
  appendShot,
  createDirectorTimeline,
  findActiveActionClips,
  findActiveShot,
  normalizeDirectorTimeline,
} from '@/utils/directorTimeline'
import {
  createDirectorResourceState,
  directorResourceStatusLabel,
  isDirectorAnimationCompatible,
  resolveDirectorAssetUrl,
  updateDirectorResourceState,
} from '@/utils/director-assets'
import {
  directorExportFilename,
  parseDirectorExportResult,
  pickDirectorRecordingMimeType,
} from '@/utils/director-export-support'

const props = defineProps({
  visible: { type: Boolean, default: false },
  drama: { type: Object, default: null },
  initialState: { type: Object, default: null },
})

const emit = defineEmits(['close', 'state-change'])
const canvasRef = ref(null)
// Threepipe owns a mutable object graph; keep it out of Vue's deep proxying.
const viewer = shallowRef(null)
const initializing = ref(false)
const errorMessage = ref('')
const viewMode = ref('director')
const playing = ref(false)
const dirty = ref(false)
const selectedShotId = ref('')
const selectedCharacterId = ref('')
const actionToAdd = ref('Idle')
const timeline = ref(createDirectorTimeline([]))
const exporting = ref(false)
const exportProgress = ref(0)
const assetStatus = ref('')
const modelLoading = ref(false)
const libraryAssets = ref([])
const libraryLoading = ref(false)
const selectedLibraryAssetId = ref('')
const resourceStates = ref({})

const scenes = computed(() => props.drama?.scenes || [])
const characters = computed(() => props.drama?.characters || [])
const propsList = computed(() => props.drama?.props || [])
const characterEntries = computed(() => characters.value.map((character, index) => ({
  id: String(character?.id ?? character?.name ?? `character-${index + 1}`),
  name: character?.name || `角色 ${index + 1}`,
})))
const shots = computed(() => timeline.value.shots)
const duration = computed(() => timeline.value.sequence.duration || 0.25)
const currentTime = computed(() => timeline.value.sequence.currentTime)
const selectedShot = computed(() => shots.value.find((shot) => shot.id === selectedShotId.value) || shots.value[0] || null)
const selectedCharacter = computed(() => characterEntries.value.find((character) => character.id === selectedCharacterId.value) || characterEntries.value[0] || null)
const selectedCharacterAsset = computed(() => timeline.value.characterAssets?.[selectedCharacter.value?.id] || { modelUrl: '', scale: 1, actions: {} })
const selectedActionAsset = computed(() => selectedCharacterAsset.value.actions?.[actionToAdd.value] || { url: '' })
const selectedModelResourceState = computed(() => resourceStates.value[resourceStateKey('model', selectedCharacter.value?.id)] || createDirectorResourceState('model', selectedCharacterAsset.value.modelUrl))
const selectedActionResourceState = computed(() => resourceStates.value[resourceStateKey('action', selectedCharacter.value?.id, actionToAdd.value)] || createDirectorResourceState('action', selectedActionAsset.value.url))
const selectedLibraryAsset = computed(() => libraryAssets.value.find((asset) => String(asset.id) === String(selectedLibraryAssetId.value)) || null)
const activeShot = computed(() => findActiveShot(timeline.value, currentTime.value))
const stageObjects = new Map()
const characterObjects = new Map()
const characterModels = new Map()
const characterPlaceholders = new Map()
const actionResourceCache = new Map()
const actionResourceRequests = new Map()
const actionResourceGenerations = new Map()
let stageRoot = null
let disposed = false
let animationFrame = 0
let lastFrameTime = 0
let stageBuildToken = 0

function formatSeconds(value) {
  return `${Math.max(0, Number(value) || 0).toFixed(2)}s`
}

function cameraLabel(value) {
  return SHOT_CAMERA_TYPES.find((item) => item.value === value)?.label || '导演视角'
}

function transitionLabel(value) {
  return TRANSITION_TYPES.find((item) => item.value === value)?.label || '硬切'
}

function characterName(characterId) {
  return characterEntries.value.find((character) => character.id === String(characterId))?.name || '未命名角色'
}

function blockStyle(item) {
  const total = duration.value || 0.25
  return {
    left: `${Math.max(0, Number(item.start) || 0) / total * 100}%`,
    width: `${Math.max(2, (Number(item.duration) || 0.25) / total * 100)}%`,
  }
}

function cloneTimeline(value) {
  return JSON.parse(JSON.stringify(value))
}

function resourceStateKey(kind, characterId, action = '') {
  return `${kind}:${String(characterId || '')}:${String(action || '')}`
}

function setResourceState(kind, characterId, asset, patch = {}, action = '') {
  const key = resourceStateKey(kind, characterId, action)
  const current = resourceStates.value[key] || createDirectorResourceState(kind, asset)
  resourceStates.value = {
    ...resourceStates.value,
    [key]: updateDirectorResourceState(current, {
      ...patch,
      url: patch.url === undefined ? asset : patch.url,
    }),
  }
}

function updateCharacterAsset(field, value) {
  if (!selectedCharacter.value) return
  const characterId = selectedCharacter.value.id
  const assets = cloneTimeline(timeline.value.characterAssets || {})
  const current = assets[characterId] || { modelUrl: '', scale: 1, actions: {} }
  assets[characterId] = {
    ...current,
    [field]: field === 'scale'
      ? Math.max(0.01, Math.min(100, Number(value) || 1))
      : field === 'modelAssetId'
        ? (Number(value) > 0 ? Number(value) : null)
        : String(value || '').trim(),
    actions: { ...(current.actions || {}) },
  }
  mutateTimeline({ ...timeline.value, characterAssets: assets })
  if (field === 'modelUrl') {
    setResourceState('model', characterId, assets[characterId].modelUrl, { status: 'idle', message: '' })
    buildStage()
  }
}

function updateActionAssetUrl(action, value, assetId = null) {
  if (!selectedCharacter.value) return
  const characterId = selectedCharacter.value.id
  const assets = cloneTimeline(timeline.value.characterAssets || {})
  const current = assets[characterId] || { modelUrl: '', scale: 1, actions: {} }
  const previousActionUrl = resolveDirectorAssetUrl(current.actions?.[action]?.url)
  const modelState = characterModels.get(String(characterId))
  const requestKey = resourceStateKey('action', characterId, action)
  actionResourceGenerations.set(requestKey, (actionResourceGenerations.get(requestKey) || 0) + 1)
  actionResourceRequests.delete(requestKey)
  if (modelState) {
    delete modelState.actionClips[action]
    modelState.activeClipKey = ''
  }
  actionResourceCache.delete(previousActionUrl)
  const actionAsset = { ...(current.actions?.[action] || {}), url: String(value || '').trim() }
  if (assetId !== null && assetId !== undefined) actionAsset.assetId = Number(assetId) > 0 ? Number(assetId) : null
  assets[characterId] = {
    ...current,
    actions: {
      ...(current.actions || {}),
      [action]: actionAsset,
    },
  }
  mutateTimeline({ ...timeline.value, characterAssets: assets })
  const url = resolveDirectorAssetUrl(value)
  actionResourceCache.delete(url)
  setResourceState('action', characterId, url, { status: 'idle', message: '' }, action)
  applyTimelineFrame()
}

async function uploadModelAsset(file, kind) {
  if (!file || !selectedCharacter.value) return
  assetStatus.value = '正在上传三维资源…'
  try {
    const result = await uploadAPI.uploadModel(file, { dramaId: props.drama?.id })
    const url = resolveDirectorAssetUrl(result)
    if (!url) throw new Error('上传成功但没有返回资源地址')
    const assetId = result?.asset_id || result?.asset?.id || null
    if (kind === 'model') {
      updateCharacterAsset('modelUrl', url)
      updateCharacterAsset('modelAssetId', assetId)
    } else {
      updateActionAssetUrl(actionToAdd.value, url, assetId)
    }
    assetStatus.value = `${kind === 'model' ? '角色模型' : '动作资源'}已上传`
    await loadProjectAssets()
  } catch (error) {
    assetStatus.value = error?.message || '三维资源上传失败'
  }
}

async function loadProjectAssets() {
  const dramaId = props.drama?.id
  if (!dramaId) {
    libraryAssets.value = []
    return
  }
  libraryLoading.value = true
  try {
    const result = await assetsAPI.list({ drama_id: dramaId, type: 'model', page_size: 100 })
    libraryAssets.value = Array.isArray(result) ? result : (result?.items || [])
  } catch (error) {
    libraryAssets.value = []
    assetStatus.value = error?.message || '项目资产读取失败'
  } finally {
    libraryLoading.value = false
  }
}

function applyLibraryAsset(kind) {
  const asset = selectedLibraryAsset.value
  if (!resolveDirectorAssetUrl(asset)) return
  const url = resolveDirectorAssetUrl(asset)
  if (kind === 'model') {
    updateCharacterAsset('modelUrl', url)
    updateCharacterAsset('modelAssetId', asset.id)
  } else {
    updateActionAssetUrl(actionToAdd.value, url, asset.id)
  }
  assetStatus.value = `${asset.name || '项目资产'}已应用为${kind === 'model' ? '角色模型' : '动作资源'}`
}

function onModelFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  void uploadModelAsset(file, 'model')
}

function onActionFileChange(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  void uploadModelAsset(file, 'action')
}

function loadSelectedCharacterModel() {
  if (selectedCharacter.value) void loadCharacterModel(selectedCharacter.value.id)
}

function retrySelectedActionResource() {
  if (!selectedCharacter.value) return
  const characterId = selectedCharacter.value.id
  const modelState = characterModels.get(String(characterId))
  const resource = timeline.value.characterAssets?.[String(characterId)]?.actions?.[actionToAdd.value]
  const url = resolveDirectorAssetUrl(resource)
  if (!url || !modelState) return
  actionResourceCache.delete(url)
  const requestKey = resourceStateKey('action', characterId, actionToAdd.value)
  actionResourceGenerations.set(requestKey, (actionResourceGenerations.get(requestKey) || 0) + 1)
  actionResourceRequests.delete(requestKey)
  delete modelState.actionClips[actionToAdd.value]
  void loadActionResource(characterId, actionToAdd.value, modelState)
}

function applyTimelineState(nextState, { emitChange = true } = {}) {
  timeline.value = normalizeDirectorTimeline(nextState, characters.value)
  if (!selectedShotId.value || !shots.value.some((shot) => shot.id === selectedShotId.value)) {
    selectedShotId.value = shots.value[0]?.id || ''
  }
  if (!selectedCharacterId.value || !characterEntries.value.some((character) => character.id === selectedCharacterId.value)) {
    selectedCharacterId.value = characterEntries.value[0]?.id || ''
  }
  dirty.value = false
  if (emitChange) emit('state-change', cloneTimeline(timeline.value))
  applyTimelineFrame()
}

function mutateTimeline(nextState) {
  applyTimelineState(nextState)
  dirty.value = true
}

function selectShot(shot) {
  if (!shot) return
  selectedShotId.value = shot.id
  setCurrentTime(shot.start)
}

function selectCharacter(characterId) {
  selectedCharacterId.value = String(characterId)
  focusItem(`character:${characterId}`)
}

function addShot() {
  const next = appendShot(timeline.value, { sceneId: selectedShot.value?.sceneId || '' })
  const last = next.shots[next.shots.length - 1]
  selectedShotId.value = last.id
  mutateTimeline(next)
}

function removeSelectedShot() {
  if (!selectedShot.value || shots.value.length <= 1) return
  const index = shots.value.findIndex((shot) => shot.id === selectedShot.value.id)
  const next = normalizeDirectorTimeline({ ...timeline.value, shots: shots.value.filter((shot) => shot.id !== selectedShot.value.id) }, characters.value)
  selectedShotId.value = next.shots[Math.max(0, index - 1)]?.id || next.shots[0]?.id || ''
  mutateTimeline(next)
}

function updateSelectedShot(field, value) {
  if (!selectedShot.value) return
  const shotsNext = shots.value.map((shot) => shot.id === selectedShot.value.id ? { ...shot, [field]: field === 'name' || field === 'camera' || field === 'transition' || field === 'sceneId' ? value : Number(value) } : shot)
  mutateTimeline({ ...timeline.value, shots: shotsNext })
}

function addActionClip() {
  if (!selectedCharacterId.value) return
  const next = appendActionClip(timeline.value, selectedCharacterId.value, actionToAdd.value, { start: currentTime.value })
  mutateTimeline(next)
}

function setCurrentTime(value) {
  timeline.value.sequence.currentTime = Math.max(0, Math.min(duration.value, Number(value) || 0))
  applyTimelineFrame()
}

function togglePlayback() {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (currentTime.value >= duration.value) setCurrentTime(0)
  playing.value = true
  lastFrameTime = performance.now()
  animationFrame = requestAnimationFrame(playFrame)
}

function playFrame(now) {
  if (!playing.value) return
  const elapsed = Math.max(0, (now - lastFrameTime) / 1000)
  lastFrameTime = now
  const next = currentTime.value + elapsed
  setCurrentTime(next >= duration.value ? 0 : next)
  animationFrame = requestAnimationFrame(playFrame)
}

function stopPlayback() {
  playing.value = false
  if (animationFrame) cancelAnimationFrame(animationFrame)
  animationFrame = 0
}

function recordingMimeType() {
  return pickDirectorRecordingMimeType((type) => window.MediaRecorder?.isTypeSupported?.(type))
}

async function recordTimelineBlob() {
  if (!canvasRef.value) throw new Error('导演台尚未初始化')
  if (!canvasRef.value.captureStream || typeof window.MediaRecorder === 'undefined') {
    throw new Error('当前浏览器不支持 WebM 画布录制')
  }
  const mimeType = recordingMimeType()
  if (!mimeType) throw new Error('当前浏览器没有可用的 WebM 编码器')
  const previousTime = currentTime.value
  const wasPlaying = playing.value
  const total = Math.max(0.25, duration.value)
  const stream = canvasRef.value.captureStream(timeline.value.sequence.fps)
  const chunks = []
  let recorder
  let exportFrame = 0
  stopPlayback()
  setCurrentTime(0)
  try {
    recorder = new MediaRecorder(stream, { mimeType })
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data)
    }
    await new Promise((resolve, reject) => {
      recorder.onerror = () => reject(new Error('WebM 录制失败'))
      recorder.onstop = resolve
      const startedAt = performance.now()
      recorder.start(100)
      const tick = (now) => {
        const elapsed = Math.max(0, (now - startedAt) / 1000)
        if (elapsed >= total) {
          setCurrentTime(total)
          exportProgress.value = 100
          recorder.stop()
          return
        }
        setCurrentTime(elapsed)
        exportProgress.value = Math.min(99, Math.round(elapsed / total * 100))
        exportFrame = requestAnimationFrame(tick)
      }
      exportFrame = requestAnimationFrame(tick)
    })
    return new Blob(chunks, { type: mimeType })
  } finally {
    if (exportFrame) cancelAnimationFrame(exportFrame)
    stream.getTracks?.().forEach((track) => track.stop())
    setCurrentTime(previousTime)
    if (wasPlaying) togglePlayback()
  }
}

async function exportTimelineVideo() {
  if (exporting.value) return
  exporting.value = true
  exportProgress.value = 0
  try {
    const blob = await recordTimelineBlob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = directorExportFilename(props.drama?.title, 'webm')
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    assetStatus.value = '视频已导出（WebM）'
  } catch (error) {
    assetStatus.value = error?.message || '视频导出失败'
  } finally {
    exporting.value = false
    exportProgress.value = 0
  }
}

async function exportTimelineMp4() {
  if (exporting.value || !props.drama?.id) return
  exporting.value = true
  exportProgress.value = 0
  try {
    const blob = await recordTimelineBlob()
    assetStatus.value = '正在提交服务端转码…'
    const created = await directorExportAPI.create(props.drama.id, blob, timeline.value)
    if (!created?.task_id) throw new Error('服务端未返回导出任务')
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const task = await taskAPI.get(created.task_id)
      exportProgress.value = Math.max(1, Math.min(99, Number(task?.progress) || 1))
      if (task?.status === 'failed') throw new Error(task.error || '服务端转码失败')
      if (task?.status !== 'completed') continue
      const result = parseDirectorExportResult(task.result)
      const url = result?.url
      if (!url) throw new Error('导出任务完成但没有下载地址')
      const link = document.createElement('a')
      link.href = url
      link.download = directorExportFilename(props.drama?.title, 'mp4')
      link.click()
      assetStatus.value = '视频已导出（MP4）'
      exportProgress.value = 100
      return
    }
    throw new Error('服务端转码超时')
  } catch (error) {
    assetStatus.value = error?.message || '服务端导出失败'
  } finally {
    exporting.value = false
    exportProgress.value = 0
  }
}

function colorize(object, color) {
  object.material?.color?.set?.(color)
  if (object.material?.roughness !== undefined) object.material.roughness = 0.76
  return object
}

function generator() {
  return viewer.value?.getPlugin?.(GeometryGeneratorPlugin)
}

function makeObject(type, params, color) {
  const object = generator()?.generateObject(type, params)
  return object ? colorize(object, color) : null
}

function addObject(key, object) {
  if (!object || !viewer.value) return
  object.userData = { ...(object.userData || {}), directorKey: key }
  viewer.value.scene.addObject(object, { addToRoot: true })
  stageObjects.set(key, object)
}

function clearStageObjects() {
  stageBuildToken += 1
  for (const object of stageObjects.values()) {
    object.parent?.remove?.(object)
    object.dispose?.()
  }
  stageObjects.clear()
  characterObjects.clear()
  characterModels.clear()
  characterPlaceholders.clear()
  actionResourceRequests.clear()
  stageRoot?.parent?.remove?.(stageRoot)
  stageRoot?.dispose?.()
  stageRoot = null
}

function rememberBaseTransform(object) {
  object.userData = {
    ...(object.userData || {}),
    directorBasePosition: { x: object.position.x, y: object.position.y, z: object.position.z },
    directorBaseRotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
  }
}

function buildStage() {
  if (!viewer.value || !generator()) return
  clearStageObjects()
  const buildToken = stageBuildToken
  const root = new Group()
  root.name = '茉莉妈妈导演台场景'
  viewer.value.scene.addObject(root, { addToRoot: true })
  stageRoot = root

  scenes.value.forEach((scene, index) => {
    const platform = makeObject('box', { width: 3.4, height: 0.12, depth: 2.2 }, 0x334155)
    if (!platform) return
    platform.position.set((index - (scenes.value.length - 1) / 2) * 4.2, 0.06, 1.5)
    platform.name = scene.location || scene.name || `场景 ${index + 1}`
    rememberBaseTransform(platform)
    root.add(platform)
    stageObjects.set(`scene:${scene.id || index}`, platform)
  })

  characterEntries.value.forEach((character, index) => {
    const x = (index - (characterEntries.value.length - 1) / 2) * 1.8
    const body = makeObject('box', { width: 0.7, height: 1.35, depth: 0.5 }, 0x818cf8)
    const head = makeObject('sphere', { radius: 0.34, widthSegments: 20, heightSegments: 14 }, 0xf5c2a4)
    if (!body || !head) return
    body.position.set(x, 0.68, 0)
    head.position.set(x, 1.62, 0)
    body.name = character.name
    head.name = `${character.name} · 头部`
    rememberBaseTransform(body)
    rememberBaseTransform(head)
    root.add(body, head)
    stageObjects.set(`character:${character.id}`, body)
    characterObjects.set(character.id, body)
    characterPlaceholders.set(character.id, [body, head])
    const modelUrl = timeline.value.characterAssets?.[character.id]?.modelUrl
    if (modelUrl) void loadCharacterModel(character.id, buildToken)
  })

  propsList.value.forEach((prop, index) => {
    const object = makeObject('box', { width: 0.55, height: 0.55, depth: 0.55 }, 0xfbbf24)
    if (!object) return
    object.position.set((index - (propsList.value.length - 1) / 2) * 1.2, 0.28, -1.35)
    object.name = prop.name || `道具 ${index + 1}`
    rememberBaseTransform(object)
    root.add(object)
    stageObjects.set(`prop:${prop.id || index}`, object)
  })

  viewer.value.setDirty?.()
  applyTimelineFrame()
}

function setCamera(position, target = [0, 0.8, 0]) {
  const camera = viewer.value?.scene?.mainCamera
  if (!camera) return
  camera.position.set(...position)
  camera.target?.set?.(...target)
  camera.setDirty?.()
}

function setCameraForShot(shot) {
  if (!shot) return
  const firstCharacter = characterObjects.values().next().value
  const target = firstCharacter?.position || { x: 0, y: 0.8, z: 0 }
  if (shot.camera === 'wide') setCamera([7.8, 5.4, 10.5], [0, 0.8, 0])
  else if (shot.camera === 'close') setCamera([target.x + 2.6, target.y + 1.3, target.z + 3.4], [target.x, target.y + 0.7, target.z])
  else if (shot.camera === 'profile') setCamera([target.x + 6.5, target.y + 1.3, target.z + 0.8], [target.x, target.y + 0.7, target.z])
  else setCamera([6.8, 4.8, 8.6], [0, 0.8, 0])
}

function pickAnimationClip(animations, actionName, clipName = '') {
  if (!Array.isArray(animations) || !animations.length) return null
  const wanted = String(clipName || '').trim().toLowerCase()
  const action = String(actionName || '').trim().toLowerCase()
  return animations.find((clip) => wanted && String(clip?.name || '').toLowerCase() === wanted)
    || animations.find((clip) => action && String(clip?.name || '').toLowerCase().includes(action))
    || animations[0]
    || null
}

function removeCharacterPlaceholder(characterId) {
  for (const object of characterPlaceholders.get(String(characterId)) || []) {
    object.parent?.remove?.(object)
    object.dispose?.()
  }
  characterPlaceholders.delete(String(characterId))
}

async function loadCharacterModel(characterId, expectedBuildToken = stageBuildToken) {
  const normalizedId = String(characterId)
  const asset = timeline.value.characterAssets?.[normalizedId]
  const url = resolveDirectorAssetUrl(asset?.modelUrl)
  if (!url || !viewer.value || !stageRoot || expectedBuildToken !== stageBuildToken) return
  const existing = characterModels.get(normalizedId)
  if (existing?.url === url) return
  modelLoading.value = true
  setResourceState('model', normalizedId, url, { status: 'loading', message: '正在加载角色模型…' })
  assetStatus.value = '正在加载角色模型…'
  try {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(url)
    if (disposed || expectedBuildToken !== stageBuildToken || !stageRoot) return
    const model = gltf.scene
    const characterIndex = characterEntries.value.findIndex((character) => character.id === normalizedId)
    const x = (characterIndex - (characterEntries.value.length - 1) / 2) * 1.8
    model.position.set(x, 0, 0)
    model.scale.setScalar(Math.max(0.01, Number(asset.scale) || 1))
    model.name = characterName(normalizedId)
    model.userData = { ...(model.userData || {}), directorKey: `character:${normalizedId}` }
    model.traverse?.((child) => {
      child.castShadow = true
      child.receiveShadow = true
    })
    rememberBaseTransform(model)
    removeCharacterPlaceholder(normalizedId)
    stageRoot.add(model)
    stageObjects.set(`character:${normalizedId}`, model)
    characterObjects.set(normalizedId, model)
    characterModels.set(normalizedId, {
      url,
      root: model,
      mixer: new AnimationMixer(model),
      animations: Array.isArray(gltf.animations) ? gltf.animations : [],
      actionClips: {},
      loadingActions: new Set(),
      activeClipKey: '',
    })
    assetStatus.value = `${characterName(normalizedId)}模型已加载`
    setResourceState('model', normalizedId, url, { status: 'ready', message: `${characterName(normalizedId)}模型已加载` })
    applyTimelineFrame()
  } catch (error) {
    if (disposed || expectedBuildToken !== stageBuildToken) return
    const message = `模型加载失败：${error?.message || '资源不可用'}`
    assetStatus.value = message
    setResourceState('model', normalizedId, url, { status: 'error', message })
  } finally {
    modelLoading.value = false
  }
}

async function loadActionResource(characterId, actionName, modelState) {
  const resource = timeline.value.characterAssets?.[String(characterId)]?.actions?.[actionName]
  const url = resolveDirectorAssetUrl(resource)
  if (!url) return
  const requestKey = resourceStateKey('action', characterId, actionName)
  const existingRequest = actionResourceRequests.get(requestKey)
  if (existingRequest?.url === url) return
  const requestToken = (actionResourceGenerations.get(requestKey) || 0) + 1
  actionResourceGenerations.set(requestKey, requestToken)
  actionResourceRequests.set(requestKey, { url, token: requestToken })
  const isCurrentRequest = () => {
    const currentRequest = actionResourceRequests.get(requestKey)
    const currentUrl = resolveDirectorAssetUrl(timeline.value.characterAssets?.[String(characterId)]?.actions?.[actionName])
    return currentRequest?.url === url
      && currentRequest?.token === requestToken
      && characterModels.get(String(characterId)) === modelState
      && currentUrl === url
  }
  setResourceState('action', characterId, url, { status: 'loading', message: `正在加载动作资源：${actionName}` }, actionName)
  if (actionResourceCache.has(url)) {
    const cachedAnimations = actionResourceCache.get(url)
    if (!isDirectorAnimationCompatible(modelState?.root, cachedAnimations)) {
      const message = '动作资源与当前角色模型骨架不兼容'
      modelState.actionClips[actionName] = []
      modelState.activeClipKey = ''
      setResourceState('action', characterId, url, { status: 'error', message }, actionName)
      actionResourceRequests.delete(requestKey)
      return
    }
    modelState.actionClips[actionName] = Array.isArray(cachedAnimations) ? cachedAnimations : []
    setResourceState('action', characterId, url, { status: 'ready', message: `${characterName(characterId)}动作资源已加载：${actionName}` }, actionName)
    actionResourceRequests.delete(requestKey)
    return
  }
  try {
    const loader = new GLTFLoader()
    const gltf = await loader.loadAsync(url)
    if (!isCurrentRequest()) return
    const animations = Array.isArray(gltf.animations) ? gltf.animations : []
    if (!isDirectorAnimationCompatible(modelState?.root, animations)) {
      throw new Error('动作资源与当前角色模型骨架不兼容')
    }
    actionResourceCache.set(url, animations)
    if (modelState) modelState.actionClips[actionName] = actionResourceCache.get(url)
    assetStatus.value = `${characterName(characterId)}动作资源已加载：${actionName}`
    setResourceState('action', characterId, url, { status: 'ready', message: `${characterName(characterId)}动作资源已加载：${actionName}` }, actionName)
    applyTimelineFrame()
  } catch (error) {
    if (!isCurrentRequest()) return
    const message = `动作资源加载失败：${error?.message || '资源不可用'}`
    assetStatus.value = message
    setResourceState('action', characterId, url, { status: 'error', message }, actionName)
    if (modelState) modelState.actionClips[actionName] = []
    actionResourceCache.set(url, [])
  } finally {
    if (actionResourceRequests.get(requestKey)?.token === requestToken) actionResourceRequests.delete(requestKey)
  }
}

function applyModelAnimation(modelState, clip, localTime) {
  if (!modelState?.mixer) return false
  const key = clip ? `${clip.uuid || clip.name || 'clip'}:${clip.name || ''}` : ''
  if (modelState.activeClipKey !== key) {
    modelState.mixer.stopAllAction()
    if (clip) modelState.mixer.clipAction(clip).reset().play()
    modelState.activeClipKey = key
  }
  if (!clip) return false
  modelState.mixer.setTime(Math.max(0, Number(localTime) || 0))
  modelState.mixer.update(0)
  return true
}

function applyTimelineFrame() {
  if (!viewer.value) return
  setCameraForShot(activeShot.value)
  for (const object of characterObjects.values()) {
    const base = object.userData?.directorBasePosition
    const rotation = object.userData?.directorBaseRotation
    if (base) object.position.set(base.x, base.y, base.z)
    if (rotation) object.rotation.set(rotation.x, rotation.y, rotation.z)
  }
  for (const clip of findActiveActionClips(timeline.value, currentTime.value)) {
    const characterId = String(clip.characterId)
    const object = characterObjects.get(characterId)
    if (!object) continue
    const modelState = characterModels.get(characterId)
    if (modelState) {
      const resource = timeline.value.characterAssets?.[characterId]?.actions?.[clip.action]
      const resourceUrl = String(resource?.url || '').trim()
      if (resourceUrl && !modelState.actionClips[clip.action]) void loadActionResource(characterId, clip.action, modelState)
      const clipSource = modelState.actionClips[clip.action] || modelState.animations
      const animation = pickAnimationClip(clipSource, clip.action, resource?.clipName)
      if (applyModelAnimation(modelState, animation, currentTime.value - clip.start)) continue
    }
    const base = object.userData?.directorBasePosition || { x: 0, y: 0, z: 0 }
    const progress = Math.max(0, Math.min(1, (currentTime.value - clip.start) / clip.duration))
    const wave = Math.sin(progress * Math.PI * 2)
    if (clip.action === 'Walk' || clip.action === 'Run') {
      object.position.x = base.x + wave * (clip.action === 'Run' ? 0.55 : 0.3)
      object.rotation.z = wave * 0.05
    } else if (clip.action === 'Wave') {
      object.rotation.z = wave * 0.22
    } else if (clip.action === 'Talk') {
      object.position.y = base.y + Math.abs(wave) * 0.07
    } else if (clip.action === 'Attack') {
      object.position.z = base.z - Math.max(0, wave) * 0.35
      object.rotation.y = wave * 0.18
    } else {
      object.position.y = base.y + Math.abs(wave) * 0.025
    }
  }
  viewer.value.setDirty?.()
}

function resetCamera() {
  viewMode.value = 'director'
  setCamera([6.8, 4.8, 8.6])
}

function setView(mode) {
  viewMode.value = mode
  if (mode === 'camera') setCamera([0, 2.25, 8.2], [0, 1, 0])
  else resetCamera()
}

function focusItem(key) {
  const object = stageObjects.get(key)
  if (!object) return
  const target = object.position.clone()
  setCamera([target.x + 3.4, target.y + 2.1, target.z + 4.8], [target.x, target.y, target.z])
  viewer.value?.getPlugin?.(PickingPlugin)?.selectObject?.(object)
}

async function initialize() {
  if (!canvasRef.value || viewer.value || disposed) return
  initializing.value = true
  errorMessage.value = ''
  try {
    const nextViewer = new ThreeViewer({ canvas: canvasRef.value, msaa: true, rgbm: true, renderScale: 'auto' })
    await nextViewer.addPlugins([
      PickingPlugin,
      Object3DGeneratorPlugin,
      GeometryGeneratorPlugin,
      new TransformControlsPlugin(false),
      new Object3DWidgetsPlugin(false),
      EditorViewWidgetPlugin,
    ])
    nextViewer.scene.setBackgroundColor('#0f172a')
    nextViewer.scene.addObject(new GridHelper(20, 20, 0x334155, 0x1e293b), { addToRoot: true })
    nextViewer.scene.addObject(new HemisphereLight(0xffffff, 0x334155, 1.6), { addToRoot: true })
    const keyLight = new DirectionalLight(0xffffff, 2.2)
    keyLight.position.set(4, 7, 5)
    nextViewer.scene.addObject(keyLight, { addToRoot: true })
    viewer.value = nextViewer
    resetCamera()
    buildStage()
  } catch (error) {
    errorMessage.value = error?.message || '导演台初始化失败'
  } finally {
    initializing.value = false
  }
}

watch(
  () => props.initialState,
  (value) => {
    if (!dirty.value) applyTimelineState(value || createDirectorTimeline(characters.value), { emitChange: false })
  },
  { deep: true },
)

watch(
  () => [scenes.value.length, characters.value.length, propsList.value.length, props.drama?.updated_at],
  () => {
    timeline.value = normalizeDirectorTimeline(timeline.value, characters.value)
    buildStage()
  },
)

onMounted(async () => {
  await loadProjectAssets()
  await nextTick()
  applyTimelineState(props.initialState || createDirectorTimeline(characters.value), { emitChange: false })
  await initialize()
})

watch(() => props.drama?.id, () => {
  void loadProjectAssets()
})

onBeforeUnmount(() => {
  disposed = true
  stopPlayback()
  clearStageObjects()
  viewer.value?.dispose?.(true)
  viewer.value = null
})
</script>

<style scoped>
.director-stage { position: fixed; inset: 0; z-index: 80; display: flex; flex-direction: column; background: #101014; color: #e4e4e7; }
.director-stage__header, .director-stage__footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; border-bottom: 1px solid #27272a; background: rgba(24, 24, 27, 0.95); }
.director-stage__footer { border-top: 1px solid #27272a; border-bottom: 0; color: #71717a; font-size: 12px; }
.director-stage__footer-actions { display: flex; align-items: center; gap: 8px; }
.director-stage__header strong { font-size: 16px; }
.director-stage__hint { margin-left: 10px; color: #818cf8; font-size: 11px; }
.director-stage__header-actions { display: flex; align-items: center; gap: 8px; }
.director-stage__header button, .director-stage__footer button, .small-button, .danger-button { border: 1px solid #3f3f46; border-radius: 9px; padding: 7px 12px; background: #18181b; color: #d4d4d8; cursor: pointer; }
.director-stage__header button.active { border-color: #818cf8; background: rgba(129, 140, 248, 0.16); color: #c4b5fd; }
.director-stage__header .close-button { width: 34px; padding: 4px; font-size: 22px; line-height: 1; }
.director-stage__save-state { color: #34d399; font-size: 11px; }
.director-stage__save-state.dirty { color: #fbbf24; }
.director-stage__body { flex: 1; display: flex; min-height: 0; }
.director-stage__sidebar { width: 286px; flex: 0 0 286px; padding: 16px 14px; overflow-y: auto; border-right: 1px solid #27272a; background: #18181b; }
.stage-section { margin-bottom: 18px; }
.stage-section__title { margin-bottom: 8px; color: #a1a1aa; font-size: 11px; font-weight: 700; }
.stage-item, .shot-list-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px; border: 0; border-radius: 7px; background: transparent; color: #e4e4e7; text-align: left; cursor: pointer; }
.stage-item:hover, .shot-list-item:hover { background: rgba(129, 140, 248, 0.14); }
.stage-item.selected, .shot-list-item.selected { background: rgba(129, 140, 248, 0.18); color: #c4b5fd; }
.stage-empty { padding: 5px 8px; color: #52525b; font-size: 11px; }
.stage-dot { width: 8px; height: 8px; display: inline-block; border-radius: 50%; flex: 0 0 auto; }
.stage-dot--scene { background: #64748b; }
.stage-dot--character { background: #818cf8; }
.stage-dot--prop { background: #fbbf24; }
.sequence-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: #71717a; font-size: 11px; }
.small-button { padding: 4px 8px; font-size: 11px; }
.shot-list-item { padding: 7px 6px; }
.shot-index { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: #27272a; color: #a1a1aa; font-size: 10px; }
.shot-list-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.shot-list-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.shot-list-copy small { color: #71717a; font-size: 10px; }
.transition-badge { color: #60a5fa; font-size: 10px; }
.shot-editor { display: grid; gap: 7px; padding: 10px; border: 1px solid #3f3f46; border-radius: 10px; background: rgba(39, 39, 42, 0.42); }
.shot-editor .stage-section__title { grid-column: 1 / -1; }
.shot-editor label { display: grid; gap: 4px; color: #a1a1aa; font-size: 10px; }
.shot-editor input, .shot-editor select, .action-add-row select { width: 100%; min-width: 0; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #18181b; color: #e4e4e7; font-size: 11px; }
.danger-button { margin-top: 3px; border-color: rgba(248, 113, 113, 0.5); color: #fca5a5; font-size: 11px; }
.action-add-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; }
.resource-editor { display: grid; gap: 7px; padding: 10px; border: 1px solid #3f3f46; border-radius: 10px; background: rgba(39, 39, 42, 0.42); }
.resource-editor .stage-section__title { margin-bottom: 0; }
.resource-editor label { display: grid; gap: 4px; color: #a1a1aa; font-size: 10px; }
.resource-editor input[type="text"], .resource-editor input[type="url"], .resource-editor input[type="number"] { width: 100%; min-width: 0; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #18181b; color: #e4e4e7; font-size: 11px; }
.resource-editor label input:not([type="file"]) { width: 100%; min-width: 0; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #18181b; color: #e4e4e7; font-size: 11px; }
.resource-upload-row { display: flex; align-items: center; gap: 6px; }
.resource-upload-row input[type="file"] { min-width: 0; flex: 1; color: #a1a1aa; font-size: 10px; }
.resource-character, .resource-tip, .resource-status { color: #71717a; font-size: 10px; }
.resource-status { color: #34d399; }
.resource-status--row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.resource-status[data-status='loading'] { color: #fbbf24; }
.resource-status[data-status='error'] { color: #fca5a5; }
.resource-status--row .small-button { min-height: 44px; }
.director-stage__viewport { position: relative; flex: 1; min-width: 0; min-height: 0; padding-bottom: 224px; background: #0f172a; }
.director-stage__canvas { width: 100%; height: 100%; display: block; outline: none; }
.director-stage__legend { position: absolute; right: 16px; top: 16px; display: flex; gap: 12px; padding: 8px 10px; border: 1px solid rgba(82, 82, 91, 0.7); border-radius: 9px; background: rgba(24, 24, 27, 0.82); color: #a1a1aa; font-size: 11px; }
.director-stage__legend span { display: inline-flex; align-items: center; gap: 5px; }
.director-stage__loading, .director-stage__error { position: absolute; inset: 50% auto auto 50%; transform: translate(-50%, -50%); color: #a1a1aa; font-size: 13px; }
.director-stage__error { color: #fca5a5; }
.timeline-panel { position: absolute; right: 12px; bottom: 12px; left: 12px; z-index: 3; padding: 10px 12px 12px; border: 1px solid #3f3f46; border-radius: 12px; background: rgba(24, 24, 27, 0.94); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.32); backdrop-filter: blur(14px); }
.timeline-toolbar { display: flex; align-items: center; gap: 12px; }
.timeline-controls { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.timeline-controls button { width: 27px; height: 27px; border: 1px solid #3f3f46; border-radius: 6px; background: #27272a; color: #e4e4e7; cursor: pointer; }
.timeline-time { min-width: 90px; color: #d4d4d8; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.timeline-fps { color: #71717a; font-size: 10px; }
.timeline-scrubber { flex: 1; accent-color: #818cf8; }
.timeline-ruler { display: flex; justify-content: space-between; padding: 8px 0 4px 102px; color: #71717a; font-size: 10px; }
.timeline-track { display: flex; min-height: 30px; margin-top: 4px; }
.track-label { width: 92px; flex: 0 0 92px; padding: 8px 10px 0 0; overflow: hidden; color: #a1a1aa; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.track-lane { position: relative; flex: 1; min-width: 0; border-top: 1px solid rgba(63, 63, 70, 0.7); background: repeating-linear-gradient(90deg, rgba(63, 63, 70, 0.16) 0, rgba(63, 63, 70, 0.16) 1px, transparent 1px, transparent 10%); }
.timeline-block { position: absolute; top: 3px; min-width: 24px; height: 24px; overflow: hidden; border: 1px solid #6366f1; border-radius: 5px; padding: 2px 6px; background: rgba(99, 102, 241, 0.35); color: #eef2ff; text-align: left; cursor: pointer; }
.timeline-block.selected { border-color: #c4b5fd; box-shadow: 0 0 0 1px #c4b5fd; }
.timeline-action { border-color: #34d399; background: rgba(16, 185, 129, 0.3); }
.timeline-block strong, .timeline-block small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline-block strong { font-size: 10px; }
.timeline-block small { color: #c4b5fd; font-size: 9px; }
.timeline-empty { padding: 8px 0 0 102px; color: #71717a; font-size: 10px; }
@media (max-width: 900px) {
  .director-stage__sidebar { width: 244px; flex-basis: 244px; }
  .director-stage__hint { display: none; }
  .timeline-panel { right: 6px; bottom: 6px; left: 6px; }
}
@media (max-width: 680px) {
  .director-stage__header, .director-stage__footer { padding: 10px 12px; }
  .director-stage__sidebar { width: 210px; flex-basis: 210px; }
  .director-stage__footer span { display: none; }
}
</style>
