<template>
  <div class="drama-canvas-page">
    <header
      class="header canvas-topbar"
      :class="{ 'workflow-open': showWorkflowPanel }"
      :style="{ '--canvas-top-toolbar-scale': canvasPreferences.top_toolbar_scale }"
    >
      <div class="header-inner">
        <CanvasWorkspaceSwitcher />
        <PlatformPrimaryNav />
        <span class="page-title">{{ drama?.title || '加载中…' }}</span>
        <span
          v-if="canvasVirtualized"
          class="canvas-virtualization-status"
          :title="`多集画布仅渲染视口附近节点：${nodes.length}/${allGraphNodes.length}`"
        >
          视口渲染 {{ nodes.length }}/{{ allGraphNodes.length }}
        </span>

        <el-select
          v-if="!isStandaloneCanvas"
          v-model="filterEpisodeId"
          class="episode-select"
          placeholder="全部集数"
          clearable
          size="small"
          style="width: 150px"
        >
          <el-option
            v-for="ep in (drama?.episodes || [])"
            :key="ep.id"
            :label="ep.title || '第' + (ep.episode_number || 0) + '集'"
            :value="ep.id"
          />
        </el-select>

        <span v-if="layoutSaveState === 'saving'" class="layout-status saving">保存中…</span>
        <span v-else-if="layoutSaveState === 'saved'" class="layout-status saved">已保存</span>
        <span v-else-if="layoutSaveState === 'error'" class="layout-status error">保存失败</span>

        <div class="header-actions">
          <div class="topbar-history" aria-label="画布历史操作">
            <button type="button" aria-label="撤销" title="撤销（Ctrl/Cmd+Z）" :disabled="!canUndo" @click="undoCanvas">
              <el-icon><RefreshLeft /></el-icon>
            </button>
            <button type="button" aria-label="重做" title="重做（Ctrl/Cmd+Shift+Z）" :disabled="!canRedo" @click="redoCanvas">
              <el-icon><RefreshRight /></el-icon>
            </button>
          </div>
          <el-button class="topbar-share" size="small" circle aria-label="分享画布" title="复制画布链接" @click="shareCanvas">
            <el-icon><Share /></el-icon>
          </el-button>
          <el-tooltip v-if="!isStandaloneCanvas" content="工作流：框选分镜后创建，可拖拽排序并按步骤整组重跑" placement="bottom">
            <el-button class="topbar-workflow-toggle" size="small" :type="showWorkflowPanel ? 'primary' : 'default'" plain @click="toggleWorkflowPanel">
              <el-icon><Operation /></el-icon>
              工作流
            </el-button>
          </el-tooltip>
          <el-dropdown class="topbar-more" trigger="click" placement="bottom-end" @command="onTopbarMoreCommand">
            <el-button class="topbar-more-trigger" size="small" aria-label="更多画布操作" title="更多画布操作">
              <el-icon><MoreFilled /></el-icon>
              <span class="topbar-more-label">更多</span>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <template v-if="isStandaloneCanvas">
                  <el-dropdown-item command="text">添加文本节点</el-dropdown-item>
                  <el-dropdown-item command="image">添加图片节点</el-dropdown-item>
                  <el-dropdown-item command="video">添加视频节点</el-dropdown-item>
                  <el-dropdown-item command="audio">添加音频节点</el-dropdown-item>
                  <el-dropdown-item divided command="run-selected-free">运行所选自由节点</el-dropdown-item>
                </template>
                <template v-else>
                  <el-dropdown-item command="script">编辑剧本</el-dropdown-item>
                  <el-dropdown-item command="storyboard">添加分镜</el-dropdown-item>
                  <el-dropdown-item command="character">添加角色</el-dropdown-item>
                  <el-dropdown-item command="scene">添加场景</el-dropdown-item>
                  <el-dropdown-item command="prop">添加道具</el-dropdown-item>
                  <el-dropdown-item command="episode">添加集数</el-dropdown-item>
                </template>
                <el-dropdown-item command="align" :disabled="aligningNodes">自动对齐节点</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <CanvasModeSwitch v-if="!isStandaloneCanvas" mode="canvas" :drama-id="dramaId" :episode-id="filterEpisodeId" />
        </div>
      </div>

      <div v-if="showWorkflowPanel" class="workflow-bar">
        <el-tooltip content="在画布空白处拖拽框选分镜，或按住 Ctrl 逐个多选" placement="bottom-start">
          <span class="wf-hint">已选 {{ selectedStoryboardIds.length }} 个分镜</span>
        </el-tooltip>
        <CanvasGenerationOptions />
        <el-checkbox-group v-model="pipelineSteps" size="small" class="wf-steps">
          <el-checkbox value="image">生图</el-checkbox>
          <el-checkbox value="video">生视频</el-checkbox>
          <el-checkbox value="audio">配音</el-checkbox>
        </el-checkbox-group>
        <el-button
          size="small"
          :disabled="selectedStoryboardIds.length === 0 || workflowRunning || layoutSaveState === 'saving'"
          @click="onCreateWorkflowGroup"
        >
          创建工作流
        </el-button>
        <el-button
          size="small"
          type="primary"
          plain
          :loading="workflowRunning"
          :disabled="selectedStoryboardIds.length === 0 || workflowRunning || layoutSaveState === 'saving'"
          @click="onRunSelectedStoryboards"
        >
          运行所选
        </el-button>
        <el-select
          v-model="activeGroupId"
          size="small"
          placeholder="选择工作流"
          clearable
          style="width: 160px"
          @change="selectWorkflowGroup"
        >
          <el-option
            v-for="g in workflowGroups"
            :key="g.id"
            :label="`${g.title} (${workflowStoryboardCountLabel(g)})`"
            :value="g.id"
          />
        </el-select>
        <el-button
          size="small"
          type="primary"
          :loading="workflowRunning"
          :disabled="!activeGroupId || layoutSaveState === 'saving'"
          @click="onRunActiveGroup"
        >
          整组重跑
        </el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :disabled="!activeGroupId || workflowRunning || layoutSaveState === 'saving'"
          @click="onDeleteActiveGroup"
        >
          删除工作流
        </el-button>
      </div>

      <div v-if="showWorkflowPanel && workflowProgress" class="workflow-progress">{{ workflowProgress }}</div>

      <CanvasWorkflowOrderPanel
        v-if="showWorkflowPanel && activeWorkflowGroup"
        :group="activeWorkflowGroup"
        :storyboards="allStoryboards"
        :disabled="workflowRunning || layoutSaveState === 'saving'"
        @change="onWorkflowOrderChange"
        @focus="focusWorkflowStoryboard"
      />

      <div v-if="showWorkflowPanel" class="generate-bar">
        <span class="gen-label">本集生成</span>
        <el-button
          size="small"
          type="primary"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="aiGenerateStoryboards"
        >
          AI 生成分镜
        </el-button>
        <el-button
          size="small"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="batchGenerateImages"
        >
          批量生图
        </el-button>
        <el-button
          size="small"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="batchGenerateVideos"
        >
          批量生视频
        </el-button>
        <span class="gen-hint" title="完整创作流水线">剧本 → 提取角色/场景/道具 → 分镜 → 生图 → 视频</span>
      </div>
      <div v-if="showWorkflowPanel && episodeGenProgress" class="workflow-progress episode-gen">{{ episodeGenProgress }}</div>
    </header>

    <div v-loading="loading" class="canvas-shell" :class="{ 'sidebar-open': sidebarVisible }">
      <aside v-if="drama && sidebarVisible" class="canvas-sidebar">
        <div class="sidebar-section sidebar-script">
          <div class="sec-label sec-label-row">
            <span>📜 剧本</span>
            <el-button link size="small" type="warning" @click="focusScriptNode">编辑</el-button>
          </div>
          <p class="sidebar-script-tip">从头创作：先写剧本，再提取左侧素材</p>
        </div>
        <div class="sidebar-title">
          素材库
          <el-button v-if="highlightAssetId" link size="small" @click="clearAssetHighlight">清除</el-button>
        </div>
        <div class="sidebar-context">
          {{ episodeContext.isFiltered ? `${selectedEpisodeLabel}引用素材` : '项目全部素材' }}
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>角色 {{ sidebarCharacters.length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('character')">+</el-button>
          </div>
          <div
            v-for="c in sidebarCharacters"
            :key="'c-' + c.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'char:' + c.id }"
            @click="selectSidebarAsset('char:' + c.id)"
          >
            {{ c.name || '未命名' }}
          </div>
          <div v-if="episodeContext.isFiltered && !sidebarCharacters.length" class="sidebar-empty">本集未引用角色</div>
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>场景 {{ sidebarScenes.length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('scene')">+</el-button>
          </div>
          <div
            v-for="s in sidebarScenes"
            :key="'s-' + s.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'scene:' + s.id }"
            @click="selectSidebarAsset('scene:' + s.id)"
          >
            {{ s.location || '未命名' }}
          </div>
          <div v-if="episodeContext.isFiltered && !sidebarScenes.length" class="sidebar-empty">本集未引用场景</div>
        </div>
        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>道具 {{ sidebarProps.length }}</span>
            <el-button link size="small" type="primary" @click="openCreateDialog('prop')">+</el-button>
          </div>
          <div
            v-for="p in sidebarProps"
            :key="'p-' + p.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'prop:' + p.id }"
            @click="selectSidebarAsset('prop:' + p.id)"
          >
            {{ p.name || '未命名' }}
          </div>
          <div v-if="episodeContext.isFiltered && !sidebarProps.length" class="sidebar-empty">本集未引用道具</div>
        </div>

        <div class="sidebar-section workflow-list">
          <div class="sec-label">工作流 {{ workflowGroups.length }}</div>
          <div
            v-for="g in workflowGroups"
            :key="g.id"
            class="sidebar-item workflow-item"
            :class="{ active: activeGroupId === g.id }"
            @click="selectWorkflowGroup(g.id)"
          >
            <div class="wf-item-title">{{ g.title }}</div>
            <div class="wf-item-meta">{{ workflowStoryboardCountLabel(g) }} · {{ (g.pipeline || []).join('→') }}</div>
          </div>
          <div v-if="!workflowGroups.length" class="sidebar-empty">框选分镜后点「创建工作流」</div>
        </div>

        <p class="sidebar-tip">经典模式流水线：分镜 → 脚本摘要 → 分镜图 → 视频。摘要节点是画布可视化，列表里合并在分镜编辑区。顶栏「本集生成」可 AI 批量操作；单击分镜可单镜生图/生视频。</p>
      </aside>

      <div
        ref="canvasMainRef"
        class="canvas-main"
        :class="{
          'space-panning': spacePanning,
          'canvas-glow': canvasPreferences.canvas_glow_enabled,
          'edge-animated': canvasPreferences.edge_animation_enabled,
          'edge-focus-only': canvasPreferences.edge_focus_only,
          'linked-preview-hidden': !canvasPreferences.linked_preview_enabled,
          'minimal-zoom': canvasPreferences.minimal_zoom_enabled && currentViewport.zoom < 0.45,
          'standalone-group-selected': isStandaloneCanvas && allGraphNodes.some((node) => node.type === 'canvasGroup' && node.selected),
        }"
        :style="canvasVisualStyle"
        @pointerdown.capture="onCanvasPointerDown"
        @wheel.capture="onCanvasWheel"
        @dragover="onCanvasImageDragOver"
        @drop="onCanvasImageDrop"
      >
        <div
          v-if="canvasPreferences.background_enabled && canvasPreferences.background_url"
          class="canvas-custom-background"
          :style="canvasBackgroundStyle"
          aria-hidden="true"
        />
        <VueFlow
          v-if="isStandaloneCanvas || allGraphNodes.length"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :edge-types="edgeTypes"
          :default-edge-options="{ type: 'cuttable' }"
          :default-viewport="initialViewport"
          :min-zoom="0.08"
          :max-zoom="8"
          :nodes-connectable="true"
          :nodes-draggable="true"
          :snap-to-grid="canvasPreferences.snap_enabled"
          :snap-grid="[canvasPreferences.grid_gap, canvasPreferences.grid_gap]"
          :connection-radius="canvasPreferences.touch_connection_radius"
          v-bind="canvasConnectionInteractionOptions"
          :elements-selectable="true"
          :select-nodes-on-drag="true"
          selection-mode="partial"
          :selection-key-code="true"
          :delete-key-code="null"
          :pan-on-drag="spacePanning"
          pan-activation-key-code="Space"
          zoom-activation-key-code="Control"
          :pan-on-scroll="canvasPreferences.wheel_action === 'pan'"
          :pan-on-scroll-speed="canvasPreferences.pan_sensitivity"
          :zoom-on-scroll="canvasPreferences.wheel_action === 'zoom'"
          :fit-view-on-init="!hasSavedViewport"
          class="vue-flow-canvas"
          @node-double-click="onNodeDoubleClick"
          @node-click="onNodeClick"
          @node-context-menu="onNodeContextMenu"
          @pane-click="onPaneClick"
          @pane-context-menu="onPaneContextMenu"
          @pane-double-click="onPaneDoubleClick"
          @node-drag-start="onNodeDragStart"
          @node-drag="onNodeDrag"
          @node-drag-stop="onNodeDragStop"
          @selection-start="onCanvasSelectionStart"
          @selection-end="onCanvasSelectionEnd"
          @viewport-change="onViewportChange"
          @move-end="scheduleLayoutSave"
          @nodes-change="onNodesChange"
          @edges-change="onEdgesChange"
          @connect-start="onConnectStart"
          @connect-end="onConnectEnd"
          @connect="onConnect"
        >
          <CanvasFlowAligner />
          <Background
            v-if="canvasPreferences.grid_visible"
            variant="dots"
            pattern-color="rgba(113, 113, 122, 0.62)"
            :gap="canvasPreferences.grid_gap"
            :size="canvasPreferences.grid_dot_size"
          />
          <Controls />
          <MiniMap v-if="canvasPreferences.minimap_visible" pannable zoomable />
        </VueFlow>
        <div v-if="alignmentGuide.x !== null" class="canvas-alignment-guide vertical" :style="{ left: `${alignmentGuide.x}px` }" aria-hidden="true" />
        <div v-if="alignmentGuide.y !== null" class="canvas-alignment-guide horizontal" :style="{ top: `${alignmentGuide.y}px` }" aria-hidden="true" />
        <el-empty v-if="!isStandaloneCanvas && !allGraphNodes.length && !loading" description="暂无画布数据" />
        <div v-if="runQueueItems.length || dismissedRunQueueCount" class="canvas-run-queue nodrag nopan" aria-label="画布节点运行队列" @mousedown.stop>
          <div class="run-queue-head">
            <span>运行队列</span>
            <small>{{ runningQueueCount }} 进行中 · {{ successQueueCount }} 完成 · {{ failedQueueCount }} 异常</small>
            <button v-if="dismissedRunQueueCount" type="button" @click.stop="restoreDismissedRunQueueItems">恢复已收起 {{ dismissedRunQueueCount }}</button>
          </div>
          <div
            v-for="item in runQueueItems"
            :key="item.key"
            class="run-queue-item"
            :class="['tone-' + item.tone, item.resultUrl ? 'queue-preview-' + queueResultPreviewType(item) : queueTextResult(item) ? 'queue-preview-text' : 'queue-preview-empty']"
            :title="queueItemTitle(item)"
            @click="focusQueueItem(item)"
          >
            <span class="run-dot" />
            <span
              class="run-result-preview"
              :class="[item.resultUrl ? 'preview-' + queueResultPreviewType(item) : queueTextResult(item) ? 'preview-text' : 'preview-empty']"
              @click.stop="item.resultUrl && openQueueItemResult(item)"
            >
              <img v-if="item.resultUrl && queueResultPreviewType(item) === 'image'" :src="item.resultUrl" alt="队列结果预览" />
              <video v-else-if="item.resultUrl && queueResultPreviewType(item) === 'video'" :src="item.resultUrl" muted playsinline />
              <audio v-else-if="item.resultUrl" :src="item.resultUrl" controls preload="metadata" @click.stop />
              <small v-else-if="queueTextResult(item)">{{ queueTextResult(item) }}</small>
            </span>
            <span class="run-info">
              <strong>{{ item.label }}</strong>
              <small>{{ item.message }}</small>
              <small v-if="item.actionError" class="run-action-error">动作：{{ item.actionError }}</small>
            </span>
            <span v-if="item.tone === 'running'" class="run-action">{{ item.elapsedText }}</span>
            <span v-else-if="item.tone === 'success'" class="run-success-actions">
              <button v-if="item.resultUrl" type="button" @click.stop="openQueueItemResult(item)">打开</button>
              <button v-if="item.resultUrl" type="button" @click.stop="copyQueueItemResult(item)">复制</button>
              <button v-if="queueTextResult(item)" type="button" @click.stop="copyQueueItemTextResult(item)">复制文本</button>
              <button v-if="item.resultReferences?.length" type="button" @click.stop="copyQueueItemResultReferences(item)">复制引用</button>
              <button v-if="queueItemRequestPayloadText(item)" type="button" @click.stop="copyQueueItemRequestPayload(item)">复制请求</button>
              <button v-if="item.resultUrl" type="button" @click.stop="downloadQueueItemResult(item)">下载</button>
              <button v-if="item.resultUrl && !item.savedAssetId" type="button" :disabled="savingQueueAssetKey === item.key" @click.stop="saveQueueItemResultAsset(item)">
                {{ savingQueueAssetKey === item.key ? '入库中…' : '存入素材库' }}
              </button>
              <button v-if="item.actionError" type="button" @click.stop="copyQueueItemActionError(item)">动作原因</button>
              <button v-if="item.retryAction" type="button" @click.stop="retryQueueItemAction(item)">{{ item.retryActionLabel || '重试动作' }}</button>
              <button v-if="item.savedAssetId" type="button" @click.stop="copyQueueItemAssetReference(item)">素材引用</button>
              <button v-if="item.savedAssetId" type="button" @click.stop="assignQueueItemAssetToSelectedStoryboard(item)">回填</button>
              <button v-if="canUseQueueItemAsDownstreamReference(item)" type="button" @click.stop="useQueueItemAsDownstreamReference(item)">作为下游参考</button>
              <button v-if="item.resultNodeId" type="button" @click.stop="focusQueueItemResult(item)">定位</button>
              <button type="button" @click.stop="dismissQueueItem(item)">收起</button>
            </span>
            <span v-else-if="item.tone === 'failed'" class="run-failed-actions">
              <button v-if="item.resultUrl" type="button" @click.stop="openQueueItemResult(item)">打开上次</button>
              <button v-if="item.resultUrl" type="button" @click.stop="copyQueueItemResult(item)">复制</button>
              <button v-if="queueTextResult(item)" type="button" @click.stop="copyQueueItemTextResult(item)">复制文本</button>
              <button v-if="item.resultReferences?.length" type="button" @click.stop="copyQueueItemResultReferences(item)">复制引用</button>
              <button v-if="queueItemRequestPayloadText(item)" type="button" @click.stop="copyQueueItemRequestPayload(item)">复制请求</button>
              <button v-if="item.resultUrl" type="button" @click.stop="downloadQueueItemResult(item)">下载</button>
              <button v-if="item.resultUrl && !item.savedAssetId" type="button" :disabled="savingQueueAssetKey === item.key" @click.stop="saveQueueItemResultAsset(item)">
                {{ savingQueueAssetKey === item.key ? '入库中…' : '存入素材库' }}
              </button>
              <button v-if="item.actionError" type="button" @click.stop="copyQueueItemActionError(item)">动作原因</button>
              <button v-if="item.retryAction" type="button" @click.stop="retryQueueItemAction(item)">{{ item.retryActionLabel || '重试动作' }}</button>
              <button v-if="item.savedAssetId" type="button" @click.stop="copyQueueItemAssetReference(item)">素材引用</button>
              <button v-if="item.savedAssetId" type="button" @click.stop="assignQueueItemAssetToSelectedStoryboard(item)">回填</button>
              <button v-if="canUseQueueItemAsDownstreamReference(item)" type="button" @click.stop="useQueueItemAsDownstreamReference(item)">作为下游参考</button>
              <button v-if="item.resultNodeId" type="button" @click.stop="focusQueueItemResult(item)">定位</button>
              <button v-if="item.errorDetail || item.message" type="button" @click.stop="copyQueueItemError(item)">原因</button>
              <button v-if="item.retryStep" type="button" @click.stop="retryQueueItem(item)">重试</button>
              <button type="button" @click.stop="dismissQueueItem(item)">收起</button>
            </span>
            <span v-else class="run-action">定位</span>
          </div>
        </div>
        <CanvasFloatingToolbar
          v-if="drama && (isStandaloneCanvas || allGraphNodes.length)"
          :standalone="isStandaloneCanvas"
        />
        <CanvasSelectionToolbar v-if="isStandaloneCanvas" />
      </div>
    </div>

    <CanvasDirectorStage
      v-if="directorStageVisible && drama"
      :visible="directorStageVisible"
      :drama="drama"
      :initial-state="directorTimeline"
      :entry-context="directorStageEntry"
      @close="closeDirectorStage"
      @state-change="onDirectorStateChange"
      @asset-created="onDirectorAssetCreated"
    />

    <CanvasCreateDialog
      v-if="!isStandaloneCanvas"
      v-model="createDialogVisible"
      :type="createDialogType"
      :on-submit="onCreateSubmit"
    />
    <AssetPickerDialog
      v-model="canvasAssetPickerVisible"
      :type="canvasAssetPickerType"
      :title="canvasAssetPickerTitle"
      :drama-id="dramaId"
      @pick="onCanvasAssetLibraryPick"
    />
    <input
      ref="canvasUploadInput"
      class="canvas-upload-input"
      type="file"
      :accept="canvasUploadAccept"
      multiple
      @change="onCanvasUpload"
    />
    <CanvasContextMenu
      :visible="contextMenuVisible"
      :x="contextMenuX"
      :y="contextMenuY"
      :mode="contextMenuNode ? 'node' : 'create'"
      :node-label="contextMenuNodeLabel"
      :node-actions="contextMenuNodeActions"
      :standalone="isStandaloneCanvas"
      @select="onContextMenuSelect"
      @close="closeContextMenu"
    />
    <el-dialog
      v-model="collaborationDialogVisible"
      title="画布协作"
      width="560px"
      append-to-body
      destroy-on-close
    >
      <el-alert
        title="邀请成员加入当前工作区后，可共同打开并编辑这张画布。"
        type="info"
        :closable="false"
        show-icon
      />
      <div class="canvas-collaboration-link">
        <el-input :model-value="canvasShareLink" readonly />
        <el-button @click="copyCanvasShareLink">复制链接</el-button>
      </div>
      <template v-if="currentTenantId">
        <div class="canvas-collaboration-invite">
          <el-input v-model="collaborationForm.email" placeholder="成员邮箱" @keyup.enter="inviteCanvasCollaborator" />
          <el-select v-model="collaborationForm.role" style="width: 128px">
            <el-option label="成员" value="member" />
            <el-option label="管理员" value="admin" />
          </el-select>
          <el-button type="primary" :loading="collaborationInviteLoading" @click="inviteCanvasCollaborator">
            邀请
          </el-button>
        </div>
        <div v-loading="collaborationLoading" class="canvas-collaboration-members">
          <div v-if="!collaborationMembers.length && !collaborationLoading" class="canvas-collaboration-empty">
            当前工作区暂无其他成员
          </div>
          <div v-for="member in collaborationMembers" :key="member.user_id || member.id || member.email" class="canvas-collaboration-member">
            <span>{{ member.email || member.user?.email || member.name || member.user_id }}</span>
            <el-tag size="small" effect="plain">{{ member.role || 'member' }}</el-tag>
          </div>
        </div>
      </template>
      <el-alert
        v-else
        title="当前未选择工作区，暂时只能复制画布链接。"
        type="warning"
        :closable="false"
        show-icon
      />
    </el-dialog>
    <el-dialog
      v-model="freeNodeDialogVisible"
      class="canvas-free-node-dialog"
      :title="freeNodeEditingId ? `编辑${freeNodeKindLabel}节点` : `添加${freeNodeKindLabel}节点`"
      width="480px"
      :z-index="3400"
      destroy-on-close
      :close-on-click-modal="false"
      @closed="resetFreeNodeDialog"
    >
      <el-form label-position="top" @submit.prevent="submitFreeNode">
        <el-form-item label="标题" required>
          <el-input
            v-model="freeNodeForm.title"
            maxlength="80"
            :placeholder="freeNodeTitlePlaceholder"
            autofocus
          />
        </el-form-item>
        <el-form-item :label="freeNodeKind === 'text' ? '内容' : '描述 / 提示词'">
          <el-input
            v-model="freeNodeForm.content"
            type="textarea"
            :rows="5"
            :placeholder="freeNodeContentPlaceholder"
          />
        </el-form-item>
        <el-form-item v-if="freeNodeKind !== 'text'" label="媒体地址（选填）">
          <el-input v-model="freeNodeForm.url" placeholder="可粘贴已有素材地址；本地文件请使用右键“上传”" />
        </el-form-item>
        <el-form-item label="模型">
          <el-select
            v-model="freeNodeForm.model"
            filterable
            allow-create
            default-first-option
            clearable
            placeholder="留空使用系统默认模型"
          >
            <el-option v-for="model in getFreeNodeModelOptions(freeNodeKind)" :key="model" :label="model" :value="model" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="['image', 'video'].includes(freeNodeKind)" label="画面比例">
          <el-select v-model="freeNodeForm.aspectRatio" placeholder="选择比例">
            <el-option label="16:9" value="16:9" />
            <el-option label="9:16" value="9:16" />
            <el-option label="1:1" value="1:1" />
            <el-option label="4:3" value="4:3" />
            <el-option label="3:4" value="3:4" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="freeNodeKind === 'video'" label="视频时长(秒)">
          <el-input-number v-model="freeNodeForm.duration" :min="1" :max="30" :step="1" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="freeNodeDialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!freeNodeForm.title.trim()" @click="submitFreeNode">
          {{ freeNodeEditingId ? '保存修改' : '添加到画布' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { MoreFilled, Operation, Plus, RefreshLeft, RefreshRight, Share } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import { dramaAPI } from '@/api/drama'
import { assetsAPI } from '@/api/assets'
import { imagesAPI } from '@/api/images'
import { imageToolsAPI } from '@/api/imageTools'
import { taskAPI } from '@/api/task'
import { storyboardsAPI } from '@/api/storyboards'
import { characterAPI } from '@/api/characters'
import { videosAPI } from '@/api/videos'
import { uploadAPI } from '@/api/upload'
import { addTenantMember, listTenantMembers } from '@/api/tenants'
import request from '@/utils/request'
import { readCurrentTenantId } from '@/utils/authSession'
import { runAudioStep, runImageStep, runVideoStep, runWorkflowGroup } from '@/composables/useCanvasWorkflowRunner'
import { generateAssetReferenceImage } from '@/composables/useCanvasAssetGenerate'
import { CANVAS_CONTEXT_KEY } from '@/composables/useCanvasContext'
import { useCanvasStoryboardMedia } from '@/composables/useCanvasStoryboardMedia'
import { useCanvasCrud } from '@/composables/useCanvasCrud'
import { useCanvasEpisodeGenerate } from '@/composables/useCanvasEpisodeGenerate'
import { useCanvasScript, scriptNodeId } from '@/composables/useCanvasScript'
import {
  CANVAS_NODE_STATUS_LABELS,
  createCanvasNodeStatusStore,
} from '@/composables/useCanvasNodeStatus'
import {
  applyCanvasHighlight,
  buildDramaCanvasGraph,
  computeAutoLayoutPositions,
  getStoryboardRefFromNode,
  stampEdgeBaseStyles,
} from '@/utils/dramaCanvasAdapter'
import { virtualizeCanvasGraph } from '@/utils/canvasVirtualization'
import {
  buildCanvasLayoutPayload,
  parseCanvasLayout,
  parseDramaMetadata,
  resizeCanvasGroupsAroundMember,
  resolveViewport,
  translateCanvasGroupChildren,
} from '@/utils/canvasLayout'
import {
  buildFreeCanvasGenerationRequest,
  buildFreeCanvasProjectAssetPayload,
  collectDirectUpstreamImageReferences,
  collectDirectUpstreamTextInputs,
  getFreeCanvasNodeResultUrl,
  resolveFreeCanvasResultUrl,
} from '@/utils/freeCanvasGeneration'
import {
  canvasModelServiceType,
  canvasNodeKind,
  resolveCanvasNodeConnection,
  toLibTvCanvasEdge,
} from '@/utils/canvasNodeContracts'
import { buildCanvasExecutionPlan } from '@/utils/canvasExecutionPlan'
import { canvasModelCapability, estimateCanvasCredits, normalizeCanvasModelCatalog } from '@/utils/canvasModelCapabilities'
import {
  commitCanvasInteractionHistory,
  createCanvasInteractionHistory,
  createCanvasInteractionState,
  redoCanvasInteractionHistory,
  undoCanvasInteractionHistory,
} from '@/utils/canvasInteractionHistory'
import {
  canvasConnectionInteractionOptions,
  resolveCanvasConnectionDrop,
} from '@/utils/canvasConnectionInteraction'
import { createCanvasLayoutPersistence } from '@/utils/canvasLayoutPersistence'
import { calculateCanvasKeyboardPanDelta, isCanvasKeyboardPanKey } from '@/utils/canvas-keyboard-pan'
import {
  mergeGenerationHistory,
  normalizeGenerationHistory,
} from '@/utils/canvasPersistedState'
import {
  DEFAULT_CANVAS_PREFERENCES,
  normalizeCanvasPreferences,
  resolveCanvasEdgePalette,
  resolveCanvasSimplePalette,
  resolveCanvasTheme,
} from '@/utils/canvasSettings'
import {
  canAlignCanvasNodes,
  computeStandaloneAutoLayoutPositions,
  computeStandaloneNodePosition,
} from '@/utils/canvasStandaloneLayout'
import { assetImageUrl, assetMediaUrl, audioUrl } from '@/utils/mediaUrl'
import { getSelectableModelsAcrossConfigs } from '@/utils/modelSelection'
import {
  imageRecordUrl,
  resolveSbFirstImageRecord,
  resolveSbLastImageRecord,
  resolveSbMainImageRecord,
  resolveSbVideoRecord,
  videoRecordUrl,
} from '@/utils/storyboardMedia'
import {
  createWorkflowGroup,
  deleteWorkflowGroup,
  findStoryboardInDrama,
  getAdjacentStoryboards,
  normalizePipeline,
  parseWorkflowGroups,
  removeStoryboardFromWorkflowGroup,
  reorderWorkflowGroup,
  storyboardIdFromNodeId,
  getDramaGenerationOptions,
  getStoryboardVideoModel,
} from '@/utils/canvasWorkflow'
import { canChainStoryboardFrames } from '@/utils/videoContinuity'
import {
  appendVoicePromptToVideoPrompt,
  buildStoryboardVoiceSnapshot,
  classifyVideoVoicePolicy,
} from '@/utils/videoVoicePolicy'
import {
  filterCanvasAssets,
  getCanvasEpisodeContext,
  isCanvasAssetVisible,
} from '@/utils/canvasEpisodeContext'
import { shouldProjectCanvasAsset } from '@/utils/canvasAssetProjection'
import { findVisualDirectionDirectorEntry } from '@/utils/visualDirectionDirectorBridge'

import CanvasLabelNode from '@/components/dramaCanvas/CanvasLabelNode.vue'
import CanvasDramaHeaderNode from '@/components/dramaCanvas/CanvasDramaHeaderNode.vue'
import CanvasAssetNode from '@/components/dramaCanvas/CanvasAssetNode.vue'
import CanvasEpisodeNode from '@/components/dramaCanvas/CanvasEpisodeNode.vue'
import CanvasScriptNode from '@/components/dramaCanvas/CanvasScriptNode.vue'
import CanvasStoryboardNode from '@/components/dramaCanvas/CanvasStoryboardNode.vue'
import CanvasMediaNode from '@/components/dramaCanvas/CanvasMediaNode.vue'
import CanvasProjectAssetNode from '@/components/dramaCanvas/CanvasProjectAssetNode.vue'
import HomeCanvasNode from '@/components/dramaCanvas/HomeCanvasNode.vue'
import CanvasGroupNode from '@/components/dramaCanvas/CanvasGroupNode.vue'
import LibTvCanvasEdge from '@/components/dramaCanvas/LibTvCanvasEdge.vue'
import CanvasCreateDialog from '@/components/dramaCanvas/CanvasCreateDialog.vue'
import CanvasContextMenu from '@/components/dramaCanvas/CanvasContextMenu.vue'
import CanvasAddButtonNode from '@/components/dramaCanvas/CanvasAddButtonNode.vue'
import CanvasFloatingToolbar from '@/components/dramaCanvas/CanvasFloatingToolbar.vue'
import CanvasSelectionToolbar from '@/components/dramaCanvas/CanvasSelectionToolbar.vue'
import CanvasFlowAligner from '@/components/dramaCanvas/CanvasFlowAligner.vue'
import CanvasDirectorStage from '@/components/dramaCanvas/CanvasDirectorStage.vue'
import CanvasGenerationOptions from '@/components/dramaCanvas/CanvasGenerationOptions.vue'
import CanvasWorkflowOrderPanel from '@/components/dramaCanvas/CanvasWorkflowOrderPanel.vue'
import CanvasCuttableEdge from '@/components/dramaCanvas/CanvasCuttableEdge.vue'
import CanvasWorkspaceSwitcher from '@/components/CanvasWorkspaceSwitcher.vue'
import PlatformPrimaryNav from '@/components/PlatformPrimaryNav.vue'
import CanvasModeSwitch from '@/components/CanvasModeSwitch.vue'
import AssetPickerDialog from '@/components/AssetPickerDialog.vue'

const route = useRoute()
const router = useRouter()
const isStandaloneCanvas = computed(() => route.name === 'standalone-canvas')
const { imagesBySbId, videosBySbId, loadForDrama } = useCanvasStoryboardMedia()

const loading = ref(false)
const drama = ref(null)
const nodes = ref([])
const edges = ref([])
const allGraphNodes = ref([])
const allGraphEdges = ref([])
const suppressedEdgeIds = ref(new Set())
const projectImageAssets = ref([])
const storyboardAssignedAssets = ref({})
const canvasVirtualized = ref(false)
const filterEpisodeId = ref(null)
const highlightAssetId = ref(null)
const layoutCache = ref(null)
const workflowGroups = ref([])
const activeGroupId = ref(null)
const selectedStoryboardIds = ref([])
const selectedFreeNodeIds = ref([])
const selectionModifierActive = ref(false)
const marqueeSelectionActive = ref(false)
const pipelineSteps = ref(['image', 'video', 'audio'])
const workflowRunning = ref(false)
const workflowProgress = ref('')
const generationOverrides = ref({})
const layoutSaveState = ref('idle')
const layoutDirty = ref(false)
const layoutPersistence = createCanvasLayoutPersistence(({ canvasLayout, workflowGroups }) => (
  dramaAPI.saveCanvasLayout(dramaId.value, canvasLayout, workflowGroups)
))
let canvasPersistQueue = Promise.resolve()
const freeCanvasAssetSaveFlights = new Map()
const freeCanvasTaskResumeFlights = new Map()
const currentViewport = ref({ x: 0, y: 0, zoom: 0.75 })
const focusedNodeId = ref(null)
const sidebarVisible = ref(false)
const showWorkflowPanel = ref(false)
const directorStageVisible = ref(false)
const canvasPreferences = ref(normalizeCanvasPreferences())
const canvasGridVisible = computed({
  get: () => canvasPreferences.value.grid_visible,
  set: (value) => { canvasPreferences.value.grid_visible = Boolean(value) },
})
const canvasMiniMapVisible = computed({
  get: () => canvasPreferences.value.minimap_visible,
  set: (value) => { canvasPreferences.value.minimap_visible = Boolean(value) },
})
const canvasSnapEnabled = computed({
  get: () => canvasPreferences.value.snap_enabled,
  set: (value) => { canvasPreferences.value.snap_enabled = Boolean(value) },
})
const alignmentGuide = ref({ x: null, y: null })
const activeCanvasTheme = computed(() => resolveCanvasTheme(canvasPreferences.value))
const activeCanvasEdgePalette = computed(() => resolveCanvasEdgePalette(canvasPreferences.value))
const activeCanvasSimplePalette = computed(() => resolveCanvasSimplePalette(canvasPreferences.value))
const canvasVisualStyle = computed(() => {
  const simpleColors = activeCanvasSimplePalette.value.colors || []
  return {
    '--canvas-theme-background': activeCanvasTheme.value.bg,
    '--canvas-panel-background': activeCanvasTheme.value.panel,
    '--canvas-edge-color': activeCanvasEdgePalette.value.base,
    '--canvas-edge-focus-color': activeCanvasEdgePalette.value.focus,
    '--canvas-edge-width': `${canvasPreferences.value.edge_width}px`,
    '--canvas-edge-focus-radius': `${canvasPreferences.value.edge_focus_radius}px`,
    ...Object.fromEntries(simpleColors.map((color, index) => [`--canvas-simple-${index + 1}`, color])),
  }
})
const canvasBackgroundStyle = computed(() => {
  const mode = canvasPreferences.value.background_mode
  return {
    backgroundImage: `url(${JSON.stringify(canvasPreferences.value.background_url)})`,
    backgroundPosition: 'center',
    backgroundRepeat: mode === 'repeat' ? 'repeat' : 'no-repeat',
    backgroundSize: mode === 'repeat'
      ? `${canvasPreferences.value.background_tile_size}% auto`
      : mode,
    filter: `blur(${canvasPreferences.value.background_blur}px)`,
    opacity: canvasPreferences.value.background_opacity,
  }
})
const canvasBackgroundCandidates = computed(() => {
  const candidates = new Map()
  const add = (url, label) => {
    const normalizedUrl = String(url || '').trim()
    if (normalizedUrl && !candidates.has(normalizedUrl)) candidates.set(normalizedUrl, { url: normalizedUrl, label })
  }
  for (const node of allGraphNodes.value) {
    add(getFreeCanvasNodeResultUrl(node), node.data?.title || node.data?.label || '画布图片')
    add(node.data?.imageUrl || node.data?.image_url || node.data?.thumbnailUrl, node.data?.title || '画布图片')
  }
  for (const asset of projectImageAssets.value) {
    add(assetImageUrl(asset), asset.name || asset.title || '项目图片')
  }
  return [...candidates.values()].slice(0, 40)
})
const persistedGenerationHistory = ref([])
const directorStageEntry = ref(null)
const DIRECTOR_STAGE_ENTRY_MODES = new Set(['director_stage', 'lighting', 'angle', 'pose', 'visual_direction'])
const canvasVisualDirectionEntry = computed(() => findVisualDirectionDirectorEntry(allGraphNodes.value))
let directorReturnFocus = null
const canvasMainRef = ref(null)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuFlowPos = ref(null)
const contextMenuNode = ref(null)
const contextMenuConnectionSource = ref(null)
const connectionDragState = ref(null)
const canvasAssetPickerVisible = ref(false)
const canvasAssetPickerFlowPos = ref(null)
const canvasAssetPickerRetryNodeId = ref('')
const canvasAssetPickerTargetStoryboardId = ref(null)
const canvasAssetPickerTargetFreeNodeId = ref('')
const canvasAssetFailureNodes = ref([])
const canvasUploadInput = ref(null)
const canvasUploadFlowPos = ref(null)
const CANVAS_MEDIA_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.mp4,.mov,.m4a,.m4b,.webm,.wav,.mp3,.ogg,.oga,.flac,.aac'
const CANVAS_IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp'
const CANVAS_VIDEO_ACCEPT = '.mp4,.mov,.webm'
const CANVAS_AUDIO_ACCEPT = '.m4a,.m4b,.webm,.wav,.mp3,.ogg,.oga,.flac,.aac'
const canvasUploadAccept = ref(CANVAS_MEDIA_ACCEPT)
const freeNodeDialogVisible = ref(false)
const collaborationDialogVisible = ref(false)
const collaborationMembers = ref([])
const collaborationLoading = ref(false)
const collaborationInviteLoading = ref(false)
const collaborationForm = ref({ email: '', role: 'member' })
const currentTenantId = computed(() => readCurrentTenantId() || '')
const canvasShareLink = computed(() => (typeof window === 'undefined' ? '' : window.location.href))
const freeNodeKind = ref('text')
const freeNodeEditingId = ref('')
const freeNodeFlowPosition = ref(null)
const freeNodeForm = ref({ title: '', content: '', url: '', model: '', aspectRatio: '16:9', duration: 5 })
const FREE_CANVAS_DEFAULTS_STORAGE_KEY = 'moli_canvas_free_node_defaults'
const FREE_CANVAS_GENERATION_HISTORY_LIMIT = 20
const freeCanvasModelConfigs = ref([])
const freeCanvasModelCatalog = ref([])
const freeCanvasVoiceOptions = ref([])
let freeCanvasModelConfigsLoaded = false
let freeCanvasVoiceOptionsLoaded = false
const savingQueueAssetKey = ref('')
const dismissedRunQueueItems = ref([])
const paneClickSuppressed = ref(false)
const spacePanning = ref(false)
const nodeStatus = createCanvasNodeStatusStore()
const aligningNodes = ref(false)
const canvasFlowApi = ref(null)
const NODE_STATUS_STORAGE_PREFIX = 'moli_canvas_node_status'
const interactionHistory = ref(createCanvasInteractionHistory(createCanvasInteractionState()))
const dragHistorySnapshot = ref(null)
const FREE_NODE_KINDS = new Set(['text', 'image', 'video', 'audio'])

function loadFreeCanvasNodeDefaults() {
  const fallback = {
    text: { model: '' },
    image: { model: '', aspectRatio: '16:9', resolution: '2K' },
    video: { model: '', aspectRatio: '16:9', duration: 5, resolution: '720p' },
    audio: { model: '' },
  }
  try {
    const stored = JSON.parse(localStorage.getItem(FREE_CANVAS_DEFAULTS_STORAGE_KEY) || '{}')
    return Object.fromEntries(
      Object.entries(fallback).map(([kind, defaults]) => [kind, { ...defaults, ...(stored?.[kind] || {}) }])
    )
  } catch {
    return fallback
  }
}

function persistFreeCanvasNodeDefaults(kind, data) {
  if (!FREE_NODE_KINDS.has(kind)) return
  const defaults = loadFreeCanvasNodeDefaults()
  const allowedKeys = kind === 'video'
    ? ['model', 'aspectRatio', 'duration', 'resolution']
    : kind === 'image'
      ? ['model', 'aspectRatio', 'resolution']
      : ['model']
  const next = { ...defaults[kind] }
  allowedKeys.forEach((key) => {
    if (data?.[key] !== undefined && data?.[key] !== '') next[key] = data[key]
  })
  try {
    localStorage.setItem(FREE_CANVAS_DEFAULTS_STORAGE_KEY, JSON.stringify({ ...defaults, [kind]: next }))
  } catch {
    // 浏览器禁用本地存储时仍允许正常编辑和运行节点。
  }
}

function getFreeNodeModelOptions(kind) {
  const catalogModels = freeCanvasModelCatalog.value.filter((item) => item.kind === kind).map((item) => item.model)
  if (catalogModels.length) return catalogModels
  const serviceType = canvasModelServiceType(kind)
  return serviceType ? getSelectableModelsAcrossConfigs(freeCanvasModelConfigs.value, serviceType) : []
}

function getFreeNodeModelCapability(kind, model) {
  return canvasModelCapability(freeCanvasModelCatalog.value, kind, model)
}

function getFreeNodeEstimatedCredits(kind, model, quantity, duration) {
  return estimateCanvasCredits(freeCanvasModelCatalog.value, kind, model, quantity, duration)
}

async function loadFreeCanvasModelConfigs() {
  if (freeCanvasModelConfigsLoaded) return
  const catalog = await request.get('/canvas/model-catalog').catch(() => [])
  freeCanvasModelCatalog.value = normalizeCanvasModelCatalog(
    Array.isArray(catalog) ? catalog : []
  )
  freeCanvasModelConfigs.value = []
  freeCanvasModelConfigsLoaded = true
}

async function loadFreeCanvasVoiceOptions() {
  if (freeCanvasVoiceOptionsLoaded || !isStandaloneCanvas.value || !dramaId.value) return
  try {
    const catalog = await characterAPI.listBuiltinVoices(dramaId.value)
    const items = Array.isArray(catalog) ? catalog : (catalog?.items || [])
    freeCanvasVoiceOptions.value = items.map((voice) => ({
      label: voice.label || voice.name || voice.voice_id || voice.id,
      value: voice.voice_id || voice.id,
    })).filter((voice) => voice.value)
    freeCanvasVoiceOptionsLoaded = true
  } catch (error) {
    console.warn('load free canvas voice options failed', error)
  }
}

const freeNodeKindLabel = computed(() => ({
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
}[freeNodeKind.value] || '自由'))
const freeNodeTitlePlaceholder = computed(() => ({
  text: '例如：第一幕故事设定',
  image: '例如：雨夜街道首帧',
  video: '例如：主角走入车站',
  audio: '例如：车站环境音',
}[freeNodeKind.value] || '输入节点标题'))
const freeNodeContentPlaceholder = computed(() => (
  freeNodeKind.value === 'text'
    ? '输入文本、脚本或创作要求'
    : `描述希望生成的${freeNodeKindLabel.value}内容`
))

function openDirectorStage(entryContext = null) {
  directorReturnFocus = document.activeElement
  const resolvedEntry = DIRECTOR_STAGE_ENTRY_MODES.has(entryContext?.mode)
    ? entryContext
    : canvasVisualDirectionEntry.value
  directorStageEntry.value = DIRECTOR_STAGE_ENTRY_MODES.has(resolvedEntry?.mode)
    ? resolvedEntry.mode === 'visual_direction'
      ? {
          mode: resolvedEntry.mode,
          sourceNodeId: String(resolvedEntry.sourceNodeId || ''),
          sourceTitle: String(resolvedEntry.sourceTitle || '视觉导演方案'),
          provenance: resolvedEntry.provenance || null,
          visualDirection: resolvedEntry.visualDirection || null,
          skillSnapshot: resolvedEntry.skillSnapshot || null,
        }
      : {
          mode: resolvedEntry.mode,
          imageUrl: String(resolvedEntry.imageUrl || ''),
          sourceNodeId: String(resolvedEntry.sourceNodeId || ''),
          sourceTitle: String(resolvedEntry.sourceTitle || '图片节点'),
        }
    : null
  directorStageVisible.value = true
}

async function closeDirectorStage() {
  directorStageVisible.value = false
  directorStageEntry.value = null
  await nextTick()
  directorReturnFocus?.focus?.()
  directorReturnFocus = null
}

const PANEL_NODE_TYPES = new Set(['canvasStoryboard', 'canvasMedia', 'canvasAsset', 'canvasScript', 'canvasProjectAsset'])

const contextMenuNodeLabel = computed(() => canvasNodeLabel(contextMenuNode.value))
const contextMenuNodeActions = computed(() => canvasNodeActions(contextMenuNode.value))
const canvasAssetPickerType = computed(() => (
  freeCanvasNodeById(canvasAssetPickerTargetFreeNodeId.value)?.data?.kind || 'all'
))
const canvasAssetPickerTitle = computed(() => (
  canvasAssetPickerTargetFreeNodeId.value ? '挂载素材到当前节点' : '从素材库加入画布'
))

let saveTimer = null
let savedHintTimer = null
let pollTimer = null
let paneClickSuppressTimer = null
let virtualizationFrame = null
let runQueueTimer = null
let canvasKeyboardPanFrame = null
let canvasKeyboardPanLastTimestamp = null
let canvasKeyboardPanMoved = false
const pressedCanvasPanKeys = new Set()

const nodeTypes = {
  canvasLabel: markRaw(CanvasLabelNode),
  canvasDramaHeader: markRaw(CanvasDramaHeaderNode),
  canvasAsset: markRaw(CanvasAssetNode),
  canvasEpisode: markRaw(CanvasEpisodeNode),
  canvasScript: markRaw(CanvasScriptNode),
  canvasStoryboard: markRaw(CanvasStoryboardNode),
  canvasMedia: markRaw(CanvasMediaNode),
  canvasProjectAsset: markRaw(CanvasProjectAssetNode),
  canvasAddButton: markRaw(CanvasAddButtonNode),
  homeCanvasNode: markRaw(HomeCanvasNode),
  canvasGroup: markRaw(CanvasGroupNode),
}
const dramaId = computed(() => Number(route.params.id))
const savedLayout = computed(() => layoutCache.value || parseCanvasLayout(drama.value?.metadata))
const directorTimeline = computed(() => savedLayout.value?.director_timeline || null)
const visibleStoryboardIds = computed(() => new Set(
  nodes.value
    .filter((node) => node.type === 'canvasStoryboard' && node.data?.storyboard?.id)
    .map((node) => Number(node.data.storyboard.id))
))

const initialViewport = computed(() => {
  const v = resolveViewport(savedLayout.value)
  return { x: v.x, y: v.y, zoom: v.zoom }
})

const hasSavedViewport = computed(() => Boolean(savedLayout.value?.viewport))
const activeWorkflowGroup = computed(() => (
  workflowGroups.value.find((group) => group.id === activeGroupId.value) || null
))
const canUndo = computed(() => interactionHistory.value.past.length > 0)
const canRedo = computed(() => interactionHistory.value.future.length > 0)

function nodeStatusStorageKey() {
  return Number.isFinite(dramaId.value) && dramaId.value > 0
    ? `${NODE_STATUS_STORAGE_PREFIX}:${dramaId.value}`
    : ''
}

function restoreNodeStatusSnapshot() {
  const key = nodeStatusStorageKey()
  nodeStatus.restore({})
  if (!key || typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(key)
    if (raw) {
      nodeStatus.restore(JSON.parse(raw))
      void syncRestoredNodeTasks()
    }
  } catch {
    window.localStorage.removeItem(key)
  }
}

function persistNodeStatusSnapshot() {
  const key = nodeStatusStorageKey()
  if (!key || typeof window === 'undefined') return
  const snapshot = nodeStatus.snapshot()
  try {
    if (Object.keys(snapshot).length) window.localStorage.setItem(key, JSON.stringify(snapshot))
    else window.localStorage.removeItem(key)
  } catch {
    // localStorage may be unavailable or full; node overlays can still work in memory.
  }
}

function isRestoredPendingNodeStatus(status) {
  return Boolean(status?.restored && status?.taskId && !['failed', 'success'].includes(status.step))
}

function taskResultObject(task) {
  const raw = task?.result
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) || {}
    } catch {
      return {}
    }
  }
  return typeof raw === 'object' ? raw : {}
}

function taskResultUrl(task) {
  const result = taskResultObject(task)
  const response = result.response || result.data || {}
  return result.video_url
    || result.image_url
    || result.audio_url
    || result.url
    || response.video_url
    || response.image_url
    || response.audio_url
    || response.url
    || ''
}

function firstTaskResultValue(result, response, fields) {
  for (const field of fields) {
    const value = result?.[field] ?? response?.[field]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return ''
}

function taskSavedAssetInfo(task) {
  const result = taskResultObject(task)
  const response = result.response || result.data || {}
  const asset = result.asset
    || result.saved_asset
    || result.savedAsset
    || response.asset
    || response.saved_asset
    || response.savedAsset
    || {}
  const savedAssetId = asset.id || firstTaskResultValue(result, response, [
    'savedAssetId',
    'saved_asset_id',
    'assetId',
    'asset_id',
  ])
  if (!savedAssetId) return null
  const savedAssetUrl = asset.url
    || asset.asset_url
    || asset.display_url
    || asset.preview_url
    || firstTaskResultValue(result, response, [
      'savedAssetUrl',
      'saved_asset_url',
      'asset_url',
      'display_url',
      'preview_url',
      'url',
    ])
  return {
    savedAssetId,
    savedAssetName: asset.name || firstTaskResultValue(result, response, [
      'savedAssetName',
      'saved_asset_name',
      'assetName',
      'asset_name',
    ]) || '素材',
    savedAssetUrl: savedAssetUrl || '',
    savedAssetLocalPath: asset.local_path || firstTaskResultValue(result, response, [
      'savedAssetLocalPath',
      'saved_asset_local_path',
      'local_path',
    ]) || '',
    savedAssetDuration: asset.duration
      ?? result.savedAssetDuration
      ?? result.saved_asset_duration
      ?? response.savedAssetDuration
      ?? response.saved_asset_duration
      ?? null,
  }
}

function taskRequestPayload(task, status) {
  const result = taskResultObject(task)
  const response = result.response || result.data || {}
  return status?.requestPayload
    || result.requestPayload
    || result.request_payload
    || result.payload
    || response.requestPayload
    || response.request_payload
    || response.payload
    || null
}

function taskRequestAudit(task, status) {
  const result = taskResultObject(task)
  const response = result.response || result.data || {}
  return status?.requestAudit
    || result.requestAudit
    || result.request_audit
    || response.requestAudit
    || response.request_audit
    || null
}

function restoredNodeStoryboardId(node, status) {
  return Number(status?.storyboardId || storyboardForNode(node)?.id || storyboardIdFromNodeId(node?.id)) || null
}

function restoredTaskResultInfo(node, status, task, resultUrl) {
  const step = status?.retryStep || status?.step || ''
  const storyboardId = restoredNodeStoryboardId(node, status)
  const storyboard = storyboardForNode(node)
  const base = storyboardId ? nodeStepResultInfo(node, step, storyboardId, storyboard) : {}
  const result = taskResultObject(task)
  const response = result.response || result.data || {}
  const savedAssetInfo = taskSavedAssetInfo(task) || {}
  return {
    ...base,
    resultUrl,
    resultType: status?.resultType || base.resultType || (['image', 'video', 'audio'].includes(step) ? step : ''),
    resultNodeId: status?.resultNodeId || base.resultNodeId || node?.id || '',
    resultLabel: status?.resultLabel || base.resultLabel || result.label || '结果已生成',
    promptText: status?.promptText || result.prompt || '',
    savedAssetId: status?.savedAssetId || savedAssetInfo.savedAssetId || '',
    savedAssetName: status?.savedAssetName || savedAssetInfo.savedAssetName || '',
    savedAssetUrl: status?.savedAssetUrl || savedAssetInfo.savedAssetUrl || '',
    savedAssetLocalPath: status?.savedAssetLocalPath || savedAssetInfo.savedAssetLocalPath || '',
    savedAssetDuration: status?.savedAssetDuration ?? savedAssetInfo.savedAssetDuration ?? null,
    requestPayload: taskRequestPayload(task, status),
    requestAudit: taskRequestAudit(task, status),
    model: status?.model || result.model || response.model || '',
    videoGenerationId: status?.videoGenerationId || result.videoGenerationId || result.video_generation_id || response.videoGenerationId || response.video_generation_id || null,
  }
}

async function syncRestoredNodeTasks() {
  const entries = Object.entries(nodeStatus.map).filter(([, status]) => isRestoredPendingNodeStatus(status))
  for (const [nodeId, status] of entries) {
    try {
      const task = await taskAPI.get(status.taskId)
      if (task?.status === 'completed') {
        const node = findGraphNode(status.sourceNodeId || nodeId) || findGraphNode(nodeId) || { id: nodeId, data: {} }
        const resultUrl = taskResultUrl(task) || status.resultUrl || status.savedAssetUrl || ''
        const storyboardId = restoredNodeStoryboardId(node, status)
        const resultInfo = restoredTaskResultInfo(node, status, task, resultUrl)
        const savedAssetInfo = !status.savedAssetId && !resultInfo.savedAssetId && resultUrl && storyboardId
          ? await saveNodeResultAsset(node, resultInfo, resultInfo.promptText || '', storyboardId)
          : null
        if (savedAssetInfo && resultInfo.resultType === 'image') await loadProjectImageAssets()
        nodeStatus.success(nodeId, {
          ...status,
          ...resultInfo,
          ...(savedAssetInfo || {}),
          message: '恢复的任务已完成',
          autoClear: false,
        })
      } else if (task?.status === 'failed') {
        const message = task?.error?.message || task?.error || '恢复的任务已失败'
        nodeStatus.fail(nodeId, {
          ...status,
          message,
          errorDetail: message,
          retryStep: status.retryStep || status.step,
          retryLabel: status.retryLabel || `重试${CANVAS_NODE_STATUS_LABELS[status.retryStep || status.step] || '节点'}`,
          recoverable: true,
        })
      }
    } catch {
      // 任务回读失败时保持恢复态，避免误清除用户可重试信息。
    }
  }
  if (entries.length) {
    try {
      await refreshDrama(true)
    } catch {
      // 恢复任务刷新失败时保留当前节点状态，等待用户手动刷新或重试。
    }
  }
}
const allStoryboards = computed(() => {
  const list = []
  for (const episode of drama.value?.episodes || []) {
    for (const storyboard of episode.storyboards || []) {
      list.push({
        ...storyboard,
        episode_title: episode.title || `第${episode.episode_number || 0}集`,
      })
    }
  }
  return list
})
const episodeContext = computed(() => getCanvasEpisodeContext(drama.value, filterEpisodeId.value))
const selectedEpisodeLabel = computed(() => {
  const episode = episodeContext.value.episode
  return episode?.title || `第${episode?.episode_number || 0}集`
})
const sidebarCharacters = computed(() => filterCanvasAssets(drama.value?.characters, 'character', episodeContext.value))
const sidebarScenes = computed(() => filterCanvasAssets(drama.value?.scenes, 'scene', episodeContext.value))
const sidebarProps = computed(() => filterCanvasAssets(drama.value?.props, 'prop', episodeContext.value))
const queueNow = ref(Date.now())
const liveRunQueueItems = computed(() => {
  const grouped = new Map()
  const seen = new Set()
  for (const [nodeId, status] of Object.entries(nodeStatus.map)) {
    if (!nodeId || !status) continue
    const key = `active:${queueStatusRunKey(nodeId, status)}`
    const isFailed = status.step === 'failed'
    const isSuccess = status.step === 'success'
    const sourceNodeId = status.sourceNodeId || nodeId
    seen.add(nodeId)
    mergeRunQueueItem(grouped, {
      key,
      nodeId: sourceNodeId,
      statusIds: [nodeId],
      tone: isFailed ? 'failed' : isSuccess ? 'success' : 'running',
      label: queueNodeLabel(sourceNodeId),
      message: isFailed
        ? (status.message || '节点执行失败')
        : isSuccess
          ? queueSuccessMessage(status)
          : queueRunningMessage(status),
      elapsedText: formatQueueElapsed(status.at),
      retryStep: isFailed ? (status.retryStep || queueNodeRetryStep(findGraphNode(sourceNodeId))) : '',
      resultUrl: statusResultUrl(status),
      resultNodeId: status.resultNodeId || resultNodeIdFromStatus(findGraphNode(sourceNodeId), status) || '',
      resultType: status.resultType || '',
      resultLabel: status.resultLabel || '',
      resultSummary: status.resultSummary || '',
      resultReferences: Array.isArray(status.resultReferences) ? status.resultReferences : [],
      promptText: status.promptText || '',
      storyboardId: status.storyboardId || storyboardIdFromNodeId(sourceNodeId) || '',
      model: status.model || '',
      taskId: status.taskId || '',
      videoGenerationId: status.videoGenerationId || '',
      requestPayload: status.requestPayload || null,
      requestAudit: status.requestAudit || null,
      savedAssetId: status.savedAssetId || '',
      savedAssetName: status.savedAssetName || '',
      savedAssetUrl: status.savedAssetUrl || '',
      savedAssetLocalPath: status.savedAssetLocalPath || '',
      savedAssetDuration: status.savedAssetDuration ?? null,
      errorDetail: isFailed ? (status.errorDetail || status.detail || status.message || '') : '',
      actionError: status.actionError || '',
      retryAction: status.retryAction || '',
      retryActionLabel: status.retryActionLabel || '',
      attachedSlot: status.attachedSlot || '',
      at: status.at,
    })
  }
  for (const node of allGraphNodes.value) {
    const failure = queueNodeFailure(node)
    if (!failure || seen.has(String(node.id))) continue
    seen.add(String(node.id))
    mergeRunQueueItem(grouped, {
      key: `failed:${node.id}`,
      nodeId: node.id,
      statusIds: [node.id],
      tone: 'failed',
      label: canvasNodeLabel(node),
      message: failure,
      retryStep: queueNodeRetryStep(node),
      errorDetail: failure,
    })
  }
  return Array.from(grouped.values())
})
const runQueueItems = computed(() => {
  const grouped = new Map()
  liveRunQueueItems.value.forEach((item) => mergeRunQueueItem(grouped, item))
  persistedGenerationHistory.value.forEach((item) => mergeRunQueueItem(grouped, {
    ...item,
    elapsedText: formatQueueElapsed(item.at),
  }))
  return Array.from(grouped.values())
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, 8)
})
const canvasNodeLocatorItems = computed(() => allGraphNodes.value
  .filter((node) => node?.type !== 'canvasAddButton')
  .map((node) => ({
    id: String(node.id),
    label: canvasNodeLabel(node),
    type: node.type || '',
  })))
const runningQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'running').length)
const successQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'success').length)
const failedQueueCount = computed(() => runQueueItems.value.filter((item) => item.tone === 'failed').length)
const dismissedRunQueueCount = computed(() => dismissedRunQueueItems.value.length)

function queueNodeLabel(nodeId) {
  const node = findGraphNode(nodeId)
  if (node) return canvasNodeLabel(node)
  const sbId = storyboardIdFromNodeId(nodeId)
  return sbId ? `分镜 #${sbId}` : String(nodeId)
}

function queueStatusRunKey(nodeId, status) {
  return status?.runKey || `node:${nodeId}`
}

function queueToneRank(tone) {
  if (tone === 'failed') return 3
  if (tone === 'running') return 2
  if (tone === 'success') return 1
  return 0
}

function mergeRunQueueItem(grouped, item) {
  const current = grouped.get(item.key)
  if (!current) {
    grouped.set(item.key, item)
    return
  }
  current.statusIds = [...new Set([...(current.statusIds || []), ...(item.statusIds || [])])]
  if (!findGraphNode(current.nodeId) && findGraphNode(item.nodeId)) current.nodeId = item.nodeId
  if (!current.resultUrl && item.resultUrl) current.resultUrl = item.resultUrl
  if (!current.resultNodeId && item.resultNodeId) current.resultNodeId = item.resultNodeId
  if (!current.resultType && item.resultType) current.resultType = item.resultType
  if (!current.resultLabel && item.resultLabel) current.resultLabel = item.resultLabel
  if (!current.resultSummary && item.resultSummary) current.resultSummary = item.resultSummary
  if ((!current.resultReferences || !current.resultReferences.length) && item.resultReferences?.length) current.resultReferences = item.resultReferences
  if (!current.promptText && item.promptText) current.promptText = item.promptText
  if (!current.storyboardId && item.storyboardId) current.storyboardId = item.storyboardId
  if (!current.model && item.model) current.model = item.model
  if (!current.taskId && item.taskId) current.taskId = item.taskId
  if (!current.videoGenerationId && item.videoGenerationId) current.videoGenerationId = item.videoGenerationId
  if (!current.requestPayload && item.requestPayload) current.requestPayload = item.requestPayload
  if (!current.requestAudit && item.requestAudit) current.requestAudit = item.requestAudit
  if (!current.savedAssetId && item.savedAssetId) current.savedAssetId = item.savedAssetId
  if (!current.savedAssetName && item.savedAssetName) current.savedAssetName = item.savedAssetName
  if (!current.savedAssetUrl && item.savedAssetUrl) current.savedAssetUrl = item.savedAssetUrl
  if (!current.savedAssetLocalPath && item.savedAssetLocalPath) current.savedAssetLocalPath = item.savedAssetLocalPath
  if (current.savedAssetDuration == null && item.savedAssetDuration != null) current.savedAssetDuration = item.savedAssetDuration
  if (!current.retryStep && item.retryStep) current.retryStep = item.retryStep
  if (!current.errorDetail && item.errorDetail) current.errorDetail = item.errorDetail
  if (!current.actionError && item.actionError) current.actionError = item.actionError
  if (!current.retryAction && item.retryAction) current.retryAction = item.retryAction
  if (!current.retryActionLabel && item.retryActionLabel) current.retryActionLabel = item.retryActionLabel
  if (!current.attachedSlot && item.attachedSlot) current.attachedSlot = item.attachedSlot
  if (queueToneRank(item.tone) > queueToneRank(current.tone)) {
    current.tone = item.tone
    if (item.message) current.message = item.message
    if (item.elapsedText) current.elapsedText = item.elapsedText
  }
  if (item.tone === current.tone && item.message) current.message = item.message
}

function statusResultUrl(status) {
  if (!status) return ''
  return assetMediaUrl({
    local_path: status.savedAssetLocalPath || '',
    url: status.savedAssetUrl || status.resultUrl || '',
  }) || status.savedAssetUrl || status.resultUrl || ''
}

function queueNodeFailure(node) {
  const data = node?.data || {}
  if (data.generationError) return data.generationError
  const sb = data.storyboard || {}
  if (sb.error_msg || sb.error_message || sb.generation_error) {
    return sb.error_msg || sb.error_message || sb.generation_error
  }
  if (sb.status === 'failed') return '节点任务失败，可定位后重试'
  return ''
}

function queueNodeRetryStep(node) {
  if (!node) return ''
  const id = String(node.id || '')
  const kind = node.data?.kind
  if (id.startsWith('sbimg:') || kind === 'image' || node.data?.frameKind) return 'image'
  if (id.startsWith('sbvid:') || kind === 'video') return 'video'
  if (id.startsWith('sbaud:') || kind === 'audio') return 'audio'
  if (node.type === 'canvasStoryboard') return 'video'
  return ''
}

function queueRunningMessage(status) {
  const elapsed = formatQueueElapsed(status?.at)
  return `${status?.message || '处理中…'} · ${elapsed}，刷新后可恢复查看`
}

function queueSuccessMessage(status) {
  const typeMap = { image: '图片结果可复用', video: '视频结果可复用', audio: '音频结果可复用' }
  return status?.resultLabel || typeMap[status?.resultType] || status?.message || '节点执行完成'
}

function queueResultPreviewType(item) {
  const type = String(item?.resultType || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  const url = String(item?.resultUrl || '').toLowerCase()
  if (/\.(mp4|webm|mov|m4v)(\?|#|$)/.test(url)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|#|$)/.test(url)) return 'audio'
  return 'image'
}

function queueTextResult(item) {
  const text = String(item?.resultSummary || '').trim()
  if (text) return text.slice(0, 80)
  return ''
}

function queueItemTitle(item) {
  const parts = [
    item?.label,
    item?.message,
    item?.actionError ? `动作失败：${item.actionError}` : '',
    item?.errorDetail ? `失败原因：${item.errorDetail}` : '',
    item?.model ? `模型：${item.model}` : '',
    item?.taskId ? `任务：${item.taskId}` : '',
    item?.videoGenerationId ? `生成记录：${item.videoGenerationId}` : '',
    item?.resultUrl ? `结果：${item.resultUrl}` : '',
  ]
  return parts.filter(Boolean).join('\n')
}

function formatQueueElapsed(startedAt) {
  const start = Number(startedAt)
  if (!Number.isFinite(start)) return '刚刚开始'
  const seconds = Math.max(0, Math.floor((queueNow.value - start) / 1000))
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

async function focusQueueItem(item) {
  if (!item?.nodeId) return
  await focusCanvasNodeWithConfig(item.nodeId)
}

async function retryQueueItem(item) {
  if (item?.retryStep === 'library') {
    openCanvasAssetLibraryRetry({
      nodeId: item.nodeId || '',
      status: item,
      message: '请在素材库中重新选择素材…',
    })
    return
  }
  const node = findGraphNode(item?.nodeId)
  if (!node || !item?.retryStep) {
    ElMessage.warning('未找到可重试节点')
    return
  }
  await focusCanvasNode(item.nodeId)
  await runCanvasNodeStep(node, item.retryStep)
}

function openQueueItemResult(item) {
  if (!item?.resultUrl) {
    ElMessage.warning('该队列项暂无可打开的结果')
    return
  }
  window.open(item.resultUrl, '_blank', 'noopener,noreferrer')
}

function downloadCanvasResult(url, fallbackName = 'canvas-result') {
  if (!url) return false
  const link = document.createElement('a')
  const rawName = String(url).split(/[?#]/)[0].split('/').pop()
  link.href = url
  link.download = rawName || fallbackName
  link.rel = 'noopener noreferrer'
  document.body.appendChild(link)
  link.click()
  link.remove()
  return true
}

function downloadQueueItemResult(item) {
  if (!downloadCanvasResult(item?.resultUrl, item?.label || 'queue-result')) {
    ElMessage.warning('该队列项暂无可下载的结果')
  }
}

async function copyQueueItemResult(item) {
  if (!item?.resultUrl) {
    ElMessage.warning('该队列项暂无可复制的结果')
    return
  }
  await copyCanvasText(item.resultUrl, '队列结果链接已复制', '队列结果链接（请手动复制）')
}

async function copyQueueItemTextResult(item) {
  const text = String(item?.resultSummary || '').trim()
  if (!text) {
    ElMessage.warning('该队列项暂无可复制的文本结果')
    return
  }
  await copyCanvasText(text, '队列文本结果已复制', '队列文本结果（请手动复制）')
}

async function copyQueueItemResultReferences(item) {
  const references = Array.isArray(item?.resultReferences) ? item.resultReferences.map((value) => String(value || '').trim()).filter(Boolean) : []
  if (!references.length) {
    ElMessage.warning('该队列项暂无可复制的结果引用')
    return
  }
  await copyCanvasText([...new Set(references)].join('\n'), '队列结果引用已复制', '队列结果引用（请手动复制）')
}

function queueItemRequestPayloadText(item) {
  const payload = item?.requestAudit || item?.requestPayload
  if (!payload) return ''
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

async function copyQueueItemRequestPayload(item) {
  const text = queueItemRequestPayloadText(item)
  if (!text) {
    ElMessage.warning('该队列项暂无可复制的真实请求')
    return
  }
  await copyCanvasText(text, '队列真实请求已复制', '队列真实请求（请手动复制）')
}

async function copyQueueItemError(item) {
  const text = item?.errorDetail || item?.message || ''
  if (!text) {
    ElMessage.warning('该队列项暂无失败原因')
    return
  }
  await copyCanvasText(text, '队列失败原因已复制', '队列失败原因（请手动复制）')
}

async function copyQueueItemActionError(item) {
  const text = item?.actionError || ''
  if (!text) {
    ElMessage.warning('该队列项暂无动作失败原因')
    return
  }
  await copyCanvasText(text, '队列动作失败原因已复制', '队列动作失败原因（请手动复制）')
}

async function retryQueueItemAction(item) {
  const node = findGraphNode(item?.nodeId)
  if (!node) {
    ElMessage.warning('未找到可重试节点')
    return
  }
  await focusCanvasNode(item.nodeId)
  await retryNodeFailedAction(node)
}

function queueItemSavedAsset(item) {
  if (!item?.savedAssetId) return null
  return {
    id: item.savedAssetId,
    name: item.savedAssetName || item.label || '队列结果素材',
    type: item.resultType || queueResultPreviewType(item),
    category: 'canvas-result',
    url: item.savedAssetUrl || item.resultUrl || '',
    local_path: item.savedAssetLocalPath || '',
    duration: item.savedAssetDuration ?? undefined,
  }
}

async function copyQueueItemAssetReference(item) {
  const text = assetReferenceText(queueItemSavedAsset(item))
  if (!text) {
    ElMessage.warning('该队列项结果尚未存入素材库')
    return
  }
  await copyCanvasText(text, '队列素材引用已复制', '队列素材引用（请手动复制）')
}

async function assignQueueItemAssetToSelectedStoryboard(item) {
  const asset = queueItemSavedAsset(item)
  if (!asset) {
    ElMessage.warning('该队列项结果尚未存入素材库')
    return
  }
  await assignProjectAssetToSelectedStoryboard(asset)
}

function queueItemReusableReferences(item) {
  const references = Array.isArray(item?.resultReferences)
    ? item.resultReferences.map((value) => String(value || '').trim()).filter(Boolean)
    : []
  const assetRef = assetReferenceText(queueItemSavedAsset(item))
  if (assetRef) references.push(assetRef)
  return [...new Set(references)]
}

function canUseQueueItemAsDownstreamReference(item) {
  return Boolean(
    findGraphNode(item?.nodeId)
    && (item?.resultUrl || queueTextResult(item) || queueItemReusableReferences(item).length)
  )
}

async function useQueueItemAsDownstreamReference(item) {
  const node = findGraphNode(item?.nodeId)
  if (!node) {
    ElMessage.warning('未找到可承接的队列节点')
    return
  }
  try {
    await useNodeResultAsDownstreamReference(node, {
      resultUrl: item.resultUrl || '',
      resultType: item.resultType || (item.resultUrl ? queueResultPreviewType(item) : 'text'),
      savedAssetId: item.savedAssetId || '',
      resultSummary: item.resultSummary || '',
      resultReferences: queueItemReusableReferences(item),
    })
  } catch (error) {
    ElMessage.error(error?.message || '队列结果作为下游参考失败')
  }
}

async function saveQueueItemResultAsset(item) {
  if (!item?.resultUrl) {
    ElMessage.warning('该队列项暂无可入库结果')
    return
  }
  if (savingQueueAssetKey.value) return
  savingQueueAssetKey.value = item.key
  try {
    const node = findGraphNode(item.nodeId) || { id: item.nodeId, data: { label: item.label } }
    const storyboardId = item.storyboardId || storyboardIdFromNodeId(item.nodeId) || selectedStoryboardIdForAssetAttach() || null
    const saved = await saveNodeResultAsset(node, {
      resultUrl: item.resultUrl,
      resultType: item.resultType || queueResultPreviewType(item),
      resultLabel: item.resultLabel || item.label || '队列结果',
      resultSummary: item.resultSummary || '',
      model: item.model || '',
      taskId: item.taskId || '',
      videoGenerationId: item.videoGenerationId || '',
      requestPayload: item.requestPayload || null,
      requestAudit: item.requestAudit || null,
    }, item.promptText || '', storyboardId)
    if (!saved?.savedAssetId) throw new Error('队列结果入库失败')
    const ids = item.statusIds?.length ? item.statusIds : [item.nodeId]
    markNodeResultSavedAsset(node, {
      ...item,
      sourceNodeId: item.nodeId,
      storyboardId,
      resultType: item.resultType || queueResultPreviewType(item),
    }, saved, '队列结果已存入素材库', ids)
    await loadProjectImageAssets()
    rebuildGraph()
    ElMessage.success('队列结果已存入素材库')
  } catch (error) {
    const message = error?.message || '队列结果入库失败'
    const ids = item.statusIds?.length ? item.statusIds : [item.nodeId]
    ids.filter(Boolean).forEach((id) => {
      const current = nodeStatus.get(id) || {}
      nodeStatus.set(id, {
        ...current,
        resultUrl: current.resultUrl || item.resultUrl || '',
        resultType: current.resultType || item.resultType || queueResultPreviewType(item),
        resultLabel: current.resultLabel || item.resultLabel || item.label || '队列结果',
        resultSummary: current.resultSummary || item.resultSummary || '',
        promptText: current.promptText || item.promptText || '',
        actionError: message,
        retryAction: 'save_result_asset',
        retryActionLabel: '重试存入素材库',
        message,
        autoClear: false,
      })
    })
    ElMessage.error(message)
  } finally {
    savingQueueAssetKey.value = ''
  }
}

async function focusQueueItemResult(item) {
  if (!item?.resultNodeId) {
    ElMessage.warning('该队列项暂无可定位的结果节点')
    return
  }
  await focusNodeOrWarn(item.resultNodeId, '该队列项暂无可定位的结果节点')
}

function dismissQueueItem(item) {
  const archived = archivedQueueStatusPayload(item)
  if (archived) {
    dismissedRunQueueItems.value = [
      archived,
      ...dismissedRunQueueItems.value.filter((entry) => entry.key !== archived.key),
    ].slice(0, 8)
  }
  const ids = item?.statusIds?.length ? item.statusIds : [item?.nodeId]
  ids.filter(Boolean).forEach((id) => nodeStatus.clear(id))
}

function archivedQueueStatusPayload(item) {
  if (!item?.nodeId) return null
  return {
    key: item.key || `dismissed:${item.nodeId}:${Date.now()}`,
    nodeId: item.nodeId,
    statusIds: item.statusIds?.length ? item.statusIds : [item.nodeId],
    step: item.tone === 'failed' ? 'failed' : item.tone === 'success' ? 'success' : 'busy',
    message: item.message || '已恢复已收起队列项',
    retryStep: item.retryStep || '',
    resultUrl: item.resultUrl || '',
    resultNodeId: item.resultNodeId || '',
    resultType: item.resultType || '',
    resultLabel: item.resultLabel || '',
    resultSummary: item.resultSummary || '',
    resultReferences: item.resultReferences || [],
    promptText: item.promptText || '',
    storyboardId: item.storyboardId || '',
    model: item.model || '',
    taskId: item.taskId || '',
    videoGenerationId: item.videoGenerationId || '',
    requestPayload: item.requestPayload || null,
    requestAudit: item.requestAudit || null,
    savedAssetId: item.savedAssetId || '',
    savedAssetName: item.savedAssetName || '',
    savedAssetUrl: item.savedAssetUrl || '',
    savedAssetLocalPath: item.savedAssetLocalPath || '',
    savedAssetDuration: item.savedAssetDuration ?? null,
    errorDetail: item.errorDetail || '',
    actionError: item.actionError || '',
    retryAction: item.retryAction || '',
    retryActionLabel: item.retryActionLabel || '',
    attachedSlot: item.attachedSlot || '',
  }
}

function restoreDismissedRunQueueItems() {
  const archivedItems = dismissedRunQueueItems.value
  if (!archivedItems.length) return
  archivedItems.forEach((item) => {
    const ids = item.statusIds?.length ? item.statusIds : [item.nodeId]
    ids.filter(Boolean).forEach((id) => nodeStatus.set(id, {
      ...item,
      sourceNodeId: item.nodeId,
      restored: true,
      at: Date.now(),
    }))
  })
  dismissedRunQueueItems.value = []
  ElMessage.success('已恢复收起的运行结果')
}

function syncWorkflowFromDrama() {
  workflowGroups.value = parseWorkflowGroups(drama.value?.metadata)
  if (activeGroupId.value && !workflowGroups.value.some((g) => g.id === activeGroupId.value)) {
    activeGroupId.value = null
  }
}

function rebuildGraph() {
  if (!drama.value) {
    allGraphNodes.value = []
    allGraphEdges.value = []
    canvasVirtualized.value = false
    nodes.value = []
    edges.value = []
    return
  }
  const graph = buildDramaCanvasGraph(drama.value, {
    standalone: isStandaloneCanvas.value,
    episodeId: filterEpisodeId.value,
    savedLayout: savedLayout.value,
    workflowGroups: workflowGroups.value,
    imagesBySbId: imagesBySbId.value,
    videosBySbId: videosBySbId.value,
    projectAssets: [...projectImageAssets.value, ...canvasAssetFailureNodes.value],
  })
  let nextNodes = graph.nodes.map((node) => {
    const storyboardId = node.type === 'canvasStoryboard' ? Number(node.data?.storyboard?.id) : null
    if (!Number.isFinite(storyboardId)) return node
    return {
      ...node,
      data: {
        ...node.data,
        assignedAssets: storyboardAssignedAssets.value[storyboardId] || [],
      },
    }
  })
  if (isStandaloneCanvas.value) {
    const freeNodeIds = new Set(nextNodes.filter((node) => node.type === 'homeCanvasNode').map((node) => String(node.id)))
    const groupNodes = (savedLayout.value?.groups || [])
      .filter((group) => (group?.child_node_ids || []).filter((id) => freeNodeIds.has(String(id))).length >= 2)
      .map((group) => ({
        id: String(group.id),
        type: 'canvasGroup',
        position: { x: Number(group.x) || 0, y: Number(group.y) || 0 },
        data: {
          title: String(group.title || '节点组'),
          childNodeIds: group.child_node_ids.map(String).filter((id) => freeNodeIds.has(id)),
          width: Math.max(260, Number(group.width) || 260),
          height: Math.max(180, Number(group.height) || 180),
        },
        zIndex: -1,
        selectable: true,
      }))
    nextNodes = [...groupNodes, ...nextNodes]
  }
  const nodesById = new Map(nextNodes.map((node) => [String(node.id), node]))
  let nextEdges = decorateCanvasEdges(graph.edges
    .filter((edge) => !suppressedEdgeIds.value.has(String(edge.id)))
    .filter((edge) => {
      const sourceNode = nodesById.get(String(edge.source))
      const targetNode = nodesById.get(String(edge.target))
      if (sourceNode?.type !== 'homeCanvasNode' || targetNode?.type !== 'homeCanvasNode') return true
      return resolveCanvasNodeConnection(canvasNodeKind(sourceNode), canvasNodeKind(targetNode)).allowed
    })
    .map((edge) => toLibTvCanvasEdge(
      edge,
      canvasNodeKind(nodesById.get(String(edge.source))),
      canvasNodeKind(nodesById.get(String(edge.target)))
    )))
  if (highlightAssetId.value) {
    const highlighted = applyCanvasHighlight(nextNodes, nextEdges, highlightAssetId.value, drama.value)
    nextNodes = highlighted.nodes
    nextEdges = highlighted.edges
  }
  const selectedIds = new Set(selectedStoryboardIds.value.map(Number))
  if (selectedIds.size) {
    nextNodes = nextNodes.map((node) => {
      if (node.type !== 'canvasStoryboard') return node
      return {
        ...node,
        selected: selectedIds.has(Number(node.data?.storyboard?.id)),
      }
    })
  }
  allGraphNodes.value = nextNodes
  allGraphEdges.value = nextEdges
  applyVirtualizedGraph()
  interactionHistory.value = createCanvasInteractionHistory(currentInteractionState())
}

function currentInteractionState() {
  return createCanvasInteractionState(
    allGraphNodes.value,
    currentViewport.value,
    allGraphEdges.value,
    [...suppressedEdgeIds.value],
  )
}

function commitInteractionHistory(previousState) {
  interactionHistory.value = commitCanvasInteractionHistory(
    interactionHistory.value,
    previousState,
    currentInteractionState(),
  )
}

function applyInteractionState(state) {
  const positions = state?.nodes || {}
  const restoredGroups = (state?.groups || []).map((group) => ({
    id: group.id,
    type: 'canvasGroup',
    position: { ...group.position },
    data: {
      title: group.title,
      childNodeIds: [...group.childNodeIds],
      width: group.width,
      height: group.height,
    },
    zIndex: -1,
    selectable: true,
    selected: false,
  }))
  allGraphNodes.value = [
    ...restoredGroups,
    ...allGraphNodes.value.filter((node) => node.type !== 'canvasGroup'),
  ].map((node) => {
    const position = positions[String(node.id)]
    return position ? { ...node, position: { ...position } } : node
  })
  selectedFreeNodeIds.value = []
  currentViewport.value = { ...(state?.viewport || currentViewport.value) }
  allGraphEdges.value = decorateCanvasEdges(state?.edges || allGraphEdges.value)
  suppressedEdgeIds.value = new Set((state?.suppressedEdgeIds || []).map(String))
  applyVirtualizedGraph()
  scheduleLayoutSave()
}

function canvasViewportSize() {
  return {
    width: canvasMainRef.value?.clientWidth || 0,
    height: canvasMainRef.value?.clientHeight || 0,
  }
}

function syncRenderedNodesToGraph() {
  if (!allGraphNodes.value.length || !nodes.value.length) return
  const renderedById = new Map(nodes.value.map((node) => [String(node.id), node]))
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    const rendered = renderedById.get(String(node.id))
    if (!rendered) return node
    return {
      ...node,
      position: rendered.position || node.position,
      dimensions: rendered.dimensions || node.dimensions,
      selected: rendered.selected,
      class: rendered.class,
      data: rendered.data || node.data,
    }
  })
}

function refreshLayoutCacheFromGraph() {
  layoutCache.value = withCanvasPersistedState(buildCanvasLayoutPayload(
    allGraphNodes.value,
    currentViewport.value,
    layoutCache.value,
    allGraphEdges.value,
    {
      persistFreeNodes: isStandaloneCanvas.value,
      suppressedEdgeIds: [...suppressedEdgeIds.value],
    },
  ))
}

function currentCanvasPreferences() {
  return normalizeCanvasPreferences(canvasPreferences.value)
}

function updateCanvasPreference(key, value) {
  canvasPreferences.value = normalizeCanvasPreferences({
    ...canvasPreferences.value,
    [key]: value,
  })
  scheduleLayoutSave()
}

function resetCanvasPreferences() {
  canvasPreferences.value = normalizeCanvasPreferences(DEFAULT_CANVAS_PREFERENCES)
  alignmentGuide.value = { x: null, y: null }
  scheduleLayoutSave()
  ElMessage.success('画布设置已恢复默认')
}

function withCanvasPersistedState(layout) {
  return {
    ...(layout || {}),
    preferences: currentCanvasPreferences(),
    generation_history: persistedGenerationHistory.value,
  }
}

function applyVirtualizedGraph() {
  if (!allGraphNodes.value.length) {
    nodes.value = []
    edges.value = []
    canvasVirtualized.value = false
    return
  }
  const result = virtualizeCanvasGraph(
    allGraphNodes.value,
    allGraphEdges.value,
    currentViewport.value,
    canvasViewportSize(),
    {
      minNodes: 80,
      overscan: 360,
      pinnedIds: focusedNodeId.value ? [focusedNodeId.value] : [],
    },
  )
  nodes.value = result.nodes
  edges.value = result.edges
  canvasVirtualized.value = result.virtualized
}

function scheduleVirtualization() {
  if (virtualizationFrame != null) {
    if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(virtualizationFrame)
    else clearTimeout(virtualizationFrame)
  }
  const run = () => {
    virtualizationFrame = null
    applyVirtualizedGraph()
  }
  if (typeof window !== 'undefined' && window.requestAnimationFrame) {
    virtualizationFrame = window.requestAnimationFrame(run)
  } else {
    virtualizationFrame = setTimeout(run, 0)
  }
}

function workflowStoryboardCountLabel(group) {
  const total = (group?.storyboard_ids || []).length
  if (filterEpisodeId.value == null) return `${total}镜`
  const visible = (group?.storyboard_ids || []).filter((id) => visibleStoryboardIds.value.has(Number(id))).length
  return `${visible}/${total}镜`
}

function applyHighlight() {
  if (!allGraphNodes.value.length) return
  const highlighted = applyCanvasHighlight(
    allGraphNodes.value.map((n) => ({ ...n, class: undefined, data: { ...n.data, highlighted: false, dimmed: false } })),
    allGraphEdges.value,
    highlightAssetId.value,
    drama.value
  )
  allGraphNodes.value = highlighted.nodes
  allGraphEdges.value = highlighted.edges
  applyVirtualizedGraph()
}

function selectSidebarAsset(assetNodeId) {
  highlightAssetId.value = highlightAssetId.value === assetNodeId ? null : assetNodeId
  applyHighlight()
}

function setHighlightAsset(assetNodeId) {
  highlightAssetId.value = assetNodeId
  applyHighlight()
}

async function refreshDrama(preserveFocus = true) {
  const keepId = preserveFocus ? focusedNodeId.value : null
  await loadDrama(true)
  await loadForDrama(drama.value, filterEpisodeId.value)
  rebuildGraph()
  if (keepId) focusedNodeId.value = keepId
}

async function refreshCanvas(preserveFocus = true) {
  await refreshDrama(preserveFocus)
}

function suppressPaneClick(ms = 350) {
  paneClickSuppressed.value = true
  if (paneClickSuppressTimer) clearTimeout(paneClickSuppressTimer)
  paneClickSuppressTimer = setTimeout(() => {
    paneClickSuppressed.value = false
    paneClickSuppressTimer = null
  }, ms)
}

function screenToFlowPosition(clientX, clientY) {
  const api = canvasFlowApi.value
  const viewport = api?.getViewport?.()
  if (viewport) {
    currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
  }
  const projectScreenPosition = api?.screenToFlowPosition || api?.project
  if (typeof projectScreenPosition === 'function') {
    const flowPosition = projectScreenPosition({ x: clientX, y: clientY })
    if (Number.isFinite(flowPosition?.x) && Number.isFinite(flowPosition?.y)) {
      return { x: flowPosition.x, y: flowPosition.y }
    }
  }
  const el = canvasMainRef.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const vp = currentViewport.value
  return {
    x: (clientX - rect.left - vp.x) / vp.zoom,
    y: (clientY - rect.top - vp.y) / vp.zoom,
  }
}

function panCanvasForNodeEditor(overflowY) {
  const distance = Math.max(0, Number(overflowY) || 0)
  const api = canvasFlowApi.value
  const viewport = api?.getViewport?.() || currentViewport.value
  if (!distance || !api?.setViewport || !viewport) return false
  const nextViewport = {
    x: Number(viewport.x || 0),
    y: Number(viewport.y || 0) - distance,
    zoom: Number(viewport.zoom || 1),
  }
  currentViewport.value = nextViewport
  api.setViewport(nextViewport, { duration: 0 })
  scheduleLayoutSave()
  return true
}

function canvasCenterFlowPosition() {
  const rect = canvasMainRef.value?.getBoundingClientRect?.()
  if (!rect) return { x: 80, y: 80 }
  return screenToFlowPosition(rect.left + rect.width / 2, rect.top + rect.height / 2) || { x: 80, y: 80 }
}

function droppedCanvasImageFile(event) {
  return [...(event.dataTransfer?.files || [])].find((file) => file.type?.startsWith('image/')) || null
}

function onCanvasImageDragOver(event) {
  if (!isStandaloneCanvas.value || !droppedCanvasImageFile(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

async function onCanvasImageDrop(event) {
  const file = droppedCanvasImageFile(event)
  if (!isStandaloneCanvas.value || !file) return
  event.preventDefault()
  event.stopPropagation()
  const position = screenToFlowPosition(event.clientX, event.clientY)
  const nodeId = await createFreeCanvasNode('image', position)
  if (nodeId) await uploadFreeCanvasNodeFile(nodeId, file)
}

function resetFreeNodeDialog() {
  freeNodeKind.value = 'text'
  freeNodeEditingId.value = ''
  freeNodeFlowPosition.value = null
  freeNodeForm.value = { title: '', content: '', url: '', model: '', aspectRatio: '16:9', duration: 5 }
}

function openFreeNodeDialog(kind, flowPosition = null, node = null) {
  if (!FREE_NODE_KINDS.has(kind)) return
  const defaults = loadFreeCanvasNodeDefaults()
  const kindDefaults = defaults[kind] || {}
  closeContextMenu()
  freeNodeKind.value = kind
  freeNodeEditingId.value = node?.id || ''
  freeNodeFlowPosition.value = node?.position || flowPosition || canvasCenterFlowPosition()
  freeNodeForm.value = {
    title: node?.data?.title || '',
    content: node?.data?.content || '',
    url: node?.data?.url || '',
    model: node?.data?.model || kindDefaults.model || '',
    aspectRatio: node?.data?.aspectRatio || kindDefaults.aspectRatio || '16:9',
    duration: node?.data?.duration || kindDefaults.duration || 5,
  }
  freeNodeDialogVisible.value = true
}

async function createFreeCanvasNode(kind, flowPosition = null, initialData = {}) {
  if (!FREE_NODE_KINDS.has(kind)) return null
  const defaults = loadFreeCanvasNodeDefaults()
  const kindDefaults = defaults[kind] || {}
  closeContextMenu()
  const previousState = currentInteractionState()
  const id = `free:${kind}:${Date.now()}`
  const title = {
    text: '文本',
    image: '图片',
    video: '视频',
    audio: '音频',
  }[kind]
  const data = {
    kind,
    title,
    content: '',
    url: '',
  }
  data.model = kindDefaults.model || ''
  if (['image', 'video'].includes(kind)) {
    data.aspectRatio = kindDefaults.aspectRatio || '16:9'
    data.resolution = kindDefaults.resolution || (kind === 'video' ? '720p' : '2K')
  }
  if (kind === 'video') data.duration = Number(kindDefaults.duration) || 5
  Object.assign(data, initialData)

  allGraphNodes.value = [
    ...allGraphNodes.value.map((node) => ({ ...node, selected: false })),
    {
      id,
      type: 'homeCanvasNode',
      position: flowPosition || computeStandaloneNodePosition(allGraphNodes.value, canvasCenterFlowPosition()),
      selected: true,
      data,
    },
  ]
  focusedNodeId.value = id
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  await persistCanvasState({ layoutOnly: true })
  await nextTick()
  document.querySelector(`.vue-flow__node[data-id="${id}"] .node-title-input`)?.focus()
  return id
}

async function createImageNodeFromVideoLastFrame(nodeOrId) {
  const videoNode = freeCanvasNodeById(nodeOrId)
  if (videoNode?.type !== 'homeCanvasNode' || videoNode.data?.kind !== 'video') return null
  let lastFrameUrl = String(
    videoNode.data?.outputLastFrameUrl
    || videoNode.data?.output_last_frame_url
    || '',
  ).trim()
  if (!lastFrameUrl && videoNode.data?.url) {
    try {
      const record = await videosAPI.extractBoundaryFrames({
        video_generation_id: videoNode.data?.videoGenerationId || undefined,
        video_url: videoNode.data?.url,
      })
      lastFrameUrl = String(record?.output_last_frame_url || record?.outputLastFrameUrl || '').trim()
      if (lastFrameUrl) {
        await patchFreeCanvasNodeData(videoNode.id, {
          outputLastFrameUrl: lastFrameUrl,
          ...(record?.output_first_frame_url ? { outputFirstFrameUrl: record.output_first_frame_url } : {}),
          ...(record?.id ? { videoGenerationId: record.id } : {}),
        })
      }
    } catch (error) {
      ElMessage.error(error?.message || '尾帧提取失败')
      return null
    }
  }
  if (!lastFrameUrl) {
    ElMessage.warning('当前视频没有可用尾帧')
    return null
  }
  const nodeId = await createFreeCanvasNode('image', {
    x: Number(videoNode.position?.x || 0) + 700,
    y: Number(videoNode.position?.y || 0),
  }, {
    title: `${videoNode.data?.title || '视频'} · 尾帧`,
    url: lastFrameUrl,
    resultUrls: [lastFrameUrl],
    status: 'success',
    sourceVideoNodeId: String(videoNode.id),
  })
  if (nodeId) ElMessage.success('尾帧已提取为图片节点')
  return nodeId
}

async function submitFreeNode() {
  const title = freeNodeForm.value.title.trim()
  if (!title) return
  const previousState = currentInteractionState()
  const nodeData = {
    kind: freeNodeKind.value,
    title,
    content: freeNodeForm.value.content.trim(),
    url: freeNodeForm.value.url.trim(),
  }
  nodeData.model = freeNodeForm.value.model.trim()
  if (['image', 'video'].includes(freeNodeKind.value)) nodeData.aspectRatio = freeNodeForm.value.aspectRatio
  if (freeNodeKind.value === 'video') nodeData.duration = Number(freeNodeForm.value.duration) || 5
  persistFreeCanvasNodeDefaults(freeNodeKind.value, nodeData)
  if (freeNodeEditingId.value) {
    allGraphNodes.value = allGraphNodes.value.map((node) => (
      String(node.id) === String(freeNodeEditingId.value)
        ? { ...node, data: { ...node.data, ...nodeData } }
        : node
    ))
  } else {
    allGraphNodes.value.push({
      id: `free:${freeNodeKind.value}:${Date.now()}`,
      type: 'homeCanvasNode',
      position: freeNodeFlowPosition.value || canvasCenterFlowPosition(),
      data: nodeData,
    })
  }
  const editing = Boolean(freeNodeEditingId.value)
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  freeNodeDialogVisible.value = false
  const saved = await persistCanvasState({ layoutOnly: true })
  if (saved) ElMessage.success(editing ? '节点已更新' : '节点已添加')
}

async function patchFreeCanvasNodeData(nodeId, patch) {
  const id = String(nodeId || '')
  if (!id) return null
  let updated = null
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    if (String(node.id) !== id) return node
    updated = { ...node, data: { ...node.data, ...patch } }
    return updated
  })
  if (!updated) return null
  if (updated.type === 'homeCanvasNode') persistFreeCanvasNodeDefaults(updated.data?.kind, updated.data)
  applyVirtualizedGraph()
  await persistCanvasState({ layoutOnly: true })
  return updated
}

async function deleteFreeCanvasNode(nodeId) {
  const id = String(nodeId || '')
  if (!isStandaloneCanvas.value || !id) return
  const previousState = currentInteractionState()
  const previousLength = allGraphNodes.value.length
  allGraphNodes.value = allGraphNodes.value.filter((node) => String(node.id) !== id)
  if (allGraphNodes.value.length === previousLength) return
  allGraphEdges.value = allGraphEdges.value.filter((edge) => String(edge.source) !== id && String(edge.target) !== id)
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  await persistCanvasState({ layoutOnly: true })
}

async function duplicateFreeCanvasNode(nodeOrId) {
  const source = freeCanvasNodeById(nodeOrId)
  if (!isStandaloneCanvas.value || source?.type !== 'homeCanvasNode') return null
  const previousState = currentInteractionState()
  const kind = source.data?.kind || 'text'
  const id = `free:${kind}:${Date.now()}`
  const hasResult = Boolean(source.data?.url)
  const data = {
    ...source.data,
    title: `${source.data?.title || '未命名节点'} 副本`,
    status: hasResult ? 'success' : 'idle',
    error: '',
    taskId: '',
    assetSaveStatus: source.data?.savedAssetId ? 'success' : '',
    assetSaveError: '',
  }
  allGraphNodes.value = [
    ...allGraphNodes.value.map((node) => ({ ...node, selected: false })),
    {
      ...source,
      id,
      position: {
        x: Number(source.position?.x || 0) + 40,
        y: Number(source.position?.y || 0) + 40,
      },
      selected: true,
      dragging: false,
      data,
    },
  ]
  focusedNodeId.value = id
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  await persistCanvasState({ layoutOnly: true })
  ElMessage.success('已复制节点')
  return id
}

async function uploadFreeCanvasNodeFile(nodeId, file) {
  const node = freeCanvasNodeById(nodeId)
  if (!isStandaloneCanvas.value || node?.type !== 'homeCanvasNode' || !file) return
  try {
    await patchFreeCanvasNodeData(node.id, { status: 'running', error: '' })
    const asset = await uploadAPI.uploadMedia(file, { dramaId: drama.value.id })
    const url = assetDisplayUrl(asset)
    if (!url) throw new Error('素材上传成功但未返回可用地址')
    await patchFreeCanvasNodeData(node.id, {
      url,
      status: 'success',
      error: '',
      savedAssetId: String(asset?.id || ''),
      assetSaveStatus: 'success',
      assetSaveError: '',
    })
    ElMessage.success('素材已上传并写入当前节点')
  } catch (error) {
    const message = error?.message || '节点素材上传失败'
    await patchFreeCanvasNodeData(node.id, { status: 'failed', error: message })
    ElMessage.error(message)
  }
}

function freeCanvasNodeById(nodeOrId) {
  if (typeof nodeOrId === 'object' && nodeOrId?.id) return findGraphNode(nodeOrId.id) || nodeOrId
  return findGraphNode(nodeOrId)
}

function freeCanvasTaskId(response) {
  return String(
    response?.task_id
    || response?.taskId
    || response?.image_generation?.task_id
    || response?.video_generation?.task_id
    || ''
  )
}

function freeCanvasGenerationId(kind, submitResult, taskResult) {
  const persistedResult = taskResultObject(taskResult)
  const result = Object.keys(persistedResult).length ? persistedResult : taskResult || {}
  if (kind === 'image') {
    return result.image_generation_id
      || result.generation_id
      || submitResult?.image_generation?.id
      || submitResult?.id
      || ''
  }
  if (kind === 'video') {
    return result.video_generation_id
      || result.generation_id
      || submitResult?.video_generation?.id
      || submitResult?.id
      || ''
  }
  return ''
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollFreeCanvasTask(taskId, { maxAttempts = 60, intervalMs = 3000 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs)
    const task = await taskAPI.get(taskId)
    if (task?.status === 'completed') return task
    if (task?.status === 'failed') throw new Error(task?.error || task?.message || '自由节点生成失败')
  }
  throw new Error('自由节点生成超时')
}

async function resolveFreeCanvasFinalUrl(kind, submitResult, taskResult) {
  const persistedResult = taskResultObject(taskResult)
  const normalizedTaskResult = Object.keys(persistedResult).length
    ? { ...taskResult, result: persistedResult }
    : taskResult
  let resultUrl = resolveFreeCanvasResultUrl(kind, normalizedTaskResult) || resolveFreeCanvasResultUrl(kind, submitResult)
  if (resultUrl || kind === 'audio') return resultUrl
  const generationId = freeCanvasGenerationId(kind, submitResult, normalizedTaskResult)
  if (!generationId) return ''
  const record = kind === 'image'
    ? await imagesAPI.get(generationId)
    : await videosAPI.get(generationId)
  return resolveFreeCanvasResultUrl(kind, record)
}

function firstVideoBoundaryFrame(sources, keys) {
  for (const source of sources) {
    for (const key of keys) {
      const value = String(source?.[key] || '').trim()
      if (value) return value
    }
  }
  return ''
}

async function resolveFreeCanvasVideoBoundaryFrames(kind, submitResult, taskResult) {
  if (kind !== 'video') return {}
  let sources = [
    taskResultObject(taskResult),
    taskResult?.result,
    taskResult,
    submitResult?.video_generation,
    submitResult,
  ]
  const firstKeys = ['output_first_frame_url', 'outputFirstFrameUrl']
  const lastKeys = ['output_last_frame_url', 'outputLastFrameUrl']
  let outputFirstFrameUrl = firstVideoBoundaryFrame(sources, firstKeys)
  let outputLastFrameUrl = firstVideoBoundaryFrame(sources, lastKeys)

  if (!outputFirstFrameUrl || !outputLastFrameUrl) {
    const generationId = freeCanvasGenerationId(kind, submitResult, taskResult)
    if (generationId) {
      const record = await videosAPI.get(generationId).catch(() => null)
      sources = [record?.video_generation, record, ...sources]
      outputFirstFrameUrl ||= firstVideoBoundaryFrame(sources, firstKeys)
      outputLastFrameUrl ||= firstVideoBoundaryFrame(sources, lastKeys)
    }
  }

  return {
    ...(outputFirstFrameUrl ? { outputFirstFrameUrl } : {}),
    ...(outputLastFrameUrl ? { outputLastFrameUrl } : {}),
  }
}

function notifyCreditAccountRefresh() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('moli:credit-account-refresh'))
}

async function saveFreeCanvasResultAsset(node, kind, resultUrl, requestPayload, taskId) {
  const nodeId = String(node?.id || '')
  const url = String(resultUrl || '')
  const saveKey = `${nodeId}::${url}`
  if (!nodeId || !url) throw new Error('自由节点素材入库缺少结果地址')

  const existingFlight = freeCanvasAssetSaveFlights.get(saveKey)
  if (existingFlight) return existingFlight

  const savePromise = (async () => {
    const latestBeforeRun = freeCanvasNodeById(nodeId) || node
    if (latestBeforeRun?.data?.savedAssetId) {
      return { id: latestBeforeRun.data.savedAssetId, skipped: true }
    }

    await patchFreeCanvasNodeData(nodeId, { assetSaveStatus: 'running', assetSaveError: '' })
    const assetPayload = buildFreeCanvasProjectAssetPayload({
      dramaId: dramaId.value,
      nodeId,
      name: latestBeforeRun.data?.title,
      taskId,
      model: latestBeforeRun.data?.model,
      type: kind,
      url,
      requestPayload,
    })
    try {
      const latestBeforeCreate = freeCanvasNodeById(nodeId) || latestBeforeRun
      if (latestBeforeCreate?.data?.savedAssetId) {
        await patchFreeCanvasNodeData(nodeId, { assetSaveStatus: 'success', assetSaveError: '' })
        return { id: latestBeforeCreate.data.savedAssetId, skipped: true }
      }
      if (assetPayload.storyboard_id !== null) throw new Error('自由节点素材入库必须隔离分镜')
      const savedAsset = await assetsAPI.create(assetPayload)
      await patchFreeCanvasNodeData(nodeId, {
        assetSaveStatus: 'success',
        assetSaveError: '',
        savedAssetId: String(savedAsset?.id || ''),
      })
      return savedAsset
    } catch (error) {
      await patchFreeCanvasNodeData(nodeId, {
        assetSaveStatus: 'failed',
        assetSaveError: error?.message || '自动存入素材库失败',
      })
      throw error
    }
  })()

  freeCanvasAssetSaveFlights.set(saveKey, savePromise)
  try {
    return await savePromise
  } finally {
    if (freeCanvasAssetSaveFlights.get(saveKey) === savePromise) {
      freeCanvasAssetSaveFlights.delete(saveKey)
    }
  }
}

function freeCanvasTaskPollOptions(kind) {
  return { maxAttempts: kind === 'video' ? 600 : 60, intervalMs: 3000 }
}

async function completeFreeCanvasNodeGeneration({
  node,
  kind,
  submitResult,
  taskResult,
  requestPayload,
  taskId,
  notify = true,
}) {
  const resolved = await resolveFreeCanvasNodeGeneration({ kind, submitResult, taskResult })
  return commitFreeCanvasNodeGeneration({
    node,
    kind,
    ...resolved,
    requestPayload,
    taskId,
    notify,
  })
}

async function resolveFreeCanvasNodeGeneration({ kind, submitResult, taskResult }) {
  const resultUrl = await resolveFreeCanvasFinalUrl(kind, submitResult, taskResult)
  if (!resultUrl) throw new Error('生成完成但未返回可用结果地址')
  const boundaryFrames = await resolveFreeCanvasVideoBoundaryFrames(kind, submitResult, taskResult)
  const generationId = freeCanvasGenerationId(kind, submitResult, taskResult)
  return { resultUrl, boundaryFrames, generationId }
}

async function commitFreeCanvasNodeGeneration({
  node,
  kind,
  resultUrl,
  boundaryFrames = {},
  generationId,
  requestPayload,
  taskId,
  resultUrls = [],
  notify = true,
}) {
  await patchFreeCanvasNodeData(node.id, {
    status: 'success',
    url: resultUrl,
    resultUrls: resultUrls.length ? resultUrls : [resultUrl],
    ...boundaryFrames,
    ...(kind === 'video' && generationId ? { videoGenerationId: generationId } : {}),
    taskId,
    progress: 100,
    error: '',
    savedAssetId: '',
    assetSaveStatus: 'running',
    assetSaveError: '',
  })
  try {
    const latestNode = findGraphNode(node.id) || { ...node, data: { ...node.data, url: resultUrl } }
    await saveFreeCanvasResultAsset(latestNode, kind, resultUrl, requestPayload, taskId)
  } catch (assetError) {
    console.warn('auto save free canvas result asset failed', assetError)
    if (notify) ElMessage.warning('生成完成，但自动存入素材库失败')
  }
  if (notify) ElMessage.success('自由节点生成完成')
  return resultUrl
}
function freeCanvasNodeInputReferences(nodeOrId) {
  const node = freeCanvasNodeById(nodeOrId)
  if (!node || !['image', 'video'].includes(node.data?.kind)) return []
  return collectDirectUpstreamImageReferences(allGraphNodes.value, allGraphEdges.value, node.id)
}

function freeCanvasReferenceCandidates(nodeOrId) {
  const targetNode = freeCanvasNodeById(nodeOrId)
  if (!targetNode) return []
  return collectDirectUpstreamImageReferences(allGraphNodes.value, allGraphEdges.value, targetNode.id)
    .filter((reference) => reference.ready && reference.enabled !== false)
    .map((reference) => ({
      nodeId: String(reference.nodeId),
      title: reference.title || '画布图片',
      url: reference.url,
    }))
}

function attachFreeCanvasReference(targetNodeOrId, sourceNodeOrId) {
  const targetNode = freeCanvasNodeById(targetNodeOrId)
  const sourceNode = freeCanvasNodeById(sourceNodeOrId)
  if (!targetNode || !sourceNode) return false
  if (!['image', 'video'].includes(targetNode.data?.kind)) return false
  if (sourceNode.data?.kind !== 'image' || !getFreeCanvasNodeResultUrl(sourceNode)) return false
  if (String(sourceNode.id) === String(targetNode.id)) return false
  onConnect({ source: sourceNode.id, target: targetNode.id })
  allGraphNodes.value = allGraphNodes.value.map((node) => ({
    ...node,
    selected: String(node.id) === String(targetNode.id),
  }))
  selectedFreeNodeIds.value = [String(targetNode.id)]
  focusedNodeId.value = String(targetNode.id)
  applyVirtualizedGraph()
  return true
}

async function createFreeCanvasReferenceNode({ targetNode, url, title, savedAssetId = '' }) {
  const inputCount = freeCanvasNodeInputReferences(targetNode).length
  const nodeId = await createFreeCanvasNode('image', {
    x: Number(targetNode.position?.x || 0) - 700,
    y: Number(targetNode.position?.y || 0) + inputCount * 48,
  })
  await patchFreeCanvasNodeData(nodeId, {
    title: title || '参考图',
    url,
    status: 'success',
    savedAssetId,
    assetSaveStatus: 'success',
    assetSaveError: '',
  })
  attachFreeCanvasReference(targetNode, nodeId)
  return nodeId
}

async function uploadFreeCanvasReferenceImage(nodeOrId, file) {
  const targetNode = freeCanvasNodeById(nodeOrId)
  if (!targetNode || !['image', 'video'].includes(targetNode.data?.kind)) return
  if (!file?.type?.startsWith('image/')) {
    ElMessage.warning('请选择图片文件')
    return
  }
  try {
    const asset = await uploadAPI.uploadMedia(file, { dramaId: drama.value.id })
    const url = assetDisplayUrl(asset)
    if (!url) throw new Error('参考图上传成功但未返回可用地址')
    await createFreeCanvasReferenceNode({
      targetNode,
      url,
      title: file.name || '参考图',
      savedAssetId: String(asset?.id || ''),
    })
    ElMessage.success('参考图已上传并连接')
  } catch (error) {
    ElMessage.error(error?.message || '参考图上传失败')
  }
}

function updateFreeCanvasReference(edgeId, patch = {}) {
  const mutate = (edge) => {
    if (String(edge.id) !== String(edgeId)) return edge
    const source = findGraphNode(edge.source)
    const target = findGraphNode(edge.target)
    return toLibTvCanvasEdge({
      ...edge,
      data: {
        ...(edge.data || {}),
        contract: { ...(edge.data?.contract || {}), ...patch },
      },
    }, canvasNodeKind(source), canvasNodeKind(target))
  }
  allGraphEdges.value = allGraphEdges.value.map(mutate)
  edges.value = edges.value.map(mutate)
  scheduleSave()
}

function detachFreeCanvasReference(edgeId) {
  const normalizedId = String(edgeId || '')
  const edge = allGraphEdges.value.find((item) => String(item.id) === normalizedId)
  if (!isStandaloneFreeNodeEdge(edge)) return false
  const previousState = currentInteractionState()
  allGraphEdges.value = allGraphEdges.value.filter((item) => String(item.id) !== normalizedId)
  edges.value = edges.value.filter((item) => String(item.id) !== normalizedId)
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  void persistCanvasState({ layoutOnly: true })
  return true
}

async function appendFreeCanvasGenerationHistory(nodeId, entry) {
  const node = freeCanvasNodeById(nodeId)
  if (!node) return
  const history = Array.isArray(node.data?.generationHistory) ? node.data.generationHistory : []
  await patchFreeCanvasNodeData(node.id, {
    generationHistory: [...history, entry].slice(-FREE_CANVAS_GENERATION_HISTORY_LIMIT),
  })
}

async function updateFreeCanvasGenerationHistory(nodeId, historyId, patch) {
  const node = freeCanvasNodeById(nodeId)
  if (!node) return
  const history = Array.isArray(node.data?.generationHistory) ? node.data.generationHistory : []
  await patchFreeCanvasNodeData(node.id, {
    generationHistory: history
      .map((item) => item.id === historyId ? { ...item, ...patch } : item)
      .slice(-FREE_CANVAS_GENERATION_HISTORY_LIMIT),
  })
}

function showFreeCanvasGenerationHistory(nodeOrId) {
  const node = freeCanvasNodeById(nodeOrId)
  const history = Array.isArray(node?.data?.generationHistory) ? node.data.generationHistory : []
  if (!history.length) {
    ElMessage.info('当前节点还没有生成历史')
    return
  }
  const statusLabels = { running: '生成中', success: '成功', failed: '失败' }
  const text = history
    .slice()
    .reverse()
    .map((item, index) => {
      const time = item.completedAt || item.requestedAt
      const details = [item.model, item.aspectRatio, item.duration ? `${item.duration}秒` : ''].filter(Boolean).join(' · ')
      const error = item.error ? `\n失败原因：${item.error}` : ''
      return `${index + 1}. ${time ? new Date(time).toLocaleString() : '未知时间'} · ${statusLabels[item.status] || item.status}\n${details}${error}`
    })
    .join('\n\n')
  ElMessageBox.alert(text, `${node.data?.title || '节点'} · 生成历史`, {
    confirmButtonText: '关闭',
    customClass: 'canvas-history-dialog',
  })
}

async function runFreeCanvasNode(nodeOrId) {
  const node = freeCanvasNodeById(nodeOrId)
  if (!isStandaloneCanvas.value || node?.type !== 'homeCanvasNode') {
    ElMessage.warning('只有独立画布自由节点可直接运行')
    return
  }
  const kind = node.data?.kind
  if (!['text', 'image', 'video', 'audio'].includes(kind)) {
    ElMessage.warning('暂不支持该自由节点类型')
    return
  }
  await waitForCanvasSubmissionDelay(node, kind)
  const upstreamReferences = freeCanvasNodeInputReferences(node)
  const upstreamUrls = upstreamReferences
    .filter((reference) => reference.enabled !== false)
    .map((reference) => reference.url)
    .filter(Boolean)
  const upstreamTexts = collectDirectUpstreamTextInputs(
    allGraphNodes.value,
    allGraphEdges.value,
    node.id
  )
  const historyId = `run:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  let requestPayload
  try {
    const capability = getFreeNodeModelCapability(kind, node.data?.model)
    requestPayload = buildFreeCanvasGenerationRequest(node.data, {
      dramaId: dramaId.value,
      upstreamUrls,
      upstreamReferences,
      upstreamTexts,
      maxReferences: capability.maxReferences,
    })
  } catch (error) {
    const errorMessage = error?.message || '自由节点生成参数不完整'
    await appendFreeCanvasGenerationHistory(node.id, {
      id: historyId,
      kind,
      model: node.data?.model || '',
      status: 'failed',
      requestedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: errorMessage,
    })
    await patchFreeCanvasNodeData(node.id, { status: 'failed', error: errorMessage })
    ElMessage.error(errorMessage)
    return { ok: false, nodeId: String(node.id), error: errorMessage }
  }

  const previousUrl = node.data?.url || ''
  const previousResultUrls = Array.isArray(node.data?.resultUrls) ? [...node.data.resultUrls] : []
  const completedResults = []
  await appendFreeCanvasGenerationHistory(node.id, {
    id: historyId,
    kind,
    model: requestPayload.model || node.data?.model || '',
    aspectRatio: requestPayload.aspect_ratio || node.data?.aspectRatio || '',
    duration: requestPayload.duration || node.data?.duration || '',
    status: 'running',
    requestedAt: new Date().toISOString(),
    error: '',
  })
  await patchFreeCanvasNodeData(node.id, { status: 'running', progress: 0, taskId: '', error: '' })
  let taskId = ''
  try {
    if (kind === 'text') {
      const textResult = await request.post('/canvas/text/generate', requestPayload)
      const content = String(textResult?.content || '').trim()
      if (!content) throw new Error('文本生成完成但未返回内容')
      await patchFreeCanvasNodeData(node.id, {
        content,
        status: 'success',
        progress: 100,
        error: '',
      })
      await updateFreeCanvasGenerationHistory(node.id, historyId, {
        status: 'success',
        completedAt: new Date().toISOString(),
      })
      ElMessage.success('文本节点生成完成')
      return { ok: true, nodeId: String(node.id) }
    }

    const quantity = ['image', 'video'].includes(kind)
      ? Math.min(4, Math.max(1, Number(node.data?.quantity) || 1))
      : 1
    for (let index = 0; index < quantity; index += 1) {
      let submitResult = null
      let taskResult = null
      if (kind === 'image') submitResult = await imagesAPI.create(requestPayload)
      else if (kind === 'video') submitResult = await videosAPI.create(requestPayload)
      else if (kind === 'audio') submitResult = await request.post('/audio/extract', requestPayload)
      else throw new Error(`暂不支持自由节点生成类型：${kind}`)

      taskId = freeCanvasTaskId(submitResult)
      if (taskId) {
        await patchFreeCanvasNodeData(node.id, { taskId })
        taskResult = await pollFreeCanvasTask(taskId, freeCanvasTaskPollOptions(kind))
      }
      const resolvedResult = await resolveFreeCanvasNodeGeneration({
        kind,
        submitResult,
        taskResult,
      })
      completedResults.push(resolvedResult)
      await patchFreeCanvasNodeData(node.id, {
        progress: Math.round((completedResults.length / quantity) * 100),
      })
    }
    const completedResultUrls = completedResults.map((result) => result.resultUrl)
    const visibleResult = completedResults[0]
    await commitFreeCanvasNodeGeneration({
      node,
      kind,
      resultUrl: visibleResult.resultUrl,
      boundaryFrames: visibleResult.boundaryFrames,
      requestPayload,
      taskId,
      resultUrls: completedResultUrls,
    })
    await updateFreeCanvasGenerationHistory(node.id, historyId, {
      status: 'success',
      completedAt: new Date().toISOString(),
      taskId,
      resultUrls: [...completedResultUrls],
    })
    return { ok: true, nodeId: String(node.id) }
  } catch (error) {
    const errorMessage = error?.message || '自由节点生成失败'
    const completedResultUrls = completedResults.map((result) => result.resultUrl)
    await updateFreeCanvasGenerationHistory(node.id, historyId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      taskId,
      resultUrls: [...completedResultUrls],
      error: errorMessage,
    })
    await patchFreeCanvasNodeData(node.id, {
      status: 'failed',
      url: previousUrl,
      resultUrls: previousResultUrls,
      taskId,
      error: errorMessage,
    })
    ElMessage.error(errorMessage)
    return { ok: false, nodeId: String(node.id), error: errorMessage }
  } finally {
    notifyCreditAccountRefresh()
    if (canvasPreferences.value.blur_after_submit) focusedNodeId.value = null
  }
}

async function runFreeCanvasSubgraph(nodeIds, includeDownstream = false) {
  const plan = buildCanvasExecutionPlan(allGraphNodes.value, allGraphEdges.value, {
    rootNodeIds: nodeIds,
    includeDownstream,
  })
  if (plan.cycleNodeIds.length) {
    ElMessage.error(`检测到画布环路：${plan.cycleNodeIds.join('、')}`)
    return { ok: false, cycleNodeIds: plan.cycleNodeIds }
  }
  if (!plan.orderedNodeIds.length) {
    ElMessage.warning('请先选择可运行的自由节点')
    return { ok: false }
  }
  for (const nodeId of plan.orderedNodeIds) {
    const result = await runFreeCanvasNode(nodeId)
    if (!result?.ok) {
      ElMessage.error(`子图已在节点 ${nodeId} 停止，下游未提交`)
      return { ok: false, failedNodeId: nodeId }
    }
  }
  ElMessage.success(`子图运行完成，共 ${plan.orderedNodeIds.length} 个节点`)
  return { ok: true, orderedNodeIds: plan.orderedNodeIds }
}
const edgeTypes = {
  libtv: markRaw(LibTvCanvasEdge),
  cuttable: markRaw(CanvasCuttableEdge),
}

async function translateFreeCanvasNode(nodeOrId) {
  const node = freeCanvasNodeById(nodeOrId)
  const content = String(node?.data?.content || '').trim()
  if (!isStandaloneCanvas.value || !node || !content) return
  const containsChinese = /[\u3400-\u9fff]/.test(content)
  const prompt = containsChinese
    ? `将以下内容翻译成自然、准确的英文，只输出译文：\n\n${content}`
    : `将以下内容翻译成自然、准确的中文，只输出译文：\n\n${content}`
  const previousContent = content
  await patchFreeCanvasNodeData(node.id, { status: 'running', error: '' })
  try {
    const result = await request.post('/canvas/text/generate', {
      drama_id: dramaId.value,
      prompt,
      model: node.data?.kind === 'text' ? node.data?.model || undefined : undefined,
    })
    const translated = String(result?.content || '').trim()
    if (!translated) throw new Error('翻译完成但未返回内容')
    await patchFreeCanvasNodeData(node.id, { content: translated, status: 'success', error: '' })
    ElMessage.success('已完成中英互译')
  } catch (error) {
    await patchFreeCanvasNodeData(node.id, {
      content: previousContent,
      status: 'failed',
      error: error?.message || '翻译失败',
    })
    ElMessage.error(error?.message || '翻译失败')
  }
}

async function resumeFreeCanvasNodeTask(nodeOrId) {
  const node = freeCanvasNodeById(nodeOrId)
  const taskId = String(node?.data?.taskId || '')
  const kind = node?.data?.kind
  if (!taskId || node?.data?.status !== 'running' || !['image', 'video', 'audio'].includes(kind)) return
  const resumeKey = `${node.id}::${taskId}`
  const existingFlight = freeCanvasTaskResumeFlights.get(resumeKey)
  if (existingFlight) return existingFlight

  const resumePromise = (async () => {
    try {
      const taskResult = await pollFreeCanvasTask(taskId, freeCanvasTaskPollOptions(kind))
      await completeFreeCanvasNodeGeneration({
        node,
        kind,
        submitResult: null,
        taskResult,
        requestPayload: null,
        taskId,
        notify: false,
      })
      ElMessage.success('已恢复自由节点生成结果')
    } catch (error) {
      const latestNode = freeCanvasNodeById(node.id)
      if (String(latestNode?.data?.taskId || '') !== taskId || latestNode?.data?.status !== 'running') return
      const errorMessage = error?.message || '自由节点生成失败'
      await patchFreeCanvasNodeData(node.id, {
        status: 'failed',
        url: latestNode?.data?.url || '',
        taskId,
        error: errorMessage,
      })
      ElMessage.error(errorMessage)
    } finally {
      notifyCreditAccountRefresh()
    }
  })()

  freeCanvasTaskResumeFlights.set(resumeKey, resumePromise)
  try {
    return await resumePromise
  } finally {
    if (freeCanvasTaskResumeFlights.get(resumeKey) === resumePromise) {
      freeCanvasTaskResumeFlights.delete(resumeKey)
    }
  }
}

function resumePendingFreeCanvasTasks() {
  if (!isStandaloneCanvas.value) return
  for (const node of allGraphNodes.value) {
    if (
      node?.type !== 'homeCanvasNode'
      || node?.data?.status !== 'running'
      || !node?.data?.taskId
    ) continue
    void resumeFreeCanvasNodeTask(node)
  }
}
async function retryFreeCanvasAssetSave(nodeOrId) {
  const node = freeCanvasNodeById(nodeOrId)
  if (!isStandaloneCanvas.value || node?.type !== 'homeCanvasNode' || !node.data?.url) {
    ElMessage.warning('该自由节点暂无可入库结果')
    return
  }
  try {
    await saveFreeCanvasResultAsset(node, node.data?.kind, node.data.url, null, node.data?.taskId || '')
    ElMessage.success('已重新存入素材库')
  } catch (error) {
    ElMessage.error(error?.message || '存入素材库失败')
  }
}

const IMAGE_TOOL_POLL_INTERVAL_MS = 2000
const IMAGE_TOOL_POLL_MAX_ATTEMPTS = 2400

function parseImageToolTaskResult(task) {
  if (task?.result && typeof task.result === 'object') return task.result
  if (typeof task?.result === 'string' && task.result.trim()) {
    try {
      return JSON.parse(task.result)
    } catch {
      throw new Error('图片处理任务返回了无效结果')
    }
  }
  throw new Error('图片处理任务未返回结果')
}

async function waitForImageToolOperation(taskId) {
  for (let attempt = 0; attempt < IMAGE_TOOL_POLL_MAX_ATTEMPTS; attempt += 1) {
    const task = await imageToolsAPI.getOperation(taskId)
    if (task?.status === 'completed') return parseImageToolTaskResult(task)
    if (task?.status === 'failed') throw new Error(task.error || task.message || '图片处理失败')
    await new Promise((resolve) => setTimeout(resolve, IMAGE_TOOL_POLL_INTERVAL_MS))
  }
  const error = new Error('图片仍在后台处理中，请稍后刷新查看')
  error.code = 'IMAGE_TOOL_POLL_TIMEOUT'
  throw error
}

async function completeImageToolOperation(nodeId, operation, result, previousHistory = []) {
  const sourceNode = freeCanvasNodeById(nodeId)
  if (sourceNode?.type !== 'homeCanvasNode' || sourceNode.data?.kind !== 'image') {
    throw new Error('图片处理完成，但源图片节点已不存在')
  }
  const resultAssets = Array.isArray(result.resultAssets) && result.resultAssets.length
    ? result.resultAssets
    : [{
        id: result.resultAssetId,
        url: result.resultUrl,
      }]
  const validResultAssets = resultAssets.filter((asset) => asset?.id && asset?.url)
  if (!validResultAssets.length) throw new Error('图片处理完成，但未返回可展示的新素材')

  for (const [index, asset] of validResultAssets.entries()) {
    const existingResultNode = allGraphNodes.value.find((node) => (
      node.type === 'homeCanvasNode'
      && node.data?.kind === 'image'
      && String(node.data?.sourceImageToolNodeId || '') === String(sourceNode.id)
      && String(node.data?.imageToolTaskId || '') === String(result.taskId || '')
      && String(node.data?.savedAssetId || '') === String(asset.id)
    ))
    if (existingResultNode) continue
    await createFreeCanvasNode('image', {
      x: Number(sourceNode.position?.x || 0) + 700,
      y: Number(sourceNode.position?.y || 0) + (index * 420),
    }, {
      title: `${sourceNode.data?.title || '图片'} · 编辑结果${validResultAssets.length > 1 ? ` ${index + 1}` : ''}`,
      content: sourceNode.data?.content || '',
      url: asset.url,
      resultUrls: [asset.url],
      status: 'success',
      savedAssetId: String(asset.id),
      assetSaveStatus: 'success',
      assetSaveError: '',
      sourceImageToolNodeId: String(sourceNode.id),
      imageToolOperation: operation,
      imageToolTaskId: result.taskId,
      imageToolStatus: 'success',
      imageToolError: '',
    })
  }

  const historyItem = {
    taskId: result.taskId,
    operation,
    status: result.status,
    resultAssetId: result.resultAssetId,
    resultUrl: result.resultUrl,
    createdAt: new Date().toISOString(),
  }
  await patchFreeCanvasNodeData(nodeId, {
    imageToolTaskId: result.taskId,
    imageToolStatus: 'success',
    imageToolError: '',
    imageToolRetryOperation: '',
    imageToolRetryParameters: null,
    imageToolResultAssets: result.resultAssets || [],
    imageToolHistory: [historyItem, ...previousHistory].slice(0, 20),
    assetSaveStatus: 'success',
    assetSaveError: '',
  })
}

async function runImageNodeTool(nodeOrId, operation, parameters = {}) {
  let node = freeCanvasNodeById(nodeOrId)
  if (node?.type !== 'homeCanvasNode' || node.data?.kind !== 'image') {
    throw new Error('该节点不是可处理的图片节点')
  }
  const previousUrl = String(node.data?.url || '')
  if (!previousUrl) throw new Error('图片节点暂无可处理结果')

  let sourceAssetId = node.data?.savedAssetId
  if (!sourceAssetId) {
    const savedAsset = await saveFreeCanvasResultAsset(
      node,
      'image',
      previousUrl,
      null,
      node.data?.taskId || '',
    )
    sourceAssetId = savedAsset?.id
    node = freeCanvasNodeById(node.id) || node
  }
  if (!sourceAssetId) throw new Error('图片尚未存入素材库，无法执行处理')

  const previousHistory = Array.isArray(node.data?.imageToolHistory)
    ? node.data.imageToolHistory
    : []
  await patchFreeCanvasNodeData(node.id, {
    imageToolStatus: 'running',
    imageToolError: '',
    imageToolRetryOperation: operation,
    imageToolRetryParameters: parameters,
  })
  let activeTaskId = ''
  try {
    const accepted = await imageToolsAPI.createOperation({
      assetId: node.data?.savedAssetId || sourceAssetId,
      sourceNodeId: String(node.id),
      operation,
      parameters,
    })
    if (accepted?.status === 'processing' && accepted?.taskId) {
      activeTaskId = String(accepted.taskId)
      resumedImageToolTasks.add(activeTaskId)
      await patchFreeCanvasNodeData(node.id, {
        imageToolTaskId: accepted.taskId,
        imageToolStatus: 'running',
      })
    }
    const result = accepted?.status === 'processing'
      ? await waitForImageToolOperation(accepted.taskId)
      : accepted
    await completeImageToolOperation(node.id, operation, result, previousHistory)
    if (activeTaskId) resumedImageToolTasks.delete(activeTaskId)
    return result
  } catch (error) {
    if (activeTaskId) resumedImageToolTasks.delete(activeTaskId)
    if (error?.code === 'IMAGE_TOOL_POLL_TIMEOUT') {
      await patchFreeCanvasNodeData(node.id, {
        imageToolStatus: 'running',
        imageToolError: error.message,
      })
      throw error
    }
    await patchFreeCanvasNodeData(node.id, {
      url: previousUrl,
      imageToolStatus: 'failed',
      imageToolError: error?.message || '图片处理失败',
      imageToolRetryOperation: operation,
      imageToolRetryParameters: parameters,
    })
    throw error
  }
}

const resumedImageToolTasks = new Set()

function resumePendingImageToolOperations() {
  for (const node of allGraphNodes.value) {
    const taskId = String(node.data?.imageToolTaskId || '')
    if (node.type !== 'homeCanvasNode'
      || node.data?.kind !== 'image'
      || node.data?.imageToolStatus !== 'running'
      || !taskId
      || resumedImageToolTasks.has(taskId)) continue
    resumedImageToolTasks.add(taskId)
    const operation = String(node.data?.imageToolRetryOperation || '')
    const previousHistory = Array.isArray(node.data?.imageToolHistory)
      ? node.data.imageToolHistory
      : []
    waitForImageToolOperation(taskId)
      .then((result) => completeImageToolOperation(node.id, operation, result, previousHistory))
      .catch(async (error) => {
        if (error?.code === 'IMAGE_TOOL_POLL_TIMEOUT') {
          resumedImageToolTasks.delete(taskId)
          return
        }
        await patchFreeCanvasNodeData(node.id, {
          imageToolStatus: 'failed',
          imageToolError: error?.message || '图片处理失败',
        })
      })
  }
}

async function replaceFreeCanvasNodeImage(nodeOrId, file) {
  const node = freeCanvasNodeById(nodeOrId)
  if (node?.type !== 'homeCanvasNode' || node.data?.kind !== 'image') {
    throw new Error('该节点不是可替换的图片节点')
  }
  if (!file?.type?.startsWith('image/')) throw new Error('请选择图片文件')
  if (!drama.value?.id) throw new Error('项目信息不完整，无法上传图片')
  const asset = await uploadAPI.uploadMedia(file, { dramaId: drama.value.id })
  if (!asset?.id || !asset?.url) throw new Error('图片上传成功但未返回素材记录')
  await patchFreeCanvasNodeData(node.id, {
    url: asset.url,
    savedAssetId: String(asset.id),
    status: 'success',
    error: '',
    assetSaveStatus: 'success',
    assetSaveError: '',
    imageToolStatus: '',
    imageToolError: '',
    imageToolRetryOperation: '',
    imageToolRetryParameters: null,
  })
  return asset
}

function setFreeCanvasNodeMarker(nodeOrId, color) {
  return patchFreeCanvasNodeData(nodeOrId, {
    imageMarkerColor: String(color || ''),
  })
}

function canvasNodeLabel(node) {
  if (!node) return ''
  if (node.type === 'homeCanvasNode') return node.data?.title || '未命名自由节点'
  if (node.data?.label) return node.data.label
  if (node.data?.entity) return node.data.entity.name || node.data.entity.location || node.id
  if (node.data?.storyboard) return node.data.storyboard.shot_title || `分镜 ${node.data.storyboard.shot_number || node.data.storyboard.id}`
  if (node.data?.episode) return node.data.episode.title || `第 ${node.data.episode.episode_number || node.data.episode.id} 集`
  return String(node.id || '未命名节点')
}


function canvasNodeActions(node) {
  if (!node) return []
  if (node.type === 'homeCanvasNode') {
    const actions = ['open-node-config', 'duplicate-free-node', 'view-generation-history', 'delete-free-node', 'copy-node-ref']
    if (['image', 'video', 'audio'].includes(node.data?.kind)) {
      actions.push('mount-free-node-asset', `run-node-${node.data.kind}`)
    }
    if (nodeResultUrl(node)) actions.unshift('open-node-result', 'copy-node-result', 'download-node-result')
    if (nodeResultUrl(node) && !node.data?.savedAssetId) actions.unshift('save-node-result-asset')
    if (node.data?.savedAssetId) actions.unshift('copy-node-asset-ref')
    return [...new Set(actions)]
  }
  const actions = ['copy-node-ref']
  const sb = storyboardForNode(node)
  const runtimeStatus = nodeRuntimeStatus(node)
  const resultUrl = nodeResultUrl(node, runtimeStatus)
  if (resultUrl) {
    actions.unshift('open-node-result', 'copy-node-result', 'download-node-result')
    actions.unshift('use-node-result-downstream-reference')
    if (nodeResultTypeFromUrl(resultUrl, runtimeStatus?.resultType || node?.data?.kind) === 'image') {
      actions.unshift('set-node-result-main-image', 'set-node-result-first-frame', 'set-node-result-last-frame')
    }
    if (!runtimeStatus?.savedAssetId) actions.unshift('save-node-result-asset')
    if (resultNodeIdFromStatus(node, runtimeStatus)) actions.unshift('focus-node-result')
  }
  if (nodeAssignedAssets(node).length) actions.unshift(
    'set-assigned-asset-main-image',
    'set-assigned-asset-first-frame',
    'set-assigned-asset-last-frame',
    'copy-node-assigned-asset-ref',
    'unbind-node-assigned-asset',
  )
  if (runtimeStatus?.savedAssetId) actions.unshift('copy-node-asset-ref', 'assign-node-asset-selected')
  if (runtimeStatus?.retryAction) actions.unshift('retry-node-action')
  if (runtimeStatus?.nextStep) actions.unshift('continue-node-next-step')
  if ((runtimeStatus?.step === 'failed' && (runtimeStatus.retryStep || queueNodeRetryStep(node))) || (queueNodeFailure(node) && queueNodeRetryStep(node))) {
    actions.unshift('retry-node-failed')
  }
  if (canOpenNodeProduction(node)) actions.unshift('open-node-production')
  if (PANEL_NODE_TYPES.has(node.type)) actions.unshift('open-node-config')
  if (node.type === 'canvasProjectAsset') {
    actions.unshift('assign-project-asset-selected')
    return [...new Set(actions)]
  }
  if (node.type === 'canvasAsset') {
    return [...new Set([...actions, 'append-downstream-storyboard', 'focus-downstream-video'])]
  }
  if (sb) {
    actions.push('focus-upstream', 'focus-downstream-video')
    actions.push('append-downstream-storyboard')
    if (node.type === 'canvasStoryboard') {
      actions.push('duplicate-storyboard-node')
      actions.push('insert-downstream-storyboard')
      if (workflowGroupForNode(node)) actions.push('select-node-workflow', 'remove-node-workflow')
      actions.push('run-node-image', 'run-node-video', 'run-node-audio', 'preview-node-video')
      actions.push('create-workflow-from-node', 'run-node-workflow')
      if (isSelectedStoryboardNode(node) && selectedStoryboardIds.value.length > 1) actions.push('run-selected-storyboards')
    } else if (node.type === 'canvasMedia') {
      if (node.data?.kind === 'image') actions.push('run-node-image', 'run-node-video')
      else if (node.data?.kind === 'video') actions.push('preview-node-video', 'run-node-video')
      else if (node.data?.kind === 'audio') actions.push('run-node-audio')
      else if (node.data?.kind === 'text' || node.data?.kind === 'universal') actions.push('run-node-image', 'run-node-video', 'run-node-audio')
    }
  }
  return [...new Set(actions)]
}

function canOpenNodeProduction(node) {
  if (!node) return false
  if (['canvasStoryboard', 'canvasScript', 'canvasEpisode', 'canvasAsset'].includes(node.type)) return true
  return Boolean(getStoryboardRefFromNode(node)?.storyboardId)
}

function findGraphNode(nodeId) {
  return allGraphNodes.value.find((node) => String(node.id) === String(nodeId))
}

function syncProjectAssetNodeAsset(asset) {
  const assetId = projectAssetId(asset)
  if (!assetId) return
  const nodeId = `project-asset:${assetId}`
  const patchNode = (node) => {
    if (String(node.id) !== nodeId) return node
    const previousAsset = node.data?.asset || {}
    return {
      ...node,
      data: {
        ...node.data,
        asset: {
          ...previousAsset,
          ...asset,
          metadata: {
            ...(previousAsset.metadata || {}),
            ...(asset?.metadata || {}),
          },
        },
      },
    }
  }
  allGraphNodes.value = allGraphNodes.value.map(patchNode)
  nodes.value = nodes.value.map(patchNode)
}

function storyboardUsesAsset(storyboard, kind, assetId) {
  const id = Number(assetId)
  if (!storyboard || !Number.isFinite(id)) return false
  if (kind === 'character') return (storyboard.characters || []).some((item) => Number(item?.id ?? item) === id)
  if (kind === 'scene') return Number(storyboard.scene_id) === id || Number(storyboard.scene?.id) === id
  if (kind === 'prop') return (storyboard.prop_ids || storyboard.props || []).some((item) => Number(item?.id ?? item) === id)
  return false
}

function storyboardForNode(node) {
  if (node?.data?.storyboard) return node.data.storyboard
  const sbId = storyboardIdFromNodeId(node?.id)
  if (!sbId) return null
  for (const ep of drama.value?.episodes || []) {
    const sb = (ep.storyboards || []).find((item) => Number(item.id) === Number(sbId))
    if (sb) return sb
  }
  return null
}

function firstAssetNodeForStoryboard(storyboard) {
  const characterId = storyboard?.characters?.[0]?.id ?? storyboard?.characters?.[0]
  const sceneId = storyboard?.scene_id || storyboard?.scene?.id
  const propId = storyboard?.prop_ids?.[0] ?? storyboard?.props?.[0]?.id ?? storyboard?.props?.[0]
  const candidates = [
    characterId ? `char:${characterId}` : null,
    sceneId ? `scene:${sceneId}` : null,
    propId ? `prop:${propId}` : null,
  ].filter(Boolean)
  return candidates.find((id) => findGraphNode(id))
}

function firstStoryboardForAssetNode(node) {
  const match = String(node?.id || '').match(/^(char|scene|prop):(\d+)$/)
  if (!match) return null
  const kind = { char: 'character', scene: 'scene', prop: 'prop' }[match[1]]
  for (const ep of drama.value?.episodes || []) {
    const sb = (ep.storyboards || []).find((item) => storyboardUsesAsset(item, kind, match[2]))
    if (sb) return sb
  }
  return null
}

async function focusNodeOrWarn(nodeId, warning) {
  return focusCanvasNodeWithConfig(nodeId, warning)
}

async function focusCanvasNodeWithConfig(nodeId, warning = '') {
  const node = findGraphNode(nodeId)
  if (!node) {
    if (warning) ElMessage.warning(warning)
    return false
  }
  await focusCanvasNode(nodeId)
  if (PANEL_NODE_TYPES.has(node.type)) openNodeConfig(node)
  return true
}

async function focusUpstreamAsset(node) {
  if (node?.type === 'canvasAsset') {
    await focusCanvasNode(node.id)
    setHighlightAsset(node.id)
    return
  }
  const assetNodeId = firstAssetNodeForStoryboard(storyboardForNode(node))
  if (!assetNodeId) {
    ElMessage.warning('该节点暂无可定位的上游素材')
    return
  }
  setHighlightAsset(assetNodeId)
  await focusCanvasNode(assetNodeId)
}

async function focusDownstreamVideo(node) {
  const storyboard = node?.type === 'canvasAsset' ? firstStoryboardForAssetNode(node) : storyboardForNode(node)
  const targetId = storyboard ? `sbvid:${storyboard.id}` : null
  await focusNodeOrWarn(targetId, '该节点下游暂无视频节点')
}

async function appendDownstreamStoryboard(node, options = {}) {
  if (!node) return
  const sourceStoryboard = storyboardForNode(node) || (node.type === 'canvasAsset' ? firstStoryboardForAssetNode(node) : null)
  let episodeId = sourceStoryboard?.episode_id || node.data?.episodeId || filterEpisodeId.value
  if (!episodeId) {
    const eps = drama.value?.episodes || []
    if (eps.length === 1) episodeId = eps[0].id
  }
  if (!episodeId) {
    ElMessage.warning('请先选择集数，再追加下游分镜')
    return
  }

  const episode = (drama.value?.episodes || []).find((ep) => Number(ep.id) === Number(episodeId))
  const boards = episode?.storyboards || []
  const maxNum = boards.reduce((max, sb) => Math.max(max, Number(sb.storyboard_number || sb.shot_number || 0)), 0)
  const created = await storyboardsAPI.create({
    episode_id: episodeId,
    storyboard_number: maxNum + 1,
    title: `下游分镜 ${maxNum + 1}`,
    description: downstreamStoryboardDescription(node, sourceStoryboard, options.result),
  })
  const storyboard = created?.data ?? created
  const storyboardId = storyboard?.id ?? storyboard?.storyboard?.id
  if (!storyboardId) throw new Error('追加下游分镜失败：未返回分镜 ID')

  const targetNodeId = `sb:${storyboardId}`
  const sourcePosition = node.position || { x: 0, y: 0 }
  const targetPosition = { x: sourcePosition.x + 420, y: sourcePosition.y }
  const edge = toLibTvCanvasEdge({
    id: manualEdgeId({ source: node.id, target: targetNodeId }),
    source: node.id,
    target: targetNodeId,
    sourceHandle: null,
    targetHandle: null,
    data: { manual: true },
  })

  layoutCache.value = {
    ...(layoutCache.value || { version: 1 }),
    nodes: {
      ...(layoutCache.value?.nodes || {}),
      [targetNodeId]: targetPosition,
    },
  }
  if (!hasSameEdgeConnection(edge)) {
    allGraphEdges.value = decorateCanvasEdges([...allGraphEdges.value, edge])
  }
  await persistCanvasState({ layoutOnly: true })
  if (filterEpisodeId.value !== episodeId) filterEpisodeId.value = episodeId
  await refreshCanvas(false)
  await focusCanvasNode(targetNodeId)
  ElMessage.success('已追加下游分镜并连线')
  return targetNodeId
}

function downstreamStoryboardDescription(node, sourceStoryboard, result = {}) {
  const base = sourceStoryboard?.description
    ? `承接：${sourceStoryboard.description}`
    : node?.type === 'canvasAsset'
      ? `围绕${canvasNodeLabel(node)}设计新分镜`
      : ''
  const references = normalizeNodeResultReferences(node, result)
  return [base, ...references].filter(Boolean).join('\n')
}

function normalizeNodeResultReferences(node, result = {}) {
  const status = nodeRuntimeStatus(node) || {}
  const references = []
  const summary = String(result.resultSummary || status.resultSummary || '').trim()
  const resultRefs = Array.isArray(result.resultReferences || status.resultReferences)
    ? (result.resultReferences || status.resultReferences)
    : []
  const assetRef = assetReferenceText(nodeSavedAsset(node, status))
  const url = result.resultUrl || nodeResultUrl(node, status)
  if (summary) references.push(`参考结果：${summary}`)
  references.push(...resultRefs.map((value) => String(value || '').trim()).filter(Boolean))
  if (assetRef) references.push(assetRef)
  else if (url) references.push(`参考素材：${url}`)
  return [...new Set(references)]
}

async function useNodeResultAsDownstreamReference(node, result = {}) {
  const url = result?.resultUrl || nodeResultUrl(node)
  const references = normalizeNodeResultReferences(node, result)
  if (!node?.id || (!url && !references.length)) {
    throw new Error('该节点暂无可作为下游参考的结果')
  }
  return appendDownstreamStoryboard(node, { result })
}

function firstManualDownstreamStoryboardEdge(node) {
  if (!node?.id) return null
  return allGraphEdges.value.find((edge) => (
    String(edge?.source || '') === String(node.id)
    && String(edge?.target || '').startsWith('sb:')
    && (edge?.data?.manual === true || String(edge?.id || '').startsWith('manual:'))
  )) || null
}

async function insertDownstreamStoryboard(node) {
  const downstreamEdge = firstManualDownstreamStoryboardEdge(node)
  if (!downstreamEdge) {
    await appendDownstreamStoryboard(node)
    return
  }
  const sourceStoryboard = storyboardForNode(node)
  const episodeId = sourceStoryboard?.episode_id || node?.data?.episodeId || filterEpisodeId.value
  if (!episodeId) {
    ElMessage.warning('请先选择集数，再插入下游分镜')
    return
  }

  const episode = (drama.value?.episodes || []).find((ep) => Number(ep.id) === Number(episodeId))
  const boards = episode?.storyboards || []
  const maxNum = boards.reduce((max, sb) => Math.max(max, Number(sb.storyboard_number || sb.shot_number || 0)), 0)
  const created = await storyboardsAPI.create({
    episode_id: episodeId,
    storyboard_number: maxNum + 1,
    title: `插入分镜 ${maxNum + 1}`,
    description: sourceStoryboard?.description ? `承接：${sourceStoryboard.description}` : '插入到现有下游连线之间',
  })
  const storyboard = created?.data ?? created
  const storyboardId = storyboard?.id ?? storyboard?.storyboard?.id
  if (!storyboardId) throw new Error('插入下游分镜失败：未返回分镜 ID')

  const targetNodeId = `sb:${storyboardId}`
  const sourcePosition = node.position || { x: 0, y: 0 }
  const downstreamNode = findGraphNode(downstreamEdge.target)
  const downstreamPosition = downstreamNode?.position || { x: sourcePosition.x + 420, y: sourcePosition.y }
  const targetPosition = {
    x: sourcePosition.x + Math.max(180, Math.round((downstreamPosition.x - sourcePosition.x) / 2)),
    y: sourcePosition.y + Math.round((downstreamPosition.y - sourcePosition.y) / 2),
  }
  const firstEdge = toLibTvCanvasEdge({
    id: manualEdgeId({ source: node.id, target: targetNodeId }),
    source: node.id,
    target: targetNodeId,
    sourceHandle: null,
    targetHandle: null,
    data: { manual: true },
  })
  const secondEdge = toLibTvCanvasEdge({
    id: manualEdgeId({ source: targetNodeId, target: downstreamEdge.target }),
    source: targetNodeId,
    target: downstreamEdge.target,
    sourceHandle: null,
    targetHandle: downstreamEdge.targetHandle || null,
    data: { manual: true },
  })

  layoutCache.value = {
    ...(layoutCache.value || { version: 1 }),
    nodes: {
      ...(layoutCache.value?.nodes || {}),
      [targetNodeId]: targetPosition,
    },
  }
  const remainingEdges = allGraphEdges.value.filter((edge) => String(edge.id) !== String(downstreamEdge.id))
  const insertedEdges = [firstEdge, secondEdge].filter((edge) => !hasSameEdgeConnection(edge, remainingEdges))
  allGraphEdges.value = decorateCanvasEdges([...remainingEdges, ...insertedEdges])
  await persistCanvasState({ layoutOnly: true })
  if (filterEpisodeId.value !== episodeId) filterEpisodeId.value = episodeId
  await refreshCanvas(false)
  await focusCanvasNode(targetNodeId)
  ElMessage.success('已插入下游分镜并重连')
}

function cloneStoryboardCreatePayload(sourceStoryboard, episodeId, storyboardNumber) {
  return {
    episode_id: episodeId,
    scene_id: sourceStoryboard?.scene_id ?? null,
    storyboard_number: storyboardNumber,
    title: `${sourceStoryboard?.title || sourceStoryboard?.shot_title || `分镜 ${storyboardNumber}`} 副本`,
    description: sourceStoryboard?.description || '',
    location: sourceStoryboard?.location || '',
    time: sourceStoryboard?.time || '',
    duration: sourceStoryboard?.duration || 0,
    dialogue: sourceStoryboard?.dialogue || '',
    action: sourceStoryboard?.action || '',
    result: sourceStoryboard?.result || '',
    atmosphere: sourceStoryboard?.atmosphere || '',
    image_prompt: sourceStoryboard?.image_prompt || '',
    video_prompt: sourceStoryboard?.video_prompt || '',
    characters: sourceStoryboard?.characters || [],
  }
}

async function duplicateStoryboardNode(node) {
  const sourceStoryboard = storyboardForNode(node)
  const episodeId = sourceStoryboard?.episode_id || node?.data?.episodeId || filterEpisodeId.value
  if (!sourceStoryboard?.id || !episodeId) {
    ElMessage.warning('该节点不是可复制的分镜')
    return
  }
  const episode = (drama.value?.episodes || []).find((ep) => Number(ep.id) === Number(episodeId))
  const boards = episode?.storyboards || []
  const maxNum = boards.reduce((max, sb) => Math.max(max, Number(sb.storyboard_number || sb.shot_number || 0)), 0)
  const created = await storyboardsAPI.create(cloneStoryboardCreatePayload(sourceStoryboard, episodeId, maxNum + 1))
  const storyboard = created?.data ?? created
  const storyboardId = storyboard?.id ?? storyboard?.storyboard?.id
  if (!storyboardId) throw new Error('复制分镜失败：未返回分镜 ID')

  const targetNodeId = `sb:${storyboardId}`
  const sourcePosition = node.position || { x: 0, y: 0 }
  layoutCache.value = {
    ...(layoutCache.value || { version: 1 }),
    nodes: {
      ...(layoutCache.value?.nodes || {}),
      [targetNodeId]: { x: sourcePosition.x + 56, y: sourcePosition.y + 56 },
    },
  }
  await persistCanvasState({ layoutOnly: true })
  if (filterEpisodeId.value !== episodeId) filterEpisodeId.value = episodeId
  await refreshCanvas(false)
  await focusCanvasNode(targetNodeId)
  ElMessage.success('已复制分镜到画布')
  return targetNodeId
}

async function copyNodeReference(node) {
  const text = `${canvasNodeLabel(node)} · ${node?.id || ''}`
  await copyCanvasText(text, '节点引用已复制', '节点引用（请手动复制）')
}

async function copyCanvasText(text, successMessage, fallbackTitle) {
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(successMessage)
  } catch {
    ElMessageBox.alert(text, fallbackTitle, { confirmButtonText: '关闭', type: 'info' })
  }
}

function nodeRuntimeStatus(node) {
  if (!node) return null
  const direct = nodeStatus.get(String(node.id || ''))
  if (direct) return direct
  const sb = storyboardForNode(node)
  return sb?.id ? nodeStatus.get(`sb:${sb.id}`) : null
}

function nodeResultUrl(node, status = nodeRuntimeStatus(node)) {
  const statusUrl = statusResultUrl(status)
  if (statusUrl) return statusUrl
  if (node?.data?.url) return node.data.url
  if (node?.type === 'canvasProjectAsset') return assetMediaUrl(node.data?.asset)
  return videoUrlFromNode(node)
}

function nodeInputReferenceUrls(node) {
  const targetId = String(node?.id || '')
  if (!targetId) return []
  const urls = []
  for (const edge of allGraphEdges.value) {
    if (String(edge?.target || '') !== targetId) continue
    const sourceNode = findGraphNode(edge.source)
    const url = nodeResultUrl(sourceNode)
      || (sourceNode?.type === 'canvasProjectAsset' ? assetDisplayUrl(sourceNode.data?.asset) : '')
    if (url) urls.push(url)
  }
  for (const asset of nodeAssignedAssets(node)) {
    const url = assetDisplayUrl(asset)
    if (url) urls.push(url)
  }
  return [...new Set(urls)]
}

function nodeAssignedAssets(node) {
  const fromNode = Array.isArray(node?.data?.assignedAssets) ? node.data.assignedAssets : []
  if (fromNode.length) return fromNode
  const sb = storyboardForNode(node)
  return sb?.id ? (storyboardAssignedAssets.value[Number(sb.id)] || []) : []
}

function assetReferenceText(asset) {
  const id = projectAssetId(asset)
  if (!id) return ''
  const name = asset.name || asset.title || asset.filename || '素材'
  const url = assetDisplayUrl(asset) || assetLocalPath(asset) || ''
  return `@素材(${name}#${id}) ${url}`.trim()
}

function assignedAssetImagePayload(asset) {
  const localPath = assetLocalPath(asset)
  const imageUrl = assetImageUrl(asset)
    || asset?.display_url
    || asset?.asset_url
    || asset?.preview_url
    || asset?.url
    || asset?.image_url
    || ''
  if (!localPath && !imageUrl) return null
  return {
    image_url: imageUrl,
    local_path: localPath || undefined,
  }
}

function projectAssetId(asset) {
  if (asset?.raw_id) return asset.raw_id
  const id = String(asset?.id || '')
  return id.startsWith('project:') ? id.slice('project:'.length) : id
}

function assetDisplayUrl(asset) {
  return assetMediaUrl(asset)
    || asset?.display_url
    || asset?.asset_url
    || asset?.preview_url
    || asset?.url
    || asset?.image_url
    || asset?.video_url
    || asset?.audio_url
    || asset?.voice_url
    || asset?.ref_image
    || asset?.thumbnail_url
    || asset?.file_url
    || asset?.cover_url
    || asset?.poster_url
    || ''
}

function assetLocalPath(asset) {
  return asset?.local_path
    || asset?.path
    || asset?.file_path
    || asset?.image_local_path
    || asset?.video_local_path
    || asset?.audio_local_path
    || asset?.voice_local_path
    || asset?.thumbnail_local_path
    || ''
}

function selectedStoryboardMediaAssetPayload(asset) {
  const type = normalizePickedAssetType(asset)
  if (!['video', 'audio'].includes(type)) return null
  const url = assetDisplayUrl(asset)
  const localPath = assetLocalPath(asset)
  if (!url && !localPath) return null
  return { type, url, localPath }
}

function storyboardCharacterIds(storyboard) {
  return [...new Set((storyboard?.characters || [])
    .map((item) => Number(item?.id ?? item))
    .filter(Number.isFinite))]
}

function voiceCatalogBindId(asset) {
  const metadata = asset?.metadata || {}
  const voiceCatalog = asset?.voice_catalog || metadata.voice_catalog || {}
  return asset?.voice_catalog_id
    || metadata.voice_catalog_id
    || voiceCatalog.id
    || voiceCatalog.voice_id
    || (asset?.category === 'voice' && projectAssetId(asset) ? `asset-${projectAssetId(asset)}` : '')
}

async function bindVoiceAssetToSingleStoryboardCharacter(asset, storyboardId, { silent = false } = {}) {
  if (normalizePickedAssetType(asset) !== 'audio') return null
  const bindId = voiceCatalogBindId(asset)
  if (!bindId) return null
  const storyboard = findStoryboardInDrama(drama.value, storyboardId)?.storyboard
  const characterIds = storyboardCharacterIds(storyboard)
  if (characterIds.length !== 1) return null
  try {
    await characterAPI.bindVoiceCatalog(characterIds[0], bindId, { silentError: true })
    return { bound: true, characterId: characterIds[0], voiceCatalogId: bindId }
  } catch (error) {
    if (!silent) ElMessage.warning(error?.message || '音色已设为分镜音频，但绑定角色音色失败')
    return { bound: false, characterId: characterIds[0], voiceCatalogId: bindId, error: error?.message || '绑定角色音色失败' }
  }
}

function mediaTypeFromFile(file) {
  const mime = String(file?.type || '').toLowerCase()
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'image'
}

function mediaTypeFromUrl(url, fallback = 'image') {
  const value = String(url || '').toLowerCase().split('?')[0]
  if (/\.(mp4|webm|mov|m4v)$/.test(value)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(value)) return 'audio'
  return fallback || 'image'
}

function normalizePickedAssetType(asset) {
  const type = String(asset?.type || '').toLowerCase()
  if (['image', 'video', 'audio'].includes(type)) return type
  if (['voice', 'tone', 'sound', 'music', 'bgm', 'tts'].includes(type)) return 'audio'
  if (asset?.source_kind === 'voice_catalog' || asset?.voice_catalog || asset?.voice_catalog_id || asset?.voice_asset_id || asset?.voice_url || asset?.voice_local_path) return 'audio'
  const url = assetDisplayUrl(asset) || assetLocalPath(asset)
  return mediaTypeFromUrl(url, 'image')
}

function selectedStoryboardIdForAssetAttach() {
  const selectedIds = selectedStoryboardIds.value.map(Number).filter(Number.isFinite)
  return selectedIds.length === 1 ? selectedIds[0] : null
}

function projectAssetAttachPayload(asset, storyboardId) {
  const payload = { drama_id: drama.value.id, storyboard_id: storyboardId }
  if (asset?.category === 'canvas-result') {
    payload.metadata = {
      ...(asset.metadata || {}),
      canvas_storyboard_attached: true,
      attached_storyboard_id: storyboardId,
    }
  }
  return payload
}

function isStoryboardAssignedAsset(asset) {
  const storyboardId = Number(asset?.storyboard_id)
  if (!Number.isFinite(storyboardId)) return false
  if (asset?.category !== 'canvas-result') return true
  return asset?.metadata?.canvas_storyboard_attached === true
}

function assetAttachSlot(asset) {
  const type = normalizePickedAssetType(asset)
  if (type === 'video') return 'video'
  if (type === 'audio') return 'audio'
  return 'main'
}

function assetAttachRetryAction(asset) {
  const type = normalizePickedAssetType(asset)
  if (type === 'video') return 'attach_library_video'
  if (type === 'audio') return 'attach_library_audio'
  return 'attach_library_image'
}

function assetAttachRetryLabel(asset) {
  const type = normalizePickedAssetType(asset)
  if (type === 'video') return '重试挂载素材库视频'
  if (type === 'audio') return '重试挂载素材库音频'
  return '重试挂载素材库图片'
}

function canvasAssetStatusPayload(asset, overrides = {}) {
  const url = assetDisplayUrl(asset)
  const localPath = assetLocalPath(asset)
  const metadata = asset?.metadata || {}
  const pickerSource = asset?.picker_source || metadata.picker_source || asset?.source_kind || 'project'
  const pickerStatus = asset?.picker_status || metadata.picker_status || ''
  const pickerStoryboardId = Number(asset?.picker_storyboard_id || metadata.picker_storyboard_id || metadata.attached_storyboard_id || asset?.storyboard_id || 0) || null
  const voiceCatalogId = asset?.voice_catalog_id || metadata.voice_catalog_id || asset?.voice_catalog?.id || asset?.voice_catalog?.voice_id || null
  const voiceAssetId = asset?.voice_asset_id || metadata.voice_asset_id || asset?.voice_catalog?.asset_id || null
  return {
    resultUrl: url,
    resultType: normalizePickedAssetType(asset),
    savedAssetId: projectAssetId(asset),
    savedAssetName: asset?.name || asset?.title || asset?.filename || '项目素材',
    savedAssetUrl: url,
    savedAssetLocalPath: localPath,
    libraryAsset: asset || null,
    pickerSource,
    pickerStatus,
    pickerStoryboardId,
    voiceCatalogId,
    voiceAssetId,
    retryStep: 'library',
    retryLabel: '重试指派素材',
    autoClear: false,
    ...overrides,
  }
}

function canvasAssetAttachStatusPayload(asset, storyboardId, overrides = {}) {
  return canvasAssetStatusPayload(asset, {
    storyboardId: storyboardId || undefined,
    dramaId: drama.value?.id || undefined,
    attachedSlot: storyboardId ? assetAttachSlot(asset) : '',
    attachedToStoryboardId: storyboardId || null,
    ...overrides,
  })
}

function canvasAssetAttachFailurePayload(asset, storyboardId, overrides = {}) {
  return canvasAssetAttachStatusPayload(asset, storyboardId, {
    retryAction: storyboardId ? assetAttachRetryAction(asset) : '',
    retryActionLabel: storyboardId ? assetAttachRetryLabel(asset) : '',
    recoverable: true,
    ...overrides,
  })
}

function assetPickerTargetStoryboardIdFrom(source, asset = null) {
  return Number(
    source?.attachedToStoryboardId
    || source?.storyboardId
    || source?.pickerStoryboardId
    || asset?.metadata?.attached_storyboard_id
    || asset?.metadata?.picker_storyboard_id
    || asset?.metadata?.storyboard_id
    || asset?.storyboard_id
    || 0
  ) || null
}

function nodeFlowPosition(nodeId) {
  const node = findGraphNode(nodeId)
  return node?.position ? { x: node.position.x, y: node.position.y } : null
}

function openCanvasAssetLibraryRetry({ nodeId = '', asset = null, status = null, flowPosition = null, message = '请在素材库中重新选择素材…' } = {}) {
  const targetStoryboardId = assetPickerTargetStoryboardIdFrom(status, asset)
  canvasAssetPickerRetryNodeId.value = nodeId || ''
  canvasAssetPickerFlowPos.value = flowPosition || nodeFlowPosition(nodeId)
  canvasAssetPickerTargetStoryboardId.value = targetStoryboardId
  canvasAssetPickerVisible.value = true
  if (nodeId) {
    nodeStatus.set(nodeId, {
      ...(status || {}),
      step: 'library',
      message,
      storyboardId: targetStoryboardId || undefined,
      attachedToStoryboardId: targetStoryboardId || null,
      retryStep: 'library',
      retryLabel: '重新打开素材库',
      autoClear: false,
    })
  }
}

function canvasAssetFailureNode(message, flowPosition = null, asset = null, storyboardId = null) {
  const id = `asset-failure:${Date.now()}`
  const name = asset?.name || asset?.title || asset?.filename || '素材库调用失败'
  const targetStoryboardId = storyboardId || assetPickerTargetStoryboardIdFrom(null, asset)
  const node = {
    id,
    raw_id: id,
    name,
    type: normalizePickedAssetType(asset || { type: 'image' }),
    category: 'canvas-asset-failure',
    metadata: {
      source: 'canvas_asset_picker_failure',
      error: message,
      source_asset_id: asset?.raw_id || asset?.id || null,
      source_asset_name: name,
      picker_storyboard_id: targetStoryboardId,
      attached_storyboard_id: targetStoryboardId,
      flow_position: flowPosition ? { x: flowPosition.x, y: flowPosition.y } : null,
    },
  }
  canvasAssetFailureNodes.value = [...canvasAssetFailureNodes.value, node]
  if (flowPosition) {
    layoutCache.value = {
      ...(layoutCache.value || { version: 1 }),
      nodes: {
        ...(layoutCache.value?.nodes || {}),
        [`project-asset:${id}`]: { x: flowPosition.x, y: flowPosition.y },
      },
    }
  }
  rebuildGraph()
  const nodeId = `project-asset:${id}`
  nodeStatus.fail(nodeId, {
    message,
    errorDetail: message,
    ...canvasAssetAttachFailurePayload(asset || node, targetStoryboardId, {
      retryStep: 'library',
      resultType: node.type,
      savedAssetName: name,
    }),
    retryLabel: '重新打开素材库',
  })
  focusedNodeId.value = nodeId
  return nodeId
}

function clearCanvasAssetFailureNode(nodeId) {
  const id = String(nodeId || '').replace(/^project-asset:/, '')
  if (!id) return
  canvasAssetFailureNodes.value = canvasAssetFailureNodes.value.filter((node) => String(node.id) !== id)
  nodeStatus.clear(`project-asset:${id}`)
  rebuildGraph()
}

async function ensureProjectMediaAsset(asset) {
  const assetId = projectAssetId(asset)
  if (asset?.source_kind === 'project' && assetId) return { ...asset, id: assetId }
  if (!drama.value?.id) throw new Error('项目信息不完整，无法加入素材')
  const localPath = assetLocalPath(asset)
  const url = assetDisplayUrl(asset)
  if (!url && !localPath) throw new Error('该素材缺少可用媒体地址')
  return assetsAPI.create({
    drama_id: drama.value.id,
    name: asset?.name || asset?.title || asset?.filename || '素材库素材',
    type: normalizePickedAssetType(asset),
    category: asset?.category || (asset?.voice_catalog || asset?.voice_catalog_id || asset?.voice_asset_id ? 'voice' : 'canvas-library-pick'),
    url,
    local_path: localPath || undefined,
    metadata: {
      source: 'canvas_asset_picker',
      picker_source: asset?.picker_source || asset?.source_kind || 'library',
      picker_status: asset?.picker_status || '',
      picker_storyboard_id: asset?.picker_storyboard_id || null,
      source_asset_id: asset?.raw_id || asset?.id || null,
      reference_text: asset?.reference_text || '',
      display_url: url,
      local_path: localPath || '',
      voice_catalog_id: asset?.voice_catalog_id || asset?.voice_catalog?.id || asset?.voice_catalog?.voice_id || null,
      voice_asset_id: asset?.voice_asset_id || asset?.voice_catalog?.asset_id || null,
      voice_catalog: asset?.voice_catalog || null,
    },
  })
}

async function placeProjectAssetNode(asset, flowPosition = null) {
  const assetId = projectAssetId(asset)
  if (!assetId) return ''
  await loadProjectImageAssets()
  const nodeId = `project-asset:${assetId}`
  if (flowPosition) {
    layoutCache.value = {
      ...(layoutCache.value || { version: 1 }),
      nodes: {
        ...(layoutCache.value?.nodes || {}),
        [nodeId]: { x: flowPosition.x, y: flowPosition.y },
      },
    }
  }
  rebuildGraph()
  focusedNodeId.value = nodeId
  await nextTick()
  if (flowPosition) await persistCanvasState({ layoutOnly: true })
  await focusCanvasNode(nodeId)
  return nodeId
}

function resultNodeIdFromStatus(node, status = nodeRuntimeStatus(node)) {
  if (status?.resultNodeId) return status.resultNodeId
  const sb = storyboardForNode(node)
  if (!sb?.id || !status?.resultType) return ''
  if (status.resultType === 'image') return `sbimg:${sb.id}`
  if (status.resultType === 'video') return `sbvid:${sb.id}`
  if (status.resultType === 'audio') return `sbaud:${sb.id}:dialogue`
  return ''
}

function nodeResultStatusIds(node, status = nodeRuntimeStatus(node), extraIds = []) {
  const ids = [
    node?.id,
    status?.sourceNodeId,
    status?.resultNodeId,
    resultNodeIdFromStatus(node, status),
    ...extraIds,
  ]
  const storyboardId = status?.storyboardId || storyboardForNode(node)?.id || storyboardIdFromNodeId(node?.id)
  if (storyboardId) ids.push(`sb:${storyboardId}`)
  if (status?.runKey) {
    for (const [id, item] of Object.entries(nodeStatus.map)) {
      if (item?.runKey === status.runKey) ids.push(id)
    }
  }
  return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))]
}

function markNodeResultSavedAsset(node, status, saved, message, extraIds = []) {
  const nextStatus = {
    ...status,
    ...saved,
    actionError: '',
    retryAction: '',
    retryActionLabel: '',
    message,
    autoClear: false,
  }
  nodeResultStatusIds(node, status, extraIds).forEach((id) => {
    const current = nodeStatus.get(id) || {}
    nodeStatus.set(id, {
      ...current,
      ...nextStatus,
    })
  })
  return nextStatus
}

function openNodeResult(node) {
  const url = nodeResultUrl(node)
  if (!url) {
    ElMessage.warning('该节点暂无可打开的结果')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function downloadNodeResult(node) {
  const url = nodeResultUrl(node)
  if (!downloadCanvasResult(url, canvasNodeLabel(node) || 'node-result')) {
    ElMessage.warning('该节点暂无可下载的结果')
  }
}

async function copyNodeResult(node) {
  const url = nodeResultUrl(node)
  if (!url) {
    ElMessage.warning('该节点暂无可复制的结果链接')
    return
  }
  await copyCanvasText(url, '结果链接已复制', '结果链接（请手动复制）')
}

function nodeSavedAsset(node, status = nodeRuntimeStatus(node)) {
  if (node?.type === 'homeCanvasNode' && node.data?.savedAssetId) {
    return {
      id: node.data.savedAssetId,
      name: node.data.title || '自由节点结果素材',
      type: node.data.kind || 'image',
      category: 'canvas-result',
      url: node.data.url || '',
    }
  }
  if (!status?.savedAssetId) return null
  return {
    id: status.savedAssetId,
    name: status.savedAssetName || canvasNodeLabel(node) || '节点结果素材',
    type: status.resultType || 'image',
    category: 'canvas-result',
    url: status.savedAssetUrl || status.resultUrl || '',
    local_path: status.savedAssetLocalPath || '',
    duration: status.savedAssetDuration ?? undefined,
  }
}

async function copyNodeAssetReference(node) {
  const text = assetReferenceText(nodeSavedAsset(node))
  if (!text) {
    ElMessage.warning('该节点结果尚未存入素材库')
    return
  }
  await copyCanvasText(text, '素材引用已复制', '素材引用（请手动复制）')
}

async function assignNodeAssetToSelectedStoryboard(node, options = {}) {
  const asset = nodeSavedAsset(node)
  if (!asset) {
    ElMessage.warning('该节点结果尚未存入素材库')
    return false
  }
  return assignProjectAssetToSelectedStoryboard(asset, options)
}

function nodeResultTypeFromUrl(url, fallback = 'image') {
  const value = String(url || '').split(/[?#]/)[0]
  if (/\.(mp4|webm|mov|m4v)$/i.test(value)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(value)) return 'audio'
  return ['image', 'video', 'audio', 'text'].includes(fallback) ? fallback : 'image'
}

async function saveNodeResultAssetFromMenu(node) {
  const status = nodeRuntimeStatus(node)
  if (status?.savedAssetId) {
    ElMessage.info('该节点结果已在素材库中')
    return nodeSavedAsset(node, status)
  }
  const resultUrl = nodeResultUrl(node, status)
  if (!resultUrl) {
    ElMessage.warning('该节点暂无可入库结果')
    return null
  }
  const sb = storyboardForNode(node)
  const storyboardId = status?.storyboardId || sb?.id || storyboardIdFromNodeId(node?.id) || selectedStoryboardIdForAssetAttach() || null
  const resultType = status?.resultType || nodeResultTypeFromUrl(resultUrl, node?.data?.kind)
  const promptText = status?.promptText || (sb ? nodeStepPromptText(resultType, sb, node) : '')
  const saved = await saveNodeResultAsset(node, {
    resultUrl,
    resultType,
    resultLabel: status?.resultLabel || canvasNodeLabel(node) || '节点结果',
    resultSummary: status?.resultSummary || '',
    model: status?.model || '',
    taskId: status?.taskId || '',
    videoGenerationId: status?.videoGenerationId || '',
    requestPayload: status?.requestPayload || null,
    requestAudit: status?.requestAudit || null,
  }, promptText, storyboardId)
  if (!saved?.savedAssetId) {
    ElMessage.error('节点结果入库失败')
    return null
  }
  const nextStatus = markNodeResultSavedAsset(node, {
    ...status,
    resultUrl,
    resultType,
    storyboardId,
  }, saved, '节点结果已存入素材库')
  await loadProjectImageAssets()
  rebuildGraph()
  ElMessage.success('节点结果已存入素材库')
  return nodeSavedAsset(node, nextStatus)
}

async function setNodeResultAsStoryboardFrame(node, frameType) {
  const status = nodeRuntimeStatus(node)
  const resultUrl = nodeResultUrl(node, status)
  const resultType = nodeResultTypeFromUrl(resultUrl, status?.resultType || node?.data?.kind)
  if (resultType !== 'image') {
    ElMessage.warning('只有图片结果可以回填为分镜图或首尾帧')
    return false
  }
  const storyboardId = restoredNodeStoryboardId(node, status) || selectedStoryboardIdForAssetAttach()
  if (!storyboardId || !drama.value?.id) {
    ElMessage.warning('请先选中一个分镜后再回填节点结果')
    return false
  }
  const asset = nodeSavedAsset(node, status) || await saveNodeResultAssetFromMenu(node)
  const payload = assignedAssetImagePayload(asset)
  if (!payload) {
    ElMessage.warning('该节点结果暂无可回填的图片地址')
    return false
  }
  const label = frameType === 'storyboard_last' ? '尾帧' : frameType === 'storyboard_first' ? '首帧' : '分镜图'
  await imagesAPI.upload({
    storyboard_id: storyboardId,
    drama_id: drama.value.id,
    frame_type: frameType,
    ...payload,
  })
  await refreshDrama(true)
  ElMessage.success(`已将节点结果设为${label}`)
  return true
}

async function copyNodeAssignedAssetReference(node) {
  const firstAsset = nodeAssignedAssets(node)[0]
  const text = assetReferenceText(firstAsset)
  if (!text) {
    ElMessage.warning('该分镜暂无指派素材')
    return
  }
  await copyCanvasText(text, '指派素材引用已复制', '指派素材引用（请手动复制）')
}

async function unbindNodeAssignedAsset(node) {
  const firstAsset = nodeAssignedAssets(node)[0]
  const assetId = projectAssetId(firstAsset)
  if (!assetId) {
    ElMessage.warning('该分镜暂无可解绑的指派素材')
    return false
  }
  await assetsAPI.update(assetId, { storyboard_id: null })
  await loadProjectImageAssets()
  rebuildGraph()
  ElMessage.success('已解绑当前分镜素材')
  return true
}

async function setNodeAssignedAssetFrame(node, frameType) {
  const sb = storyboardForNode(node)
  const firstAsset = nodeAssignedAssets(node)[0]
  const payload = assignedAssetImagePayload(firstAsset)
  if (!sb?.id || !drama.value?.id || !payload) {
    ElMessage.warning('该分镜暂无可回填的指派素材')
    return false
  }
  const label = frameType === 'storyboard_last' ? '尾帧' : frameType === 'storyboard_first' ? '首帧' : '分镜图'
  await imagesAPI.upload({
    storyboard_id: sb.id,
    drama_id: drama.value.id,
    frame_type: frameType,
    ...payload,
  })
  await refreshDrama(true)
  ElMessage.success(`已将指派素材设为${label}`)
  return true
}

async function assignProjectAssetToSelectedStoryboard(asset, options = {}) {
  const silent = options.silent === true
  const returnDetail = options.returnDetail === true
  const explicitStoryboardId = Number(options.storyboardId || options.targetStoryboardId || 0)
  const fail = (message) => {
    if (!silent) ElMessage.warning(message)
    return returnDetail ? { ok: false, message } : false
  }
  const success = (message = '已指派素材到选中分镜', detail = {}) => returnDetail ? { ok: true, message, ...detail } : true
  const selectedIds = selectedStoryboardIds.value.map(Number).filter(Number.isFinite)
  if (!Number.isFinite(explicitStoryboardId) || explicitStoryboardId <= 0) {
    if (selectedIds.length !== 1) {
      return fail(selectedIds.length ? '请只选中一个分镜后再指派素材' : '请先选中一个分镜')
    }
  }
  const storyboardId = Number.isFinite(explicitStoryboardId) && explicitStoryboardId > 0 ? explicitStoryboardId : selectedIds[0]
  if (!storyboardId) {
    return fail(selectedIds.length ? '请只选中一个分镜后再指派素材' : '请先选中一个分镜')
  }
  const assetId = projectAssetId(asset)
  if (!drama.value?.id || !assetId) {
    return fail(!assetId ? '素材信息不完整，无法指派' : '缺少项目 ID，无法指派素材')
  }
  const mediaPayload = selectedStoryboardMediaAssetPayload(asset)
  let resultMessage = '已指派素材到选中分镜'
  const updatedAsset = await assetsAPI.update(assetId, projectAssetAttachPayload(asset, storyboardId))
  const assignedAsset = { ...asset, ...(updatedAsset || {}), storyboard_id: storyboardId }
  syncProjectAssetNodeAsset(assignedAsset)
  if (mediaPayload?.type === 'video') {
    await videosAPI.attach({
      storyboard_id: storyboardId,
      drama_id: drama.value.id,
      video_url: mediaPayload.url,
      local_path: mediaPayload.localPath || undefined,
      duration: asset?.duration ?? undefined,
    })
    resultMessage = '已指派素材并设为分镜成片'
    await refreshDrama(true)
  } else if (mediaPayload?.type === 'audio') {
    await storyboardsAPI.update(storyboardId, {
      audio_local_path: mediaPayload.localPath || undefined,
      audio_url: mediaPayload.localPath ? undefined : mediaPayload.url,
    })
    const voiceBind = await bindVoiceAssetToSingleStoryboardCharacter(assignedAsset, storyboardId, { silent })
    resultMessage = voiceBind?.bound ? '已指派音色并绑定到分镜角色' : '已指派素材并设为分镜音频'
    await refreshDrama(true)
  } else {
    await loadProjectImageAssets()
    rebuildGraph()
  }
  await focusCanvasNode(`sb:${storyboardId}`)
  if (!silent) ElMessage.success(resultMessage)
  return success(resultMessage, { storyboardId, asset: assignedAsset })
}

async function autoAssignCanvasAssetToSelectedStoryboard(asset) {
  const selectedIds = selectedStoryboardIds.value.map(Number).filter(Number.isFinite)
  if (selectedIds.length !== 1) return { attempted: false }
  const storyboardId = selectedIds[0]
  try {
    const result = await assignProjectAssetToSelectedStoryboard(asset, { silent: true, returnDetail: true, storyboardId })
    return { attempted: true, storyboardId, ...(result || {}) }
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      storyboardId,
      message: error?.message || '素材指派失败',
    }
  }
}

async function runCanvasProjectAssetNodeStep(node, step) {
  if (step !== 'library') {
    ElMessage.warning('该项目素材节点暂不支持该操作')
    return
  }
  const nodeId = String(node?.id || '')
  const asset = node?.data?.asset
  const existingStatus = nodeStatus.get(nodeId)
  if (asset?.category === 'canvas-asset-failure') {
    openCanvasAssetLibraryRetry({
      nodeId,
      asset,
      status: existingStatus,
      flowPosition: nodeFlowPosition(nodeId),
    })
    return
  }
  const targetStoryboardId = selectedStoryboardIdForAssetAttach()
    || Number(existingStatus?.attachedToStoryboardId || existingStatus?.storyboardId || 0)
    || null
  const retryPayload = canvasAssetAttachStatusPayload(asset, targetStoryboardId)
  if (!nodeId) return
  nodeStatus.set(nodeId, {
    step: 'library',
    message: '指派素材到分镜中…',
    ...retryPayload,
  })
  try {
    const result = await assignProjectAssetToSelectedStoryboard(asset, { silent: true, returnDetail: true, storyboardId: targetStoryboardId })
    if (!result?.ok) throw new Error(result?.message || '素材未指派，请选中一个分镜后重试')
    nodeStatus.success(nodeId, {
      message: result.message || '已指派素材到选中分镜',
      ...canvasAssetAttachStatusPayload(result.asset || asset, result.storyboardId || targetStoryboardId),
    })
  } catch (error) {
    const message = error?.message || '素材指派失败'
    nodeStatus.fail(nodeId, {
      message,
      errorDetail: message,
      ...canvasAssetAttachFailurePayload(asset, targetStoryboardId),
    })
    ElMessage.error(message)
  }
}

function openCanvasAssetLibrary(flowPosition = null) {
  canvasAssetPickerFlowPos.value = flowPosition
  canvasAssetPickerRetryNodeId.value = ''
  canvasAssetPickerTargetStoryboardId.value = selectedStoryboardIdForAssetAttach()
  canvasAssetPickerTargetFreeNodeId.value = ''
  canvasAssetPickerVisible.value = true
}

function openFreeNodeAssetLibrary(nodeOrId) {
  const node = freeCanvasNodeById(nodeOrId)
  if (node?.type !== 'homeCanvasNode' || node.data?.kind === 'text') return
  canvasAssetPickerFlowPos.value = node.position || null
  canvasAssetPickerRetryNodeId.value = ''
  canvasAssetPickerTargetStoryboardId.value = null
  canvasAssetPickerTargetFreeNodeId.value = String(node.id)
  canvasAssetPickerVisible.value = true
}

function openCanvasUpload(flowPosition = null, accept = CANVAS_MEDIA_ACCEPT) {
  canvasUploadFlowPos.value = flowPosition
  canvasUploadAccept.value = accept || CANVAS_MEDIA_ACCEPT
  canvasUploadInput.value?.click()
}

async function createCanvasProjectAssetFromUpload(file, flowPosition = null, offsetIndex = 0) {
  if (!drama.value?.id) throw new Error('项目信息不完整，无法上传素材')
  const asset = await uploadAPI.uploadMedia(file, { dramaId: drama.value.id })
  if (!asset?.id) throw new Error('素材上传成功但未返回资产记录')
  const targetPos = flowPosition ? { x: flowPosition.x + offsetIndex * 36, y: flowPosition.y + offsetIndex * 36 } : null
  const nodeId = await placeProjectAssetNode(asset, targetPos)
  const assignResult = await autoAssignCanvasAssetToSelectedStoryboard(asset)
  if (nodeId) {
    if (assignResult.attempted && !assignResult.ok) {
      const message = assignResult.message || '素材已加入画布，但未指派到分镜'
      nodeStatus.fail(nodeId, {
        ...canvasAssetAttachFailurePayload(asset, assignResult.storyboardId, {
          message,
          errorDetail: message,
          retryStep: 'library',
          retryLabel: '重新指派素材',
          autoClear: false,
        }),
      })
    } else {
      nodeStatus.success(nodeId, {
        ...canvasAssetAttachStatusPayload(assignResult.asset || asset, assignResult.storyboardId, {
          message: assignResult.attempted ? '已上传并指派到分镜' : '已上传并加入画布',
          savedAssetName: asset.name || file.name || '上传素材',
          retryLabel: '重新指派素材',
          autoClear: false,
        }),
      })
    }
  }
  return asset
}

async function onCanvasUpload(event) {
  const files = Array.from(event?.target?.files || [])
  if (!files.length) return
  const flowPosition = canvasUploadFlowPos.value
  let ok = 0
  for (const [index, file] of files.entries()) {
    try {
      await createCanvasProjectAssetFromUpload(file, flowPosition, index)
      ok += 1
    } catch (error) {
      ElMessage.warning(`${file.name || '素材'} 上传失败：${error?.message || '未知错误'}`)
    }
  }
  if (ok) ElMessage.success(`已上传 ${ok} 个素材到画布`)
  canvasUploadFlowPos.value = null
  canvasUploadAccept.value = CANVAS_MEDIA_ACCEPT
  if (event?.target) event.target.value = ''
}

async function createCanvasProjectAssetFromUrl(url, flowPosition = null) {
  if (!drama.value?.id) throw new Error('项目信息不完整，无法粘贴素材')
  const asset = await assetsAPI.create({
    drama_id: drama.value.id,
    name: '粘贴素材',
    type: mediaTypeFromUrl(url),
    category: 'canvas-paste',
    url,
    metadata: { source: 'canvas_context_paste' },
  })
  const nodeId = await placeProjectAssetNode(asset, flowPosition)
  const assignResult = await autoAssignCanvasAssetToSelectedStoryboard(asset)
  if (nodeId) {
    if (assignResult.attempted && !assignResult.ok) {
      const message = assignResult.message || '素材已加入画布，但未指派到分镜'
      nodeStatus.fail(nodeId, {
        ...canvasAssetAttachFailurePayload(asset, assignResult.storyboardId, {
          message,
          errorDetail: message,
          retryStep: 'library',
          retryLabel: '重新指派素材',
          autoClear: false,
        }),
      })
    } else {
      nodeStatus.success(nodeId, {
        ...canvasAssetAttachStatusPayload(assignResult.asset || asset, assignResult.storyboardId, {
          message: assignResult.attempted ? '已粘贴并指派到分镜' : '已粘贴素材到画布',
          savedAssetName: asset.name || '粘贴素材',
          retryLabel: '重新指派素材',
          autoClear: false,
        }),
      })
    }
  }
}

async function pasteCanvasClipboard(flowPosition = null) {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((value) => /^(image|video|audio)\//.test(value))
        if (!type) continue
        const blob = await item.getType(type)
        const file = new File([blob], `clipboard.${type.split('/')[1] || 'bin'}`, { type })
        await createCanvasProjectAssetFromUpload(file, flowPosition)
        ElMessage.success('已粘贴剪贴板素材到画布')
        return
      }
    }
    const text = (await navigator.clipboard?.readText?.())?.trim()
    if (!/^https?:\/\//i.test(text || '')) throw new Error('剪贴板没有可用的媒体文件或链接')
    await createCanvasProjectAssetFromUrl(text, flowPosition)
    ElMessage.success('已粘贴媒体链接到画布')
  } catch (error) {
    ElMessage.warning(error?.message || '读取剪贴板失败')
  }
}

async function onCanvasAssetLibraryPick(asset) {
  let nodeId = ''
  let projectAsset = null
  const retryNodeId = canvasAssetPickerRetryNodeId.value
  const targetFreeNodeId = canvasAssetPickerTargetFreeNodeId.value
  const targetStoryboardId = canvasAssetPickerTargetStoryboardId.value || selectedStoryboardIdForAssetAttach()
  try {
    if (targetFreeNodeId) {
      const targetNode = freeCanvasNodeById(targetFreeNodeId)
      if (!targetNode) throw new Error('目标节点已不存在，请重新选择')
      const assetType = normalizePickedAssetType(asset)
      if (assetType !== targetNode.data?.kind) {
        throw new Error(`当前${targetNode.data?.kind === 'image' ? '图片' : targetNode.data?.kind === 'video' ? '视频' : '音频'}节点不能挂载${assetType === 'image' ? '图片' : assetType === 'video' ? '视频' : '音频'}素材`)
      }
      projectAsset = await ensureProjectMediaAsset(asset)
      const url = assetDisplayUrl(projectAsset)
      if (!url) throw new Error('所选素材没有可用地址')
      await patchFreeCanvasNodeData(targetFreeNodeId, {
        url,
        status: 'success',
        error: '',
        savedAssetId: String(projectAssetId(projectAsset) || ''),
        assetSaveStatus: 'success',
        assetSaveError: '',
        taskId: '',
        imageToolStatus: '',
        imageToolError: '',
        imageToolRetryOperation: '',
        imageToolRetryParameters: null,
      })
      ElMessage.success('素材已挂载到当前节点')
      return
    }
    projectAsset = await ensureProjectMediaAsset(asset)
    nodeId = await placeProjectAssetNode(projectAsset, canvasAssetPickerFlowPos.value)
    if (retryNodeId) clearCanvasAssetFailureNode(retryNodeId)
    let resultMessage = nodeId ? '已从素材库加入画布' : '素材已加入项目素材库'
    if (targetStoryboardId) {
      const assignResult = await assignProjectAssetToSelectedStoryboard(projectAsset, { silent: true, returnDetail: true, storyboardId: targetStoryboardId })
      if (!assignResult?.ok) throw new Error(assignResult?.message || '素材未指派，请选中一个分镜后重试')
      projectAsset = assignResult.asset || projectAsset
      resultMessage = '已加入画布并指派到分镜'
    } else {
      ElMessage.success(resultMessage)
    }
    if (nodeId) {
      nodeStatus.success(nodeId, {
        ...canvasAssetAttachStatusPayload(projectAsset || asset, targetStoryboardId, {
          message: resultMessage,
          retryLabel: '重新指派素材',
        }),
      })
    }
  } catch (e) {
    if (targetFreeNodeId) {
      ElMessage.error(e?.message || '素材挂载失败')
      return
    }
    if (!nodeId) nodeId = canvasAssetFailureNode(e?.message || '素材库素材加入画布失败', canvasAssetPickerFlowPos.value, asset, targetStoryboardId)
    if (nodeId) {
      const message = e?.message || '素材库素材加入画布失败'
      nodeStatus.fail(nodeId, {
        ...canvasAssetAttachFailurePayload(projectAsset || asset, targetStoryboardId, {
          message,
          errorDetail: message,
        }),
        retryStep: 'library',
        retryLabel: targetStoryboardId ? '重新选择素材' : '重试指派素材',
      })
    }
    ElMessage.error(e?.message || '素材库素材加入画布失败')
  } finally {
    canvasAssetPickerFlowPos.value = null
    canvasAssetPickerRetryNodeId.value = ''
    canvasAssetPickerTargetStoryboardId.value = null
    canvasAssetPickerTargetFreeNodeId.value = ''
  }
}

async function focusNodeResult(node) {
  const resultNodeId = resultNodeIdFromStatus(node)
  if (!resultNodeId) {
    ElMessage.warning('该节点暂无可定位的结果节点')
    return
  }
  await focusNodeOrWarn(resultNodeId, '该节点暂无可定位的结果节点')
}

async function retryFailedNode(node) {
  const status = nodeRuntimeStatus(node)
  const retryStep = status?.retryStep || queueNodeRetryStep(node)
  if (!retryStep) {
    ElMessage.warning('该节点暂无可重试步骤')
    return
  }
  await focusCanvasNode(node.id)
  await runCanvasNodeStep(node, retryStep)
}

async function continueNodeNextStep(node) {
  const status = nodeRuntimeStatus(node)
  if (!status?.nextStep) {
    ElMessage.warning('该节点暂无可继续的下游步骤')
    return
  }
  await focusCanvasNode(node.id)
  await runCanvasNodeStep(node, status.nextStep)
}

function frameTypeFromRetryAction(action, status) {
  const slot = action === 'attach_library_image'
    ? (status?.attachedSlot || 'main')
    : String(action || '').replace('attach_image_', '')
  if (slot === 'first') return 'storyboard_first'
  if (slot === 'last') return 'storyboard_last'
  return undefined
}

function clearNodeRetryAction(node, status, message = '节点结果操作已恢复') {
  if (!node?.id) return
  nodeStatus.set(node.id, {
    ...status,
    actionError: '',
    retryAction: '',
    retryActionLabel: '',
    message,
    autoClear: false,
  })
}

async function retryNodeFailedAction(node) {
  const status = nodeRuntimeStatus(node)
  const action = status?.retryAction
  if (!action) {
    ElMessage.warning('该节点暂无可重试操作')
    return
  }
  let recovered = false
  if (action === 'save_result_asset') {
    recovered = Boolean(await saveNodeResultAssetFromMenu(node))
  } else if (action === 'use_downstream_reference') {
    await useNodeResultAsDownstreamReference(node)
    recovered = true
  } else if (action === 'attach_library_image' || action.startsWith('attach_image_')) {
    recovered = await setNodeResultAsStoryboardFrame(node, frameTypeFromRetryAction(action, status))
  } else if (['attach_video', 'attach_audio', 'attach_library_video', 'attach_library_audio'].includes(action)) {
    const asset = nodeSavedAsset(node, status) || await saveNodeResultAssetFromMenu(node)
    if (!asset) return
    recovered = await assignNodeAssetToSelectedStoryboard(node, {
      storyboardId: restoredNodeStoryboardId(node, status) || selectedStoryboardIdForAssetAttach(),
    })
  } else {
    ElMessage.warning('该节点操作暂不支持从右键重试')
    return
  }
  if (recovered) clearNodeRetryAction(node, nodeRuntimeStatus(node))
}


function nodeStepStatusLabel(step, node) {
  if (step === 'image' && node?.data?.frameKind === 'first') return '首帧生成中…'
  if (step === 'image' && node?.data?.frameKind === 'last') return '尾帧生成中…'
  if (step === 'link_tail_frame') return '尾帧衔接中…'
  return CANVAS_NODE_STATUS_LABELS[step] || '处理中…'
}

function nodeStepResultUrl(node, step, storyboard) {
  const nodeUrl = node?.data?.url || ''
  if (nodeUrl) return nodeUrl
  if (!storyboard) return ''
  if (step === 'image') {
    const frameKind = node?.data?.frameKind
    if (frameKind === 'first') return imageRecordUrl(resolveSbFirstImageRecord(storyboard, imagesBySbId.value))
    if (frameKind === 'last') return imageRecordUrl(resolveSbLastImageRecord(storyboard, imagesBySbId.value))
    return imageRecordUrl(resolveSbMainImageRecord(storyboard, imagesBySbId.value))
  }
  if (step === 'video') return videoRecordUrl(resolveSbVideoRecord(storyboard, videosBySbId.value))
  if (step === 'audio') return audioUrl(storyboard.audio_local_path || storyboard.audio_url || '')
  return ''
}

function videoNodeNextAction(storyboard) {
  const fallback = { nextStep: 'audio', nextLabel: '继续配音' }
  if (!drama.value || !storyboard?.id) return fallback
  const found = findStoryboardInDrama(drama.value, storyboard.id)
  const current = found?.storyboard || storyboard
  const { next } = found?.episode ? getAdjacentStoryboards(found.episode, current.id) : {}
  if (next && canChainStoryboardFrames(next, current)) {
    return { nextStep: 'link_tail_frame', nextLabel: '尾帧衔接' }
  }
  return fallback
}

function nodeStepResultInfo(node, step, storyboardId, storyboard = null) {
  const id = String(node?.id || '')
  const frameKind = node?.data?.frameKind
  const resultNodeId = step === 'image'
    ? (frameKind ? `sbimg-${frameKind}:${storyboardId}` : (id.startsWith('sbimg') ? id : `sbimg:${storyboardId}`))
    : step === 'video'
      ? (id.startsWith('sbvid:') ? id : `sbvid:${storyboardId}`)
      : step === 'audio'
        ? (id.startsWith('sbaud:') ? id : `sbaud:${storyboardId}:dialogue`)
        : id
  const resultNode = findGraphNode(resultNodeId) || findGraphNode(id) || node
  const resultType = step === 'audio' ? 'audio' : step === 'link_tail_frame' ? 'text' : step
  const labelMap = { image: '图片已生成', video: '视频已生成', audio: '音频已生成', text: '尾帧衔接完成' }
  const nextMap = {
    image: { nextStep: 'video', nextLabel: '继续生成视频' },
    video: videoNodeNextAction(storyboard),
  }
  return {
    resultUrl: nodeStepResultUrl(resultNode, step, storyboard),
    resultNodeId,
    resultType,
    resultLabel: labelMap[resultType] || '结果已生成',
    ...(nextMap[resultType] || {}),
  }
}

function resultLocalPathFromUrl(url) {
  const value = String(url || '')
  const marker = '/static/'
  const index = value.indexOf(marker)
  if (index < 0) return ''
  return value.slice(index + marker.length).split(/[?#]/)[0] || ''
}

function nodeResultAssetName(node, resultInfo) {
  const label = node?.data?.label || node?.data?.title || resultInfo?.resultLabel || '节点结果'
  const filename = String(resultInfo?.resultUrl || '').split(/[?#]/)[0].split('/').pop()
  return filename ? `${label}-${filename}` : label
}

async function saveNodeResultAsset(node, resultInfo, promptText, storyboardId) {
  if (!resultInfo?.resultUrl || !drama.value?.id) return null
  try {
    const asset = await assetsAPI.create({
      drama_id: drama.value.id,
      storyboard_id: storyboardId,
      name: nodeResultAssetName(node, resultInfo),
      type: resultInfo.resultType || 'image',
      category: 'canvas-result',
      url: resultInfo.resultUrl,
      local_path: resultLocalPathFromUrl(resultInfo.resultUrl) || undefined,
      metadata: {
        source: 'canvas_node_result',
        canvas_node_id: node?.id || '',
        result_label: resultInfo.resultLabel || '',
        prompt_text: promptText || '',
        model: resultInfo.model || '',
        task_id: resultInfo.taskId || '',
        video_generation_id: resultInfo.videoGenerationId || '',
        request_payload: resultInfo.requestPayload || null,
        request_audit: resultInfo.requestAudit || null,
        auto_saved: true,
      },
    })
    if (!asset?.id) return null
    return {
      savedAssetId: asset.id,
      savedAssetName: asset.name || nodeResultAssetName(node, resultInfo),
      savedAssetUrl: asset.url || resultInfo.resultUrl,
      savedAssetLocalPath: asset.local_path || '',
      savedAssetDuration: asset.duration ?? null,
    }
  } catch (error) {
    console.warn('auto save canvas node result asset failed', error)
    return null
  }
}

function nodeStepPromptText(step, sb, node) {
  if (!sb) return ''
  if (step === 'image') {
    const frameKind = node?.data?.frameKind
    if (frameKind === 'last') return sb.video_prompt || sb.result || sb.action || sb.description || ''
    return sb.polished_prompt || sb.image_prompt || sb.description || sb.action || ''
  }
  if (step === 'video') {
    const genOpts = getCanvasGenerationOptions()
    const model = getStoryboardVideoModel(sb, genOpts)
    const voiceSnapshot = buildStoryboardVoiceSnapshot(drama.value, sb)
    return appendVoicePromptToVideoPrompt({
      prompt: sb.video_prompt || sb.polished_prompt || sb.image_prompt || sb.description || '',
      policy: classifyVideoVoicePolicy({ model }),
      characters: voiceSnapshot.characters,
    })
  }
  if (step === 'audio') return sb.dialogue || ''
  return ''
}

async function linkStoryboardTailFrameFromNode(storyboard) {
  if (!drama.value?.id || !storyboard?.id) throw new Error('项目信息不完整，无法尾帧衔接')
  const found = findStoryboardInDrama(drama.value, storyboard.id)
  const current = found?.storyboard || storyboard
  const { next } = getAdjacentStoryboards(found?.episode, current.id)
  if (!next) throw new Error('当前分镜没有下一镜，无法尾帧衔接')
  if (!canChainStoryboardFrames(next, current)) throw new Error('跨场景不自动锁定尾帧')
  const result = await storyboardsAPI.linkTailFrame(current.id, { drama_id: drama.value.id })
  return { nextStoryboardId: result?.next_storyboard_id || next.id }
}

function shouldKeepNodeStatus(nodeId) {
  return ['failed', 'success'].includes(nodeStatus.get(nodeId)?.step)
}

function nodeStepStatusIds(node, step, storyboardId) {
  return [...new Set([
    node?.id,
    `sb:${storyboardId}`,
    nodeStepResultInfo(node, step, storyboardId).resultNodeId,
  ].filter(Boolean))]
}

function setNodeStepStatus(statusIds, payload) {
  statusIds.forEach((id) => nodeStatus.set(id, payload))
}

function successNodeStepStatus(statusIds, payload) {
  statusIds.forEach((id) => nodeStatus.success(id, payload))
}

function failNodeStepStatus(statusIds, payload) {
  statusIds.forEach((id) => nodeStatus.fail(id, payload))
}

function clearTransientNodeStepStatus(statusIds) {
  statusIds.forEach((id) => {
    if (!shouldKeepNodeStatus(id)) nodeStatus.clear(id)
  })
}

function previousNodeStepResultPayload(statusIds) {
  for (const id of statusIds) {
    const status = nodeStatus.get(id)
    const resultUrl = statusResultUrl(status)
    if (!resultUrl && !status?.savedAssetId) continue
    return {
      resultUrl,
      resultNodeId: status?.resultNodeId || '',
      resultType: status?.resultType || '',
      resultLabel: status?.resultLabel || '上次成功结果',
      resultSummary: status?.resultSummary || '失败前结果已保留',
      savedAssetId: status?.savedAssetId || '',
      savedAssetName: status?.savedAssetName || '',
      savedAssetUrl: status?.savedAssetUrl || '',
      savedAssetLocalPath: status?.savedAssetLocalPath || '',
      savedAssetDuration: status?.savedAssetDuration ?? null,
      recoverable: true,
    }
  }
  return {}
}

function nodeStepTaskStatusOptions(statusIds, basePayload) {
  return {
    onTask(task) {
      setNodeStepStatus(statusIds, {
        ...basePayload,
        taskId: task?.taskId || '',
        message: `${basePayload.message || '处理中…'} · 任务已创建`,
      })
    },
    onPoll(task) {
      setNodeStepStatus(statusIds, {
        ...basePayload,
        taskId: task?.id || task?.task_id || basePayload.taskId || '',
        progress: task?.progress ?? null,
        message: task?.message || task?.status_message || basePayload.message,
      })
    },
  }
}

async function runCanvasNodeStep(node, step) {
  if (isStandaloneCanvas.value && node?.type === 'homeCanvasNode') {
    await runFreeCanvasNode(node)
    return
  }
  if (node?.type === 'canvasProjectAsset') {
    await runCanvasProjectAssetNodeStep(node, step)
    return
  }
  if (node?.type === 'canvasAsset') {
    await runCanvasAssetNodeStep(node, step)
    return
  }

  const sb = storyboardForNode(node)
  if (!drama.value || !sb?.id) {
    ElMessage.warning('该节点没有绑定分镜，无法执行生成')
    return
  }
  const nodeId = node?.id
  const statusIds = nodeStepStatusIds(node, step, sb.id)
  const runKey = `storyboard:${sb.id}:${step}:${Date.now()}`
  const statusMessage = nodeStepStatusLabel(step, node)
  const initialPromptText = nodeStepPromptText(step, sb, node)
  const upstreamReferenceUrlsForNode = nodeInputReferenceUrls(node)
  const previousResultPayload = previousNodeStepResultPayload(statusIds)
  const baseStatusPayload = {
    step,
    message: statusMessage,
    promptText: initialPromptText,
    runKey,
    sourceNodeId: nodeId,
    upstreamReferenceUrls: upstreamReferenceUrlsForNode,
  }
  setNodeStepStatus(statusIds, baseStatusPayload)
  try {
    const found = findStoryboardInDrama(drama.value, sb.id)
    const latestSb = found?.storyboard || sb
    const promptText = nodeStepPromptText(step, latestSb, node)
    const taskStatusOptions = nodeStepTaskStatusOptions(statusIds, { ...baseStatusPayload, promptText })
    setNodeStepStatus(statusIds, { ...baseStatusPayload, promptText })
    const genOpts = {
      ...getCanvasGenerationOptions(),
      upstreamReferenceUrls: upstreamReferenceUrlsForNode,
    }
    let operationResult = null
    if (step === 'image') await runImageStep(drama.value, latestSb, genOpts, node?.data?.frameKind || '', taskStatusOptions)
    else if (step === 'video') operationResult = await runVideoStep(drama.value, latestSb, genOpts, taskStatusOptions)
    else if (step === 'audio') {
      const res = await runAudioStep(latestSb, getCanvasGenerationOptions())
      if (res?.skipped) {
        ElMessage.info(res.reason || '已跳过')
        return
      }
      operationResult = res
    }
    else if (step === 'link_tail_frame') operationResult = await linkStoryboardTailFrameFromNode(latestSb)
    else throw new Error(`暂不支持该节点步骤：${step}`)
    ElMessage.success(step === 'link_tail_frame' ? '尾帧衔接完成' : '节点生成完成')
    await refreshDrama(true)
    const refreshed = findStoryboardInDrama(drama.value, sb.id)
    const refreshedSb = refreshed?.storyboard || latestSb
    const resultInfo = { ...nodeStepResultInfo(node, step, sb.id, refreshedSb), ...(operationResult || {}), promptText }
    const savedAssetInfo = await saveNodeResultAsset(node, resultInfo, promptText, sb.id)
    if (savedAssetInfo && resultInfo.resultType === 'image') await loadProjectImageAssets()
    const successPayload = { ...resultInfo, ...(savedAssetInfo || {}), runKey, sourceNodeId: nodeId, autoClear: false }
    successNodeStepStatus(statusIds, successPayload)
    if (nodeId) await focusCanvasNode(nodeId)
  } catch (e) {
    const errorMessage = e?.message || '节点生成失败'
    const retryPayload = {
      ...previousResultPayload,
      message: errorMessage,
      errorDetail: errorMessage,
      promptText: nodeStepPromptText(step, sb, node),
      retryStep: step,
      retryLabel: `重试${nodeStepStatusLabel(step, node).replace(/中…$/, '')}`,
      runKey,
      sourceNodeId: nodeId,
      upstreamReferenceUrls: upstreamReferenceUrlsForNode,
    }
    failNodeStepStatus(statusIds, retryPayload)
    ElMessage.error(errorMessage)
    await refreshDrama(true)
  } finally {
    clearTransientNodeStepStatus(statusIds)
  }
}

async function runCanvasAssetNodeStep(node, step) {
  if (step !== 'ref_image') {
    ElMessage.warning('该素材节点暂不支持该操作')
    return
  }
  const entity = node?.data?.entity
  const kind = node?.data?.kind
  if (!entity?.id || !kind) {
    ElMessage.warning('该素材节点缺少素材信息，无法执行生成')
    return
  }
  try {
    await generateAssetReferenceImage(
      { nodeStatus, drama, refreshDrama, refresh: refreshCanvas },
      { kind, entity, nodeId: node.id }
    )
    ElMessage.success('素材参考图已生成')
    await refreshDrama(true)
    await focusCanvasNode(node.id)
  } catch (e) {
    ElMessage.error(e?.message || '素材参考图生成失败')
    await refreshDrama(true)
  }
}

function videoUrlFromNode(node) {
  if (node?.data?.url) return node.data.url
  const localPath = node?.data?.videoRecord?.local_path
  if (localPath) return `/static/${String(localPath).replace(/^\/+/, '')}`
  if (node?.data?.videoRecord?.video_url) return node.data.videoRecord.video_url
  const sb = storyboardForNode(node)
  const videoNode = sb?.id ? findGraphNode(`sbvid:${sb.id}`) : null
  if (!videoNode || videoNode === node) return ''
  return videoUrlFromNode(videoNode)
}

function previewNodeVideo(node) {
  const url = videoUrlFromNode(node)
  if (!url) {
    ElMessage.warning('该视频节点暂无可预览地址')
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function createWorkflowFromNode(node) {
  const storyboard = storyboardForNode(node)
  const storyboardId = Number(storyboard?.id)
  if (!Number.isFinite(storyboardId)) {
    ElMessage.warning('只有分镜节点可以创建工作流')
    return
  }
  const selectedIds = selectedStoryboardIds.value.map(Number)
  if (!selectedIds.includes(storyboardId)) applySelectedStoryboardIds([storyboardId])
  await onCreateWorkflowGroup()
}

async function runWorkflowFromNode(node) {
  const storyboard = storyboardForNode(node)
  const storyboardId = Number(storyboard?.id)
  if (!Number.isFinite(storyboardId)) {
    ElMessage.warning('只有分镜节点可以运行工作流')
    return
  }
  const containingGroups = workflowGroups.value.filter((group) => (
    (group.storyboard_ids || []).map(Number).includes(storyboardId)
  ))
  if (!containingGroups.length) {
    ElMessage.warning('该分镜尚未加入工作流，请先创建工作流')
    return
  }
  if (!activeGroupId.value || !containingGroups.some((group) => group.id === activeGroupId.value)) {
    activeGroupId.value = containingGroups[0].id
  }
  await onRunActiveGroup()
}

function workflowGroupForNode(node) {
  const storyboard = storyboardForNode(node)
  const storyboardId = Number(storyboard?.id)
  if (!Number.isFinite(storyboardId)) return null
  return workflowGroups.value.find((group) => (
    (group.storyboard_ids || []).map(Number).includes(storyboardId)
  )) || null
}

function isSelectedStoryboardNode(node) {
  const storyboard = storyboardForNode(node)
  const storyboardId = Number(storyboard?.id)
  return Number.isFinite(storyboardId) && selectedStoryboardIds.value.map(Number).includes(storyboardId)
}

function selectWorkflowGroupFromNode(node) {
  const group = workflowGroupForNode(node)
  if (!group) {
    ElMessage.warning('该分镜尚未加入工作流')
    return
  }
  selectWorkflowGroup(group.id)
  ElMessage.success('已选中所在工作流')
}

async function removeNodeFromWorkflowGroup(node) {
  const group = workflowGroupForNode(node)
  const storyboard = storyboardForNode(node)
  const storyboardId = Number(storyboard?.id)
  if (!group || !Number.isFinite(storyboardId)) {
    ElMessage.warning('该分镜尚未加入工作流')
    return
  }

  const previousGroups = workflowGroups.value
  const previousActiveGroupId = activeGroupId.value
  const previousSelectedIds = [...selectedStoryboardIds.value]
  const wasActiveGroup = activeGroupId.value === group.id
  const nextGroups = removeStoryboardFromWorkflowGroup(workflowGroups.value, group.id, storyboardId)
  const nextGroup = nextGroups.find((item) => item.id === group.id)
  workflowGroups.value = nextGroups
  if (wasActiveGroup) activeGroupId.value = nextGroup?.id || nextGroups[0]?.id || null
  selectedStoryboardIds.value = selectedStoryboardIds.value.map(Number).filter((id) => id !== storyboardId)
  rebuildGraph()

  const saved = await persistCanvasState({ groupsOnly: true })
  if (!saved) {
    workflowGroups.value = previousGroups
    activeGroupId.value = previousActiveGroupId
    selectedStoryboardIds.value = previousSelectedIds
    rebuildGraph()
    return
  }
  if (activeGroupId.value) selectWorkflowGroup(activeGroupId.value)
  else applySelectedStoryboardIds(selectedStoryboardIds.value)
  ElMessage.success(nextGroup ? '已从工作流移出' : '已移出并解散空工作流')
}

async function runNodeMenuAction(type, node) {
  if (type === 'open-node-config') {
    openNodeConfig(node)
  } else if (type === 'duplicate-free-node') {
    await duplicateFreeCanvasNode(node)
  } else if (type === 'view-generation-history') {
    showFreeCanvasGenerationHistory(node)
  } else if (type === 'mount-free-node-asset') {
    openFreeNodeAssetLibrary(node)
  } else if (type === 'delete-free-node') {
    await deleteFreeCanvasNode(node.id)
  } else if (type === 'open-node-production') {
    onNodeDoubleClick({ node })
  } else if (type === 'open-node-result') {
    openNodeResult(node)
  } else if (type === 'copy-node-result') {
    await copyNodeResult(node)
  } else if (type === 'download-node-result') {
    downloadNodeResult(node)
  } else if (type === 'save-node-result-asset') {
    if (isStandaloneCanvas.value && node?.type === 'homeCanvasNode') {
      try {
        await saveFreeCanvasResultAsset(node, node.data?.kind, nodeResultUrl(node), null, node.data?.taskId || '')
        ElMessage.success('已存入素材库')
      } catch (error) {
        ElMessage.error(error?.message || '存入素材库失败')
      }
    } else {
      await saveNodeResultAssetFromMenu(node)
    }
  } else if (type === 'copy-node-asset-ref') {
    await copyNodeAssetReference(node)
  } else if (type === 'assign-node-asset-selected') {
    await assignNodeAssetToSelectedStoryboard(node)
  } else if (type === 'use-node-result-downstream-reference') {
    await useNodeResultAsDownstreamReference(node)
  } else if (type === 'copy-node-assigned-asset-ref') {
    await copyNodeAssignedAssetReference(node)
  } else if (type === 'unbind-node-assigned-asset') {
    await unbindNodeAssignedAsset(node)
  } else if (type === 'set-assigned-asset-main-image') {
    await setNodeAssignedAssetFrame(node)
  } else if (type === 'set-assigned-asset-first-frame') {
    await setNodeAssignedAssetFrame(node, 'storyboard_first')
  } else if (type === 'set-assigned-asset-last-frame') {
    await setNodeAssignedAssetFrame(node, 'storyboard_last')
  } else if (type === 'set-node-result-main-image') {
    await setNodeResultAsStoryboardFrame(node)
  } else if (type === 'set-node-result-first-frame') {
    await setNodeResultAsStoryboardFrame(node, 'storyboard_first')
  } else if (type === 'set-node-result-last-frame') {
    await setNodeResultAsStoryboardFrame(node, 'storyboard_last')
  } else if (type === 'assign-project-asset-selected') {
    await runCanvasNodeStep(node, 'library')
  } else if (type === 'focus-node-result') {
    await focusNodeResult(node)
  } else if (type === 'retry-node-action') {
    await retryNodeFailedAction(node)
  } else if (type === 'retry-node-failed') {
    await retryFailedNode(node)
  } else if (type === 'continue-node-next-step') {
    await continueNodeNextStep(node)
  } else if (type === 'run-node-image') {
    await runCanvasNodeStep(node, 'image')
  } else if (type === 'run-node-video') {
    await runCanvasNodeStep(node, 'video')
  } else if (type === 'run-node-audio') {
    await runCanvasNodeStep(node, 'audio')
  } else if (type === 'preview-node-video') {
    previewNodeVideo(node)
  } else if (type === 'duplicate-storyboard-node') {
    await duplicateStoryboardNode(node)
  } else if (type === 'focus-upstream') {
    await focusUpstreamAsset(node)
  } else if (type === 'focus-downstream-video') {
    await focusDownstreamVideo(node)
  } else if (type === 'append-downstream-storyboard') {
    await appendDownstreamStoryboard(node)
  } else if (type === 'insert-downstream-storyboard') {
    await insertDownstreamStoryboard(node)
  } else if (type === 'copy-node-ref') {
    await copyNodeReference(node)
  } else if (type === 'create-workflow-from-node') {
    await createWorkflowFromNode(node)
  } else if (type === 'select-node-workflow') {
    selectWorkflowGroupFromNode(node)
  } else if (type === 'remove-node-workflow') {
    await removeNodeFromWorkflowGroup(node)
  } else if (type === 'run-selected-storyboards') {
    await onRunSelectedStoryboards()
  } else if (type === 'run-node-workflow') {
    await runWorkflowFromNode(node)
  }
}

function openNodeConfig(node) {
  if (!node) return
  if (PANEL_NODE_TYPES.has(node.type)) {
    focusNodeForConfig(node)
    return
  }
  onNodeDoubleClick({ node })
}

function focusNodeForConfig(node, options = {}) {
  if (!node?.id) return
  focusedNodeId.value = node.id
  const storyboard = storyboardForNode(node)
  if (options?.syncStoryboard !== false && storyboard?.id) applySelectedStoryboardIds([storyboard.id])
  scheduleVirtualization()
}

function openCanvasCreateMenuAt(clientX, clientY, connectionSource = null, flowPosition = null) {
  const flowPos = flowPosition || screenToFlowPosition(clientX, clientY)
  contextMenuFlowPos.value = flowPos
  contextMenuNode.value = null
  contextMenuConnectionSource.value = connectionSource
  contextMenuX.value = clientX
  contextMenuY.value = clientY
  contextMenuVisible.value = true
}

function onPaneContextMenu(payload) {
  const event = payload?.event || payload
  if (event?.preventDefault) event.preventDefault()
  if (canvasPreferences.value.blank_action !== 'contextmenu') return
  openCanvasCreateMenuAt(
    event.clientX,
    event.clientY,
    null,
    payload?.flowPosition || null,
  )
}

function onPaneDoubleClick(payload) {
  if (canvasPreferences.value.blank_action !== 'doubleclick') return
  const event = payload?.event || payload
  event?.preventDefault?.()
  openCanvasCreateMenuAt(
    event.clientX,
    event.clientY,
    null,
    payload?.flowPosition || null,
  )
}

function onNodeContextMenu(payload) {
  const event = payload?.event || payload
  if (event?.preventDefault) event.preventDefault()
  event?.stopPropagation?.()
  contextMenuNode.value = payload?.node || null
  contextMenuFlowPos.value = contextMenuNode.value?.position || screenToFlowPosition(event.clientX, event.clientY)
  contextMenuConnectionSource.value = null
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuFlowPos.value = null
  contextMenuNode.value = null
  contextMenuConnectionSource.value = null
}

function clearCanvasInteractionState() {
  closeContextMenu()
  focusedNodeId.value = null
  activeGroupId.value = null
  applySelectedStoryboardIds([])
  selectedFreeNodeIds.value = []
}

function selectedStandaloneNodes() {
  const selected = new Set(selectedFreeNodeIds.value)
  return allGraphNodes.value.filter((node) => node.type === 'homeCanvasNode' && selected.has(String(node.id)))
}

function createStandaloneGroup() {
  if (!isStandaloneCanvas.value) return
  syncRenderedNodesToGraph()
  const members = selectedStandaloneNodes()
  if (members.length < 2) {
    ElMessage.warning('请先框选至少 2 个节点')
    return
  }
  const previousState = currentInteractionState()
  const padding = canvasPreferences.value.group_padding
  const minX = Math.min(...members.map((node) => node.position.x)) - padding
  const minY = Math.min(...members.map((node) => node.position.y)) - padding
  const maxX = Math.max(...members.map((node) => node.position.x + Number(node.dimensions?.width || 460))) + padding
  const maxY = Math.max(...members.map((node) => node.position.y + Number(node.dimensions?.height || 300))) + padding
  allGraphNodes.value = [{
    id: `canvas-group:${Date.now()}`,
    type: 'canvasGroup',
    position: { x: minX, y: minY },
    data: {
      title: `节点组 ${allGraphNodes.value.filter((node) => node.type === 'canvasGroup').length + 1}`,
      childNodeIds: members.map((node) => String(node.id)),
      width: maxX - minX,
      height: maxY - minY,
    },
    zIndex: -1,
    selectable: true,
    selected: true,
  }, ...allGraphNodes.value.map((node) => ({ ...node, selected: false }))]
  selectedFreeNodeIds.value = []
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  scheduleLayoutSave()
  ElMessage.success(`已将 ${members.length} 个节点打组`)
}

function ungroupStandaloneSelection() {
  if (!isStandaloneCanvas.value) return
  const selectedGroups = allGraphNodes.value.filter((node) => node.type === 'canvasGroup' && node.selected)
  if (!selectedGroups.length) {
    ElMessage.warning('请先选中组框')
    return
  }
  const previousState = currentInteractionState()
  const groupIds = new Set(selectedGroups.map((group) => String(group.id)))
  allGraphNodes.value = allGraphNodes.value.filter((node) => !groupIds.has(String(node.id)))
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  scheduleLayoutSave()
  ElMessage.success('已解组，组内节点已保留')
}

async function runSelectedStandaloneGroup() {
  if (!isStandaloneCanvas.value) return
  const group = allGraphNodes.value.find((node) => node.type === 'canvasGroup' && node.selected)
  if (!group) {
    ElMessage.warning('请先选中组框')
    return
  }
  await runFreeCanvasSubgraph(group.data?.childNodeIds || [], false)
}

async function onContextMenuSelect(type) {
  const node = contextMenuNode.value
  const connectionSource = contextMenuConnectionSource.value
  if (node) {
    closeContextMenu()
    await runNodeMenuAction(type, node)
    return
  }
  const flowPosition = contextMenuFlowPos.value
  if (type === 'focus-script') {
    closeContextMenu()
    await focusScriptNode(flowPosition)
    return
  }
  if (type === 'open-media-library') {
    closeContextMenu()
    openCanvasAssetLibrary(flowPosition)
    return
  }
  if (type === 'open-director-stage') {
    closeContextMenu()
    openDirectorStage()
    return
  }
  if (type === 'upload-media') {
    closeContextMenu()
    openCanvasUpload(flowPosition)
    return
  }
  if (type === 'upload-image') {
    closeContextMenu()
    openCanvasUpload(flowPosition, CANVAS_IMAGE_ACCEPT)
    return
  }
  if (type === 'upload-video') {
    closeContextMenu()
    openCanvasUpload(flowPosition, CANVAS_VIDEO_ACCEPT)
    return
  }
  if (type === 'upload-audio') {
    closeContextMenu()
    openCanvasUpload(flowPosition, CANVAS_AUDIO_ACCEPT)
    return
  }
  if (type === 'paste-media') {
    closeContextMenu()
    await pasteCanvasClipboard(flowPosition)
    return
  }
  pendingFlowPosition.value = flowPosition
  void openCreateDialog(type, flowPosition, connectionSource)
  closeContextMenu()
}

async function onCreateSubmit(form) {
  try {
    await submitCreate(form)
  } catch (e) {
    ElMessage.error(e?.message || '创建失败')
  }
}

function getCanvasGenerationOptions() {
  return {
    ...getDramaGenerationOptions(drama.value),
    ...generationOverrides.value,
    imagesBySbId: imagesBySbId.value,
  }
}

let generationSaveTimer = null
function updateGenerationOptions(patch = {}) {
  generationOverrides.value = { ...generationOverrides.value, ...patch }
  const current = getCanvasGenerationOptions()
  if (drama.value) {
    const metadata = parseDramaMetadata(drama.value.metadata) || {}
    const nextMetadata = {
      ...metadata,
      aspect_ratio: current.aspectRatio || '16:9',
      video_resolution: current.videoResolution || '480p',
    }
    if (Object.hasOwn(patch, 'imageModel')) nextMetadata.image_model = current.imageModel || null
    if (Object.hasOwn(patch, 'videoModel')) nextMetadata.video_model = current.videoModel || null
    drama.value = { ...drama.value, metadata: nextMetadata }
  }
  if (generationSaveTimer) clearTimeout(generationSaveTimer)
  generationSaveTimer = setTimeout(async () => {
    generationSaveTimer = null
    if (!dramaId.value) return
    const latest = getCanvasGenerationOptions()
    const metadata = {
      ...(parseDramaMetadata(drama.value?.metadata) || {}),
      aspect_ratio: latest.aspectRatio || '16:9',
      video_resolution: latest.videoResolution || '480p',
    }
    try {
      await dramaAPI.saveOutline(dramaId.value, { metadata })
    } catch (e) {
      ElMessage.error(e?.message || '生成参数保存失败')
    }
  }, 450)
}

const scriptActionsHolder = {}

function isMediaSubmission(node, step) {
  const kind = String(node?.data?.kind || step || '').toLowerCase()
  return ['image', 'video'].includes(kind)
}

async function waitForCanvasSubmissionDelay(node, step) {
  if (!isMediaSubmission(node, step)) return
  const delaySeconds = Number(canvasPreferences.value.media_submit_delay_seconds || 0)
  if (delaySeconds <= 0) return
  await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000))
}

async function runCanvasNodeStepWithPreferences(node, step) {
  if (!(isStandaloneCanvas.value && node?.type === 'homeCanvasNode')) {
    await waitForCanvasSubmissionDelay(node, step)
  }
  try {
    return await runCanvasNodeStep(node, step)
  } finally {
    if (canvasPreferences.value.blur_after_submit) focusedNodeId.value = null
  }
}

provide(CANVAS_CONTEXT_KEY, {
  focusedNodeId,
  allGraphNodes,
  selectedFreeNodeIds,
  currentViewport,
  drama,
  imagesBySbId,
  videosBySbId,
  generationOptions: computed(() => getCanvasGenerationOptions()),
  updateGenerationOptions,
  getGenerationOptions: getCanvasGenerationOptions,
  setFocusedNode: (nodeId) => {
    const node = findGraphNode(nodeId)
    if (node) focusNodeForConfig(node)
    else focusedNodeId.value = nodeId
  },
  clearFocusedNode: () => {
    focusedNodeId.value = null
  },
  setHighlightAsset,
  refresh: refreshCanvas,
  refreshDrama,
  refreshProjectAssets: async () => {
    await loadProjectImageAssets()
    rebuildGraph()
  },
  suppressPaneClick,
  nodeStatus,
  openCreateDialog: (...args) => openCreateDialog(...args),
  scriptActions: scriptActionsHolder,
  registerCanvasFlowApi: (api) => {
    canvasFlowApi.value = api
  },
  panCanvasForNodeEditor,
  sidebarVisible,
  showWorkflowPanel,
  directorStageVisible,
  canvasGridVisible,
  canvasMiniMapVisible,
  canvasSnapEnabled,
  canvasPreferences,
  canvasBackgroundCandidates,
  canvasEdgePalette: activeCanvasEdgePalette,
  runQueueItems,
  canvasNodeLocatorItems,
  canUndo,
  canRedo,
  openDirectorStage,
  toggleSidebar,
  toggleWorkflowPanel,
  focusScript: focusScriptNode,
  goListMode,
  alignNodes: onAlignNodes,
  fitCanvasView,
  focusCanvasNode,
  focusQueueItem,
  updateCanvasPreference,
  resetCanvasPreferences,
  toggleCanvasGrid: () => {
    updateCanvasPreference('grid_visible', !canvasPreferences.value.grid_visible)
  },
  toggleCanvasMiniMap: () => {
    updateCanvasPreference('minimap_visible', !canvasPreferences.value.minimap_visible)
  },
  toggleCanvasSnap: () => {
    updateCanvasPreference('snap_enabled', !canvasPreferences.value.snap_enabled)
  },
  findCanvasNode: findGraphNode,
  useNodeResultAsDownstreamReference,
  undoCanvas,
  redoCanvas,
  zoomIn: () => canvasFlowApi.value?.zoomIn?.({ duration: 180 }),
  zoomOut: () => canvasFlowApi.value?.zoomOut?.({ duration: 180 }),
  showCanvasHelp,
  selectStoryboard: (storyboardId, event) => selectStoryboard(storyboardId, event),
  assignProjectAssetToSelectedStoryboard,
  runNodeStep: runCanvasNodeStepWithPreferences,
  openFreeNodeConfig: (nodeId) => {
    const node = freeCanvasNodeById(nodeId)
    if (node) openFreeNodeDialog(node.data?.kind || 'text', node.position, node)
  },
  updateFreeCanvasNode: patchFreeCanvasNodeData,
  createImageNodeFromVideoLastFrame,
  deleteFreeCanvasNode,
  duplicateFreeCanvasNode,
  uploadFreeCanvasNodeFile,
  openFreeNodeAssetLibrary,
  getFreeNodeModelOptions,
  getFreeNodeModelCapability,
  getFreeNodeEstimatedCredits,
  getFreeNodeVoiceOptions: () => freeCanvasVoiceOptions.value,
  getFreeNodeInputReferences: freeCanvasNodeInputReferences,
  getFreeNodeReferenceCandidates: freeCanvasReferenceCandidates,
  uploadFreeCanvasReferenceImage,
  attachFreeCanvasReference,
  updateFreeCanvasReference,
  detachFreeCanvasReference,
  runFreeCanvasNode,
  runFreeCanvasSubgraph: (nodeId) => runFreeCanvasSubgraph([nodeId], true),
  runSelectedFreeCanvasNodes: () => runFreeCanvasSubgraph(
    allGraphNodes.value.filter((node) => node.type === 'homeCanvasNode' && node.selected).map((node) => node.id),
    false,
  ),
  createStandaloneGroup,
  ungroupStandaloneSelection,
  runSelectedStandaloneGroup,
  translateFreeCanvasNode,
  retryFreeCanvasAssetSave,
  runImageNodeTool,
  replaceFreeCanvasNodeImage,
  setFreeCanvasNodeMarker,
})

function clearAssetHighlight() {
  highlightAssetId.value = null
  applyHighlight()
}

function applySelectedStoryboardIds(ids = []) {
  const normalizedIds = [...new Set(ids.map(Number).filter(Number.isFinite))]
  selectedStoryboardIds.value = normalizedIds
  const selectedIds = new Set(normalizedIds)
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    if (node.type !== 'canvasStoryboard') return node
    return { ...node, selected: selectedIds.has(Number(node.data?.storyboard?.id)) }
  })
  nodes.value = nodes.value.map((node) => {
    if (node.type !== 'canvasStoryboard') return node
    return { ...node, selected: selectedIds.has(Number(node.data?.storyboard?.id)) }
  })

  if (!normalizedIds.length) {
    activeGroupId.value = null
    return
  }

  const containingGroups = workflowGroups.value.filter((group) => {
    const groupIds = new Set((group.storyboard_ids || []).map(Number))
    return normalizedIds.every((id) => groupIds.has(Number(id)))
  })
  if (containingGroups.length === 1 && (normalizedIds.length > 1 || !activeGroupId.value)) {
    activeGroupId.value = containingGroups[0].id
  } else if (normalizedIds.length > 1 && containingGroups.length !== 1) {
    activeGroupId.value = null
  }
}

function applySelectedFreeNodeIds(ids = []) {
  const normalizedIds = [...new Set(ids.map(String))]
  const selectedIds = new Set(normalizedIds)
  selectedFreeNodeIds.value = normalizedIds
  allGraphNodes.value = allGraphNodes.value.map((node) => ({
    ...node,
    selected: node.type === 'homeCanvasNode' && selectedIds.has(String(node.id)),
  }))
  nodes.value = nodes.value.map((node) => ({
    ...node,
    selected: node.type === 'homeCanvasNode' && selectedIds.has(String(node.id)),
  }))
}

function onCanvasPointerDown(event) {
  selectionModifierActive.value = Boolean(event?.ctrlKey || event?.metaKey)
  requestAnimationFrame(() => {
    selectionModifierActive.value = false
  })
}

function onCanvasSelectionStart() {
  marqueeSelectionActive.value = true
}

function onCanvasSelectionEnd() {
  requestAnimationFrame(() => {
    if (isStandaloneCanvas.value) {
      applySelectedFreeNodeIds(nodes.value
        .filter((node) => node.type === 'homeCanvasNode' && node.selected)
        .map((node) => node.id))
    }
    marqueeSelectionActive.value = false
  })
}

function onNodesChange(changes = []) {
  const removedFreeNodeIds = new Set(
    changes
      .filter((change) => change?.type === 'remove' && findGraphNode(change.id)?.type === 'homeCanvasNode')
      .map((change) => String(change.id))
  )
  if (removedFreeNodeIds.size) {
    allGraphNodes.value = allGraphNodes.value.filter((node) => !removedFreeNodeIds.has(String(node.id)))
    allGraphEdges.value = allGraphEdges.value.filter((edge) => (
      !removedFreeNodeIds.has(String(edge.source)) && !removedFreeNodeIds.has(String(edge.target))
    ))
    allGraphNodes.value = allGraphNodes.value
      .map((node) => node.type === 'canvasGroup'
        ? { ...node, data: { ...node.data, childNodeIds: (node.data?.childNodeIds || []).filter((id) => !removedFreeNodeIds.has(String(id))) } }
        : node)
      .filter((node) => node.type !== 'canvasGroup' || node.data.childNodeIds.length >= 2)
    applyVirtualizedGraph()
    scheduleLayoutSave()
  }

  const selectionChanges = changes.filter((change) => change?.type === 'select')
  if (!selectionChanges.length) return

  if (isStandaloneCanvas.value) {
    const homeSelectionChanges = selectionChanges.filter((change) => (
      findGraphNode(change.id)?.type === 'homeCanvasNode'
    ))
    const selectedHomeChange = [...homeSelectionChanges].reverse().find((change) => change.selected)
    if (homeSelectionChanges.length && !selectionModifierActive.value && !marqueeSelectionActive.value) {
      applySelectedFreeNodeIds(selectedHomeChange ? [selectedHomeChange.id] : [])
      return
    }
    const selectedIds = new Set(selectedFreeNodeIds.value)
    for (const change of selectionChanges) {
      const node = findGraphNode(change.id)
      if (node?.type === 'homeCanvasNode') {
        if (change.selected) selectedIds.add(String(change.id))
        else selectedIds.delete(String(change.id))
      } else if (node?.type === 'canvasGroup') {
        allGraphNodes.value = allGraphNodes.value.map((item) => String(item.id) === String(change.id)
          ? { ...item, selected: Boolean(change.selected) }
          : item)
      }
    }
    selectedFreeNodeIds.value = [...selectedIds]
    return
  }

  const selectedIds = new Set(selectedStoryboardIds.value.map(Number))
  for (const change of selectionChanges) {
    const storyboardId = storyboardIdFromNodeId(change.id)
    if (!storyboardId) continue
    if (change.selected) selectedIds.add(Number(storyboardId))
    else selectedIds.delete(Number(storyboardId))
  }
  applySelectedStoryboardIds([...selectedIds])
}

function manualEdgeId(connection) {
  return [
    'manual',
    connection.source,
    connection.sourceHandle || 'out',
    connection.target,
    connection.targetHandle || 'in',
  ].join(':')
}

function hasSameEdgeConnection(candidate, edgeList = allGraphEdges.value) {
  return edgeList.some((edge) => (
    String(edge.source) === String(candidate.source)
    && String(edge.target) === String(candidate.target)
    && String(edge.sourceHandle || '') === String(candidate.sourceHandle || '')
    && String(edge.targetHandle || '') === String(candidate.targetHandle || '')
  ))
}

function isStandaloneFreeNodeEdge(edge) {
  if (!isStandaloneCanvas.value || !edge) return false
  return findGraphNode(edge.source)?.type === 'homeCanvasNode'
    && findGraphNode(edge.target)?.type === 'homeCanvasNode'
}

function decorateCanvasEdges(edgeList) {
  return stampEdgeBaseStyles(edgeList).map((edge) => ({
    ...edge,
    type: 'cuttable',
    data: {
      ...(edge.data || {}),
      lineType: edge.data?.lineType || edge.type || 'smoothstep',
    },
  }))
}

function cutCanvasEdges(edgeIds = [], source = 'remove') {
  const removed = new Set((edgeIds || []).map(String))
  if (!removed.size) return 0

  const previousState = currentInteractionState()
  const matched = allGraphEdges.value.filter((edge) => removed.has(String(edge.id)))
  if (!matched.length) return 0

  for (const edge of matched) {
    const isManual = edge.data?.manual === true || String(edge.id).startsWith('manual:')
    if (!isManual) suppressedEdgeIds.value.add(String(edge.id))
  }
  allGraphEdges.value = allGraphEdges.value.filter((edge) => !removed.has(String(edge.id)))
  applyVirtualizedGraph()
  commitInteractionHistory(previousState)
  scheduleLayoutSave()
  if (source === 'scissor') ElMessage.success('已剪断连线')
  return matched.length
}

provide('cut-canvas-edges', cutCanvasEdges)

function canvasEdgeTarget(edgeId) {
  const edge = allGraphEdges.value.find((item) => String(item.id) === String(edgeId))
  return edge ? findGraphNode(edge.target) : null
}

function canRunCanvasEdgeTarget(edgeId) {
  const target = canvasEdgeTarget(edgeId)
  return Boolean(
    isStandaloneCanvas.value
    && target?.type === 'homeCanvasNode'
    && target.data?.kind === 'image'
  )
}

async function runCanvasEdgeTarget(edgeId) {
  const target = canvasEdgeTarget(edgeId)
  if (!canRunCanvasEdgeTarget(edgeId) || !target) return
  await runFreeCanvasNode(target)
}

provide('can-run-canvas-edge-target', canRunCanvasEdgeTarget)
provide('run-canvas-edge-target', runCanvasEdgeTarget)

function onConnectStart(eventOrParams, maybeParams) {
  const params = maybeParams?.nodeId ? maybeParams : eventOrParams
  if (!params?.nodeId) return
  connectionDragState.value = {
    sourceNodeId: String(params.nodeId),
    sourceHandle: params.handleId || null,
    connected: false,
  }
}

function connectionDropPoint(event) {
  const pointer = event?.changedTouches?.[0] || event?.touches?.[0] || event
  if (!Number.isFinite(pointer?.clientX) || !Number.isFinite(pointer?.clientY)) return null
  return { clientX: pointer.clientX, clientY: pointer.clientY }
}

function onConnectEnd(event) {
  const dragState = connectionDragState.value
  connectionDragState.value = null
  if (!dragState?.sourceNodeId || dragState.connected) return

  const point = connectionDropPoint(event)
  if (!point) return
  const targets = [
    event?.target,
    ...(document.elementsFromPoint?.(point.clientX, point.clientY) || []),
  ].filter(Boolean)
  const drop = resolveCanvasConnectionDrop({
    sourceNodeId: dragState.sourceNodeId,
    targets,
    ...point,
  })
  if (drop?.kind === 'connect') {
    onConnect({
      source: dragState.sourceNodeId,
      target: drop.targetNodeId,
      sourceHandle: dragState.sourceHandle,
      targetHandle: null,
    })
    return
  }
  if (drop?.kind === 'create') {
    suppressPaneClick()
    openCanvasCreateMenuAt(drop.clientX, drop.clientY, {
      sourceNodeId: dragState.sourceNodeId,
      sourceHandle: dragState.sourceHandle,
    })
  }
}

function onConnect(connection) {
  if (!connection?.source || !connection?.target) return
  if (
    connectionDragState.value
    && String(connectionDragState.value.sourceNodeId) === String(connection.source)
  ) {
    connectionDragState.value.connected = true
  }
  if (String(connection.source) === String(connection.target)) {
    ElMessage.warning('不能连接到同一个节点')
    return
  }
  if (hasSameEdgeConnection(connection)) {
    ElMessage.info('该连线已存在')
    return
  }

  const sourceNode = findGraphNode(connection.source)
  const targetNode = findGraphNode(connection.target)
  const sourceKind = canvasNodeKind(sourceNode)
  const targetKind = canvasNodeKind(targetNode)
  const contract = resolveCanvasNodeConnection(sourceKind, targetKind)
  if (
    sourceNode?.type === 'homeCanvasNode'
    && targetNode?.type === 'homeCanvasNode'
    && !contract.allowed
  ) {
    ElMessage.warning('节点契约不匹配：当前输出不能作为目标节点输入')
    return
  }

  const edge = toLibTvCanvasEdge({
    id: manualEdgeId(connection),
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle || null,
    targetHandle: connection.targetHandle || null,
    data: {
      manual: true,
      contract: {
        order: allGraphEdges.value.filter((item) => String(item.target) === String(connection.target)).length,
      },
    },
  }, sourceKind, targetKind)
  allGraphEdges.value = decorateCanvasEdges([...allGraphEdges.value, edge])
  applyVirtualizedGraph()
  scheduleLayoutSave()
  if (
    sourceNode?.type === 'homeCanvasNode'
    && sourceNode.data?.kind === 'image'
    && targetNode?.type === 'homeCanvasNode'
    && targetNode.data?.kind === 'video'
  ) {
    ElMessage.success(sourceNode.data?.url ? '视频节点已自动采用该图片作为参考图' : '图片已连接，生成完成后会自动作为视频参考图')
  } else {
    ElMessage.success('已添加画布连线')
  }
}

function onEdgesChange(changes = []) {
  const removedEdgeIds = changes
    .filter((change) => {
      if (change?.type !== 'remove') return false
      const edge = allGraphEdges.value.find((item) => String(item.id) === String(change.id))
      return edge?.data?.manual === true || isStandaloneFreeNodeEdge(edge)
    })
    .map((change) => String(change.id))
  if (!removedEdgeIds.length) return
  if (cutCanvasEdges(removedEdgeIds)) ElMessage.success('已删除画布连线')
}

function selectStoryboard(storyboardId, event) {
  const normalizedId = Number(storyboardId)
  if (!Number.isFinite(normalizedId)) return
  const selectedIds = new Set(selectedStoryboardIds.value.map(Number))
  if (event?.ctrlKey || event?.metaKey) {
    if (selectedIds.has(normalizedId)) selectedIds.delete(normalizedId)
    else selectedIds.add(normalizedId)
  } else {
    selectedIds.clear()
    selectedIds.add(normalizedId)
  }
  applySelectedStoryboardIds([...selectedIds])
}

function selectWorkflowGroup(groupId) {
  activeGroupId.value = groupId || null
  const group = workflowGroups.value.find((item) => item.id === groupId)
  const storyboardIds = group
    ? (group.storyboard_ids || []).map(Number).filter((id) => allGraphNodes.value.some(
      (node) => node.type === 'canvasStoryboard' && Number(node.data?.storyboard?.id) === id,
    ))
    : []
  const selectedIds = new Set(storyboardIds)
  selectedStoryboardIds.value = storyboardIds
  allGraphNodes.value = allGraphNodes.value.map((node) => {
    if (node.type !== 'canvasStoryboard') return node
    return {
      ...node,
      selected: selectedIds.has(Number(node.data?.storyboard?.id)),
    }
  })
  applyVirtualizedGraph()
}

function onViewportChange(viewport) {
  currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
  scheduleVirtualization()
}

function syncCanvasViewportFromFlow() {
  const viewport = canvasFlowApi.value?.getViewport?.()
  if (!viewport) return
  currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
  scheduleVirtualization()
}

function onCanvasWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  event.stopPropagation()
  const action = event.deltaY < 0
    ? canvasFlowApi.value?.zoomIn?.({ duration: 0 })
    : event.deltaY > 0
      ? canvasFlowApi.value?.zoomOut?.({ duration: 0 })
      : null
  if (action && typeof action.finally === 'function') {
    action.finally(syncCanvasViewportFromFlow)
  } else {
    syncCanvasViewportFromFlow()
  }
}

function toggleSidebar() {
  sidebarVisible.value = !sidebarVisible.value
}

function toggleWorkflowPanel() {
  showWorkflowPanel.value = !showWorkflowPanel.value
}

async function loadCanvasCollaborators() {
  if (!currentTenantId.value) {
    collaborationMembers.value = []
    return
  }
  collaborationLoading.value = true
  try {
    const result = await listTenantMembers(currentTenantId.value)
    collaborationMembers.value = Array.isArray(result)
      ? result
      : Array.isArray(result?.members)
        ? result.members
        : []
  } catch (error) {
    collaborationMembers.value = []
    ElMessage.error(error?.message || '协作成员加载失败')
  } finally {
    collaborationLoading.value = false
  }
}

async function copyCanvasShareLink() {
  const url = canvasShareLink.value
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
    await navigator.clipboard.writeText(url)
    ElMessage.success('画布链接已复制')
  } catch {
    ElMessageBox.alert(url, '画布链接（请手动复制）', {
      confirmButtonText: '关闭',
      type: 'info',
    })
  }
}

async function inviteCanvasCollaborator() {
  const tenantId = currentTenantId.value
  const email = collaborationForm.value.email.trim()
  if (!tenantId) {
    ElMessage.warning('请先选择工作区')
    return
  }
  if (!email) {
    ElMessage.warning('请输入成员邮箱')
    return
  }
  collaborationInviteLoading.value = true
  try {
    await addTenantMember(tenantId, {
      email,
      role: collaborationForm.value.role,
    })
    collaborationForm.value.email = ''
    await loadCanvasCollaborators()
    ElMessage.success('协作成员已加入工作区')
  } catch (error) {
    ElMessage.error(error?.message || '邀请协作成员失败')
  } finally {
    collaborationInviteLoading.value = false
  }
}

async function shareCanvas() {
  collaborationDialogVisible.value = true
  await loadCanvasCollaborators()
}

async function fitCanvasView() {
  const api = canvasFlowApi.value
  if (!api?.fitView) return
  await api.fitView({ padding: 0.14, duration: 250, includeHiddenNodes: false })
  const viewport = api.getViewport?.()
  if (viewport) {
    currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    scheduleVirtualization()
  }
}

async function focusCanvasNode(nodeId) {
  if (!nodeId) return
  focusedNodeId.value = nodeId
  scheduleVirtualization()
  await nextTick()
  const api = canvasFlowApi.value
  if (!api?.fitView) return
  await api.fitView({ nodes: [{ id: nodeId }], padding: 0.55, duration: 320, includeHiddenNodes: false })
  const viewport = api.getViewport?.()
  if (viewport) {
    currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
    scheduleVirtualization()
  }
}

function showCanvasHelp() {
  ElMessageBox.alert(
    [
      '空格 + 鼠标左键拖动：平移画布',
      '普通滚轮：上下滚动画布',
      'Ctrl/⌘ + 滚轮：放大或缩小画布',
      '拖动画布空白区域：框选节点',
      'Ctrl/⌘ + 点击：多选节点',
      'Ctrl/⌘ + A：选中当前可见分镜',
      'Ctrl/⌘ + G：将已选分镜创建为工作流',
      'Esc：清空选择、焦点和右键菜单',
      '右键画布：添加节点',
      '双击节点：打开对应制作入口',
    ].join('\n'),
    '画布操作指南',
    { confirmButtonText: '知道了', type: 'info' },
  )
}

function scheduleLayoutSave() {
  layoutDirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistCanvasState({ layoutOnly: true })
  }, 700)
}

let draggedGroupSnapshot = null
function onNodeDragStart(payload) {
  syncRenderedNodesToGraph()
  dragHistorySnapshot.value = currentInteractionState()
  alignmentGuide.value = { x: null, y: null }
  const node = payload?.node
  if (node?.type === 'canvasGroup') {
    const childIds = new Set(node.data?.childNodeIds || [])
    draggedGroupSnapshot = {
      id: String(node.id),
      position: { ...node.position },
      children: Object.fromEntries(allGraphNodes.value
        .filter((item) => childIds.has(String(item.id)))
        .map((item) => [String(item.id), { ...item.position }])),
    }
  }
}

function onNodeDrag(payload) {
  const node = payload?.node
  if (node?.type === 'canvasGroup' && draggedGroupSnapshot?.id === String(node.id)) {
    allGraphNodes.value = translateCanvasGroupChildren(
      allGraphNodes.value,
      draggedGroupSnapshot,
      node.position,
    )
    nodes.value = translateCanvasGroupChildren(nodes.value, draggedGroupSnapshot, node.position)
  }
  if (!canvasPreferences.value.alignment_guides_enabled) {
    alignmentGuide.value = { x: null, y: null }
    return
  }
  if (!node) return
  const zoom = Number(currentViewport.value.zoom || 1)
  const threshold = 6 / zoom
  const width = Number(node.dimensions?.width || 460)
  const height = Number(node.dimensions?.height || 300)
  const xAnchors = [node.position.x, node.position.x + width / 2, node.position.x + width]
  const yAnchors = [node.position.y, node.position.y + height / 2, node.position.y + height]
  let alignedX = null
  let alignedY = null

  for (const candidate of allGraphNodes.value) {
    if (String(candidate.id) === String(node.id) || candidate.hidden) continue
    const candidateWidth = Number(candidate.dimensions?.width || candidate.data?.width || 460)
    const candidateHeight = Number(candidate.dimensions?.height || candidate.data?.height || 300)
    const candidateX = [
      candidate.position.x,
      candidate.position.x + candidateWidth / 2,
      candidate.position.x + candidateWidth,
    ]
    const candidateY = [
      candidate.position.y,
      candidate.position.y + candidateHeight / 2,
      candidate.position.y + candidateHeight,
    ]
    if (alignedX === null) alignedX = candidateX.find((anchor) => xAnchors.some((value) => Math.abs(value - anchor) <= threshold)) ?? null
    if (alignedY === null) alignedY = candidateY.find((anchor) => yAnchors.some((value) => Math.abs(value - anchor) <= threshold)) ?? null
    if (alignedX !== null && alignedY !== null) break
  }

  alignmentGuide.value = {
    x: alignedX === null ? null : alignedX * zoom + currentViewport.value.x,
    y: alignedY === null ? null : alignedY * zoom + currentViewport.value.y,
  }
}

function onNodeDragStop() {
  syncRenderedNodesToGraph()
  syncCanvasViewportFromFlow()
  refreshLayoutCacheFromGraph()
  const node = arguments[0]?.node
  if (node?.type === 'canvasGroup' && draggedGroupSnapshot?.id === String(node.id)) {
    const currentGroup = findGraphNode(node.id)
    allGraphNodes.value = translateCanvasGroupChildren(
      allGraphNodes.value,
      draggedGroupSnapshot,
      currentGroup.position,
    )
    applyVirtualizedGraph()
  } else if (node?.type === 'homeCanvasNode') {
    const resizedNodes = resizeCanvasGroupsAroundMember(
      allGraphNodes.value,
      node.id,
      canvasPreferences.value.group_padding,
    )
    if (resizedNodes !== allGraphNodes.value) {
      allGraphNodes.value = resizedNodes
      applyVirtualizedGraph()
    }
  }
  draggedGroupSnapshot = null
  alignmentGuide.value = { x: null, y: null }
  if (dragHistorySnapshot.value) commitInteractionHistory(dragHistorySnapshot.value)
  dragHistorySnapshot.value = null
  scheduleLayoutSave()
}

function isEditableTarget(target) {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable))
}

function setSpacePanning(active) {
  if (spacePanning.value === active) return
  spacePanning.value = active
  if (!active) suppressPaneClick()
}

function undoCanvas() {
  const next = undoCanvasInteractionHistory(interactionHistory.value)
  if (next === interactionHistory.value) return
  interactionHistory.value = next
  applyInteractionState(next.present)
  ElMessage.info('已撤销画布布局操作')
}

function redoCanvas() {
  const next = redoCanvasInteractionHistory(interactionHistory.value)
  if (next === interactionHistory.value) return
  interactionHistory.value = next
  applyInteractionState(next.present)
  ElMessage.info('已重做画布布局操作')
}

function selectVisibleStoryboards() {
  const ids = [...visibleStoryboardIds.value]
  if (!ids.length) {
    ElMessage.warning('当前画布暂无可选分镜')
    return
  }
  applySelectedStoryboardIds(ids)
  ElMessage.success(`已选中 ${ids.length} 个可见分镜`)
}

function selectVisibleCanvasNodes() {
  if (!isStandaloneCanvas.value) {
    selectVisibleStoryboards()
    return
  }
  const ids = nodes.value
    .filter((node) => node.type === 'homeCanvasNode' && !node.hidden)
    .map((node) => String(node.id))
  if (!ids.length) {
    ElMessage.warning('当前画布暂无可选节点')
    return
  }
  applySelectedFreeNodeIds(ids)
  ElMessage.success(`已选中 ${ids.length} 个节点`)
}

function panCanvasByKeyboard(delta) {
  if (!delta.x && !delta.y) return false
  const viewport = canvasFlowApi.value?.getViewport?.() || currentViewport.value
  const nextViewport = {
    x: Number(viewport?.x || 0) + delta.x,
    y: Number(viewport?.y || 0) + delta.y,
    zoom: Number(viewport?.zoom || 1),
  }
  currentViewport.value = nextViewport
  canvasFlowApi.value?.setViewport?.(nextViewport, { duration: 0 })
  return true
}

function runCanvasKeyboardPanFrame(timestamp) {
  canvasKeyboardPanFrame = null
  if (!pressedCanvasPanKeys.size) return
  const elapsed = canvasKeyboardPanLastTimestamp == null ? 16 : timestamp - canvasKeyboardPanLastTimestamp
  canvasKeyboardPanLastTimestamp = timestamp
  const delta = calculateCanvasKeyboardPanDelta(pressedCanvasPanKeys, elapsed)
  canvasKeyboardPanMoved = panCanvasByKeyboard(delta) || canvasKeyboardPanMoved
  canvasKeyboardPanFrame = window.requestAnimationFrame(runCanvasKeyboardPanFrame)
}

function startCanvasKeyboardPan() {
  if (canvasKeyboardPanFrame != null) return
  canvasKeyboardPanLastTimestamp = null
  runCanvasKeyboardPanFrame(window.performance?.now?.() || Date.now())
}

function stopCanvasKeyboardPan() {
  pressedCanvasPanKeys.clear()
  if (canvasKeyboardPanFrame != null) window.cancelAnimationFrame(canvasKeyboardPanFrame)
  canvasKeyboardPanFrame = null
  canvasKeyboardPanLastTimestamp = null
  if (canvasKeyboardPanMoved) scheduleLayoutSave()
  canvasKeyboardPanMoved = false
}

function onCanvasKeydown(event) {
  if (isEditableTarget(event.target)) return
  const key = String(event.key || '').toLowerCase()
  if (isStandaloneCanvas.value && (key === 'delete' || key === 'del')) {
    const selectedEdgeIds = edges.value
      .filter((edge) => edge.selected && isStandaloneFreeNodeEdge(edge))
      .map((edge) => String(edge.id))
    if (selectedEdgeIds.length) {
      event.preventDefault()
      const previousState = currentInteractionState()
      const idSet = new Set(selectedEdgeIds)
      allGraphEdges.value = allGraphEdges.value.filter((edge) => !idSet.has(String(edge.id)))
      edges.value = edges.value.filter((edge) => !idSet.has(String(edge.id)))
      applyVirtualizedGraph()
      commitInteractionHistory(previousState)
      void persistCanvasState({ layoutOnly: true })
      ElMessage.success('已删除画布连线')
      return
    }
    const selectedIds = selectedFreeNodeIds.value.length
      ? selectedFreeNodeIds.value
      : [focusedNodeId.value].filter(Boolean)
    const removableIds = selectedIds.filter((id) => findGraphNode(id)?.type === 'homeCanvasNode')
    if (removableIds.length) {
      event.preventDefault()
      const previousState = currentInteractionState()
      const idSet = new Set(removableIds.map(String))
      allGraphNodes.value = allGraphNodes.value.filter((node) => !idSet.has(String(node.id)))
      allGraphEdges.value = allGraphEdges.value.filter((edge) => (
        !idSet.has(String(edge.source)) && !idSet.has(String(edge.target))
      ))
      selectedFreeNodeIds.value = []
      focusedNodeId.value = null
      applyVirtualizedGraph()
      commitInteractionHistory(previousState)
      void persistCanvasState({ layoutOnly: true })
    }
    return
  }
  if (key === 'escape' || key === 'esc') {
    event.preventDefault()
    clearCanvasInteractionState()
    return
  }
  if (key === ' ' || key === 'spacebar') {
    event.preventDefault()
    setSpacePanning(true)
    return
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && isCanvasKeyboardPanKey(key)) {
    event.preventDefault()
    pressedCanvasPanKeys.add(key)
    startCanvasKeyboardPan()
    return
  }
  const modifier = event.ctrlKey || event.metaKey
  if (!modifier || event.altKey) return
  if (key === 'a') {
    event.preventDefault()
    selectVisibleCanvasNodes()
    return
  }
  if (key === 'g') {
    event.preventDefault()
    if (isStandaloneCanvas.value) createStandaloneGroup()
    else {
      void onCreateWorkflowGroup()
    }
    return
  }
  if (key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redoCanvas()
    else undoCanvas()
  } else if (key === 'y') {
    event.preventDefault()
    redoCanvas()
  }
}

function onCanvasKeyup(event) {
  const key = String(event.key || '').toLowerCase()
  if (pressedCanvasPanKeys.delete(key)) {
    event.preventDefault()
    if (!pressedCanvasPanKeys.size) stopCanvasKeyboardPan()
    return
  }
  if (key === ' ' || key === 'spacebar') {
    event.preventDefault()
    setSpacePanning(false)
  }
}

function onCanvasBlur() {
  setSpacePanning(false)
  stopCanvasKeyboardPan()
}

function persistCanvasState(options = {}) {
  const runPersist = () => persistCanvasStateNow(options)
  canvasPersistQueue = canvasPersistQueue.then(runPersist, runPersist)
  return canvasPersistQueue
}

async function persistCanvasStateNow({ layoutOnly = false, groupsOnly = false } = {}) {
  if (!dramaId.value) return

  let layoutPayload = null
  if (!groupsOnly) {
    syncRenderedNodesToGraph()
    layoutPayload = withCanvasPersistedState(buildCanvasLayoutPayload(
      allGraphNodes.value,
      currentViewport.value,
      layoutCache.value,
      allGraphEdges.value,
      {
        persistFreeNodes: isStandaloneCanvas.value,
        suppressedEdgeIds: [...suppressedEdgeIds.value],
      }
    ))
    if (layoutOnly && layoutPayload) layoutCache.value = layoutPayload
  }
  const groupsPayload = groupsOnly || !layoutOnly ? workflowGroups.value : undefined

  layoutSaveState.value = 'saving'
  try {
    const updated = await layoutPersistence.update({
      ...(layoutPayload !== null ? { canvasLayout: layoutPayload } : {}),
      ...(groupsPayload !== undefined ? { workflowGroups: groupsPayload } : {}),
    })
    const meta = parseDramaMetadata(updated.metadata)
    if (meta.canvas_layout) layoutCache.value = meta.canvas_layout
    if (meta.workflow_groups) workflowGroups.value = meta.workflow_groups
    // 仅合并 metadata / 时间戳，勿用精简对象覆盖 episodes、characters 等完整数据
    if (drama.value && updated) {
      drama.value = {
        ...drama.value,
        metadata: updated.metadata,
        updated_at: updated.updated_at,
        title: updated.title ?? drama.value.title,
        style: updated.style ?? drama.value.style,
        genre: updated.genre ?? drama.value.genre,
        description: updated.description ?? drama.value.description,
      }
      if (Array.isArray(updated.episodes) && updated.episodes.length) {
        drama.value.episodes = updated.episodes
      }
      if (Array.isArray(updated.characters)) {
        drama.value.characters = updated.characters
      }
      if (Array.isArray(updated.scenes)) {
        drama.value.scenes = updated.scenes
      }
      if (Array.isArray(updated.props)) {
        drama.value.props = updated.props
      }
    } else if (updated) {
      drama.value = updated
    }
    layoutSaveState.value = 'saved'
    layoutDirty.value = false
    if (savedHintTimer) clearTimeout(savedHintTimer)
    savedHintTimer = setTimeout(() => {
      if (layoutSaveState.value === 'saved') layoutSaveState.value = 'idle'
    }, 2000)
    return true
  } catch (e) {
    layoutSaveState.value = 'error'
    ElMessage.error(e?.message || '保存失败')
    return false
  }
}

async function onDirectorStateChange(nextState, acknowledge) {
  const currentLayout = layoutCache.value || parseCanvasLayout(drama.value?.metadata) || {}
  layoutCache.value = {
    ...currentLayout,
    director_timeline: nextState,
  }
  const saved = await persistCanvasState({ layoutOnly: true })
  acknowledge?.(saved)
}

async function loadProjectImageAssets() {
  if (!dramaId.value) {
    projectImageAssets.value = []
    storyboardAssignedAssets.value = {}
    return
  }
  const result = await assetsAPI.list({ drama_id: dramaId.value, page_size: 100 })
  const assets = Array.isArray(result) ? result : (result?.items || [])
  projectImageAssets.value = assets
  storyboardAssignedAssets.value = assets.reduce((map, asset) => {
    const storyboardId = Number(asset?.storyboard_id)
    if (!isStoryboardAssignedAsset(asset)) return map
    if (!map[storyboardId]) map[storyboardId] = []
    map[storyboardId].push(asset)
    return map
  }, {})
}

async function onDirectorAssetCreated(asset) {
  await loadProjectImageAssets()
  rebuildGraph()
  if (!shouldProjectCanvasAsset(asset)) {
    ElMessage.success('参考素材已保存到项目资产，不再生成重复画布节点')
    return
  }
  const nodeId = `project-asset:${asset.id}`
  focusedNodeId.value = nodeId
  await nextTick()
  canvasFlowApi.value?.fitView?.({ nodes: [{ id: nodeId }], padding: 0.5, duration: 350 })
  ElMessage.success('导演截图已写入项目资产并定位到画布')
}

const {
  createDialogVisible,
  createDialogType,
  pendingFlowPosition,
  openCreateDialog: openProductionCreateDialog,
  submitCreate,
} = useCanvasCrud({
  drama,
  filterEpisodeId,
  layoutCache,
  focusedNodeId,
  refreshCanvas,
  persistCanvasState,
})

async function openCreateDialog(type, flowPosition = null, connectionSource = null) {
  if (isStandaloneCanvas.value && FREE_NODE_KINDS.has(type)) {
    const nodeId = await createFreeCanvasNode(type, flowPosition)
    if (connectionSource?.sourceNodeId && nodeId) {
      onConnect({
        source: connectionSource.sourceNodeId,
        target: nodeId,
        sourceHandle: connectionSource.sourceHandle || null,
        targetHandle: null,
      })
    }
    return nodeId
  }
  openProductionCreateDialog(type, flowPosition)
  return null
}

const {
  episodeGenerating,
  episodeGenProgress,
  aiGenerateStoryboards,
  batchGenerateImages,
  batchGenerateVideos,
} = useCanvasEpisodeGenerate({
  drama,
  filterEpisodeId,
  imagesBySbId,
  videosBySbId,
  refreshCanvas,
  nodeStatus,
})

Object.assign(
  scriptActionsHolder,
  useCanvasScript({
    drama,
    dramaId,
    refreshCanvas: refreshDrama,
    nodeStatus,
  })
)

async function focusScriptNode(flowPosition = null) {
  let epId = filterEpisodeId.value
  if (!epId) {
    const eps = drama.value?.episodes || []
    if (eps.length === 1) epId = eps[0].id
  }
  if (!epId) {
    ElMessage.warning('请先选择或新建集数')
    return
  }
  if (!filterEpisodeId.value) filterEpisodeId.value = epId
  const nodeId = scriptNodeId(epId)
  if (flowPosition) {
    allGraphNodes.value = allGraphNodes.value.map((node) => (
      node.id === nodeId ? { ...node, position: { x: flowPosition.x, y: flowPosition.y } } : node
    ))
    layoutCache.value = {
      ...(layoutCache.value || { version: 1 }),
      nodes: {
        ...(layoutCache.value?.nodes || {}),
        [nodeId]: { x: flowPosition.x, y: flowPosition.y },
      },
    }
    applyVirtualizedGraph()
    await persistCanvasState({ layoutOnly: true })
  }
  await focusCanvasNode(nodeId)
}

function onTopbarMoreCommand(command) {
  if (command === 'script') focusScriptNode()
  else if (command === 'align') onAlignNodes()
  else if (command === 'run-selected-free') {
    void runFreeCanvasSubgraph(
      allGraphNodes.value.filter((node) => node.type === 'homeCanvasNode' && node.selected).map((node) => node.id),
      false,
    )
  }
  else openCreateDialog(command)
}

async function onAlignNodes() {
  if (!canAlignCanvasNodes({
    standalone: isStandaloneCanvas.value,
    hasDrama: Boolean(drama.value),
    nodeCount: allGraphNodes.value.length,
    aligning: aligningNodes.value,
  })) return
  aligningNodes.value = true
  focusedNodeId.value = null
  try {
    const positions = isStandaloneCanvas.value
      ? computeStandaloneAutoLayoutPositions(allGraphNodes.value, {
          columnGap: 560 + canvasPreferences.value.layout_horizontal_gap,
          rowGap: 350 + canvasPreferences.value.layout_vertical_gap,
        })
      : computeAutoLayoutPositions(drama.value, {
        episodeId: filterEpisodeId.value,
        workflowGroups: workflowGroups.value,
        imagesBySbId: imagesBySbId.value,
        videosBySbId: videosBySbId.value,
      }).positions
    allGraphNodes.value = allGraphNodes.value.map((n) => {
      const pos = positions[n.id]
      return pos
        ? {
            ...n,
            position: { x: pos.x, y: pos.y },
            ...(n.computedPosition
              ? { computedPosition: { ...n.computedPosition, x: pos.x, y: pos.y } }
              : {}),
          }
        : n
    })
    applyVirtualizedGraph()
    canvasFlowApi.value?.setNodes?.(nodes.value)
    layoutCache.value = {
      version: 1,
      nodes: { ...positions },
      viewport: layoutCache.value?.viewport,
    }
    await nextTick()
    const flowApi = canvasFlowApi.value
    if (flowApi?.fitView) {
      await flowApi.fitView({
        padding: 0.14,
        duration: 380,
        includeHiddenNodes: false,
      })
      await new Promise((r) => setTimeout(r, 400))
      const vp = flowApi.getViewport?.()
      if (vp) {
        currentViewport.value = { x: vp.x, y: vp.y, zoom: vp.zoom }
        scheduleVirtualization()
      }
    }
    await persistCanvasState({ layoutOnly: true })
    ElMessage.success('节点已按规则对齐并适配当前视图')
  } catch (e) {
    ElMessage.error(e?.message || '对齐失败')
  } finally {
    aligningNodes.value = false
  }
}

async function loadDrama(silent = false) {
  if (!dramaId.value) return
  if (!silent) loading.value = true
  try {
    drama.value = await dramaAPI.get(dramaId.value)
    await loadProjectImageAssets()
    layoutCache.value = parseCanvasLayout(drama.value.metadata)
    const preferences = normalizeCanvasPreferences(layoutCache.value?.preferences)
    canvasPreferences.value = preferences
    persistedGenerationHistory.value = normalizeGenerationHistory(layoutCache.value?.generation_history)
    suppressedEdgeIds.value = new Set((layoutCache.value?.suppressed_edge_ids || []).map(String))
    syncWorkflowFromDrama()
    const vp = resolveViewport(layoutCache.value)
    currentViewport.value = vp
    if (route.query.episode) filterEpisodeId.value = Number(route.query.episode)
    await loadForDrama(drama.value, filterEpisodeId.value)
    rebuildGraph()
    resumePendingFreeCanvasTasks()
  } catch (e) {
    if (!silent) ElMessage.error(e?.message || '加载项目失败')
  } finally {
    if (!silent) loading.value = false
  }
}

async function onCreateWorkflowGroup() {
  if (workflowRunning.value || layoutSaveState.value === 'saving') {
    ElMessage.warning('请等待当前画布任务完成后再创建工作流')
    return
  }
  if (!selectedStoryboardIds.value.length) {
    ElMessage.warning('请先框选或 Ctrl 点击选择分镜节点')
    return
  }
  const previousGroups = workflowGroups.value
  const previousActiveGroupId = activeGroupId.value
  try {
    const { value } = await ElMessageBox.prompt('工作流名称', '创建工作流', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputValue: `工作流 ${workflowGroups.value.length + 1}`,
    })
    workflowGroups.value = createWorkflowGroup(workflowGroups.value, {
      title: value?.trim() || undefined,
      storyboardIds: selectedStoryboardIds.value,
      pipeline: normalizePipeline(pipelineSteps.value),
    })
    activeGroupId.value = workflowGroups.value[workflowGroups.value.length - 1]?.id || null
    const saved = await persistCanvasState({ groupsOnly: true })
    if (!saved) {
      workflowGroups.value = previousGroups
      activeGroupId.value = previousActiveGroupId
      rebuildGraph()
      return
    }
    rebuildGraph()
    ElMessage.success('工作流已创建')
  } catch (_) {}
}

async function onDeleteActiveGroup() {
  if (!activeGroupId.value) return
  const previousGroups = workflowGroups.value
  const previousActiveGroupId = activeGroupId.value
  try {
    await ElMessageBox.confirm('确定删除该工作流？', '删除工作流', { type: 'warning' })
    workflowGroups.value = deleteWorkflowGroup(workflowGroups.value, activeGroupId.value)
    activeGroupId.value = workflowGroups.value[0]?.id || null
    const saved = await persistCanvasState({ groupsOnly: true })
    if (!saved) {
      workflowGroups.value = previousGroups
      activeGroupId.value = previousActiveGroupId
      rebuildGraph()
      return
    }
    rebuildGraph()
    selectedStoryboardIds.value = []
    ElMessage.success('已删除')
  } catch (_) {}
}

async function onWorkflowOrderChange(storyboardIds) {
  if (!activeGroupId.value || workflowRunning.value || layoutSaveState.value === 'saving') return
  const previousGroups = workflowGroups.value
  const nextGroups = reorderWorkflowGroup(workflowGroups.value, activeGroupId.value, storyboardIds)
  const previousIds = previousGroups.find((group) => group.id === activeGroupId.value)?.storyboard_ids || []
  const nextIds = nextGroups.find((group) => group.id === activeGroupId.value)?.storyboard_ids || []
  if (JSON.stringify(previousIds) === JSON.stringify(nextIds)) return

  workflowGroups.value = nextGroups
  rebuildGraph()
  const saved = await persistCanvasState({ groupsOnly: true })
  if (!saved) {
    workflowGroups.value = previousGroups
    rebuildGraph()
    return
  }
  ElMessage.success('工作流执行顺序已保存')
}

async function focusWorkflowStoryboard(storyboardId) {
  const id = Number(storyboardId)
  if (!Number.isFinite(id)) return
  applySelectedStoryboardIds([id])
  await focusCanvasNode(`sb:${id}`)
}

async function onRunActiveGroup() {
  const group = workflowGroups.value.find((g) => g.id === activeGroupId.value)
  if (!group) {
    ElMessage.warning('请先选择工作流')
    return
  }

  await runWorkflowWithConfirm({
    ...group,
    pipeline: normalizePipeline(group.pipeline?.length ? group.pipeline : pipelineSteps.value),
  }, '整组重跑')
}

async function onRunSelectedStoryboards() {
  const storyboardIds = selectedStoryboardIds.value
    .map(Number)
    .filter((id) => visibleStoryboardIds.value.has(id))

  if (!storyboardIds.length) {
    ElMessage.warning('请先框选或 Ctrl 点击选择分镜节点')
    return
  }

  await runWorkflowWithConfirm({
    id: 'selected-storyboards',
    title: '所选分镜',
    storyboard_ids: storyboardIds,
    pipeline: normalizePipeline(pipelineSteps.value),
  }, '运行所选分镜')
}

async function runWorkflowWithConfirm(runGroup, confirmTitle) {
  try {
    await ElMessageBox.confirm(
      `将对 ${(runGroup.storyboard_ids || []).length} 个分镜依次执行：${(runGroup.pipeline || pipelineSteps.value).join(' → ')}\n耗时可能较长，是否继续？`,
      confirmTitle,
      { type: 'warning', confirmButtonText: '开始执行' }
    )
  } catch {
    return
  }

  const storyboardIds = runGroup.storyboard_ids || []
  const total = storyboardIds.length
  let currentIndex = 0

  storyboardIds.forEach((storyboardId) => nodeStatus.clear(`sb:${storyboardId}`))
  workflowRunning.value = true
  workflowProgress.value = '准备执行…'
  try {
    const summary = await runWorkflowGroup(drama.value, runGroup, {
      stopOnError: true,
      generationOptions: getCanvasGenerationOptions(),
      reloadStoryboard: async (storyboardId) => {
        await loadDrama(true)
        return findStoryboardInDrama(drama.value, storyboardId)?.storyboard
      },
      onStoryboardStart: ({ storyboardId }) => {
        currentIndex = Math.max(storyboardIds.indexOf(storyboardId) + 1, currentIndex + 1)
        nodeStatus.set(`sb:${storyboardId}`, {
          step: 'workflow',
          message: `工作流 ${currentIndex}/${total}`,
        })
        workflowProgress.value = `${runGroup.title} · ${currentIndex}/${total} · 准备执行…`
      },
      onStepStart: ({ storyboardId, step }) => {
        const label = CANVAS_NODE_STATUS_LABELS[step] || step
        nodeStatus.set(`sb:${storyboardId}`, { step, message: label, storyboardId, retryStep: step })
        workflowProgress.value = `${runGroup.title} · ${currentIndex}/${total} · 分镜 #${storyboardId}：${label}`
      },
      onStoryboardComplete: ({ storyboardId }) => {
        nodeStatus.clear(`sb:${storyboardId}`)
      },
      onStepError: ({ storyboardId, step, error }) => {
        nodeStatus.fail(`sb:${storyboardId}`, {
          message: `${CANVAS_NODE_STATUS_LABELS[step] || step}失败：${error?.message || error}`,
          errorDetail: error?.message || String(error || ''),
          storyboardId,
          retryStep: step,
          retryLabel: `重试${CANVAS_NODE_STATUS_LABELS[step] || step}`,
        })
      },
      onStoryboardError: ({ storyboardId, error }) => {
        nodeStatus.fail(`sb:${storyboardId}`, {
          message: `工作流失败：${error?.message || error}`,
          errorDetail: error?.message || String(error || ''),
          storyboardId,
          retryStep: queueNodeRetryStep(findGraphNode(`sb:${storyboardId}`)) || 'video',
          retryLabel: '重试当前分镜',
        })
        ElMessage.error(`分镜 #${storyboardId} 失败：${error?.message || error}`)
      },
    })
    await loadDrama(true)
    await loadForDrama(drama.value, filterEpisodeId.value)
    rebuildGraph()
    if (summary.failed.length) {
      ElMessage.warning(`完成 ${summary.ok.length} 镜，失败 ${summary.failed.length} 镜`)
    } else {
      ElMessage.success(`工作流执行完成，共 ${summary.ok.length} 镜`)
    }
  } catch (e) {
    ElMessage.error(e?.message || '工作流执行失败')
  } finally {
    workflowRunning.value = false
    workflowProgress.value = ''
  }
}

function hasProcessingStoryboards() {
  for (const ep of drama.value?.episodes || []) {
    for (const sb of ep.storyboards || []) {
      if (sb.status === 'processing') return true
    }
  }
  return false
}

function startStatusPoll() {
  stopStatusPoll()
  if (!hasProcessingStoryboards()) return
  pollTimer = setInterval(() => {
    if (hasProcessingStoryboards()) loadDrama(true)
    else stopStatusPoll()
  }, 8000)
}

function stopStatusPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function goListMode() {
  if (isStandaloneCanvas.value) {
    router.push('/canvas')
    return
  }
  const query = filterEpisodeId.value ? { episode: String(filterEpisodeId.value) } : {}
  router.push({ path: `/film/${dramaId.value}`, query })
}

function navigateToProduction(episodeId, hash) {
  router.push({
    path: `/film/${dramaId.value}`,
    query: episodeId ? { episode: String(episodeId) } : {},
    hash: hash ? `#${hash}` : undefined,
  })
}

function navigateToStoryboard(episodeId, storyboardId) {
  navigateToProduction(episodeId, storyboardId ? `sb-${storyboardId}` : undefined)
}

function onNodeDoubleClick({ node }) {
  if (node.type === 'homeCanvasNode') {
    openFreeNodeDialog(node.data?.kind || 'text', node.position, node)
    return
  }
  if (node.type === 'canvasStoryboard') {
    navigateToStoryboard(node.data.episodeId || node.data.storyboard?.episode_id, node.data.storyboard?.id)
    return
  }

  if (node.type === 'canvasScript') {
    navigateToProduction(node.data.episode?.id, 'anchor-script')
    return
  }

  if (node.type === 'canvasEpisode') {
    navigateToProduction(node.data.episode?.id, 'anchor-storyboard')
    return
  }

  if (node.type === 'canvasAsset') {
    const anchor = {
      character: 'anchor-characters',
      scene: 'anchor-scenes',
      prop: 'anchor-props',
    }[node.data?.kind]
    navigateToProduction(filterEpisodeId.value, anchor)
    return
  }

  const ref = getStoryboardRefFromNode(node)
  if (ref?.storyboardId) navigateToStoryboard(ref.episodeId, ref.storyboardId)
}

function onPaneClick(event) {
  if (paneClickSuppressed.value) return
  const target = event?.event?.target || event?.target
  if (target?.closest?.('.canvas-node-panel') || target?.closest?.('.el-popper') || target?.closest?.('.canvas-context-menu')) {
    return
  }
  focusedNodeId.value = null
  if (isStandaloneCanvas.value) applySelectedFreeNodeIds([])
  activeGroupId.value = null
  closeContextMenu()
}

function onNodeClick({ node, event }) {
  if (node.type === 'canvasAddButton') {
    event?.stopPropagation?.()
    openCreateDialog(node.data?.assetType || 'storyboard', node.data?.flowPosition || node.position || null)
    return
  }

  if (PANEL_NODE_TYPES.has(node.type)) {
    focusNodeForConfig(node, { syncStoryboard: false })
  }

  if (node.type === 'homeCanvasNode') {
    if (!event?.ctrlKey && !event?.metaKey) {
      applySelectedFreeNodeIds([node.id])
    }
    focusedNodeId.value = node.id
    scheduleVirtualization()
    return
  }

  if (node.type === 'canvasAsset') {
    const prefix = node.data.kind === 'character' ? 'char' : node.data.kind === 'scene' ? 'scene' : 'prop'
    selectSidebarAsset(`${prefix}:${node.data.entity.id}`)
    return
  }
  const sbId = storyboardIdFromNodeId(node.id) || storyboardForNode(node)?.id
  if (sbId) {
    selectStoryboard(sbId, event)
  }
}

watch(filterEpisodeId, async (val) => {
  if (drama.value) await loadForDrama(drama.value, val)
  if (highlightAssetId.value && !isCanvasAssetVisible(highlightAssetId.value, episodeContext.value)) {
    highlightAssetId.value = null
  }
  rebuildGraph()
  selectedStoryboardIds.value = selectedStoryboardIds.value.filter((id) => visibleStoryboardIds.value.has(Number(id)))
  if (activeGroupId.value) {
    const activeGroup = workflowGroups.value.find((group) => group.id === activeGroupId.value)
    const hasVisibleStoryboards = activeGroup
      && activeGroup.storyboard_ids.some((id) => visibleStoryboardIds.value.has(Number(id)))
    if (!hasVisibleStoryboards) activeGroupId.value = null
  }
  const query = { ...route.query }
  if (val != null) query.episode = String(val)
  else delete query.episode
  router.replace({ query }).catch(() => {})
})

watch(focusedNodeId, () => scheduleVirtualization())

watch(allGraphNodes, () => {
  resumePendingImageToolOperations()
})

watch(() => dramaId.value, () => {
  restoreNodeStatusSnapshot()
}, { immediate: true })

watch(nodeStatus.map, () => {
  persistNodeStatusSnapshot()
}, { deep: true })

watch(liveRunQueueItems, (items) => {
  const nextHistory = mergeGenerationHistory(
    persistedGenerationHistory.value,
    items.filter((item) => item.tone === 'success' || item.tone === 'failed'),
  )
  if (JSON.stringify(nextHistory) === JSON.stringify(persistedGenerationHistory.value)) return
  persistedGenerationHistory.value = nextHistory
  scheduleLayoutSave()
}, { deep: true })

watch(() => route.params.id, () => {
  highlightAssetId.value = null
  layoutCache.value = null
  activeGroupId.value = null
  selectedStoryboardIds.value = []
  focusedNodeId.value = null
  generationOverrides.value = {}
  freeCanvasVoiceOptions.value = []
  canvasPreferences.value = normalizeCanvasPreferences(DEFAULT_CANVAS_PREFERENCES)
  persistedGenerationHistory.value = []
  freeCanvasVoiceOptionsLoaded = false
  loadDrama()
}, { immediate: true })

watch(isStandaloneCanvas, (standalone) => {
  if (standalone) void loadFreeCanvasModelConfigs()
}, { immediate: true })

watch(drama, () => {
  startStatusPoll()
  void loadFreeCanvasVoiceOptions()
})

onMounted(() => {
  scheduleVirtualization()
  runQueueTimer = setInterval(() => {
    queueNow.value = Date.now()
  }, 1000)
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', scheduleVirtualization)
    window.addEventListener('keydown', onCanvasKeydown)
    window.addEventListener('keyup', onCanvasKeyup)
    window.addEventListener('blur', onCanvasBlur)
  }
})

onBeforeUnmount(() => {
  stopCanvasKeyboardPan()
  if (saveTimer) clearTimeout(saveTimer)
  if (savedHintTimer) clearTimeout(savedHintTimer)
  if (paneClickSuppressTimer) clearTimeout(paneClickSuppressTimer)
  if (generationSaveTimer) clearTimeout(generationSaveTimer)
  if (runQueueTimer) clearInterval(runQueueTimer)
  if (virtualizationFrame != null) {
    if (typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(virtualizationFrame)
    else clearTimeout(virtualizationFrame)
    virtualizationFrame = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', scheduleVirtualization)
    window.removeEventListener('keydown', onCanvasKeydown)
    window.removeEventListener('keyup', onCanvasKeyup)
    window.removeEventListener('blur', onCanvasBlur)
  }
  stopStatusPoll()
  if (layoutDirty.value) persistCanvasState({ layoutOnly: true })
})
</script>

<style scoped>
.drama-canvas-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page, #0f0f12);
  color: var(--text-primary, #e4e4e7);
  overflow: hidden;
}

.header {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color, #27272a);
  background: var(--bg-card, #18181b);
}

.header-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px 6px;
  flex-wrap: wrap;
}

.workflow-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px 10px;
  flex-wrap: wrap;
}

.wf-hint {
  font-size: 12px;
  color: var(--text-subtle, #71717a);
}

.wf-steps {
  display: flex;
  gap: 4px;
}

.workflow-progress {
  padding: 0 20px 8px;
  font-size: 12px;
  color: #60a5fa;
}

.workflow-progress.episode-gen {
  color: #34d399;
}

.generate-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 20px 10px;
  flex-wrap: wrap;
  border-top: 1px solid rgba(63, 63, 70, 0.35);
  margin-top: 2px;
  padding-top: 8px;
}

.gen-label {
  font-size: 12px;
  font-weight: 600;
  color: #a1a1aa;
  margin-right: 4px;
}

.gen-hint {
  font-size: 11px;
  color: #52525b;
  flex: 1;
  min-width: 200px;
}

.logo {
  margin: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 1.2;
}
.brand-logo { width: 40px; height: 40px; object-fit: cover; border-radius: 11px; flex: 0 0 auto; }
.brand-copy { display: flex; flex-direction: column; }

.logo-main {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-bright, #fafafa);
}

.logo-sub {
  font-size: 11px;
  color: #818cf8;
}

.breadcrumb-sep { color: var(--text-faint, #52525b); }

.page-title {
  font-size: 14px;
  color: var(--text-muted, #a1a1aa);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layout-status { font-size: 12px; }
.layout-status.saving { color: #60a5fa; }
.layout-status.saved { color: #34d399; }
.layout-status.error { color: #f87171; }
.canvas-virtualization-status {
  flex: 0 0 auto;
  padding: 3px 7px;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 999px;
  color: #93c5fd;
  font-size: 11px;
  white-space: nowrap;
}

.header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.canvas-shell {
  flex: 1;
  display: flex;
  min-height: 0;
}

.canvas-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color, #27272a);
  background: var(--bg-card, #18181b);
  padding: 14px 12px;
  overflow-y: auto;
}

.sidebar-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 12px;
  color: var(--text-bright, #fafafa);
}

.sidebar-context {
  margin: -6px 0 12px;
  font-size: 10px;
  color: var(--text-faint, #52525b);
}

.sidebar-section { margin-bottom: 14px; }
.sidebar-script {
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border-color, #27272a);
}
.sidebar-script-tip {
  margin: 0;
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-subtle, #71717a);
}

.sec-label {
  font-size: 11px;
  color: var(--text-subtle, #71717a);
  margin-bottom: 6px;
}

.sec-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-item {
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--text-primary, #e4e4e7);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s;
}
.sidebar-item:hover { background: rgba(129, 140, 248, 0.12); }
.sidebar-item.active { background: rgba(52, 211, 153, 0.16); color: #6ee7b7; }

.workflow-item { white-space: normal; }
.wf-item-title { font-weight: 600; }
.wf-item-meta { font-size: 10px; color: var(--text-faint, #52525b); margin-top: 2px; }
.sidebar-empty { font-size: 11px; color: var(--text-faint, #52525b); padding: 4px 0; }

.sidebar-tip {
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-faint, #52525b);
  margin-top: 16px;
}

.canvas-main {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--canvas-theme-background, #0f0f0f);
}

.canvas-main.space-panning :deep(.vue-flow__pane) {
  cursor: grab;
}

.canvas-main.space-panning :deep(.vue-flow__pane:active) {
  cursor: grabbing;
}
.canvas-main.standalone-group-selected :deep(.vue-flow__nodesselection-rect) {
  pointer-events: none;
}
.canvas-main.standalone-group-selected :deep(.vue-flow__node[data-id^="canvas-group:"]) {
  z-index: -1 !important;
}

.vue-flow-canvas {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  background: transparent;
}

.canvas-custom-background {
  position: absolute;
  inset: -24px;
  z-index: 0;
  pointer-events: none;
}

.canvas-alignment-guide {
  position: absolute;
  z-index: 18;
  pointer-events: none;
  background: rgba(124, 92, 255, 0.9);
  box-shadow: 0 0 8px rgba(124, 92, 255, 0.55);
}
.canvas-alignment-guide.vertical { top: 0; bottom: 0; width: 1px; }
.canvas-alignment-guide.horizontal { left: 0; right: 0; height: 1px; }

.canvas-main.canvas-glow::after {
  content: '';
  position: absolute;
  inset: -20%;
  z-index: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--canvas-panel-background, #18181b) 85%, #7c5cff 15%) 0%, transparent 58%);
  opacity: 0.72;
}

.canvas-main :deep(.canvas-cuttable-edge .vue-flow__edge-path) {
  stroke: var(--canvas-edge-color, rgba(255, 255, 255, 0.11)) !important;
  stroke-width: var(--canvas-edge-width, 2px) !important;
}
.canvas-main :deep(.vue-flow__edge.selected .canvas-cuttable-edge .vue-flow__edge-path),
.canvas-main :deep(.vue-flow__edge:hover .canvas-cuttable-edge .vue-flow__edge-path) {
  stroke: var(--canvas-edge-focus-color, rgba(255, 255, 255, 0.45)) !important;
}
.canvas-main :deep(.vue-flow__edge-interaction) {
  stroke-width: var(--canvas-edge-focus-radius, 12px);
}
.canvas-main.edge-focus-only :deep(.vue-flow__edge:not(.selected):not(:hover) .vue-flow__edge-path) {
  opacity: 0;
}
.canvas-main.edge-animated :deep(.canvas-cuttable-edge .vue-flow__edge-path) {
  stroke-dasharray: 8 8 !important;
  animation: canvas-edge-dash 1.2s linear infinite;
}

.canvas-main.minimal-zoom :deep(.vue-flow__node) {
  border-radius: 8px;
}
.canvas-main.linked-preview-hidden :deep(.reference-panel) { display: none; }
.canvas-main.minimal-zoom :deep(.vue-flow__nodes .vue-flow__node:nth-child(6n + 1)) { box-shadow: 0 0 0 2px var(--canvas-simple-1, rgba(255, 255, 255, 0.06)); }
.canvas-main.minimal-zoom :deep(.vue-flow__nodes .vue-flow__node:nth-child(6n + 2)) { box-shadow: 0 0 0 2px var(--canvas-simple-2, rgba(255, 255, 255, 0.06)); }
.canvas-main.minimal-zoom :deep(.vue-flow__nodes .vue-flow__node:nth-child(6n + 3)) { box-shadow: 0 0 0 2px var(--canvas-simple-3, rgba(255, 255, 255, 0.06)); }
.canvas-main.minimal-zoom :deep(.vue-flow__nodes .vue-flow__node:nth-child(6n + 4)) { box-shadow: 0 0 0 2px var(--canvas-simple-4, rgba(255, 255, 255, 0.06)); }
.canvas-main.minimal-zoom :deep(.vue-flow__nodes .vue-flow__node:nth-child(6n + 5)) { box-shadow: 0 0 0 2px var(--canvas-simple-5, rgba(255, 255, 255, 0.06)); }
.canvas-main.minimal-zoom :deep(.vue-flow__nodes .vue-flow__node:nth-child(6n + 6)) { box-shadow: 0 0 0 2px var(--canvas-simple-6, rgba(255, 255, 255, 0.06)); }

@keyframes canvas-edge-dash {
  to { stroke-dashoffset: -16; }
}

.canvas-upload-input {
  display: none;
}

:deep(.vue-flow__minimap) {
  background: rgba(24, 24, 27, 0.92);
  border: 1px solid #3f3f46;
}

:deep(.vue-flow__controls) {
  box-shadow: none;
  border: 1px solid #3f3f46;
}

:deep(.vue-flow__controls button) {
  background: #18181b;
  border-color: #3f3f46;
  color: #e4e4e7;
}

:deep(.vue-flow__node.selected) {
  box-shadow: 0 0 0 2px rgba(255, 113, 57, 0.86);
}
/* OpenVideo 风格画布工作区覆盖层 */
.header.canvas-topbar {
  position: absolute;
  inset: 0 0 auto;
  z-index: 30;
  min-height: 64px;
  border-bottom: 1px solid #242424;
  background: #080808;
  color: #f5f5f5;
  pointer-events: none;
}
.canvas-topbar .header-inner {
  scale: var(--canvas-top-toolbar-scale, 1);
  transform-origin: top center;
  min-height: 64px;
  margin: 0;
  padding: 8px 18px;
  min-width: 0;
  flex-wrap: nowrap;
  border: 0;
  background: transparent;
  box-shadow: none;
  pointer-events: auto;
}
.canvas-topbar :deep(.canvas-workspace-switcher) {
  padding: 5px 10px 5px 5px;
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 14px;
  background: rgba(12, 12, 12, .9);
  box-shadow: 0 14px 38px rgba(0, 0, 0, .32);
  backdrop-filter: blur(18px);
}
.canvas-name {
  padding-left: 12px;
  border-left: 1px solid #3f3f46;
  color: #a1a1aa;
  font-size: 12px;
  white-space: nowrap;
}
.canvas-topbar .header-actions {
  gap: 6px;
  min-width: 0;
  margin-left: auto;
  padding: 5px;
  flex: 0 0 auto;
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 14px;
  background: rgba(12, 12, 12, .9);
  box-shadow: 0 14px 38px rgba(0, 0, 0, .32);
  backdrop-filter: blur(18px);
}
.canvas-topbar {
  --el-text-color-regular: #d4d4d8;
  --el-text-color-primary: #f5f5f5;
  --el-button-text-color: #f5f5f5;
  --el-button-bg-color: #151515;
  --el-button-border-color: #303030;
  --el-button-hover-text-color: #ff9a72;
  --el-button-hover-bg-color: rgba(255, 113, 57, .12);
  --el-button-hover-border-color: rgba(255, 113, 57, .48);
}
.canvas-topbar :deep(.platform-primary-nav__link) {
  color: #a1a1aa;
}
.canvas-topbar :deep(.platform-primary-nav__link:hover),
.canvas-topbar :deep(.platform-primary-nav__link.is-active) {
  color: #f5f5f5;
}
.canvas-topbar :deep(.platform-primary-nav__link.is-active)::after {
  background: #ff7139;
}
.canvas-topbar .page-title {
  min-width: 0;
  max-width: 280px;
  padding: 10px 14px;
  flex: 0 1 auto;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .08);
  border-radius: 12px;
  color: #efefef;
  background: rgba(12, 12, 12, .9);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar-history {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border: 1px solid #292929;
  border-radius: 9px;
  background: #111;
}
.topbar-history button {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 7px;
  color: #969696;
  background: transparent;
  cursor: pointer;
}
.topbar-history button:hover:not(:disabled) { color: #fff; background: #202020; }
.topbar-history button:disabled { opacity: .34; cursor: not-allowed; }
.canvas-topbar .topbar-workflow-toggle { min-width: 92px; }
.canvas-topbar .topbar-share { width: 38px; padding: 0; }
.canvas-topbar .topbar-more { flex: 0 0 auto; }
.canvas-topbar .topbar-more-trigger { min-width: 42px; padding: 0 10px; }
.canvas-topbar .topbar-more-label { margin-left: 4px; }
.canvas-topbar .el-button { min-height: 38px; }
.canvas-topbar .workflow-bar,
.canvas-topbar .generate-bar,
.canvas-topbar .workflow-progress { pointer-events: auto; }
.canvas-topbar .workflow-bar,
.canvas-topbar .generate-bar {
  margin: 8px 16px 0;
  padding: 10px 14px;
  border: 1px solid #303030;
  border-radius: 14px;
  background: rgba(15, 15, 15, 0.94);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(18px);
}
.canvas-topbar .workflow-progress {
  margin: 8px 16px 0;
  padding: 7px 12px;
  border-radius: 10px;
  background: rgba(24, 24, 27, 0.86);
}
.canvas-shell { position: relative; width: 100%; }
.canvas-sidebar {
  position: absolute;
  top: 82px;
  left: 16px;
  bottom: 16px;
  z-index: 20;
  width: 248px;
  border: 1px solid rgba(82, 82, 91, 0.72);
  border-radius: 16px;
  background: rgba(24, 24, 27, 0.9);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(18px);
}
.canvas-main { width: 100%; height: 100%; }
.vue-flow-canvas { background: transparent; }
.canvas-topbar .layout-status { font-size: 11px; white-space: nowrap; }
.canvas-run-queue {
  position: absolute;
  left: 18px;
  bottom: 22px;
  z-index: 24;
  width: min(360px, calc(100% - 36px));
  padding: 9px;
  border: 1px solid rgba(82, 82, 91, 0.72);
  border-radius: 14px;
  background: rgba(24, 24, 27, 0.92);
  box-shadow: 0 16px 38px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(18px);
  pointer-events: auto;
}
.run-queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 3px 7px;
  color: #e4e4e7;
  font-size: 12px;
  font-weight: 700;
}
.run-queue-head small {
  color: #71717a;
  font-size: 10px;
  font-weight: 400;
}
.run-queue-head button {
  padding: 2px 7px;
  border: 1px solid rgba(129, 140, 248, 0.5);
  border-radius: 999px;
  background: rgba(49, 46, 129, 0.35);
  color: #c7d2fe;
  font-size: 10px;
  cursor: pointer;
}
.run-queue-head button:hover {
  border-color: rgba(129, 140, 248, 0.85);
  background: rgba(67, 56, 202, 0.45);
}
.run-queue-item {
  width: 100%;
  display: grid;
  grid-template-columns: 10px 42px 1fr auto;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  padding: 7px 8px;
  border: 1px solid rgba(63, 63, 70, 0.8);
  border-radius: 10px;
  background: rgba(9, 9, 11, 0.44);
  color: #d4d4d8;
  text-align: left;
  cursor: pointer;
}
.run-queue-item:hover {
  border-color: rgba(129, 140, 248, 0.62);
  background: rgba(129, 140, 248, 0.12);
}
.run-queue-item.queue-preview-audio {
  grid-template-columns: 10px 112px minmax(0, 1fr) auto;
}
.run-queue-item.queue-preview-text {
  grid-template-columns: 10px 96px minmax(0, 1fr) auto;
}
.run-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #60a5fa;
}
.tone-running .run-dot {
  animation: queue-pulse 1.2s ease-in-out infinite;
}
.tone-failed .run-dot {
  background: #f87171;
}
.tone-success .run-dot {
  background: #34d399;
}
.run-result-preview {
  width: 42px;
  height: 32px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid rgba(63, 63, 70, 0.8);
  background: rgba(39, 39, 42, 0.72);
}
.run-result-preview:not(.preview-empty) {
  cursor: zoom-in;
}
.run-result-preview img,
.run-result-preview video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.run-result-preview.preview-audio {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 112px;
  color: #fbbf24;
  background: rgba(251, 191, 36, 0.12);
}
.run-result-preview.preview-audio audio {
  width: 104px;
  height: 24px;
}
.run-result-preview.preview-text {
  width: 96px;
  padding: 4px 6px;
  color: #c7d2fe;
  background: rgba(129, 140, 248, 0.12);
}
.run-result-preview.preview-text small {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 9px;
  line-height: 1.25;
}
.run-result-preview.preview-empty {
  opacity: 0.28;
}
.run-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.run-info strong,
.run-info small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-info strong {
  font-size: 11px;
  font-weight: 700;
}
.run-info small {
  color: #a1a1aa;
  font-size: 10px;
}
.tone-failed .run-info small {
  color: #fca5a5;
}
.tone-success .run-info small {
  color: #bbf7d0;
}
.run-info .run-action-error {
  color: #fed7aa;
}
.run-action {
  color: #a5b4fc;
  font-size: 10px;
}
.run-success-actions,
.run-failed-actions {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.run-success-actions button {
  padding: 3px 7px;
  border: 1px solid rgba(52, 211, 153, 0.55);
  border-radius: 999px;
  background: rgba(6, 78, 59, 0.32);
  color: #bbf7d0;
  font-size: 10px;
  cursor: pointer;
}
.run-success-actions button:hover {
  border-color: rgba(52, 211, 153, 0.9);
  background: rgba(6, 95, 70, 0.48);
}
.run-failed-actions button {
  padding: 3px 7px;
  border: 1px solid rgba(248, 113, 113, 0.55);
  border-radius: 999px;
  background: rgba(127, 29, 29, 0.32);
  color: #fecaca;
  font-size: 10px;
  cursor: pointer;
}
.run-failed-actions button:hover {
  border-color: rgba(248, 113, 113, 0.9);
  background: rgba(185, 28, 28, 0.45);
}
.canvas-collaboration-link,
.canvas-collaboration-invite {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}
.canvas-collaboration-members {
  min-height: 72px;
  margin-top: 16px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}
.canvas-collaboration-member {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
.canvas-collaboration-member + .canvas-collaboration-member {
  border-top: 1px solid var(--el-border-color-lighter);
}
.canvas-collaboration-empty {
  padding: 16px 0;
  color: var(--el-text-color-secondary);
  text-align: center;
}
@keyframes queue-pulse {
  0%, 100% { opacity: 0.45; transform: scale(0.92); }
  50% { opacity: 1; transform: scale(1.12); }
}
@media (max-width: 980px) {
  .canvas-topbar .header-inner { margin: 0; padding: 8px 10px; }
  .page-title { max-width: 160px; }
  .canvas-topbar .episode-select { width: 130px !important; }
}
@media (max-width: 680px) {
  .canvas-topbar .header-inner { padding: 7px 8px; }
  .workspace-switcher { min-width: 0; }
  .brand-copy, .breadcrumb-sep, .canvas-name, .layout-status, .canvas-virtualization-status { display: none; }
  .brand-logo { width: 34px; height: 34px; }
  .page-title { max-width: 120px; }
  .episode-select { width: 112px !important; }
  .canvas-topbar .topbar-workflow-toggle { min-width: 42px; padding: 0 10px; }
  .canvas-topbar .topbar-workflow-toggle .el-icon + span { display: none; }
  .canvas-topbar .topbar-more-label { display: none; }
  .canvas-topbar .topbar-more-trigger { width: 42px; padding: 0; }
  .canvas-topbar .header-actions { gap: 4px; }
  .canvas-sidebar { top: 70px; left: 8px; right: 8px; width: auto; }
}
@media (max-width: 480px) {
  .canvas-topbar .page-title { display: none; }
  .canvas-topbar .header-inner { gap: 6px; margin: 0; }
  .canvas-topbar .episode-select { width: 96px !important; }
}
@media (prefers-reduced-motion: reduce) {
  .canvas-topbar .header-inner { transition: none; }
}
</style>

<style>
html.light .drama-canvas-page { background: #080808; }
html.light .drama-canvas-page .vue-flow-canvas { background: #080808; }
html.light .drama-canvas-page .header.canvas-topbar {
  border-bottom-color: #242424 !important;
  background: #080808 !important;
  color: #f5f5f5 !important;
}
html.light .drama-canvas-page .canvas-topbar .header-actions .el-button {
  border-color: #303030 !important;
  background: #151515 !important;
  color: #f5f5f5 !important;
}
html.light .drama-canvas-page .canvas-topbar .header-actions .el-button:hover {
  border-color: rgba(255, 113, 57, .48) !important;
  background: rgba(255, 113, 57, .12) !important;
  color: #ff9a72 !important;
}
</style>
