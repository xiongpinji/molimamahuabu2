<template>
  <section class="export-panel">
    <header>
      <strong>交付文件</strong>
      <span>只显示服务端状态与 hash。</span>
    </header>
    <div v-if="!exports.length" class="empty">暂无完成导出。</div>
    <ul v-else>
      <li v-for="item in exports" :key="item.id">
        <div>
          <strong>{{ String(item.kind || '').toUpperCase() }}</strong>
          <small>{{ item.status || 'unknown' }}</small>
          <code v-if="item.sha256 || item.hash">{{ item.sha256 || item.hash }}</code>
        </div>
        <el-button size="small" :disabled="item.status !== 'completed'" :title="item.status !== 'completed' ? '导出未完成' : '下载文件'" @click="download(item)">
          下载
        </el-button>
      </li>
    </ul>
    <div class="disabled-actions">
      <el-button disabled title="服务端暂未开放已验证导入端点">剪映导入不可用</el-button>
      <el-button disabled title="服务端暂未开放已验证导入端点">工厂导入不可用</el-button>
      <span>服务端暂未开放已验证导入端点。</span>
    </div>
  </section>
</template>

<script setup>
import { redrawAPI } from '@/api/redraw'

const props = defineProps({
  versionId: { type: [String, Number], required: true },
  exports: { type: Array, default: () => [] },
})

async function download(item) {
  const blob = await redrawAPI.downloadExport(props.versionId, item.id)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const suffix = String(item.kind || 'bin').toLowerCase()
  a.href = url
  a.download = `redraw-export-${item.id}.${suffix}`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<style scoped>
.export-panel {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  background: #121212;
}

header,
.disabled-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

header span,
.disabled-actions span,
.empty {
  color: #999;
  overflow-wrap: anywhere;
}

ul {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  padding: 10px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
}

li > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

code,
small,
strong {
  overflow-wrap: anywhere;
}

code {
  color: #ff9a6d;
  font-size: 12px;
}
</style>
