<template>
  <section class="character-library" aria-label="整集角色计划">
    <header class="panel-heading">
      <div>
        <p class="eyebrow">整集角色库</p>
        <h3>姓名、身份、声音与服装锁定</h3>
      </div>
      <el-tag :type="projected.ready ? 'success' : 'warning'">
        {{ projected.ready ? '角色计划已就绪' : '角色计划待补齐' }}
      </el-tag>
    </header>
    <div v-loading="loading" class="character-grid">
      <article v-for="character in projected.characters" :key="character.sourceCharacterKey" class="character-card">
        <strong>{{ character.name || character.sourceCharacterKey }}</strong>
        <dl>
          <div><dt>姓名</dt><dd>{{ character.name || '待命名' }}</dd></div>
          <div><dt>身份</dt><dd>{{ character.identity.label }}</dd></div>
          <div><dt>声音</dt><dd>{{ character.voice.label }} · {{ stateLabel(character.voice.ready) }}</dd></div>
          <div><dt>服装</dt><dd>{{ character.wardrobe.label }} · {{ stateLabel(character.wardrobe.ready) }}</dd></div>
        </dl>
      </article>
      <p v-if="!projected.characters.length" class="empty-state">尚未形成服务端角色计划。</p>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { projectRedrawCharacterPlan } from '@/utils/redrawCharacterIdentity'

const props = defineProps({
  plan: { type: Object, default: null },
  loading: { type: Boolean, default: false },
})

const projected = computed(() => projectRedrawCharacterPlan(props.plan || {}))
const stateLabel = (ready) => ready ? '已锁定' : '待补齐'
</script>

<style scoped>
.character-library { display: grid; gap: 12px; padding: 16px; border: 1px solid #303030; border-radius: 10px; background: #121212; }
.panel-heading { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
.eyebrow { margin: 0 0 4px; color: #ff9a6d; font-size: 12px; font-weight: 800; }
h3 { margin: 0; font-size: 17px; }
.character-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; min-height: 44px; }
.character-card { padding: 13px; border: 1px solid #292929; border-radius: 8px; background: #191919; }
dl { display: grid; gap: 7px; margin: 12px 0 0; }
dl div { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 8px; }
dt { color: #8f8f8f; }
dd { margin: 0; overflow-wrap: anywhere; }
.empty-state { margin: 0; color: #8f8f8f; }
</style>
