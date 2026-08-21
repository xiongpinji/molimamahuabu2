<template>
  <section class="redraw-timeline" aria-label="固定源片顺序时间线">
    <header>
      <strong>固定源片顺序</strong>
      <span>只读展示镜头，不支持拖拽改剧情。</span>
    </header>
    <ol>
      <li
        v-for="shot in orderedShots"
        :key="shot.id"
        :class="{ active: String(shot.id) === String(selectedShotId) }"
      >
        <button type="button" :aria-label="`查看镜头 ${shot.shot_index || shot.id}`" @click="$emit('select', shot.id)">
          <span>镜头 {{ shot.shot_index || shot.id }}</span>
          <small>{{ formatTimecode(shot.start_ms) }}–{{ formatTimecode(shot.end_ms) }}</small>
          <em>{{ statusLabel(shot.status) }}</em>
        </button>
      </li>
    </ol>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { formatTimecode, normalizeTimelineShots, statusLabel } from '@/utils/redrawTimelineState'

const props = defineProps({
  shots: { type: Array, default: () => [] },
  selectedShotId: { type: [String, Number], default: null },
})
defineEmits(['select'])

const orderedShots = computed(() => normalizeTimelineShots(props.shots))
</script>

<style scoped>
.redraw-timeline {
  min-width: 0;
  padding: 14px;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  background: #121212;
}

header {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  color: #f5f5f5;
}

header span {
  color: #999;
  font-size: 12px;
  overflow-wrap: anywhere;
}

ol {
  display: flex;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-x: auto;
}

li {
  flex: 0 0 168px;
  min-width: 0;
}

button {
  display: grid;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 10px;
  border: 1px solid #333;
  border-radius: 8px;
  background: #1b1b1b;
  color: #eee;
  text-align: left;
}

li.active button {
  border-color: #ff7139;
}

span,
small,
em {
  overflow-wrap: anywhere;
}

small {
  color: #aaa;
}

em {
  color: #ff9a6d;
  font-style: normal;
}
</style>
