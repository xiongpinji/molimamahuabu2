<template>
  <el-dialog
    v-model="showUpdateDialog"
    title="发现新版本"
    :width="480"
    :close-on-click-modal="!forceUpdate"
    :close-on-press-escape="!forceUpdate"
    :show-close="!forceUpdate"
    center
    append-to-body
  >
    <div class="app-update-content">
      <p class="version-info">
        当前版本：<el-tag size="small">{{ currentVersion }}</el-tag>
        <el-icon style="margin: 0 8px;"><Right /></el-icon>
        最新版本：<el-tag size="small" type="success">{{ latestVersion }}</el-tag>
      </p>

      <div v-if="releaseNotes" class="release-notes">
        <h4>更新内容：</h4>
        <pre>{{ releaseNotes }}</pre>
      </div>

      <el-alert
        v-if="forceUpdate"
        type="warning"
        :closable="false"
        title="本次为强制更新，请点击「立即更新」刷新页面"
        show-icon
      />
    </div>

    <template #footer>
      <el-button v-if="!forceUpdate" @click="dismissUpdate">稍后再说</el-button>
      <el-button type="primary" @click="applyUpdate">立即更新</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue';
import { Right } from '@element-plus/icons-vue';
import { useAppVersion } from '@/composables/useAppVersion';

const {
  currentVersion,
  latestVersion,
  releaseNotes,
  forceUpdate,
  showUpdateDialog,
  applyUpdate,
  dismissUpdate,
  init,
  cleanup,
} = useAppVersion();

onMounted(() => {
  init();
});

onUnmounted(() => {
  cleanup();
});
</script>

<style scoped>
.app-update-content {
  padding: 0 12px;
}

.version-info {
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  font-size: 14px;
}

.release-notes {
  background: #f5f7fa;
  border-radius: 6px;
  padding: 12px;
  margin-top: 12px;
  max-height: 200px;
  overflow-y: auto;
}

.release-notes h4 {
  margin: 0 0 8px;
  color: #303133;
  font-size: 14px;
}

.release-notes pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: inherit;
  color: #606266;
  font-size: 13px;
  line-height: 1.6;
}
</style>
