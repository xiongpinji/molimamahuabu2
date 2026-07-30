<template>
  <div
    v-if="visible"
    ref="dialogRef"
    class="director-stage"
    :class="`director-stage--${entryMode}`"
    role="dialog"
    aria-modal="true"
    :aria-label="entryTitle"
    tabindex="-1"
  >
    <header class="director-stage__header">
      <strong>{{ entryTitle }}</strong>
      <div class="director-stage__view-switch" aria-label="视角切换">
        <button type="button" :class="{ active: viewMode === 'director' }" @click="setView('director')">导演视角</button>
        <button type="button" :class="{ active: viewMode === 'camera' }" @click="setView('camera')">机位视角</button>
      </div>
      <div class="director-stage__header-actions">
        <span class="director-stage__save-state" :class="{ dirty }">{{ dirty ? '有修改' : '已保存' }}</span>
        <button type="button" :disabled="!canUndo" aria-label="撤销导演操作" title="撤销（Ctrl/Cmd+Z）" @click="undoDirector">撤销</button>
        <button type="button" :disabled="!canRedo" aria-label="重做导演操作" title="重做（Ctrl/Cmd+Shift+Z）" @click="redoDirector">重做</button>
        <button ref="helpButtonRef" type="button" aria-label="导演台帮助" @click="helpOpen = true">帮助</button>
        <button type="button" class="close-button" aria-label="关闭导演台" @click="emit('close')">×</button>
      </div>
    </header>

    <div class="director-stage__body">
      <aside class="director-stage__sidebar">
        <nav class="director-stage__left-tabs" aria-label="导演台左侧功能">
          <button type="button" :class="{ active: leftPanelTab === 'outline' }" @click="leftPanelTab = 'outline'">大纲</button>
          <button type="button" :class="{ active: leftPanelTab === 'assets' }" @click="leftPanelTab = 'assets'">资产</button>
          <button type="button" :class="{ active: leftPanelTab === 'ai' }" @click="openAIRecognition">AI识图</button>
        </nav>
        <template v-if="leftPanelTab === 'outline'">
        <section class="stage-section">
          <div class="stage-section__title">场景大纲</div>
          <input v-model="sceneSearch" class="scene-search" type="search" placeholder="搜索场景对象" aria-label="搜索场景对象" />
          <div class="director-outline-counts">
            <span>人物 ({{ directorObjectCounts.people }})</span>
            <span>道具 ({{ directorObjectCounts.props }})</span>
            <span>机位 ({{ directorObjectCounts.cameras }})</span>
          </div>
          <div class="object-create-row director-outline-actions">
            <button ref="addRoleButtonRef" type="button" class="small-button" @click="addRoleArchetype(ROLE_ARCHETYPES[0])">+ 人物</button>
            <button ref="addCameraButtonRef" type="button" class="small-button" @click="addCamera">+ 机位</button>
            <button type="button" class="small-button" @click="addSceneGroup">+ 新建组</button>
            <button type="button" class="small-button" @click="crowdModalOpen = true">+ 群众阵列</button>
          </div>
          <div
            v-for="object in filteredDirectorObjects"
            :key="object.id"
            class="stage-tree-row"
            :class="{ selected: selectedObjectId === object.id, muted: !object.visible }"
          >
            <button type="button" class="stage-item stage-tree-row__name" @click="selectSceneObject(object.id)">
              <span class="stage-dot stage-dot--prop" />
              {{ object.name }}
              <small>{{ object.type }}</small>
            </button>
            <button type="button" class="tree-icon-button" :aria-label="`${object.visible ? '隐藏' : '显示'} ${object.name}`" :title="object.visible ? '隐藏' : '显示'" @click="toggleObjectVisibility(object)">{{ object.visible ? '◉' : '○' }}</button>
            <button type="button" class="tree-icon-button" :aria-label="`${object.locked ? '解锁' : '锁定'} ${object.name}`" :title="object.locked ? '解锁' : '锁定'" @click="toggleObjectLock(object)">{{ object.locked ? '🔒' : '🔓' }}</button>
            <button v-if="object.type === 'group'" type="button" class="tree-icon-button" :aria-label="`解散分组 ${object.name}`" title="解散分组" @click="releaseGroup(object.id)">解散分组</button>
            <button type="button" class="tree-icon-button" :aria-label="`删除 ${object.name}`" title="删除" @click="deleteSceneObject(object.id)">×</button>
          </div>
          <div v-if="!filteredDirectorObjects.length" class="stage-empty">{{ timeline.objects.length ? '没有匹配对象' : '使用上方按钮添加可编辑对象' }}</div>
        </section>
        <template v-if="workspaceMode === 'animation'">
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
          <div class="shot-cut-range" aria-label="镜头切点">入点 {{ formatSeconds(selectedShot.start) }} · 出点 {{ formatSeconds(selectedShot.start + selectedShot.duration) }}</div>
          <button type="button" class="small-button" :disabled="!canSplitSelectedShot" @click="splitSelectedShot">在播放头切开镜头</button>
          <label>名称<input :value="selectedShot.name" @input="updateSelectedShot('name', $event.target.value)" /></label>
          <label>时长（秒）<input type="number" min="0.25" step="0.25" :value="selectedShot.duration" @change="updateSelectedShot('duration', $event.target.value)" /></label>
          <label>机位
            <select :value="selectedShot.camera" @change="updateSelectedShot('camera', $event.target.value)">
              <option v-for="camera in SHOT_CAMERA_TYPES" :key="camera.value" :value="camera.value">{{ camera.label }}</option>
            </select>
          </label>
          <label>绑定相机
            <select :value="selectedShot.cameraId" @change="updateSelectedShot('cameraId', $event.target.value)">
              <option v-for="camera in timeline.cameras" :key="camera.id" :value="camera.id">{{ camera.name }}</option>
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
          <div v-if="shots.length > 1" class="object-create-row">
            <button type="button" class="small-button" :disabled="shots[0]?.id === selectedShot.id" @click="moveSelectedShot(-1)">镜头前移</button>
            <button type="button" class="small-button" :disabled="shots.at(-1)?.id === selectedShot.id" @click="moveSelectedShot(1)">镜头后移</button>
          </div>
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

        <section v-if="selectedActionClip" class="stage-section action-clip-editor">
          <div class="stage-section__title">动作片段</div>
          <label>动作
            <select :value="selectedActionClip.action" aria-label="动作片段动作" @change="updateSelectedActionClip('action', $event.target.value)">
              <option v-for="action in ACTION_LIBRARY" :key="`clip-${action}`" :value="action">{{ action }}</option>
            </select>
          </label>
          <label>开始时间（秒）<input type="number" min="0" step="0.25" :value="selectedActionClip.start" aria-label="动作片段开始时间" @change="updateSelectedActionClip('start', $event.target.value)" /></label>
          <label>时长（秒）<input type="number" :min="MIN_ACTION_CLIP_DURATION" :step="MIN_ACTION_CLIP_DURATION" :value="selectedActionClip.duration" aria-label="动作片段时长" @change="updateSelectedActionClip('duration', $event.target.value)" /></label>
          <button type="button" class="danger-button" @click="removeSelectedActionClip">删除动作片段</button>
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
          <div class="resource-upload-row">
            <button type="button" class="small-button" :disabled="modelLoading" @click="applyValidationAsset">加载 CC0 验证模型</button>
            <span class="resource-tip">Khronos SimpleSkin，仅用于功能验证，不是专业角色库</span>
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
        <section
          v-if="isSelectedProceduralCharacter || selectedModelResourceState.status === 'ready'"
          ref="poseEditorRef"
          class="stage-section bone-editor"
          aria-label="骨骼姿态"
          tabindex="-1"
        >
          <div class="stage-section__title">骨骼姿态</div>
          <div v-if="isSelectedProceduralCharacter" class="resource-tip">程序化 3D 角色关节，可直接预演并保存姿势。</div>
          <template v-if="isSelectedProceduralCharacter || selectedCharacterBones.length">
            <div class="pose-presets" aria-label="姿势预设">
              <button v-for="preset in POSE_PRESETS" :key="preset.name" type="button" class="small-button" @click="applyPosePreset(preset)">{{ preset.name }}</button>
            </div>
            <div class="semantic-pose-controls" aria-label="姿势调节">
              <label v-for="control in availableSemanticControls" :key="`${control.semantic}-${control.axis}`">{{ control.label }}
                <input type="range" :min="control.min" :max="control.max" step="1" :value="semanticRotationDegrees(control)" :aria-label="control.label" @input="updateSemanticRotation(control, $event.target.value)" />
              </label>
            </div>
            <template v-if="!isSelectedProceduralCharacter">
              <label>关节
                <select v-model="selectedBoneName" aria-label="选择骨骼">
                  <option v-for="bone in selectedCharacterBones" :key="bone.name" :value="bone.name">{{ bone.name }}</option>
                </select>
              </label>
              <div class="inspector-group">
                <strong>关节旋转（度）</strong>
                <div class="vector-row">
                  <label v-for="(axis, index) in axes" :key="`bone-${axis}`">{{ axis }}
                    <input type="number" step="1" :aria-label="`骨骼旋转 ${axis}`" :value="selectedBoneRotationDegrees[index]" @input="updateBoneRotation(index, $event.target.value)" />
                  </label>
                </div>
              </div>
              <button type="button" class="small-button" @click="resetSelectedBone">重置当前关节</button>
            </template>
          </template>
          <div v-else class="stage-empty">模型不含骨骼</div>
        </section>
        </template>
        </template>
        <section v-else-if="leftPanelTab === 'assets'" class="stage-section director-asset-library" aria-label="导演台资产库">
          <div class="stage-section__title">资产库</div>
          <nav class="director-asset-tabs" aria-label="资产类型">
            <button
              v-for="tab in DIRECTOR_ASSET_TABS"
              :key="tab.value"
              type="button"
              :class="{ active: assetLibraryTab === tab.value }"
              @click="assetLibraryTab = tab.value"
            >{{ tab.label }}</button>
          </nav>
          <input v-model="assetLibrarySearch" type="search" aria-label="搜索导演台资产" placeholder="搜索资产" />
          <div class="director-asset-grid">
            <button
              v-for="asset in filteredAssetItems"
              :key="`${assetLibraryTab}-${asset.name}`"
              type="button"
              class="director-asset-card"
              @click="activateAssetItem(asset)"
            >
              <span class="director-asset-card__preview">{{ assetLibraryTab === 'cameras' ? '▣' : assetLibraryTab === 'people' ? '人' : assetLibraryTab === 'templates' ? '景' : '◇' }}</span>
              <span>{{ asset.name }}</span>
            </button>
          </div>
          <button v-if="assetLibraryTab === 'templates'" type="button" class="small-button" @click="templateImportRef?.click()">导入模板 JSON</button>
          <input ref="templateImportRef" class="visually-hidden" type="file" accept="application/json,.json" aria-label="导入模板 JSON" @change="onTemplateImport" />
        </section>
        <section v-else class="stage-section director-ai-panel" aria-label="AI识图">
          <div class="stage-section__title">AI识图</div>
          <p>上传参考图后识别场景、角色或道具，并把结果保存为可移动的 3D 场景对象。</p>
          <button type="button" class="small-button" @click="aiImportOpen = true">打开 AI 识图</button>
          <button type="button" class="small-button" @click="leftPanelTab = 'assets'; assetLibraryTab = 'templates'">从模板开始</button>
        </section>
      </aside>

      <main class="director-stage__viewport" :class="{ 'director-stage__viewport--timeline': workspaceMode === 'animation' }">
        <canvas ref="canvasRef" class="director-stage__canvas" aria-label="3D 导演台预览" @wheel="onViewportWheel" />
        <div class="viewport-tools" aria-label="视口变换工具">
          <button v-for="tool in TRANSFORM_TOOLS" :key="tool.mode" type="button" :class="{ active: transformMode === tool.mode }" :aria-label="tool.label" @click="setTransformMode(tool.mode)">{{ tool.icon }}</button>
          <button type="button" :class="{ active: transformSpace === 'local' }" aria-label="切换局部与世界坐标" @click="toggleTransformSpace">{{ transformSpace === 'local' ? '局部' : '世界' }}</button>
        </div>
        <div v-if="activeCompositionGuides" class="composition-guides" aria-label="构图辅助线">
          <span class="composition-guides__v composition-guides__v--1" /><span class="composition-guides__v composition-guides__v--2" />
          <span class="composition-guides__h composition-guides__h--1" /><span class="composition-guides__h composition-guides__h--2" />
          <span class="composition-guides__safe" />
        </div>
        <div
          v-if="timeline.environment.showObjectLabels"
          class="director-object-labels"
          :style="{ '--director-label-size': `${timeline.environment.labelFontSize}px` }"
          aria-label="场景对象标签"
        >
          <button
            v-for="object in visibleDirectorObjects"
            :key="`label-${object.id}`"
            type="button"
            :class="{ selected: selectedObjectId === object.id }"
            @click="selectSceneObject(object.id)"
          >
            {{ object.name }}
            <small v-if="timeline.environment.showBottomIds">{{ object.id }}</small>
          </button>
        </div>
        <div class="director-stage__legend">
          <span><i class="stage-dot stage-dot--scene" />场景</span>
          <span><i class="stage-dot stage-dot--character" />角色</span>
          <span><i class="stage-dot stage-dot--prop" />道具</span>
          <span v-if="activeShot">当前：{{ activeShot.name }}</span>
        </div>
        <section v-if="entryReferenceUrl" class="director-entry-reference" aria-label="图片节点参考图">
          <strong>当前图片参考</strong>
          <img :src="entryReferenceUrl" :alt="entryReferenceTitle" />
          <small>{{ entryReferenceTitle }}</small>
          <span v-if="lightingEntry">3D 灯光预演，不直接修改原图；截图会生成新素材。</span>
          <span v-else-if="angleEntry">3D 机位角度预演，不直接修改原图；添加或选择机位后可截图生成新素材。</span>
          <span v-else-if="poseEntry">3D 角色姿势预演，不直接修改原图；添加或选择 3D 角色后可调整骨骼姿势。</span>
          <span v-else>可据此布置场景、角色和机位；截图会生成新素材，原图保持不变。</span>
        </section>
        <div v-if="initializing" class="director-stage__loading">正在初始化导演台…</div>
        <div v-else-if="errorMessage" class="director-stage__error">{{ errorMessage }}</div>

        <section v-if="workspaceMode === 'animation'" class="timeline-panel" :class="{ collapsed: timeline.sequence.timelineCollapsed }" :style="{ '--timeline-zoom': timeline.sequence.timelineZoom }" aria-label="导演时间线">
          <div class="animation-studio-toolbar" aria-label="动画导演工具">
            <button type="button" @click="newMotionTrack">新建轨道</button>
            <button type="button" :disabled="!selectedDirectorObject" @click="addCurrentMotionKeyframe">保存当前</button>
            <button type="button" :disabled="!selectedMotionTrack" @click="deleteSelectedMotionTrack">删除当前</button>
            <select aria-label="动画机位" :value="selectedCamera?.id || timeline.sequence.activeCameraId" @change="selectAnimationCamera($event.target.value)">
              <option v-for="camera in timeline.cameras" :key="`animation-${camera.id}`" :value="camera.id">{{ camera.name }}</option>
            </select>
            <button type="button" :class="{ active: timeline.sequence.loop }" @click="toggleLoopPlayback">整段循环</button>
            <button type="button" :class="{ active: timeline.sequence.shotLoop }" @click="toggleSequenceOption('shotLoop')">镜头循环</button>
            <button type="button" @click="toggleAnimationViewMode">{{ timeline.sequence.animationViewMode === 'observer' ? '观察机位' : '跟随镜头' }}</button>
            <select aria-label="播放速度" :value="timeline.sequence.playbackRate" @change="updateSequenceValue('playbackRate', Number($event.target.value))">
              <option v-for="rate in PLAYBACK_RATES" :key="rate" :value="rate">{{ rate }}x</option>
            </select>
            <select aria-label="镜头方向" :value="timeline.sequence.orientationMode" @change="updateSequenceValue('orientationMode', $event.target.value)">
              <option v-for="mode in ORIENTATION_MODES" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
            </select>
            <button type="button" :disabled="!selectedDirectorObject" @click="addCurrentMotionKeyframe">添加关键帧</button>
            <button type="button" :disabled="!isSelectedCharacterObject" @click="addPersonFrame">人物帧</button>
            <label>时长
              <input type="number" min="0.25" step="0.25" :value="duration" aria-label="动画时长" @change="updateTimelineDuration($event.target.value)" />
            </label>
            <button type="button" :disabled="exporting || initializing" @click="exportTimelineVideo">导出视频</button>
          </div>
          <div class="timeline-toolbar">
            <div class="timeline-controls">
              <button type="button" :aria-label="playing ? '暂停' : '播放'" @click="togglePlayback">{{ playing ? 'Ⅱ' : '▶' }}</button>
              <button type="button" aria-label="停止" @click="stopPlayback">■</button>
              <button type="button" :class="{ active: timeline.sequence.loop }" :aria-pressed="timeline.sequence.loop" aria-label="循环播放" @click="toggleLoopPlayback">↻</button>
              <button type="button" :class="{ active: timeline.sequence.autoKey }" :aria-pressed="timeline.sequence.autoKey" aria-label="自动关键帧" @click="toggleSequenceOption('autoKey')">◇</button>
              <button type="button" :class="{ active: timeline.sequence.showMotionPaths }" :aria-pressed="timeline.sequence.showMotionPaths" aria-label="运动轨迹" @click="toggleSequenceOption('showMotionPaths')">⌁</button>
              <button type="button" :disabled="!selectedDirectorObject" aria-label="在当前位置添加关键帧" @click="addCurrentMotionKeyframe">◆</button>
              <span class="timeline-time">{{ formatSeconds(currentTime) }} / {{ formatSeconds(duration) }}</span>
              <span class="timeline-fps">{{ timeline.sequence.fps }} fps</span>
              <button type="button" aria-label="缩小时间线" @click="setTimelineZoom(timeline.sequence.timelineZoom - 0.25)">−</button>
              <span class="timeline-zoom">{{ Math.round(timeline.sequence.timelineZoom * 100) }}%</span>
              <button type="button" aria-label="放大时间线" @click="setTimelineZoom(timeline.sequence.timelineZoom + 0.25)">＋</button>
              <button type="button" aria-label="最小化时间线" @click="toggleTimelineCollapsed">{{ timeline.sequence.timelineCollapsed ? '展开' : '最小化' }}</button>
            </div>
            <input class="timeline-scrubber" type="range" min="0" :max="duration || 0.25" step="0.01" :value="currentTime" aria-label="时间线位置" @input="setCurrentTime(Number($event.target.value))" />
          </div>

          <div v-if="!timeline.sequence.timelineCollapsed" class="timeline-scroll-content">
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
                :class="{ selected: selectedActionClipId === clip.id }"
                :style="blockStyle(clip)"
                :aria-label="`${characterName(track.characterId)} ${clip.action} 动作片段`"
                @click="selectActionClip(track, clip)"
              >
                <strong>{{ clip.action }}</strong>
                <small>{{ formatSeconds(clip.duration) }}</small>
              </button>
            </div>
          </div>
          <div v-for="track in timeline.motionTracks" :key="track.id" class="timeline-track motion-track">
            <div class="track-label">{{ objectName(track.objectId) }}</div>
            <div class="track-lane">
              <button v-for="keyframe in track.keyframes" :key="keyframe.id" type="button" class="motion-keyframe" :class="{ selected: selectedMotionKeyframeId === keyframe.id }" :style="keyframeStyle(keyframe)" :aria-label="`${objectName(track.objectId)} ${formatSeconds(keyframe.time)} 关键帧`" @click="selectMotionKeyframe(track, keyframe)">◆</button>
            </div>
          </div>
          <div v-if="!timeline.tracks.length" class="timeline-empty">暂无角色轨道</div>
          </div>
          <section v-if="keyframePanelOpen && selectedMotionKeyframe" class="keyframe-detail-panel" aria-label="缓动曲线 / 参数">
            <div class="keyframe-detail-panel__header"><strong>缓动曲线 / 参数</strong><button type="button" aria-label="关闭关键帧参数" @click="keyframePanelOpen = false">×</button></div>
            <label>时间<input type="number" min="0" :max="duration" step="0.1" :value="selectedMotionKeyframe.time" @change="updateSelectedMotionKeyframe('time', Number($event.target.value))" /></label>
            <label>路径
              <select :value="selectedMotionKeyframe.pathMode" @change="updateSelectedMotionKeyframe('pathMode', $event.target.value)">
                <option value="curve">曲线</option><option value="line">直线</option><option value="hold">保持</option>
              </select>
            </label>
            <label>横滚角<input type="number" min="-180" max="180" step="1" :value="selectedMotionKeyframe.roll" @change="updateSelectedMotionKeyframe('roll', Number($event.target.value))" /></label>
            <div class="keyframe-speed-presets">
              <button v-for="preset in DIRECTOR_SPEED_PRESETS" :key="preset.name" type="button" :class="{ active: selectedMotionKeyframe.speedPreset === preset.name }" @click="applyKeyframeSpeedPreset(preset)">{{ preset.name }}</button>
            </div>
            <div class="keyframe-detail-actions">
              <button type="button" @click="resetSelectedMotionKeyframe">重置</button>
              <button type="button" @click="applyCurrentViewToKeyframe">应用当前视图</button>
              <button type="button" @click="deleteSelectedMotionKeyframe">删除</button>
            </div>
          </section>
        </section>
        <nav class="director-stage__quick-toolbar" aria-label="导演台工具栏">
          <button type="button" :class="{ active: transformMode === 'translate' }" @click="setTransformMode('translate')">移动</button>
          <button type="button" :class="{ active: transformMode === 'rotate' }" @click="setTransformMode('rotate')">旋转</button>
          <button type="button" :class="{ active: transformMode === 'scale' }" @click="setTransformMode('scale')">缩放</button>
          <button type="button" :class="{ active: timeline.environment.gridSnap }" @click="updateEnvironment('gridSnap', !timeline.environment.gridSnap)">吸附</button>
          <button type="button" @click="setViewportPreset('top')">俯视</button>
          <button type="button" @click="setViewportPreset('front')">正面</button>
          <button type="button" @click="resetCamera">重置</button>
          <button type="button" :disabled="!selectedDirectorObject" @click="focusSelectedObject">聚焦</button>
          <button type="button" :disabled="!canUndo" @click="undoDirector">撤销</button>
          <button type="button" :disabled="!canRedo" @click="redoDirector">重做</button>
          <span class="director-stage__quick-divider" />
          <button type="button" @click="panoramaModalOpen = true">全景</button>
          <button type="button" :class="{ active: labelsMenuOpen }" @click="labelsMenuOpen = !labelsMenuOpen; aspectMenuOpen = false">标签</button>
          <button type="button" :class="{ active: aspectMenuOpen }" @click="openAspectMenu">{{ cameraAspectLabel(selectedCamera?.aspect || timeline.cameras[0]?.aspect) }}</button>
          <button type="button" aria-label="动画时间轴" :class="{ active: workspaceMode === 'animation' }" @click="workspaceMode = workspaceMode === 'animation' ? 'scene' : 'animation'">动画(BATE)</button>
          <button type="button" class="confirm-composition-button" :disabled="capturing || initializing" @click="confirmComposition">确认构图</button>
          <button type="button" aria-label="全屏" title="全屏" @click="toggleFullscreen">⤢</button>
          <section v-if="labelsMenuOpen" class="quick-toolbar-popover labels-popover" aria-label="标签设置">
            <label><input type="checkbox" :checked="timeline.environment.showObjectLabels" @change="updateEnvironment('showObjectLabels', $event.target.checked)" /> 显示标签</label>
            <label>字体大小<input type="range" min="12" max="64" step="1" :value="timeline.environment.labelFontSize" @input="updateEnvironment('labelFontSize', $event.target.value)" /></label>
            <label><input type="checkbox" :checked="timeline.environment.showBottomIds" @change="updateEnvironment('showBottomIds', $event.target.checked)" /> 底部标识</label>
            <label><input type="checkbox" :checked="timeline.environment.showCameraGuides" @change="updateEnvironment('showCameraGuides', $event.target.checked)" /> 机位辅助线</label>
          </section>
          <section v-if="aspectMenuOpen" class="quick-toolbar-popover aspect-popover" aria-label="画幅比例">
            <button v-for="ratio in CAMERA_ASPECTS.filter((item) => item.value)" :key="`quick-${ratio.label}`" type="button" @click="selectAspectRatio(ratio.label)">{{ ratio.label }}</button>
          </section>
          <span v-if="compositionConfirmMessage" class="composition-confirm-message">{{ compositionConfirmMessage }}</span>
        </nav>
      </main>

      <aside class="director-stage__inspector" aria-label="属性检查器">
        <template v-if="selectedDirectorObject">
          <div class="director-stage__inspector-title">{{ isSelectedCharacterObject ? '角色' : selectedDirectorObject.type === 'camera' ? '机位' : '对象' }}</div>
          <div v-if="isSelectedCharacterObject" class="director-stage__inspector-tabs">
            <button type="button" :class="{ active: inspectorTab === 'properties' }" @click="inspectorTab = 'properties'">属性</button>
            <button type="button" :class="{ active: inspectorTab === 'pose' }" @click="inspectorTab = 'pose'">姿势</button>
          </div>
          <template v-if="inspectorTab === 'properties' || !isSelectedCharacterObject">
          <label>名称<input :value="selectedDirectorObject.name" @input="updateSelectedObject({ name: $event.target.value })" /></label>
          <button type="button" class="small-button" @click="toggleObjectLock(selectedDirectorObject)">{{ selectedDirectorObject.locked ? '解锁' : '锁定' }}</button>
          <label class="visibility-row"><input type="checkbox" :checked="selectedDirectorObject.visible" @change="updateSelectedObject({ visible: $event.target.checked })" /> 显示对象</label>
          <div v-if="isSelectedCharacterObject" class="character-body-types">
            <strong>体型</strong>
            <button
              v-for="role in [ROLE_ARCHETYPES[0], ROLE_ARCHETYPES[1], ROLE_ARCHETYPES[6], ROLE_ARCHETYPES[3], ROLE_ARCHETYPES[4]]"
              :key="`body-${role.kind}`"
              type="button"
              :class="{ active: selectedDirectorObject.assetRef?.kind === role.kind }"
              @click="setCharacterArchetype(role)"
            >{{ role.label }}</button>
            <label>颜色<input type="color" :value="selectedDirectorObject.assetRef?.color || '#4f8ef7'" @input="setCharacterColor($event.target.value)" /></label>
          </div>
          <div v-if="selectedDirectorObject.assetRef?.description" class="ai-reference-description">
            <strong>AI 识图描述</strong>
            <p>{{ selectedDirectorObject.assetRef.description }}</p>
          </div>
          <label>父级分组
            <select :value="selectedDirectorObject.parentId" @change="updateObjectParent($event.target.value)">
              <option value="">场景根节点</option>
              <option v-for="group in availableParentGroups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </label>
          <div class="inspector-group">
            <strong>位置（米）</strong>
            <div class="vector-row"><label v-for="(axis, index) in axes" :key="`p-${axis}`">{{ axis }}<input type="number" step="0.1" :value="selectedInspectorTransform.position[index]" @change="updateObjectVector('position', index, $event.target.value)" /></label></div>
          </div>
          <div class="inspector-group">
            <strong>旋转（度）</strong>
            <div class="vector-row"><label v-for="(axis, index) in axes" :key="`r-${axis}`">{{ axis }}<input type="number" step="1" :value="radiansToDegrees(selectedInspectorTransform.rotation[index])" @change="updateObjectRotation(index, $event.target.value)" /></label></div>
          </div>
          <div class="inspector-group">
            <strong>缩放</strong>
            <label v-if="isSelectedCharacterObject">统一缩放<input type="range" min="0.1" max="3" step="0.1" :value="selectedInspectorTransform.scale[0]" @input="updateUniformScale($event.target.value)" /></label>
            <div class="vector-row"><label v-for="(axis, index) in axes" :key="`s-${axis}`">{{ axis }}<input type="number" min="0.0001" step="0.1" :value="selectedInspectorTransform.scale[index]" @change="updateObjectScale(index, $event.target.value, $event.shiftKey)" /></label></div>
          </div>
          <template v-if="selectedCamera">
            <div ref="cameraEditorRef" class="inspector-group"><strong>相机</strong>
              <label>构图预设
                <select aria-label="构图预设" @change="applyCameraPreset($event.target.value)">
                  <option value="">选择机位视角</option>
                  <option v-for="preset in CAMERA_PRESETS" :key="preset.name" :value="preset.name">{{ preset.name }}</option>
                </select>
              </label>
              <label>视野 FOV<input type="number" min="1" max="179" :value="selectedCamera.fov" @change="updateSelectedCamera('fov', $event.target.value)" /></label>
              <label>方位角（°）<input type="range" min="-180" max="180" step="1" :value="selectedCamera.azimuth" @input="updateCameraAngle('azimuth', $event.target.value)" /></label>
              <label>仰角（°）<input type="range" min="-89" max="89" step="1" :value="selectedCamera.elevation" @input="updateCameraAngle('elevation', $event.target.value)" /></label>
              <label>机位距离（米）<input type="number" min="0.1" max="1000" step="0.1" :value="selectedCamera.distance" @change="updateCameraAngle('distance', $event.target.value)" /></label>
              <label>横滚角（°）<input type="range" min="-180" max="180" step="1" :value="selectedCamera.roll" @input="updateCameraAngle('roll', $event.target.value)" /></label>
              <label>画幅比例
                <select aria-label="画幅比例" :value="cameraAspectLabel(selectedCamera.aspect)" @change="applyCameraAspect($event.target.value)">
                  <option v-for="ratio in CAMERA_ASPECTS" :key="ratio.label" :value="ratio.label">{{ ratio.label }}</option>
                </select>
              </label>
              <label>跟随目标
                <select aria-label="相机跟随目标" :value="selectedCamera.followTargetId" @change="updateSelectedCamera('followTargetId', $event.target.value)">
                  <option value="">不跟随</option>
                  <option v-for="object in cameraTargetObjects" :key="`follow-${object.id}`" :value="object.id">{{ object.name }}</option>
                </select>
              </label>
              <label>注视模式
                <select aria-label="相机注视模式" :value="selectedCamera.lookAtMode" @change="updateSelectedCamera('lookAtMode', $event.target.value)">
                  <option value="origin">场景中心</option><option value="object">指定对象</option>
                </select>
              </label>
              <label v-if="selectedCamera.lookAtMode === 'object'">注视目标
                <select aria-label="相机注视目标" :value="selectedCamera.lookAtTargetId" @change="updateSelectedCamera('lookAtTargetId', $event.target.value)">
                  <option value="">请选择对象</option>
                  <option v-for="object in cameraTargetObjects" :key="`look-${object.id}`" :value="object.id">{{ object.name }}</option>
                </select>
              </label>
              <label class="visibility-row"><input type="checkbox" :checked="selectedCamera.showGuides" @change="updateSelectedCamera('showGuides', $event.target.checked)" /> 构图辅助线</label>
              <button type="button" class="small-button" @click="captureCurrentViewToCamera">从当前视角更新机位</button>
              <button type="button" class="small-button" @click="captureToCanvasAsset">机位截图回写画布</button>
            </div>
          </template>
          <button type="button" class="small-button" aria-label="复制对象" @click="duplicateSelectedObject">复制</button>
          <button type="button" class="danger-button" @click="deleteSelectedObject">删除对象</button>
          </template>
          <section v-else class="director-pose-panel" aria-label="角色姿势">
            <strong>姿势预设</strong>
            <div class="pose-presets">
              <button v-for="preset in POSE_PRESETS" :key="`inspector-${preset.name}`" type="button" class="small-button" :disabled="!availableSemanticControls.length" @click="applyPosePreset(preset)">{{ preset.name }}</button>
            </div>
            <div class="pose-mirror-actions" aria-label="姿势镜像">
              <button v-for="section in DIRECTOR_POSE_MIRROR_SECTIONS" :key="section.label" type="button" class="small-button" @click="mirrorPoseLeftToRight(section)">{{ section.label }} 镜像左→右</button>
            </div>
            <strong>IK 端点</strong>
            <div class="ik-endpoint-controls">
              <button
                v-for="endpoint in IK_ENDPOINTS"
                :key="endpoint.value"
                type="button"
                :class="{ active: selectedIkEndpoint === endpoint.value, locked: selectedDirectorObject.ikLocks?.[endpoint.value] }"
                @click="toggleIkEndpoint(endpoint.value)"
              >{{ endpoint.label }}{{ selectedDirectorObject.ikLocks?.[endpoint.value] ? ' · 已锁定' : '' }}</button>
            </div>
            <div v-if="selectedIkEndpoint" class="inspector-group">
              <strong>{{ IK_ENDPOINTS.find((endpoint) => endpoint.value === selectedIkEndpoint)?.label }} IK 目标</strong>
              <div class="vector-row">
                <label v-for="(axis, index) in axes" :key="`ik-${selectedIkEndpoint}-${axis}`">{{ axis }}
                  <input type="number" step="0.1" :value="selectedDirectorObject.ikTargets?.[selectedIkEndpoint]?.[index] || 0" @input="updateIkTarget(index, $event.target.value)" />
                </label>
              </div>
            </div>
            <strong>姿势调节</strong>
            <div v-if="availableSemanticControls.length" class="semantic-pose-controls">
              <label v-for="control in availableSemanticControls" :key="`inspector-${control.semantic}-${control.axis}`">{{ control.label }}
                <input type="range" :min="control.min" :max="control.max" step="1" :value="semanticRotationDegrees(control)" :aria-label="control.label" @input="updateSemanticRotation(control, $event.target.value)" />
              </label>
            </div>
            <div v-else class="stage-empty">加载带骨骼的角色模型后可逐关节调节</div>
          </section>
        </template>
        <div v-else class="stage-empty">在场景树中选择对象以编辑属性</div>
        <section ref="environmentEditorRef" class="inspector-group environment-editor">
          <strong>{{ lightingEntry ? '3D 灯光' : '3D 场景与灯光' }}</strong>
          <div class="lighting-controls">
            <div class="lighting-presets" aria-label="灯光预设">
              <button
                v-for="preset in LIGHTING_PRESETS"
                :key="preset.name"
                type="button"
                class="small-button"
                @click="applyLightingPreset(preset)"
              >
                {{ preset.name }}
              </button>
            </div>
            <div class="light-list-header"><strong>灯光列表</strong><button type="button" class="small-button" @click="addDirectorLight">+ 添加灯光</button></div>
            <div class="light-list" aria-label="灯光列表">
              <button
                v-for="light in lightObjects"
                :key="light.id"
                type="button"
                :class="{ active: selectedLightObject?.id === light.id }"
                @click="selectSceneObject(light.id)"
              >
                <span class="light-color-dot" :style="{ background: light.light.color }" />
                {{ light.name }}
              </button>
              <span v-if="!lightObjects.length" class="stage-empty">选择预设或添加灯光</span>
            </div>
            <div v-if="selectedLightObject" class="inspector-group light-editor">
              <label>光线类型
                <select :value="selectedLightObject.light.type" @change="updateSelectedLight('type', $event.target.value)">
                  <option value="hard">硬光</option>
                  <option value="soft">柔光</option>
                </select>
              </label>
              <label>灯光强度<input type="range" min="0" max="10" step="0.1" :value="selectedLightObject.light.intensity" @input="updateSelectedLight('intensity', $event.target.value)" /></label>
              <label>方位角（°）<input type="range" min="-180" max="180" step="1" :value="selectedLightObject.light.azimuth" @input="updateSelectedLight('azimuth', $event.target.value)" /></label>
              <label>仰角（°）<input type="range" min="-90" max="90" step="1" :value="selectedLightObject.light.elevation" @input="updateSelectedLight('elevation', $event.target.value)" /></label>
              <label>灯光距离（米）<input type="number" min="0.1" max="100" step="0.1" :value="selectedLightObject.light.distance" @change="updateSelectedLight('distance', $event.target.value)" /></label>
              <div><strong>灯光颜色</strong>
                <div class="light-color-presets">
                  <button
                    v-for="color in LIGHT_COLOR_PRESETS"
                    :key="color.name"
                    type="button"
                    :title="color.name"
                    :aria-label="color.name"
                    :style="{ background: color.color }"
                    @click="updateSelectedLight('color', color.color)"
                  />
                </div>
              </div>
              <label>自定义颜色<input type="color" :value="selectedLightObject.light.color" @input="updateSelectedLight('color', $event.target.value)" /></label>
            </div>
          </div>
          <label>场景缩放<input type="range" min="0.1" max="5" step="0.1" :value="timeline.environment.sceneScale" @input="updateEnvironment('sceneScale', $event.target.value)" /></label>
          <div class="inspector-group"><strong>场景平移</strong><div class="vector-row"><label v-for="(axis, index) in axes" :key="`env-p-${axis}`">{{ axis }}<input type="number" step="0.1" :value="timeline.environment.scenePosition[index]" @change="updateEnvironmentVector('scenePosition', index, $event.target.value)" /></label></div></div>
          <div class="inspector-group"><strong>场景旋转（度）</strong><div class="vector-row"><label v-for="(axis, index) in axes" :key="`env-r-${axis}`">{{ axis }}<input type="number" step="1" :value="radiansToDegrees(timeline.environment.sceneRotation[index])" @change="updateEnvironmentRotation(index, $event.target.value)" /></label></div></div>
          <label>天空颜色<input type="color" :value="timeline.environment.backgroundColor" @input="updateEnvironment('backgroundColor', $event.target.value)" /></label>
          <label>全景图 URL<input :value="timeline.environment.panoramaUrl" placeholder="https://…/panorama.jpg" @change="updateEnvironment('panoramaUrl', $event.target.value)" /></label>
          <label>全景水平旋转<input type="range" min="-180" max="180" step="1" :value="timeline.environment.panoramaRotation" @input="updateEnvironment('panoramaRotation', $event.target.value)" /></label>
          <label>全景球半径<input type="range" min="10" max="200" step="1" :value="timeline.environment.panoramaRadius" @input="updateEnvironment('panoramaRadius', $event.target.value)" /></label>
          <label class="visibility-row"><input type="checkbox" :checked="timeline.environment.showCharacterLabels" @change="updateEnvironment('showCharacterLabels', $event.target.checked)" /> 角色标签</label>
          <label class="visibility-row"><input type="checkbox" :checked="timeline.environment.gridSnap" @change="updateEnvironment('gridSnap', $event.target.checked)" /> 网格吸附</label>
          <label class="visibility-row"><input type="checkbox" :checked="timeline.environment.groundSnap" @change="updateEnvironment('groundSnap', $event.target.checked)" /> 地面吸附</label>
          <label class="visibility-row"><input type="checkbox" :checked="timeline.environment.showGround" @change="updateEnvironment('showGround', $event.target.checked)" /> 地面</label>
          <label>地面透明度<input type="range" min="0" max="1" step="0.05" :value="timeline.environment.groundOpacity" @input="updateEnvironment('groundOpacity', $event.target.value)" /></label>
          <label>地面高度<input type="number" step="0.1" :value="timeline.environment.groundHeight" @change="updateEnvironment('groundHeight', $event.target.value)" /></label>
          <label>环境光<input type="number" min="0" max="20" step="0.1" :value="timeline.environment.ambientIntensity" @input="updateEnvironment('ambientIntensity', $event.target.value)" /></label>
          <label>方向光<input type="number" min="0" max="20" step="0.1" :value="timeline.environment.directionalIntensity" @input="updateEnvironment('directionalIntensity', $event.target.value)" /></label>
        </section>
      </aside>
    </div>

    <section v-if="aiImportOpen" ref="aiImportModalRef" class="director-modal" role="dialog" aria-modal="true" aria-label="AI 识图导入">
      <div class="director-modal__panel">
        <div class="director-modal__header"><strong>AI 识图导入</strong><button type="button" aria-label="关闭 AI 识图导入" @click="aiImportOpen = false">×</button></div>
        <label>识别类型<select v-model="aiImportType"><option value="scene">场景</option><option value="character">角色</option><option value="prop">道具</option></select></label>
        <label>参考图片<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择识图图片" @change="onAIImportFile" /></label>
        <img v-if="aiImportPreview" class="ai-import-preview" :src="aiImportPreview" alt="AI 识图参考预览" />
        <button type="button" :disabled="!aiImportFile || aiImportBusy" @click="analyzeAIImport">{{ aiImportBusy ? '识别中…' : '开始识图' }}</button>
        <label>识别描述<textarea v-model="aiImportDescription" rows="5" placeholder="识别结果也可手动修订" /></label>
        <div v-if="aiImportStatus" class="resource-status">{{ aiImportStatus }}</div>
        <button type="button" :disabled="!aiImportDescription.trim() || aiImportBusy" @click="createAIImportObject">导入 3D 场景</button>
      </div>
    </section>

    <section v-if="helpOpen" ref="helpModalRef" class="director-modal" role="dialog" aria-modal="true" aria-label="导演台帮助">
      <div class="director-modal__panel">
        <div class="director-modal__header"><strong>3D 导演台帮助</strong><button type="button" aria-label="关闭导演台帮助" @click="helpOpen = false">×</button></div>
        <div class="director-help-grid">
          <section><strong>水平移动</strong><span>W A S D</span></section>
          <section><strong>上下移动</strong><span>E Q</span></section>
          <section><strong>加速</strong><span>Shift</span></section>
          <section><strong>移动视角</strong><span>右键拖拽 / 中键拖拽 / 方向键 / 触控板双指滑动</span></section>
          <section><strong>相机</strong><span>[ ] 调整焦距 · F 聚焦 · C 应用视图到机位 · 0 回到原点</span></section>
        </div>
        <label>移动灵敏度<input v-model.number="movementSensitivity" type="range" min="0.2" max="3" step="0.1" /> {{ movementSensitivity.toFixed(1) }}×</label>
        <label class="visibility-row"><input v-model="invertTouchpad" type="checkbox" /> 反转触控板双指滑动方向</label>
        <label class="visibility-row"><input v-model="wheelFovEnabled" type="checkbox" /> 滚轮调整 FOV</label>
      </div>
    </section>

    <section v-if="crowdModalOpen" class="director-modal" role="dialog" aria-modal="true" aria-label="群众阵列">
      <div class="director-modal__panel director-modal__panel--compact">
        <div class="director-modal__header"><strong>群众阵列</strong><button type="button" aria-label="关闭群众阵列" @click="crowdModalOpen = false">×</button></div>
        <label>行数<input v-model.number="crowdRows" type="number" min="1" max="12" /></label>
        <label>列数<input v-model.number="crowdColumns" type="number" min="1" max="12" /></label>
        <label>间距<input v-model.number="crowdSpacing" type="number" min="0.5" max="6" step="0.1" /></label>
        <p>共 {{ Math.max(1, crowdRows) * Math.max(1, crowdColumns) }} 人</p>
        <div class="director-modal__actions"><button type="button" @click="crowdModalOpen = false">取消</button><button type="button" @click="confirmCrowdArray">添加群众</button></div>
      </div>
    </section>

    <section v-if="pendingTemplate" class="director-modal" role="dialog" aria-modal="true" aria-label="应用场景模板">
      <div class="director-modal__panel director-modal__panel--compact">
        <div class="director-modal__header"><strong>应用「{{ pendingTemplate.name }}」</strong><button type="button" aria-label="关闭模板确认" @click="pendingTemplate = null">×</button></div>
        <p>将覆盖所有人物、机位和道具，此操作不可撤销。</p>
        <div class="director-modal__actions"><button type="button" @click="pendingTemplate = null">取消</button><button type="button" class="danger-button" @click="confirmSceneTemplate">确认应用</button></div>
      </div>
    </section>

    <section v-if="panoramaModalOpen" class="director-modal" role="dialog" aria-modal="true" aria-label="生成站位参考">
      <div class="director-modal__panel">
        <div class="director-modal__header"><strong>生成站位参考</strong><button type="button" aria-label="关闭生成站位参考" @click="closePanoramaModal">×</button></div>
        <div class="panorama-source-actions">
          <button type="button" @click="panoramaFileRef?.click()">本地上传</button>
          <button type="button" @click="assetStatus = '暂无历史记录'">历史记录</button>
        </div>
        <input ref="panoramaFileRef" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" @change="onPanoramaFile" />
        <img v-if="panoramaReferencePreview" class="ai-import-preview" :src="panoramaReferencePreview" alt="站位参考图预览" />
        <label><input v-model="panoramaReferenceMode" type="radio" value="insert" /> 插入当前导演台（不覆盖）</label>
        <label><input v-model="panoramaReferenceMode" type="radio" value="override" /> 覆盖当前导演台</label>
        <div v-if="assetStatus" class="resource-status">{{ assetStatus }}</div>
        <button type="button" :disabled="!panoramaReferenceFile" @click="applyPanoramaReference">应用参考图</button>
      </div>
    </section>

    <footer v-if="workspaceMode === 'animation'" class="director-stage__footer">
      <span>镜头实体决定机位与转场；角色轨道决定动作片段。拖动时间线可预览当前编排。</span>
      <div class="director-stage__footer-actions">
        <button type="button" @click="aiImportOpen = true">AI 识图导入</button>
        <button type="button" :disabled="capturing || exporting || initializing" @click="captureToCanvasAsset">
          {{ capturing ? '截图回写中…' : '截图回写画布' }}
        </button>
        <button type="button" :disabled="exporting || initializing" @click="exportTimelineVideo">
          {{ exporting ? `导出中 ${exportProgress}%` : '导出 WebM 视频' }}
        </button>
        <button type="button" :disabled="exporting || initializing || !drama?.id" @click="exportTimelineMp4">
          {{ exporting ? `服务端处理中 ${exportProgress}%` : '服务端导出 MP4' }}
        </button>
        <button v-if="exporting" type="button" @click="cancelExport">取消导出</button>
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
  MIN_ACTION_CLIP_DURATION,
  MIN_SHOT_DURATION,
  SHOT_CAMERA_TYPES,
  TRANSITION_TYPES,
  appendActionClip,
  appendDirectorCamera,
  appendDirectorObject,
  duplicateDirectorObject,
  appendShot,
  cameraAnglesFromPosition,
  cameraPositionFromAngles,
  createDirectorTimeline,
  findActiveActionClips,
  findActiveCameraObject,
  findActiveShot,
  normalizeDirectorTimeline,
  proportionalScaleFromAxis,
  removeActionClip,
  removeDirectorObject,
  splitShotAtTime,
  interpolateMotionTransform,
  upsertMotionKeyframe,
  updateActionClip,
  updateDirectorObject,
} from '@/utils/directorTimeline'
import {
  DIRECTOR_CAMERA_ASSETS,
  DIRECTOR_POSE_MIRROR_SECTIONS,
  DIRECTOR_PROP_ASSETS,
  DIRECTOR_SCENE_TEMPLATES,
  DIRECTOR_SPEED_PRESETS,
  appendConfiguredCrowd,
  isDirectorTouchpadGesture,
  releaseDirectorGroup,
} from '@/utils/director-parity'

const CAMERA_ASPECTS = [
  { label: 'Auto', value: 0 }, { label: '21:9', value: 21 / 9 }, { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 }, { label: '1:1', value: 1 }, { label: '3:4', value: 3 / 4 }, { label: '9:16', value: 9 / 16 },
]
const CAMERA_PRESETS = [{ name: '当前视角', current: true }, ...DIRECTOR_CAMERA_ASSETS]

const directorLight = (name, azimuth, elevation, intensity, color = '#ffffff', type = 'soft', distance = 7) => ({
  name, type, color, intensity, azimuth, elevation, distance,
})
const LIGHT_COLOR_PRESETS = [
  { name: '烛光暖黄', color: '#ffd29b' }, { name: '钨丝灯', color: '#ffc46b' }, { name: '夕阳橙', color: '#ff8a4c' },
  { name: '金色', color: '#ffd45c' }, { name: '火焰橙红', color: '#ff5a36' }, { name: '琥珀色', color: '#ffb347' },
  { name: '柔和白光', color: '#fff7e8' }, { name: '月光蓝', color: '#b8d4ff' }, { name: '阴天冷光', color: '#d6e4f0' },
  { name: '冷蓝光', color: '#7eb6ff' }, { name: '冰蓝', color: '#8fe9ff' }, { name: '午夜蓝', color: '#3155a6' },
  { name: '霓虹粉', color: '#ff4fd8' }, { name: '霓虹紫', color: '#9b5cff' }, { name: '赛博蓝', color: '#35d7ff' },
  { name: '霓虹绿', color: '#45ff9a' }, { name: '霓虹橙', color: '#ff7438' },
]
const LIGHTING_PRESETS = [
  {
    name: '三点布光', backgroundColor: '#111827', ambientIntensity: 0.8, directionalIntensity: 0,
    lights: [
      directorLight('主光', -45, 25, 8, '#fff7e8', 'soft', 8),
      directorLight('辅光', 45, 20, 4, '#d6e4f0', 'soft', 8),
      directorLight('轮廓光', 180, 15, 5, '#b8d4ff', 'hard', 7),
    ],
  },
  { name: '伦勃朗布光', backgroundColor: '#17120f', ambientIntensity: 0.45, directionalIntensity: 0, lights: [directorLight('伦勃朗主光', -48, 38, 7.5, '#ffc46b', 'hard'), directorLight('暗部补光', 38, 12, 1.8, '#d6e4f0')] },
  { name: '分割光', backgroundColor: '#09090b', ambientIntensity: 0.2, directionalIntensity: 0, lights: [directorLight('侧切主光', 90, 5, 8.5, '#fff7e8', 'hard')] },
  { name: '顶光戏剧', backgroundColor: '#101014', ambientIntensity: 0.2, directionalIntensity: 0, lights: [directorLight('顶部主光', 0, 86, 9, '#fff7e8', 'hard', 6)] },
  { name: '动漫柔光', backgroundColor: '#dbeafe', ambientIntensity: 2.2, directionalIntensity: 0, lights: [directorLight('动漫主光', -25, 42, 4.2, '#ffffff'), directorLight('动漫补光', 55, 18, 2.8, '#b8d4ff')] },
  { name: '赛博朋克', backgroundColor: '#160c2d', ambientIntensity: 0.65, directionalIntensity: 0, lights: [directorLight('赛博蓝', -65, 18, 7, '#35d7ff', 'hard'), directorLight('霓虹粉', 58, 10, 7, '#ff4fd8', 'hard'), directorLight('紫色轮廓', 175, 28, 4.5, '#9b5cff')] },
  { name: '自然光', backgroundColor: '#bfdbfe', ambientIntensity: 2.2, directionalIntensity: 0, lights: [directorLight('自然主光', -30, 48, 4.8, '#fff7e8'), directorLight('天空补光', 120, 42, 2.2, '#d6e4f0')] },
  { name: '黄金时刻', backgroundColor: '#7c2d12', ambientIntensity: 0.9, directionalIntensity: 0, lights: [directorLight('夕阳主光', -72, 9, 7, '#ff8a4c', 'hard'), directorLight('金色轮廓', 150, 16, 3.5, '#ffd45c')] },
  { name: '蓝调时刻', backgroundColor: '#172554', ambientIntensity: 0.8, directionalIntensity: 0, lights: [directorLight('蓝调主光', -40, 18, 4.8, '#7eb6ff'), directorLight('冷色补光', 75, 25, 2.6, '#b8d4ff')] },
  { name: '高调光', backgroundColor: '#e4e4e7', ambientIntensity: 3.2, directionalIntensity: 0, lights: [directorLight('高调主光', -35, 35, 4.2), directorLight('高调辅光', 35, 32, 4), directorLight('高调背景光', 180, 24, 3.2)] },
  { name: '低调光', backgroundColor: '#09090b', ambientIntensity: 0.12, directionalIntensity: 0, lights: [directorLight('低调主光', -58, 18, 6.2, '#fff7e8', 'hard'), directorLight('低调轮廓', 165, 12, 2.8, '#7eb6ff', 'hard')] },
  { name: '轮廓光', backgroundColor: '#050505', ambientIntensity: 0.08, directionalIntensity: 0, lights: [directorLight('左轮廓光', -150, 14, 6.5, '#b8d4ff', 'hard'), directorLight('右轮廓光', 150, 14, 6.5, '#fff7e8', 'hard')] },
  { name: '剪影', backgroundColor: '#020617', ambientIntensity: 0.02, directionalIntensity: 0, lights: [directorLight('逆光', 180, 8, 9.2, '#d6e4f0', 'hard')] },
  { name: '霓虹灯', backgroundColor: '#1e1033', ambientIntensity: 0.45, directionalIntensity: 0, lights: [directorLight('霓虹粉', -72, 8, 7.5, '#ff4fd8', 'hard'), directorLight('霓虹蓝', 68, 12, 7.2, '#35d7ff', 'hard'), directorLight('霓虹绿', 178, 26, 3.8, '#45ff9a')] },
  { name: '实景光', backgroundColor: '#334155', ambientIntensity: 1.6, directionalIntensity: 0, lights: [directorLight('窗外主光', -38, 28, 4.8, '#d6e4f0'), directorLight('室内暖光', 62, 16, 2.8, '#ffc46b')] },
  { name: '明暗对比', backgroundColor: '#18181b', ambientIntensity: 0.3, directionalIntensity: 0, lights: [directorLight('高反差主光', -62, 24, 8, '#fff7e8', 'hard'), directorLight('冷色轮廓', 160, 18, 3, '#7eb6ff', 'hard')] },
  { name: '篝火光', backgroundColor: '#431407', ambientIntensity: 0.55, directionalIntensity: 0, lights: [directorLight('篝火主光', -8, -18, 7.8, '#ff5a36', 'soft', 4), directorLight('火焰辅光', 42, -10, 3.6, '#ffb347', 'soft', 5)] },
  { name: '月夜神秘', backgroundColor: '#0f172a', ambientIntensity: 0.28, directionalIntensity: 0, lights: [directorLight('月光', -42, 52, 5.5, '#b8d4ff', 'hard', 10), directorLight('午夜补光', 86, 8, 1.8, '#3155a6')] },
]
const SEMANTIC_BONES = {
  root: ['root', 'hips', 'pelvis', 'mixamorighips'], spine: ['spine', 'chest', 'upperchest', 'mixamorigspine'], head: ['head', 'neck', 'mixamorighead'],
  leftShoulder: ['leftshoulder', 'leftarm', 'upperarm_l', 'mixamorigleftarm'], rightShoulder: ['rightshoulder', 'rightarm', 'upperarm_r', 'mixamorigrightarm'],
  leftElbow: ['leftforearm', 'lowerarm_l', 'mixamorigleftforearm'], rightElbow: ['rightforearm', 'lowerarm_r', 'mixamorigrightforearm'],
  leftWrist: ['lefthand', 'hand_l', 'mixamoriglefthand'], rightWrist: ['righthand', 'hand_r', 'mixamorigrighthand'],
  leftHip: ['leftupleg', 'thigh_l', 'mixamorigleftupleg'], rightHip: ['rightupleg', 'thigh_r', 'mixamorigrightupleg'],
  leftKnee: ['leftleg', 'calf_l', 'mixamorigleftleg'], rightKnee: ['rightleg', 'calf_r', 'mixamorigrightleg'],
  leftAnkle: ['leftfoot', 'foot_l', 'mixamorigleftfoot'], rightAnkle: ['rightfoot', 'foot_r', 'mixamorigrightfoot'],
}
const SEMANTIC_POSE_CONTROLS = [
  { label: '身体前倾', semantic: 'root', axis: 0, min: -45, max: 45 }, { label: '身体转身', semantic: 'root', axis: 1, min: -90, max: 90 }, { label: '身体侧倾', semantic: 'root', axis: 2, min: -45, max: 45 },
  { label: '躯干前倾', semantic: 'spine', axis: 0, min: -45, max: 45 }, { label: '躯干扭转', semantic: 'spine', axis: 1, min: -60, max: 60 }, { label: '躯干侧倾', semantic: 'spine', axis: 2, min: -45, max: 45 },
  { label: '头部点头', semantic: 'head', axis: 0, min: -60, max: 60 }, { label: '头部转头', semantic: 'head', axis: 1, min: -90, max: 90 }, { label: '头部歪头', semantic: 'head', axis: 2, min: -45, max: 45 },
  { label: '左肩前举', semantic: 'leftShoulder', axis: 0, min: -120, max: 120 }, { label: '左肩旋转', semantic: 'leftShoulder', axis: 1, min: -120, max: 120 }, { label: '左肩侧举', semantic: 'leftShoulder', axis: 2, min: -150, max: 150 },
  { label: '右肩前举', semantic: 'rightShoulder', axis: 0, min: -120, max: 120 }, { label: '右肩旋转', semantic: 'rightShoulder', axis: 1, min: -120, max: 120 }, { label: '右肩侧举', semantic: 'rightShoulder', axis: 2, min: -150, max: 150 },
  { label: '左肘弯曲', semantic: 'leftElbow', axis: 0, min: 0, max: 150 }, { label: '左肘旋转', semantic: 'leftElbow', axis: 1, min: -120, max: 120 },
  { label: '右肘弯曲', semantic: 'rightElbow', axis: 0, min: 0, max: 150 }, { label: '右肘旋转', semantic: 'rightElbow', axis: 1, min: -120, max: 120 },
  { label: '左腕俯仰', semantic: 'leftWrist', axis: 0, min: -90, max: 90 }, { label: '左腕旋转', semantic: 'leftWrist', axis: 1, min: -120, max: 120 }, { label: '左腕侧弯', semantic: 'leftWrist', axis: 2, min: -90, max: 90 },
  { label: '右腕俯仰', semantic: 'rightWrist', axis: 0, min: -90, max: 90 }, { label: '右腕旋转', semantic: 'rightWrist', axis: 1, min: -120, max: 120 }, { label: '右腕侧弯', semantic: 'rightWrist', axis: 2, min: -90, max: 90 },
  { label: '左髋前抬', semantic: 'leftHip', axis: 0, min: -90, max: 120 }, { label: '左髋侧抬', semantic: 'leftHip', axis: 2, min: -90, max: 90 },
  { label: '右髋前抬', semantic: 'rightHip', axis: 0, min: -90, max: 120 }, { label: '右髋侧抬', semantic: 'rightHip', axis: 2, min: -90, max: 90 },
  { label: '左膝弯曲', semantic: 'leftKnee', axis: 0, min: 0, max: 150 }, { label: '右膝弯曲', semantic: 'rightKnee', axis: 0, min: 0, max: 150 },
  { label: '左踝俯仰', semantic: 'leftAnkle', axis: 0, min: -75, max: 75 }, { label: '右踝俯仰', semantic: 'rightAnkle', axis: 0, min: -75, max: 75 },
]
const pose = (name, rotations = {}) => ({ name, rotations })
const POSE_PRESETS = [
  pose('重置'), pose('站立', { spine: [2, 0, 0], head: [-10, 0, 0], leftElbow: [15, 0, 0], rightElbow: [15, 0, 0] }), pose('T型', { leftShoulder: [0, 0, -90], rightShoulder: [0, 0, 90] }),
  pose('行走', { spine: [5, 0, 0], leftShoulder: [-25, 0, 0], rightShoulder: [25, 0, 0], leftHip: [25, 0, 0], rightHip: [-20, 0, 0], rightKnee: [25, 0, 0] }),
  pose('跑步', { root: [15, 0, 0], spine: [12, 0, 0], leftShoulder: [-55, 0, 0], rightShoulder: [55, 0, 0], leftHip: [55, 0, 0], rightHip: [-35, 0, 0], rightKnee: [75, 0, 0] }),
  pose('跳跃', { root: [-8, 0, 0], leftShoulder: [-120, 0, -15], rightShoulder: [-120, 0, 15], leftHip: [35, 0, -15], rightHip: [35, 0, 15], leftKnee: [55, 0, 0], rightKnee: [55, 0, 0] }),
  pose('踢球', { root: [8, 0, 0], rightHip: [-60, 0, 0], rightKnee: [25, 0, 0] }), pose('投掷', { spine: [-8, -20, 0], rightShoulder: [-105, 0, 25], rightElbow: [55, 0, 0] }),
  pose('推', { root: [12, 0, 0], leftShoulder: [-65, 0, -12], rightShoulder: [-65, 0, 12], leftElbow: [25, 0, 0], rightElbow: [25, 0, 0] }),
  pose('坐姿', { root: [5, 0, 0], leftHip: [85, 0, 0], rightHip: [85, 0, 0], leftKnee: [90, 0, 0], rightKnee: [90, 0, 0] }), pose('蹲下', { root: [18, 0, 0], leftHip: [65, 0, 0], rightHip: [65, 0, 0], leftKnee: [115, 0, 0], rightKnee: [115, 0, 0] }),
  pose('单膝跪', { leftHip: [45, 0, 0], rightHip: [75, 0, 0], leftKnee: [90, 0, 0], rightKnee: [130, 0, 0] }), pose('双膝跪', { leftHip: [25, 0, 0], rightHip: [25, 0, 0], leftKnee: [135, 0, 0], rightKnee: [135, 0, 0] }),
  pose('躺', { root: [0, 0, 90], leftShoulder: [20, 0, -15], rightShoulder: [20, 0, 15] }),
  pose('招手', { rightShoulder: [-70, 0, 35], rightElbow: [85, 0, 0] }), pose('指向', { rightShoulder: [-80, 0, 0], rightElbow: [8, 0, 0] }),
  pose('举手', { leftShoulder: [-145, 0, -8], rightShoulder: [-145, 0, 8] }), pose('庆祝', { leftShoulder: [-125, 0, -35], rightShoulder: [-125, 0, 35], leftElbow: [35, 0, 0], rightElbow: [35, 0, 0] }),
  pose('鞠躬', { root: [35, 0, 0], spine: [25, 0, 0], head: [-15, 0, 0] }), pose('演讲', { rightShoulder: [-48, 0, 25], rightElbow: [70, 0, 0], leftShoulder: [-25, 0, -20] }),
  pose('叉腰', { leftShoulder: [10, 0, -35], rightShoulder: [10, 0, 35], leftElbow: [95, 0, 0], rightElbow: [95, 0, 0] }),
  pose('抱臂', { leftShoulder: [-35, 0, -25], rightShoulder: [-35, 0, 25], leftElbow: [105, 0, 0], rightElbow: [105, 0, 0] }), pose('思考', { head: [8, -12, 8], rightShoulder: [-35, 0, 15], rightElbow: [110, 0, 0] }),
  pose('倚靠', { root: [0, 0, 12], spine: [0, 0, -8] }), pose('伸懒腰', { root: [-8, 0, 0], leftShoulder: [-140, 0, -20], rightShoulder: [-140, 0, 20] }),
  pose('看手机', { head: [18, 0, 0], leftShoulder: [-25, 0, -10], rightShoulder: [-25, 0, 10], leftElbow: [95, 0, 0], rightElbow: [95, 0, 0] }),
  pose('拍照', { head: [2, 0, 0], leftShoulder: [-55, 0, -15], rightShoulder: [-55, 0, 15], leftElbow: [85, 0, 0], rightElbow: [85, 0, 0] }),
  pose('格斗', { spine: [8, -15, 0], leftShoulder: [-55, 0, -20], rightShoulder: [-65, 0, 20], leftElbow: [95, 0, 0], rightElbow: [105, 0, 0] }),
  pose('舞蹈', { root: [0, 18, -8], leftShoulder: [-105, 0, -45], rightShoulder: [-45, 0, 65], leftHip: [35, 0, -18], rightKnee: [50, 0, 0] }),
]
const ROLE_ARCHETYPES = [
  { kind: 'male', label: '标准素体', height: 1.82, width: 0.5, color: 0x4f8ef7 },
  { kind: 'female', label: '女性素体', height: 1.7, width: 0.42, color: 0xf472b6 },
  { kind: 'broad', label: '宽厚素体', height: 1.78, width: 0.66, color: 0xf59e0b },
  { kind: 'muscular', label: '壮实素体', height: 1.84, width: 0.6, color: 0xef4444 },
  { kind: 'slim', label: '纤细素体', height: 1.78, width: 0.35, color: 0x8b5cf6 },
  { kind: 'youth', label: '少年素体', height: 1.52, width: 0.38, color: 0x22c55e },
  { kind: 'child', label: '儿童素体', height: 1.22, width: 0.34, color: 0x06b6d4 },
  { kind: 'chibi', label: '二头身', height: 0.95, width: 0.46, color: 0xf97316 },
]
const DIRECTOR_PERSON_ASSETS = [
  { name: '标准关节人偶素体', kind: 'male' },
  { name: '女性比例关节人偶', kind: 'female' },
  { name: '儿童比例关节人偶', kind: 'child' },
  { name: '壮实体型关节人偶', kind: 'muscular' },
  { name: '高挑纤细关节人偶', kind: 'slim' },
  { name: '一排3个素体人偶', crowd: 3 },
  { name: '一排5个素体人偶', crowd: 5 },
]
const DIRECTOR_ASSET_TABS = [
  { value: 'props', label: '道具' },
  { value: 'people', label: '人物' },
  { value: 'cameras', label: '机位' },
  { value: 'templates', label: '模板' },
]
const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2]
const ORIENTATION_MODES = [
  { value: 'shot', label: '镜头方向' },
  { value: 'locked', label: '锁定方向' },
  { value: 'path', label: '沿路径' },
]
const IK_ENDPOINTS = [
  { value: 'leftHand', label: '左手' }, { value: 'rightHand', label: '右手' },
  { value: 'leftFoot', label: '左脚' }, { value: 'rightFoot', label: '右脚' },
]
const TRANSFORM_TOOLS = [
  { mode: 'translate', label: '移动工具', icon: '↔' },
  { mode: 'rotate', label: '旋转工具', icon: '⟳' },
  { mode: 'scale', label: '缩放工具', icon: '⤢' },
]
import {
  DIRECTOR_VALIDATION_ASSET_URL,
  createDirectorResourceState,
  directorResourceStatusLabel,
  isDirectorAnimationCompatible,
  loadDirectorGltf,
  resolveDirectorAssetUrl,
  updateDirectorResourceState,
} from '@/utils/director-assets'
import {
  directorExportDownloadUrl,
  directorExportFilename,
  parseDirectorExportResult,
  pickDirectorRecordingMimeType,
  waitForDirectorExportTask,
} from '@/utils/director-export-support'

const props = defineProps({
  visible: { type: Boolean, default: false },
  drama: { type: Object, default: null },
  initialState: { type: Object, default: null },
  entryContext: { type: Object, default: null },
})

const emit = defineEmits(['close', 'state-change', 'asset-created'])
const dialogRef = ref(null)
const aiImportModalRef = ref(null)
const environmentEditorRef = ref(null)
const cameraEditorRef = ref(null)
const addCameraButtonRef = ref(null)
const poseEditorRef = ref(null)
const addRoleButtonRef = ref(null)
const helpModalRef = ref(null)
const aiImportButtonRef = ref(null)
const helpButtonRef = ref(null)
const canvasRef = ref(null)
const templateImportRef = ref(null)
const panoramaFileRef = ref(null)
// Threepipe owns a mutable object graph; keep it out of Vue's deep proxying.
const viewer = shallowRef(null)
const initializing = ref(false)
const errorMessage = ref('')
const viewMode = ref('director')
const playing = ref(false)
const dirty = ref(false)
const selectedShotId = ref('')
const selectedCharacterId = ref('')
const selectedActionClipId = ref('')
const actionToAdd = ref('Idle')
const timeline = ref(createDirectorTimeline([]))
const exporting = ref(false)
const capturing = ref(false)
const exportProgress = ref(0)
const exportCancelled = ref(false)
const activeExportTaskId = ref('')
const assetStatus = ref('')
const modelLoading = ref(false)
const libraryAssets = ref([])
const libraryLoading = ref(false)
const selectedLibraryAssetId = ref('')
const selectedObjectId = ref('')
const selectedBoneName = ref('')
const characterBones = ref({})
const resourceStates = ref({})
const transformMode = ref('translate')
const transformSpace = ref('world')
const workspaceMode = ref('scene')
const inspectorTab = ref('properties')
const sceneSearch = ref('')
const leftPanelTab = ref('outline')
const assetLibraryTab = ref('props')
const assetLibrarySearch = ref('')
const labelsMenuOpen = ref(false)
const aspectMenuOpen = ref(false)
const panoramaModalOpen = ref(false)
const panoramaReferenceMode = ref('insert')
const panoramaReferenceFile = ref(null)
const panoramaReferencePreview = ref('')
const crowdModalOpen = ref(false)
const crowdRows = ref(3)
const crowdColumns = ref(3)
const crowdSpacing = ref(1.2)
const pendingTemplate = ref(null)
const selectedMotionTrackId = ref('')
const selectedMotionKeyframeId = ref('')
const keyframePanelOpen = ref(false)
const confirmCompositionArmed = ref(false)
const compositionConfirmMessage = ref('')
const movementSensitivity = ref(1)
const invertTouchpad = ref(false)
const wheelFovEnabled = ref(true)
const selectedIkEndpoint = ref('')
const aiImportOpen = ref(false)
const helpOpen = ref(false)
const aiImportType = ref('scene')
const aiImportFile = ref(null)
const aiImportPreview = ref('')
const aiImportDescription = ref('')
const aiImportStatus = ref('')
const aiImportBusy = ref(false)
const aiImportUploadedUrl = ref('')
const aiImportAssetId = ref(null)
const axes = ['X', 'Y', 'Z']
const undoStack = ref([])
const redoStack = ref([])
let ambientLight = null
let keyLight = null
let groundGrid = null
let environmentRequest = 0
let transformControls = null
let transformStartScale = null
let shiftPressed = false
let pickingPlugin = null

const scenes = computed(() => props.drama?.scenes || [])
const characters = computed(() => props.drama?.characters || [])
const propsList = computed(() => props.drama?.props || [])
const entryReferenceUrl = computed(() => String(props.entryContext?.imageUrl || '').trim())
const entryReferenceTitle = computed(() => String(props.entryContext?.sourceTitle || '图片节点参考图').trim())
const lightingEntry = computed(() => props.entryContext?.mode === 'lighting')
const angleEntry = computed(() => props.entryContext?.mode === 'angle')
const poseEntry = computed(() => props.entryContext?.mode === 'pose')
const entryMode = computed(() => props.entryContext?.mode || 'director_stage')
const entryTitle = computed(() => ({
  lighting: '灯光调节',
  angle: '相机角度调整',
  pose: '姿势编辑器',
  director_stage: '3D 导演台',
}[entryMode.value] || '3D 导演台'))
const characterEntries = computed(() => {
  const entries = characters.value.map((character, index) => ({
    id: String(character?.id ?? character?.name ?? `character-${index + 1}`),
    name: character?.name || `角色 ${index + 1}`,
  }))
  const knownIds = new Set(entries.map((entry) => entry.id))
  for (const entry of timeline.value.objects.filter((entry) => entry.type === 'humanoid')) {
    const id = String(entry.assetRef?.characterId || entry.id)
    if (knownIds.has(id)) continue
    entries.push({ id, name: entry.name || `角色 ${entries.length + 1}` })
    knownIds.add(id)
  }
  return entries
})
const shots = computed(() => timeline.value.shots)
const duration = computed(() => timeline.value.sequence.duration || 0.25)
const currentTime = computed(() => timeline.value.sequence.currentTime)
const selectedShot = computed(() => shots.value.find((shot) => shot.id === selectedShotId.value) || shots.value[0] || null)
const canSplitSelectedShot = computed(() => {
  if (!selectedShot.value) return false
  const offset = currentTime.value - selectedShot.value.start
  return offset >= MIN_SHOT_DURATION && selectedShot.value.duration - offset >= MIN_SHOT_DURATION
})
const selectedActionClip = computed(() => timeline.value.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedActionClipId.value) || null)
const selectedCharacter = computed(() => characterEntries.value.find((character) => character.id === selectedCharacterId.value) || characterEntries.value[0] || null)
const selectedCharacterAsset = computed(() => timeline.value.characterAssets?.[selectedCharacter.value?.id] || { modelUrl: '', scale: 1, actions: {} })
const proceduralCharacterIds = ref(new Set())
const selectedCharacterBones = computed(() => characterBones.value[selectedCharacter.value?.id] || [])
const selectedPoseRotations = computed(() => isSelectedProceduralCharacter.value
  ? (selectedDirectorObject.value?.poseRotations || {})
  : (selectedCharacterAsset.value.boneRotations || {}))
const availableSemanticControls = computed(() => SEMANTIC_POSE_CONTROLS.filter((control) => resolveSemanticBone(control.semantic)))
const selectedBoneRotation = computed(() => selectedCharacterAsset.value.boneRotations?.[selectedBoneName.value] || [0, 0, 0])
const selectedBoneRotationDegrees = computed(() => selectedBoneRotation.value.map(radiansToDegrees))
const selectedActionAsset = computed(() => selectedCharacterAsset.value.actions?.[actionToAdd.value] || { url: '' })
const selectedModelResourceState = computed(() => resourceStates.value[resourceStateKey('model', selectedCharacter.value?.id)] || createDirectorResourceState('model', selectedCharacterAsset.value.modelUrl))
const selectedActionResourceState = computed(() => resourceStates.value[resourceStateKey('action', selectedCharacter.value?.id, actionToAdd.value)] || createDirectorResourceState('action', selectedActionAsset.value.url))
const selectedLibraryAsset = computed(() => libraryAssets.value.find((asset) => String(asset.id) === String(selectedLibraryAssetId.value)) || null)
const activeShot = computed(() => findActiveShot(timeline.value, currentTime.value))
const selectedDirectorObject = computed(() => timeline.value.objects.find((object) => object.id === selectedObjectId.value) || null)
const isSelectedCharacterObject = computed(() => ['character', 'humanoid'].includes(selectedDirectorObject.value?.type))
const isSelectedProceduralCharacter = computed(() => selectedDirectorObject.value?.type === 'humanoid'
  || (selectedDirectorObject.value?.type === 'character'
    && proceduralCharacterIds.value.has(String(selectedDirectorObject.value.assetRef?.characterId || ''))))
const filteredDirectorObjects = computed(() => {
  const query = sceneSearch.value.trim().toLowerCase()
  return query ? timeline.value.objects.filter((object) => `${object.name} ${object.type}`.toLowerCase().includes(query)) : timeline.value.objects
})
const selectedInspectorTransform = computed(() => selectedDirectorObject.value
  ? (interpolateMotionTransform(timeline.value, selectedDirectorObject.value.id, currentTime.value) || selectedDirectorObject.value.transform)
  : { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
const selectedCamera = computed(() => timeline.value.cameras.find((camera) => camera.objectId === selectedObjectId.value) || null)
const lightObjects = computed(() => timeline.value.objects.filter((object) => object.type === 'light'))
const selectedLightObject = computed(() => selectedDirectorObject.value?.type === 'light' ? selectedDirectorObject.value : null)
const selectedMotionTrack = computed(() => timeline.value.motionTracks.find((track) => track.id === selectedMotionTrackId.value)
  || timeline.value.motionTracks.find((track) => track.objectId === selectedObjectId.value)
  || null)
const selectedMotionKeyframe = computed(() => selectedMotionTrack.value?.keyframes.find((keyframe) => keyframe.id === selectedMotionKeyframeId.value) || null)
const directorObjectCounts = computed(() => ({
  people: timeline.value.objects.filter((object) => ['character', 'humanoid'].includes(object.type)).length,
  props: timeline.value.objects.filter((object) => !['character', 'humanoid', 'camera', 'group', 'light'].includes(object.type)).length,
  cameras: timeline.value.objects.filter((object) => object.type === 'camera').length,
}))
const filteredAssetItems = computed(() => {
  const query = assetLibrarySearch.value.trim().toLowerCase()
  const source = {
    props: DIRECTOR_PROP_ASSETS,
    people: DIRECTOR_PERSON_ASSETS,
    cameras: DIRECTOR_CAMERA_ASSETS,
    templates: DIRECTOR_SCENE_TEMPLATES,
  }[assetLibraryTab.value] || []
  return query ? source.filter((item) => item.name.toLowerCase().includes(query)) : source
})
const visibleDirectorObjects = computed(() => timeline.value.objects.filter((object) => object.visible && object.type !== 'group'))
const cameraTargetObjects = computed(() => timeline.value.objects.filter((object) => object.id !== selectedCamera.value?.objectId && object.type !== 'camera'))
const activeCompositionGuides = computed(() => {
  if (timeline.value.environment.showCameraGuides) return true
  if (viewMode.value !== 'camera') return false
  const camera = timeline.value.cameras.find((entry) => entry.id === selectedShot.value?.cameraId)
  return camera?.showGuides === true
})
const availableParentGroups = computed(() => timeline.value.objects.filter((object) => object.type === 'group' && object.id !== selectedObjectId.value))
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)
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

function applyBoneRotations(characterId) {
  const modelState = characterModels.get(String(characterId))
  const rotations = timeline.value.characterAssets?.[String(characterId)]?.boneRotations || {}
  if (!modelState?.bones) return
  for (const [name, rotation] of Object.entries(rotations)) {
    const bone = modelState.bones.get(name)
    if (bone) bone.rotation.set(...rotation)
  }
}

function normalizedBoneName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function resolveSemanticBone(semantic) {
  if (isSelectedProceduralCharacter.value) return SEMANTIC_BONES[semantic] ? semantic : ''
  const aliases = SEMANTIC_BONES[semantic] || []
  const bones = selectedCharacterBones.value
  return bones.find((bone) => aliases.some((alias) => normalizedBoneName(bone.name) === alias || normalizedBoneName(bone.name).includes(alias)))?.name || ''
}

function semanticRotationDegrees(control) {
  const boneName = resolveSemanticBone(control.semantic)
  const rotation = selectedPoseRotations.value[boneName] || [0, 0, 0]
  return radiansToDegrees(rotation[control.axis])
}

function applyProceduralPose(objectId) {
  const object = stageObjects.get(`custom:${objectId}`)
  const rotations = timeline.value.objects.find((entry) => entry.id === objectId)?.poseRotations || {}
  const poseBones = object?.userData?.poseBones
  if (!poseBones) return
  for (const semantic of Object.keys(SEMANTIC_BONES)) {
    const rotation = rotations[semantic] || [0, 0, 0]
    poseBones[semantic]?.rotation?.set?.(...rotation)
  }
  viewer.value?.setDirty?.()
}

function persistPoseRotations(poseRotations) {
  if (isSelectedProceduralCharacter.value) {
    const objectId = selectedDirectorObject.value.id
    mutateTimeline(updateDirectorObject(timeline.value, objectId, { poseRotations }))
    applyProceduralPose(objectId)
    return
  }
  persistBoneRotations(poseRotations)
}

function persistBoneRotations(boneRotations) {
  if (!selectedCharacter.value) return
  const characterId = selectedCharacter.value.id
  const assets = cloneTimeline(timeline.value.characterAssets || {})
  const current = assets[characterId] || { modelUrl: '', scale: 1, actions: {}, boneRotations: {} }
  assets[characterId] = { ...current, actions: { ...(current.actions || {}) }, boneRotations }
  mutateTimeline({ ...timeline.value, characterAssets: assets })
  applyBoneRotations(characterId)
}

function updateSemanticRotation(control, value) {
  const boneName = resolveSemanticBone(control.semantic)
  if (!boneName) return
  const rotations = cloneTimeline(selectedPoseRotations.value)
  const rotation = [...(rotations[boneName] || [0, 0, 0])]
  rotation[control.axis] = (Number(value) || 0) * Math.PI / 180
  rotations[boneName] = rotation
  persistPoseRotations(rotations)
}

function applyPosePreset(preset) {
  const rotations = cloneTimeline(selectedPoseRotations.value)
  for (const semantic of Object.keys(SEMANTIC_BONES)) {
    const boneName = resolveSemanticBone(semantic)
    if (boneName) rotations[boneName] = [0, 0, 0]
  }
  for (const [semantic, degrees] of Object.entries(preset.rotations || {})) {
    const boneName = resolveSemanticBone(semantic)
    if (boneName) rotations[boneName] = degrees.map((value) => Number(value || 0) * Math.PI / 180)
  }
  persistPoseRotations(rotations)
  assetStatus.value = `已应用姿势：${preset.name}`
}

function mirrorPoseLeftToRight(section) {
  if (!selectedDirectorObject.value) return
  const leftName = resolveSemanticBone(section.left)
  const rightName = resolveSemanticBone(section.right)
  if (!leftName || !rightName) return
  const rotations = cloneTimeline(selectedPoseRotations.value)
  const source = rotations[leftName] || [0, 0, 0]
  rotations[rightName] = [source[0], -source[1], -source[2]]
  persistPoseRotations(rotations)
  assetStatus.value = `已镜像左侧${section.label}到右侧`
}

function toggleIkEndpoint(endpoint) {
  if (!selectedDirectorObject.value || !IK_ENDPOINTS.some((item) => item.value === endpoint)) return
  selectedIkEndpoint.value = endpoint
  updateSelectedObject({
    ikLocks: {
      ...(selectedDirectorObject.value.ikLocks || {}),
      [endpoint]: !selectedDirectorObject.value.ikLocks?.[endpoint],
    },
  })
}

function updateIkTarget(index, value) {
  if (!selectedDirectorObject.value || !selectedIkEndpoint.value) return
  const endpoint = selectedIkEndpoint.value
  const target = [...(selectedDirectorObject.value.ikTargets?.[endpoint] || [0, 0, 0])]
  target[index] = Number(value) || 0
  const ikTargets = { ...(selectedDirectorObject.value.ikTargets || {}), [endpoint]: target }
  const rotations = cloneTimeline(selectedPoseRotations.value)
  const hand = endpoint.endsWith('Hand')
  const side = endpoint.startsWith('left') ? 'left' : 'right'
  const primary = resolveSemanticBone(`${side}${hand ? 'Shoulder' : 'Hip'}`)
  const secondary = resolveSemanticBone(`${side}${hand ? 'Elbow' : 'Knee'}`)
  if (primary) rotations[primary] = [target[2] * -0.45, target[1] * 0.3, target[0] * (side === 'left' ? -0.45 : 0.45)]
  if (secondary) rotations[secondary] = [Math.max(0, Math.min(2.6, Math.hypot(...target) * 0.5)), 0, 0]
  mutateTimeline(updateDirectorObject(timeline.value, selectedDirectorObject.value.id, { ikTargets, poseRotations: rotations }))
  applyProceduralPose(selectedDirectorObject.value.id)
}

function updateBoneRotation(index, value) {
  if (!selectedCharacter.value || !selectedBoneName.value) return
  const current = selectedCharacterAsset.value
  const rotation = [...(current.boneRotations?.[selectedBoneName.value] || [0, 0, 0])]
  rotation[index] = (Number(value) || 0) * Math.PI / 180
  persistBoneRotations({ ...(current.boneRotations || {}), [selectedBoneName.value]: rotation })
}

function resetSelectedBone() {
  if (!selectedCharacter.value || !selectedBoneName.value) return
  const characterId = selectedCharacter.value.id
  const assets = cloneTimeline(timeline.value.characterAssets || {})
  const current = assets[characterId]
  if (!current) return
  const boneRotations = { ...(current.boneRotations || {}) }
  delete boneRotations[selectedBoneName.value]
  assets[characterId] = { ...current, boneRotations }
  mutateTimeline({ ...timeline.value, characterAssets: assets })
  const bone = characterModels.get(characterId)?.bones?.get(selectedBoneName.value)
  bone?.rotation?.set?.(0, 0, 0)
  viewer.value?.setDirty?.()
}

function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('截图生成失败')), type)
    } catch (error) {
      reject(new Error(`截图失败，可能存在未允许跨域读取的纹理：${error?.message || '画布不可读取'}`))
    }
  })
}

async function blobHash(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function captureToCanvasAsset() {
  const dramaId = Number(props.drama?.id)
  if (!canvasRef.value || !dramaId || capturing.value) return
  capturing.value = true
  assetStatus.value = '正在生成导演截图…'
  try {
    viewer.value?.setDirty?.()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const blob = await canvasBlob(canvasRef.value)
    const hash = await blobHash(blob)
    const name = `导演截图-${hash.slice(0, 12)}.png`
    const existingResult = await assetsAPI.list({ drama_id: dramaId, type: 'image', page_size: 100 })
    const existing = (Array.isArray(existingResult) ? existingResult : (existingResult?.items || []))
      .find((asset) => asset.name === name && asset.category === 'director-capture')
    if (existing) {
      assetStatus.value = '相同导演截图已在画布中'
      emit('asset-created', existing)
      return
    }
    const file = new File([blob], name, { type: 'image/png' })
    const uploaded = await uploadAPI.uploadImage(file, { dramaId })
    const asset = await assetsAPI.create({
      drama_id: dramaId,
      name,
      type: 'image',
      category: 'director-capture',
      url: uploaded?.url || '',
      local_path: uploaded?.local_path || uploaded?.path || null,
      file_size: blob.size,
      mime_type: blob.type || 'image/png',
      width: canvasRef.value.width,
      height: canvasRef.value.height,
    })
    assetStatus.value = '导演截图已写入项目画布'
    emit('asset-created', asset)
  } catch (error) {
    assetStatus.value = error?.message || '导演截图回写失败'
  } finally {
    capturing.value = false
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('无法读取图片'))
    reader.readAsDataURL(file)
  })
}

function onAIImportFile(event) {
  const file = event.target.files?.[0] || null
  if (aiImportPreview.value) URL.revokeObjectURL(aiImportPreview.value)
  aiImportFile.value = file
  aiImportPreview.value = file ? URL.createObjectURL(file) : ''
  aiImportDescription.value = ''
  aiImportStatus.value = ''
  aiImportUploadedUrl.value = ''
  aiImportAssetId.value = null
}

async function analyzeAIImport() {
  const file = aiImportFile.value
  if (!file || aiImportBusy.value) return
  aiImportBusy.value = true
  aiImportStatus.value = '正在识别并上传参考图…'
  try {
    const dataUrl = await fileToDataUrl(file)
    const analysis = await uploadAPI.extractDescriptionFromImage(aiImportType.value, dataUrl, '导演台参考')
    const uploaded = await uploadAPI.uploadImage(file, { dramaId: props.drama?.id })
    const description = String(analysis?.description || analysis?.data?.description || '').trim()
    if (!description) throw new Error('识图服务未返回描述')
    aiImportDescription.value = description
    aiImportUploadedUrl.value = uploaded?.url || ''
    const dramaId = Number(props.drama?.id)
    if (dramaId) {
      const asset = await assetsAPI.create({
        drama_id: dramaId,
        name: file.name,
        type: 'image',
        category: 'director-ai-reference',
        url: uploaded?.url || '',
        local_path: uploaded?.local_path || uploaded?.path || null,
        file_size: file.size,
        mime_type: file.type || 'image/png',
      })
      aiImportAssetId.value = asset?.id || null
      emit('asset-created', asset)
    }
    aiImportStatus.value = '识别完成，可修订描述后导入'
  } catch (error) {
    aiImportStatus.value = `${error?.message || '识图失败'}；可手动填写描述后继续导入`
  } finally {
    aiImportBusy.value = false
  }
}

function closePanoramaModal() {
  if (panoramaReferencePreview.value) URL.revokeObjectURL(panoramaReferencePreview.value)
  panoramaReferenceFile.value = null
  panoramaReferencePreview.value = ''
  panoramaModalOpen.value = false
  if (panoramaFileRef.value) panoramaFileRef.value.value = ''
}

function onPanoramaFile(event) {
  const file = event.target.files?.[0] || null
  if (panoramaReferencePreview.value) URL.revokeObjectURL(panoramaReferencePreview.value)
  panoramaReferenceFile.value = file
  panoramaReferencePreview.value = file ? URL.createObjectURL(file) : ''
  assetStatus.value = file ? `已选择：${file.name}` : ''
}

async function applyPanoramaReference() {
  const file = panoramaReferenceFile.value
  if (!file) return
  assetStatus.value = '正在上传站位参考图…'
  try {
    const uploaded = await uploadAPI.uploadImage(file, { dramaId: props.drama?.id })
    const url = String(uploaded?.url || '')
    if (!url) throw new Error('参考图上传后未返回可用地址')
    const dramaId = Number(props.drama?.id)
    if (dramaId) {
      const asset = await assetsAPI.create({
        drama_id: dramaId,
        name: file.name,
        type: 'image',
        category: 'director-panorama-reference',
        url,
        local_path: uploaded?.local_path || uploaded?.path || null,
        file_size: file.size,
        mime_type: file.type || 'image/png',
      })
      emit('asset-created', asset)
    }
    if (panoramaReferenceMode.value === 'override') {
      updateEnvironment('panoramaUrl', url)
      assetStatus.value = '参考图已作为全景环境应用'
    } else {
      const next = appendDirectorObject(timeline.value, 'box', {
        name: `站位参考 · ${file.name}`,
        assetRef: { assetId: null, url, kind: 'director-panorama-reference' },
        transform: { position: [0, 1.3, -3], rotation: [0, 0, 0], scale: [4, 2.25, 0.08] },
      })
      selectedObjectId.value = next.objects.at(-1)?.id || ''
      mutateTimeline(next)
      buildStage()
      assetStatus.value = '参考图已插入当前导演台'
    }
    closePanoramaModal()
  } catch (error) {
    assetStatus.value = error?.message || '站位参考图应用失败'
  }
}

function createAIImportObject() {
  const description = aiImportDescription.value.trim()
  if (!description) return
  const type = aiImportType.value
  const objectType = type === 'character' ? 'humanoid' : type === 'scene' ? 'group' : 'box'
  const name = type === 'character' ? 'AI 角色参考' : type === 'scene' ? 'AI 场景参考' : 'AI 道具参考'
  const next = appendDirectorObject(timeline.value, objectType, {
    name,
    assetRef: {
      kind: `ai-${type}-reference`,
      url: aiImportUploadedUrl.value,
      assetId: aiImportAssetId.value,
      description,
    },
  })
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
  aiImportOpen.value = false
  assetStatus.value = `${name}已加入导演台`
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

function applyValidationAsset() {
  if (!selectedCharacter.value) return
  assetStatus.value = '正在加载 Khronos SimpleSkin CC0 验证资产…'
  updateCharacterAsset('modelUrl', DIRECTOR_VALIDATION_ASSET_URL)
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
  if (selectedActionClipId.value && !selectedActionClip.value) selectedActionClipId.value = ''
  dirty.value = false
  if (emitChange) emit('state-change', cloneTimeline(timeline.value))
  applySceneEnvironment()
  applyTimelineFrame()
}

function mutateTimeline(nextState) {
  const previous = cloneTimeline(timeline.value)
  let normalized = normalizeDirectorTimeline(nextState, characters.value)
  if (normalized.revision <= previous.revision) normalized = { ...normalized, revision: previous.revision + 1 }
  if (JSON.stringify(previous) === JSON.stringify(normalized)) return
  undoStack.value = [...undoStack.value, previous].slice(-80)
  redoStack.value = []
  applyTimelineState(normalized, { emitChange: false })
  dirty.value = true
  const emittedRevision = timeline.value.revision
  emit('state-change', cloneTimeline(timeline.value), (saved) => {
    if (saved && timeline.value.revision === emittedRevision) dirty.value = false
  })
}

function persistHistoryState(nextState) {
  applyTimelineState({ ...nextState, revision: timeline.value.revision + 1 }, { emitChange: false })
  dirty.value = true
  buildStage()
  const emittedRevision = timeline.value.revision
  emit('state-change', cloneTimeline(timeline.value), (saved) => {
    if (saved && timeline.value.revision === emittedRevision) dirty.value = false
  })
}

function undoDirector() {
  const previous = undoStack.value.at(-1)
  if (!previous) return
  redoStack.value = [...redoStack.value, cloneTimeline(timeline.value)].slice(-80)
  undoStack.value = undoStack.value.slice(0, -1)
  persistHistoryState(previous)
}

function redoDirector() {
  const next = redoStack.value.at(-1)
  if (!next) return
  undoStack.value = [...undoStack.value, cloneTimeline(timeline.value)].slice(-80)
  redoStack.value = redoStack.value.slice(0, -1)
  persistHistoryState(next)
}

function cameraVector(vector, fallback) {
  return vector ? [Number(vector.x) || 0, Number(vector.y) || 0, Number(vector.z) || 0] : [...fallback]
}

function moveDirectorView(key, accelerated = false) {
  const camera = viewer.value?.scene?.mainCamera
  if (!camera) return
  const position = cameraVector(camera.position, [6.8, 4.8, 8.6])
  const target = cameraVector(camera.target, [0, 0.8, 0])
  const distance = Math.max(0.05, movementSensitivity.value * (accelerated ? 0.6 : 0.16))
  const deltas = {
    w: [0, 0, -distance], s: [0, 0, distance], a: [-distance, 0, 0], d: [distance, 0, 0],
    e: [0, distance, 0], q: [0, -distance, 0],
  }
  const delta = deltas[key]
  if (!delta) return
  setCamera(position.map((value, index) => value + delta[index]), target.map((value, index) => value + delta[index]))
}

function orbitDirectorView(key) {
  const camera = viewer.value?.scene?.mainCamera
  if (!camera) return
  const position = cameraVector(camera.position, [6.8, 4.8, 8.6])
  const target = cameraVector(camera.target, [0, 0.8, 0])
  const offset = position.map((value, index) => value - target[index])
  if (key === 'arrowup' || key === 'arrowdown') {
    const delta = (key === 'arrowup' ? 1 : -1) * movementSensitivity.value * 0.12
    position[1] += delta
    target[1] += delta
  } else {
    const angle = (key === 'arrowleft' ? 1 : -1) * movementSensitivity.value * Math.PI / 36
    const x = offset[0] * Math.cos(angle) - offset[2] * Math.sin(angle)
    const z = offset[0] * Math.sin(angle) + offset[2] * Math.cos(angle)
    position[0] = target[0] + x
    position[2] = target[2] + z
  }
  setCamera(position, target)
}

function orbitDirectorViewByDelta(deltaX, deltaY) {
  const camera = viewer.value?.scene?.mainCamera
  if (!camera) return
  const position = cameraVector(camera.position, [6.8, 4.8, 8.6])
  const target = cameraVector(camera.target, [0, 0.8, 0])
  const offset = position.map((value, index) => value - target[index])
  const radius = Math.max(0.1, Math.hypot(...offset))
  const horizontal = Number(deltaX) || 0
  const vertical = Number(deltaY) || 0
  const theta = Math.atan2(offset[0], offset[2]) + horizontal * movementSensitivity.value * 0.003
  const phi = Math.max(0.08, Math.min(Math.PI - 0.08, Math.acos(Math.max(-1, Math.min(1, offset[1] / radius))) + vertical * movementSensitivity.value * 0.003))
  setCamera([
    target[0] + radius * Math.sin(phi) * Math.sin(theta),
    target[1] + radius * Math.cos(phi),
    target[2] + radius * Math.sin(phi) * Math.cos(theta),
  ], target)
}

function adjustDirectorFov(delta) {
  const camera = viewer.value?.scene?.mainCamera
  if (!camera) return
  camera.fov = Math.max(1, Math.min(179, Number(camera.fov || 50) + delta))
  camera.updateProjectionMatrix?.()
  viewer.value?.setDirty?.()
  if (selectedCamera.value) updateSelectedCamera('fov', camera.fov)
}

function onViewportWheel(event) {
  if (isDirectorTouchpadGesture(event)) {
    event.preventDefault()
    const direction = invertTouchpad.value ? -1 : 1
    orbitDirectorViewByDelta(event.deltaX * direction, event.deltaY * direction)
    return
  }
  if (!wheelFovEnabled.value) return
  event.preventDefault()
  adjustDirectorFov(Math.sign(event.deltaY) * 2)
}

function onDirectorKeydown(event) {
  if (event.key === 'Shift') shiftPressed = true
  if (event.key === 'Escape') {
    event.preventDefault()
    if (aiImportOpen.value) aiImportOpen.value = false
    else if (helpOpen.value) helpOpen.value = false
    else emit('close')
    return
  }
  if (event.key === 'Tab') {
    const scope = aiImportModalRef.value || helpModalRef.value || dialogRef.value
    const focusable = [...(scope?.querySelectorAll?.('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') || [])]
      .filter((element) => element.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
    return
  }
  const key = String(event.key || '').toLowerCase()
  if ((event.ctrlKey || event.metaKey) && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redoDirector()
    else undoDirector()
    return
  }
  const target = event.target
  if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return
  if (['w', 'a', 's', 'd', 'e', 'q'].includes(key)) {
    event.preventDefault()
    moveDirectorView(key, event.shiftKey)
  } else if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
    event.preventDefault()
    orbitDirectorView(key)
  } else if (key === 'f') {
    event.preventDefault()
    focusSelectedObject()
  } else if (key === 'c') {
    event.preventDefault()
    captureCurrentViewToCamera()
  } else if (key === '0') {
    event.preventDefault()
    resetCamera()
  } else if (key === '[' || key === ']') {
    event.preventDefault()
    adjustDirectorFov(key === '[' ? -2 : 2)
  }
}

function onDirectorKeyup(event) {
  if (event.key === 'Shift') shiftPressed = false
}

function selectShot(shot) {
  if (!shot) return
  selectedShotId.value = shot.id
  setCurrentTime(shot.start)
}

function selectCharacter(characterId) {
  selectedCharacterId.value = String(characterId)
  const object = timeline.value.objects.find((entry) => (
    (entry.type === 'character' || entry.type === 'humanoid')
    && String(entry.assetRef?.characterId || entry.id) === selectedCharacterId.value
  ))
  if (object) selectSceneObject(object.id)
}

function addSceneObject(type) {
  if (type === 'light') {
    addDirectorLight()
    return
  }
  const next = appendDirectorObject(timeline.value, type)
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
  if (selectedObjectId.value) nextTick(() => focusItem(`custom:${selectedObjectId.value}`))
}

function openAIRecognition() {
  leftPanelTab.value = 'ai'
  aiImportOpen.value = true
}

function addSceneGroup() {
  const count = timeline.value.objects.filter((object) => object.type === 'group').length
  const next = appendDirectorObject(timeline.value, 'group', {
    name: `组${count + 1}`,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
}

function deleteSceneObject(objectId) {
  selectedObjectId.value = String(objectId || '')
  deleteSelectedObject()
}

function releaseGroup(groupId) {
  const next = releaseDirectorGroup(timeline.value, groupId)
  selectedObjectId.value = ''
  mutateTimeline(next)
  buildStage()
}

function confirmCrowdArray() {
  const next = appendConfiguredCrowd(timeline.value, {
    rows: crowdRows.value,
    columns: crowdColumns.value,
    spacing: crowdSpacing.value,
  })
  selectedObjectId.value = [...next.objects].reverse().find((object) => object.type === 'group')?.id || ''
  mutateTimeline(next)
  buildStage()
  crowdModalOpen.value = false
}

function addPropAsset(asset, state = timeline.value) {
  const count = state.objects.filter((object) => !['character', 'humanoid', 'camera', 'group', 'light'].includes(object.type)).length
  return appendDirectorObject(state, asset.type || 'box', {
    name: asset.name,
    assetRef: { assetId: null, url: '', kind: `director-prop:${asset.name}` },
    transform: {
      position: [(count % 4) * 1.4 - 2.1, Math.max(0.02, Number(asset.scale?.[1] || 1) / 2), -Math.floor(count / 4) * 1.5],
      rotation: [0, 0, 0],
      scale: [...(asset.scale || [1, 1, 1])],
    },
  })
}

function addPersonAsset(asset) {
  if (asset.crowd) {
    const next = appendConfiguredCrowd(timeline.value, { rows: 1, columns: asset.crowd, spacing: 1.2 })
    selectedObjectId.value = [...next.objects].reverse().find((object) => object.type === 'group')?.id || ''
    mutateTimeline(next)
    buildStage()
    return
  }
  addRoleArchetype(ROLE_ARCHETYPES.find((role) => role.kind === asset.kind) || ROLE_ARCHETYPES[0])
}

function addCameraAsset(asset, state = timeline.value) {
  return appendDirectorCamera(state, {
    name: asset.name,
    transform: { position: [...asset.position], rotation: [0, 0, 0], scale: [1, 1, 1] },
    target: [...asset.target],
    fov: asset.fov,
    roll: asset.roll || 0,
  })
}

function activateAssetItem(asset) {
  if (assetLibraryTab.value === 'templates') {
    pendingTemplate.value = asset
    return
  }
  if (assetLibraryTab.value === 'people') {
    addPersonAsset(asset)
    return
  }
  let next = assetLibraryTab.value === 'cameras' ? addCameraAsset(asset) : addPropAsset(asset)
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
  if (assetLibraryTab.value === 'cameras') setView('camera')
}

function confirmSceneTemplate() {
  const template = pendingTemplate.value
  if (!template) return
  let next = createDirectorTimeline([])
  for (let index = 0; index < template.people; index += 1) {
    const role = ROLE_ARCHETYPES[index % 5]
    next = appendDirectorObject(next, 'humanoid', {
      name: `${role.label} ${index + 1}`,
      assetRef: { assetId: null, url: '', kind: role.kind },
      transform: { position: [(index - (template.people - 1) / 2) * 1.4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    })
  }
  for (const propName of template.props || []) {
    const asset = DIRECTOR_PROP_ASSETS.find((item) => item.name === propName)
    if (asset) next = addPropAsset(asset, next)
  }
  const cameraAsset = DIRECTOR_CAMERA_ASSETS.find((item) => item.name === template.camera)
  if (cameraAsset) next = addCameraAsset(cameraAsset, next)
  selectedObjectId.value = ''
  mutateTimeline(next)
  buildStage()
  pendingTemplate.value = null
  assetStatus.value = `已应用模板：${template.name}`
}

async function onTemplateImport(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    mutateTimeline(normalizeDirectorTimeline(parsed.timeline || parsed, characters.value))
    buildStage()
    assetStatus.value = `已导入模板：${file.name}`
  } catch (error) {
    assetStatus.value = error?.message || '模板 JSON 无效'
  }
}

function addDirectorLight() {
  const count = lightObjects.value.length
  const light = directorLight(`灯光 ${count + 1}`, 30 + count * 35, 30, 5)
  const position = cameraPositionFromAngles([0, 1, 0], light.azimuth, light.elevation, light.distance)
  const next = appendDirectorObject(timeline.value, 'light', {
    name: light.name,
    light,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
  })
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
  if (selectedObjectId.value) nextTick(() => focusItem(`custom:${selectedObjectId.value}`))
}

function addRoleArchetype(role) {
  const count = timeline.value.objects.filter((object) => object.type === 'humanoid').length
  const next = appendDirectorObject(timeline.value, 'humanoid', {
    name: `${role.label} ${count + 1}`,
    assetRef: { assetId: null, url: '', kind: role.kind },
    transform: { position: [(count % 4) * 1.25 - 1.8, 0, -Math.floor(count / 4) * 1.2], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
  if (poseEntry.value) {
    nextTick(() => {
      if (poseEntry.value) poseEditorRef.value?.focus()
    })
  }
}

function setCharacterArchetype(role) {
  if (!isSelectedCharacterObject.value || !role) return
  updateSelectedObject({
    assetRef: {
      ...(selectedDirectorObject.value.assetRef || {}),
      kind: role.kind,
    },
  })
  buildStage()
}

function setCharacterColor(color) {
  if (!isSelectedCharacterObject.value || !/^#[0-9a-f]{6}$/i.test(String(color || ''))) return
  updateSelectedObject({
    assetRef: {
      ...(selectedDirectorObject.value.assetRef || {}),
      color: String(color),
    },
  })
  buildStage()
}

function updateUniformScale(value) {
  if (!selectedDirectorObject.value) return
  const scale = Math.max(0.1, Math.min(3, Number(value) || 1))
  updateSelectedObject({ transform: { scale: [scale, scale, scale] } })
}

function addCrowd() {
  let next = appendDirectorObject(timeline.value, 'group', { name: '群众 3×3', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } })
  const groupId = next.objects.at(-1).id
  for (let index = 0; index < 9; index += 1) {
    const role = ROLE_ARCHETYPES[index % ROLE_ARCHETYPES.length]
    next = appendDirectorObject(next, 'humanoid', {
      name: `群众 ${index + 1}`,
      parentId: groupId,
      assetRef: { assetId: null, url: '', kind: role.kind },
      transform: { position: [(index % 3 - 1) * 1.15, 0, (Math.floor(index / 3) - 1) * 1.05], rotation: [0, 0, 0], scale: [0.86, 0.86, 0.86] },
    })
  }
  selectedObjectId.value = groupId
  mutateTimeline(next)
  buildStage()
}

function addCamera() {
  const next = appendDirectorCamera(timeline.value)
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
}

function duplicateSelectedObject() {
  if (!selectedDirectorObject.value) return
  const next = duplicateDirectorObject(timeline.value, selectedDirectorObject.value.id)
  selectedObjectId.value = next.objects.at(-1)?.id || ''
  mutateTimeline(next)
  buildStage()
}

function selectSceneObject(objectId) {
  selectedObjectId.value = String(objectId)
  const object = timeline.value.objects.find((entry) => entry.id === selectedObjectId.value)
  if (object?.type === 'character' || object?.type === 'humanoid') {
    selectedCharacterId.value = String(object.assetRef?.characterId || object.id)
  }
  inspectorTab.value = 'properties'
  for (const [key, stageObject] of stageObjects.entries()) {
    for (const marker of stageObject.userData?.rigControls || []) marker.visible = key === `custom:${objectId}`
  }
  viewer.value?.setDirty?.()
  focusItem(`custom:${objectId}`)
}

function selectEnvironmentInspector() {
  selectedObjectId.value = ''
  inspectorTab.value = 'properties'
}

function applyEntryContext() {
  if (!['director_stage', 'lighting', 'angle', 'pose'].includes(props.entryContext?.mode)) return
  workspaceMode.value = (angleEntry.value || poseEntry.value) ? 'animation' : 'scene'
  viewMode.value = 'director'
  if (poseEntry.value) {
    inspectorTab.value = 'properties'
    const poseableObject = timeline.value.objects.find((object) => ['character', 'humanoid'].includes(object.type))
    if (poseableObject) selectSceneObject(poseableObject.id)
    else selectedObjectId.value = ''
    nextTick(() => {
      if (!poseEntry.value) return
      if (poseableObject) poseEditorRef.value?.focus()
      else addRoleButtonRef.value?.focus()
    })
    return
  }
  if (angleEntry.value) {
    inspectorTab.value = 'properties'
    const activeCameraObject = findActiveCameraObject(timeline.value)
    if (activeCameraObject) selectSceneObject(activeCameraObject.id)
    else selectedObjectId.value = ''
    nextTick(() => {
      if (!angleEntry.value) return
      if (activeCameraObject) cameraEditorRef.value?.scrollIntoView({ block: 'start' })
      else addCameraButtonRef.value?.focus()
    })
    return
  }
  if (lightingEntry.value) {
    const firstLight = lightObjects.value[0]
    if (firstLight) selectSceneObject(firstLight.id)
    else selectEnvironmentInspector()
    nextTick(() => environmentEditorRef.value?.scrollIntoView({ block: 'start' }))
  }
}

function updateSelectedObject(patch) {
  if (!selectedObjectId.value) return
  if (selectedDirectorObject.value?.locked && patch.locked === undefined && patch.visible === undefined) return
  let next = updateDirectorObject(timeline.value, selectedObjectId.value, patch)
  const updated = next.objects.find((object) => object.id === selectedObjectId.value)
  if (patch.transform && timeline.value.sequence.autoKey && updated) next = upsertMotionKeyframe(next, selectedObjectId.value, currentTime.value, updated.transform)
  mutateTimeline(next)
  applyDirectorObjectToStage(next.objects.find((object) => object.id === selectedObjectId.value))
}

function toggleObjectVisibility(object) {
  if (!object) return
  selectedObjectId.value = object.id
  updateSelectedObject({ visible: !object.visible })
}

function toggleObjectLock(object) {
  if (!object) return
  selectedObjectId.value = object.id
  updateSelectedObject({ locked: !object.locked })
}

function updateObjectParent(parentId) {
  updateSelectedObject({ parentId: String(parentId || '') })
  buildStage()
}

function applyDirectorObjectToStage(entry) {
  const object = entry ? stageObjects.get(`custom:${entry.id}`) : null
  if (!object) return
  object.name = entry.name
  object.visible = entry.visible
  object.position.set(...entry.transform.position)
  object.rotation.set(...entry.transform.rotation)
  object.scale.set(...entry.transform.scale)
  if (entry.type === 'light' && entry.light) {
    object.color?.set?.(entry.light.color)
    object.intensity = entry.light.intensity
    object.castShadow = true
    if (object.shadow) object.shadow.radius = entry.light.type === 'soft' ? 4 : 0
  }
  rememberBaseTransform(object)
  viewer.value?.setDirty?.()
}

function updateObjectVector(field, index, value) {
  if (!selectedDirectorObject.value) return
  const vector = [...selectedInspectorTransform.value[field]]
  vector[index] = Number(value) || 0
  updateSelectedObject({ transform: { [field]: vector } })
}

function updateObjectRotation(index, value) {
  if (!selectedDirectorObject.value) return
  const vector = [...selectedInspectorTransform.value.rotation]
  vector[index] = (Number(value) || 0) * Math.PI / 180
  updateSelectedObject({ transform: { rotation: vector } })
}

function updateObjectScale(index, value, proportional = false) {
  const current = [...selectedInspectorTransform.value.scale]
  const nextValue = Math.max(0.0001, Number(value) || 0.0001)
  if (proportional) {
    const edited = [...current]
    edited[index] = nextValue
    updateSelectedObject({ transform: { scale: proportionalScaleFromAxis(current, edited) } })
  } else {
    current[index] = nextValue
    updateSelectedObject({ transform: { scale: current } })
  }
}

function radiansToDegrees(value) {
  return Number((Number(value || 0) * 180 / Math.PI).toFixed(2))
}

function deleteSelectedObject() {
  if (!selectedObjectId.value) return
  mutateTimeline(removeDirectorObject(timeline.value, selectedObjectId.value))
  selectedObjectId.value = ''
  buildStage()
}

function updateSelectedCamera(field, value) {
  if (!selectedCamera.value) return
  const normalized = ['fov', 'aspect', 'near', 'far'].includes(field) ? Number(value) : field === 'showGuides' ? Boolean(value) : String(value || '')
  const cameras = timeline.value.cameras.map((camera) => camera.id === selectedCamera.value.id ? { ...camera, [field]: normalized } : camera)
  mutateTimeline({ ...timeline.value, cameras })
  if (selectedShot.value?.cameraId === selectedCamera.value.id) setCameraForShot(selectedShot.value)
}

function persistSelectedCameraView(position, target, patch = {}) {
  if (!selectedCamera.value || !selectedDirectorObject.value || selectedDirectorObject.value.locked) return
  const cameraState = selectedCamera.value
  const objectId = selectedDirectorObject.value.id
  const { angles: patchAngles, ...cameraPatch } = patch
  const roll = Number(cameraPatch.roll ?? cameraState.roll) || 0
  const angles = {
    ...cameraAnglesFromPosition(position, target),
    ...(patchAngles || {}),
  }
  setCamera(position, target)
  const camera = viewer.value?.scene?.mainCamera
  if (camera) {
    camera.fov = Number(cameraPatch.fov ?? cameraState.fov) || 50
    camera.rotation.z = roll * Math.PI / 180
    camera.updateProjectionMatrix?.()
    camera.updateMatrixWorld?.()
  }
  const quaternion = camera ? [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w] : null
  let next = updateDirectorObject(timeline.value, objectId, {
    transform: {
      position,
      rotation: [selectedDirectorObject.value.transform.rotation[0], selectedDirectorObject.value.transform.rotation[1], roll * Math.PI / 180],
    },
  })
  next = {
    ...next,
    cameras: next.cameras.map((entry) => entry.id === cameraState.id ? {
      ...entry,
      ...cameraPatch,
      target: [...target],
      azimuth: angles.azimuth,
      elevation: angles.elevation,
      distance: angles.distance,
      roll,
      quaternion,
    } : entry),
  }
  const updated = next.objects.find((object) => object.id === objectId)
  if (timeline.value.sequence.autoKey && updated) next = upsertMotionKeyframe(next, objectId, currentTime.value, updated.transform)
  mutateTimeline(next)
  applyDirectorObjectToStage(updated)
  viewer.value?.setDirty?.()
}

function updateCameraAngle(field, value) {
  if (!selectedCamera.value) return
  const numeric = Number(value)
  const nextCamera = { ...selectedCamera.value, [field]: Number.isFinite(numeric) ? numeric : selectedCamera.value[field] }
  const position = cameraPositionFromAngles(selectedCamera.value.target, nextCamera.azimuth, nextCamera.elevation, nextCamera.distance)
  persistSelectedCameraView(position, selectedCamera.value.target, {
    angles: { azimuth: nextCamera.azimuth, elevation: nextCamera.elevation, distance: nextCamera.distance },
    roll: nextCamera.roll,
  })
}

function cameraAspectLabel(value) {
  const numeric = Number(value)
  return CAMERA_ASPECTS.find((ratio) => ratio.value && Math.abs(ratio.value - numeric) < 0.01)?.label || 'Auto'
}

function applyCameraAspect(label) {
  const ratio = CAMERA_ASPECTS.find((item) => item.label === label)
  if (!ratio || !selectedCamera.value) return
  const canvas = canvasRef.value
  const aspect = ratio.value || (canvas?.clientWidth && canvas?.clientHeight ? canvas.clientWidth / canvas.clientHeight : 16 / 9)
  updateSelectedCamera('aspect', aspect)
  const camera = viewer.value?.scene?.mainCamera
  if (camera) {
    camera.aspect = aspect
    camera.updateProjectionMatrix?.()
    viewer.value?.setDirty?.()
  }
}

function cycleCameraAspect() {
  if (!selectedCamera.value) {
    const activeCameraId = selectedShot.value?.cameraId
    const activeCamera = timeline.value.cameras.find((camera) => camera.id === activeCameraId) || timeline.value.cameras[0]
    if (activeCamera?.objectId) selectSceneObject(activeCamera.objectId)
  }
  if (!selectedCamera.value) return
  const current = cameraAspectLabel(selectedCamera.value.aspect)
  const index = CAMERA_ASPECTS.findIndex((ratio) => ratio.label === current)
  applyCameraAspect(CAMERA_ASPECTS[(index + 1) % CAMERA_ASPECTS.length].label)
}

function openAspectMenu() {
  labelsMenuOpen.value = false
  if (!selectedCamera.value) {
    const activeCamera = timeline.value.cameras.find((camera) => camera.id === timeline.value.sequence.activeCameraId)
      || timeline.value.cameras.find((camera) => camera.objectId)
    if (activeCamera?.objectId) selectSceneObject(activeCamera.objectId)
  }
  aspectMenuOpen.value = !aspectMenuOpen.value
}

function selectAspectRatio(label) {
  applyCameraAspect(label)
  aspectMenuOpen.value = false
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen?.()
    return
  }
  await dialogRef.value?.requestFullscreen?.()
}

async function confirmComposition() {
  if (!confirmCompositionArmed.value) {
    if (!selectedCamera.value) {
      const activeCamera = timeline.value.cameras.find((camera) => camera.id === timeline.value.sequence.activeCameraId)
        || timeline.value.cameras.find((camera) => camera.objectId)
      if (activeCamera?.objectId) selectSceneObject(activeCamera.objectId)
    }
    confirmCompositionArmed.value = true
    compositionConfirmMessage.value = '已锁定当前构图，再次点击将截图回写画布'
    return
  }
  confirmCompositionArmed.value = false
  compositionConfirmMessage.value = ''
  await captureToCanvasAsset()
}

function applyCameraPreset(name) {
  const preset = CAMERA_PRESETS.find((item) => item.name === name)
  if (!preset || !selectedCamera.value) return
  if (preset.current) {
    captureCurrentViewToCamera()
    return
  }
  const angles = cameraAnglesFromPosition(preset.position, preset.target)
  persistSelectedCameraView(preset.position, preset.target, {
    angles,
    fov: preset.fov,
    roll: Math.abs(Number(preset.roll) || 0) > Math.PI * 2 ? Number(preset.roll) : radiansToDegrees(preset.roll || 0),
    quaternion: null,
  })
}

async function applyEnvironment(environment = timeline.value.environment) {
  const currentViewer = viewer.value
  if (!currentViewer) return
  const requestId = ++environmentRequest
  currentViewer.scene?.setBackgroundColor?.(environment.backgroundColor || '#0f172a')
  if (ambientLight) ambientLight.intensity = Math.max(0, Number(environment.ambientIntensity) || 0)
  if (keyLight) keyLight.intensity = Math.max(0, Number(environment.directionalIntensity) || 0)
  try {
    if (environment.panoramaUrl) {
      await currentViewer.setBackgroundMap(environment.panoramaUrl, { setEnvironment: true })
    } else {
      await currentViewer.setBackgroundMap(null)
      currentViewer.scene?.setBackgroundColor?.(environment.backgroundColor || '#0f172a')
    }
    if (requestId === environmentRequest) errorMessage.value = ''
  } catch (error) {
    if (requestId === environmentRequest) errorMessage.value = error?.message || '全景环境加载失败'
  }
  currentViewer.setDirty?.()
}

function updateEnvironment(field, value) {
  const numeric = ['ambientIntensity', 'directionalIntensity', 'sceneScale', 'panoramaRotation', 'panoramaRadius', 'groundOpacity', 'groundHeight', 'labelFontSize'].includes(field)
  const boolean = ['showCharacterLabels', 'gridSnap', 'groundSnap', 'showGround', 'showObjectLabels', 'showBottomIds', 'showCameraGuides'].includes(field)
  mutateTimeline({
    ...timeline.value,
    environment: { ...timeline.value.environment, [field]: boolean ? Boolean(value) : numeric ? Number(value) || 0 : String(value || '') },
    revision: timeline.value.revision + 1,
  })
  applySceneEnvironment()
  void applyEnvironment()
}

function applyLightingPreset(preset) {
  let next = normalizeDirectorTimeline({
    ...timeline.value,
    objects: timeline.value.objects.filter((object) => object.type !== 'light'),
    environment: {
      ...timeline.value.environment,
      backgroundColor: preset.backgroundColor,
      ambientIntensity: preset.ambientIntensity,
      directionalIntensity: preset.directionalIntensity,
    },
    revision: timeline.value.revision + 1,
  }, characters.value)
  const presetLights = preset.lights.map((light) => ({
    ...light,
    position: cameraPositionFromAngles([0, 1, 0], light.azimuth, light.elevation, light.distance),
  }))
  for (const light of presetLights) {
    next = appendDirectorObject(next, 'light', {
      name: light.name,
      light,
      transform: { position: light.position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    })
  }
  selectedObjectId.value = next.objects.find((object) => object.type === 'light')?.id || ''
  mutateTimeline(next)
  buildStage()
  void applyEnvironment(next.environment)
  assetStatus.value = `已应用灯光预设：${preset.name}`
}

function updateSelectedLight(field, value) {
  if (!selectedLightObject.value) return
  const numericFields = new Set(['intensity', 'azimuth', 'elevation', 'distance'])
  const light = {
    ...selectedLightObject.value.light,
    [field]: numericFields.has(field) ? Number(value) : String(value || ''),
  }
  const position = cameraPositionFromAngles([0, 1, 0], light.azimuth, light.elevation, light.distance)
  updateSelectedObject({ light, transform: { position } })
}

function updateEnvironmentVector(field, index, value) {
  const vector = [...timeline.value.environment[field]]
  vector[index] = Number(value) || 0
  mutateTimeline({ ...timeline.value, environment: { ...timeline.value.environment, [field]: vector } })
  applySceneEnvironment()
}

function updateEnvironmentRotation(index, value) {
  const vector = [...timeline.value.environment.sceneRotation]
  vector[index] = (Number(value) || 0) * Math.PI / 180
  mutateTimeline({ ...timeline.value, environment: { ...timeline.value.environment, sceneRotation: vector } })
  applySceneEnvironment()
}

function applySceneEnvironment() {
  const environment = timeline.value.environment
  if (stageRoot) {
    stageRoot.position.set(...environment.scenePosition)
    stageRoot.rotation.set(...environment.sceneRotation)
    stageRoot.scale.setScalar(environment.sceneScale)
  }
  if (groundGrid) {
    groundGrid.visible = environment.showGround
    groundGrid.position.y = environment.groundHeight
    if (groundGrid.material) {
      groundGrid.material.transparent = environment.groundOpacity < 1
      groundGrid.material.opacity = environment.groundOpacity
    }
  }
  viewer.value?.setDirty?.()
}

function captureCurrentViewToCamera() {
  const camera = viewer.value?.scene?.mainCamera
  if (!camera || !selectedDirectorObject.value || !selectedCamera.value || selectedDirectorObject.value.locked) return
  const position = [camera.position.x, camera.position.y, camera.position.z]
  const target = camera.target ? [camera.target.x, camera.target.y, camera.target.z] : [0, 0.8, 0]
  persistSelectedCameraView(position, target, {
    fov: camera.fov,
    roll: radiansToDegrees(camera.rotation.z),
  })
  assetStatus.value = '已从当前导演视角更新机位位置与方向'
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

function moveSelectedShot(direction) {
  if (!selectedShot.value) return
  const index = shots.value.findIndex((shot) => shot.id === selectedShot.value.id)
  const target = index + direction
  if (index < 0 || target < 0 || target >= shots.value.length) return
  const ordered = [...shots.value]
  ;[ordered[index], ordered[target]] = [ordered[target], ordered[index]]
  mutateTimeline(normalizeDirectorTimeline({ ...timeline.value, shots: ordered }, characters.value))
}

function splitSelectedShot() {
  if (!selectedShot.value || !canSplitSelectedShot.value) return
  const shotIndex = shots.value.findIndex((shot) => shot.id === selectedShot.value.id)
  const next = splitShotAtTime(timeline.value, selectedShot.value.id, currentTime.value)
  selectedShotId.value = next.shots[shotIndex + 1].id
  mutateTimeline(next)
}

function updateSelectedShot(field, value) {
  if (!selectedShot.value) return
  const shotsNext = shots.value.map((shot) => shot.id === selectedShot.value.id ? { ...shot, [field]: field === 'name' || field === 'camera' || field === 'cameraId' || field === 'transition' || field === 'sceneId' ? value : Number(value) } : shot)
  mutateTimeline({ ...timeline.value, shots: shotsNext })
}

function addActionClip() {
  if (!selectedCharacterId.value) return
  const next = appendActionClip(timeline.value, selectedCharacterId.value, actionToAdd.value, { start: currentTime.value })
  selectedActionClipId.value = next.tracks.find((track) => track.characterId === selectedCharacterId.value)?.clips.at(-1)?.id || ''
  mutateTimeline(next)
}

function selectActionClip(track, clip) {
  if (!track || !clip) return
  selectedCharacterId.value = track.characterId
  selectedActionClipId.value = clip.id
  actionToAdd.value = clip.action
  setCurrentTime(clip.start)
}

function updateSelectedActionClip(field, value) {
  if (!selectedActionClip.value) return
  const normalized = field === 'action' ? String(value || '') : Number(value)
  mutateTimeline(updateActionClip(timeline.value, selectedActionClip.value.id, { [field]: normalized }))
  if (field === 'action') actionToAdd.value = normalized
}

function removeSelectedActionClip() {
  if (!selectedActionClip.value) return
  mutateTimeline(removeActionClip(timeline.value, selectedActionClip.value.id))
  selectedActionClipId.value = ''
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
  const elapsed = Math.max(0, (now - lastFrameTime) / 1000) * timeline.value.sequence.playbackRate
  lastFrameTime = now
  const next = currentTime.value + elapsed
  if (timeline.value.sequence.shotLoop && activeShot.value) {
    const shotEnd = activeShot.value.start + activeShot.value.duration
    if (next >= shotEnd) {
      setCurrentTime(activeShot.value.start + ((next - activeShot.value.start) % activeShot.value.duration))
      animationFrame = requestAnimationFrame(playFrame)
      return
    }
  }
  if (next >= duration.value && !timeline.value.sequence.loop) {
    setCurrentTime(duration.value)
    stopPlayback()
    return
  }
  setCurrentTime(next >= duration.value ? next % duration.value : next)
  animationFrame = requestAnimationFrame(playFrame)
}

function toggleLoopPlayback() {
  mutateTimeline({ ...timeline.value, sequence: { ...timeline.value.sequence, loop: !timeline.value.sequence.loop } })
}

function toggleSequenceOption(field) {
  mutateTimeline({ ...timeline.value, sequence: { ...timeline.value.sequence, [field]: !timeline.value.sequence[field] } })
}

function setTimelineZoom(value) {
  mutateTimeline({ ...timeline.value, sequence: { ...timeline.value.sequence, timelineZoom: Math.max(0.5, Math.min(4, Number(value) || 1)) } })
}

function toggleTimelineCollapsed() {
  mutateTimeline({ ...timeline.value, sequence: { ...timeline.value.sequence, timelineCollapsed: !timeline.value.sequence.timelineCollapsed } })
}

function setTransformMode(mode) {
  if (!TRANSFORM_TOOLS.some((tool) => tool.mode === mode)) return
  transformMode.value = mode
  if (transformControls) transformControls.mode = mode
}

function toggleTransformSpace() {
  transformSpace.value = transformSpace.value === 'world' ? 'local' : 'world'
  if (transformControls) transformControls.space = transformSpace.value
}

function directorObjectIdForStageObject(object) {
  let current = object
  while (current) {
    for (const [key, stageObject] of stageObjects) if (stageObject === current && key.startsWith('custom:')) return key.slice(7)
    current = current.parent
  }
  return ''
}

function directorStageObjectForSelection(object) {
  const objectId = directorObjectIdForStageObject(object)
  if (!objectId || timeline.value.objects.find((entry) => entry.id === objectId)?.locked) return null
  return stageObjects.get(`custom:${objectId}`) || null
}

function restoreTransformSelection() {
  const object = stageObjects.get(`custom:${selectedObjectId.value}`)
  if (!object || selectedDirectorObject.value?.locked) return
  pickingPlugin?.setSelectedObject?.(object, false)
}

function syncTransformSelection(event) {
  const pickedObject = event?.object || event?.value
  const objectId = directorObjectIdForStageObject(pickedObject)
  if (!objectId) return
  selectedObjectId.value = objectId
  const rootObject = directorStageObjectForSelection(pickedObject)
  if (rootObject && rootObject !== pickedObject) nextTick(restoreTransformSelection)
}

function rememberTransformControlStart() {
  transformStartScale = directorStageObjectForSelection(transformControls?.object)?.scale?.toArray?.() || null
}

function persistTransformControlChange() {
  const object = directorStageObjectForSelection(transformControls?.object)
  const objectId = directorObjectIdForStageObject(object)
  if (!objectId) return
  if (transformMode.value === 'scale' && shiftPressed && transformStartScale) {
    object.scale.set(...proportionalScaleFromAxis(transformStartScale, object.scale.toArray()))
  }
  selectedObjectId.value = objectId
  const transform = { position: object.position.toArray(), rotation: [object.rotation.x, object.rotation.y, object.rotation.z], scale: object.scale.toArray() }
  const entry = timeline.value.objects.find((item) => item.id === objectId)
  const light = entry?.type === 'light'
    ? { ...entry.light, ...cameraAnglesFromPosition(transform.position, [0, 1, 0]) }
    : null
  updateSelectedObject({ transform, ...(light ? { light } : {}) })
  transformStartScale = null
}

function addCurrentMotionKeyframe() {
  if (!selectedDirectorObject.value) return
  const objectId = selectedDirectorObject.value.id
  const next = upsertMotionKeyframe(timeline.value, objectId, currentTime.value, selectedDirectorObject.value.transform)
  const track = next.motionTracks.find((entry) => entry.objectId === objectId)
  const keyframe = track?.keyframes.find((entry) => Math.abs(entry.time - currentTime.value) < 0.001)
  selectedMotionTrackId.value = track?.id || ''
  selectedMotionKeyframeId.value = keyframe?.id || ''
  mutateTimeline(next)
}

function newMotionTrack() {
  if (!selectedDirectorObject.value) {
    assetStatus.value = '请先选择要创建轨道的对象'
    return
  }
  const existing = timeline.value.motionTracks.find((track) => track.objectId === selectedDirectorObject.value.id)
  if (existing) {
    selectedMotionTrackId.value = existing.id
    assetStatus.value = '该对象已有运动轨道'
    return
  }
  const track = {
    id: `motion-${selectedDirectorObject.value.id}-${Date.now()}`,
    objectId: selectedDirectorObject.value.id,
    keyframes: [],
  }
  selectedMotionTrackId.value = track.id
  mutateTimeline({ ...timeline.value, motionTracks: [...timeline.value.motionTracks, track] })
  assetStatus.value = `已新建轨道：${selectedDirectorObject.value.name}`
}

function deleteSelectedMotionTrack() {
  if (!selectedMotionTrack.value) return
  const targetId = selectedMotionTrack.value.id
  mutateTimeline({ ...timeline.value, motionTracks: timeline.value.motionTracks.filter((track) => track.id !== targetId) })
  selectedMotionTrackId.value = ''
  selectedMotionKeyframeId.value = ''
  keyframePanelOpen.value = false
}

function selectAnimationCamera(cameraId) {
  const camera = timeline.value.cameras.find((entry) => entry.id === String(cameraId || ''))
  if (!camera) return
  updateSequenceValue('activeCameraId', camera.id)
  if (camera.objectId) selectSceneObject(camera.objectId)
  viewMode.value = 'camera'
  setCameraForShot({ ...selectedShot.value, cameraId: camera.id })
}

function toggleAnimationViewMode() {
  const next = timeline.value.sequence.animationViewMode === 'observer' ? 'follow' : 'observer'
  updateSequenceValue('animationViewMode', next)
  if (next === 'follow') setView('camera')
  else setView('director')
}

function updateSequenceValue(field, value) {
  mutateTimeline({ ...timeline.value, sequence: { ...timeline.value.sequence, [field]: value } })
}

function addPersonFrame() {
  if (!isSelectedCharacterObject.value) return
  addCurrentMotionKeyframe()
  assetStatus.value = `已添加人物帧：${selectedDirectorObject.value.name}`
}

function updateTimelineDuration(value) {
  const targetDuration = Math.max(MIN_SHOT_DURATION, Number(value) || duration.value)
  if (!timeline.value.shots.length) return
  const previousDuration = timeline.value.shots.slice(0, -1).reduce((total, shot) => total + shot.duration, 0)
  const lastDuration = Math.max(MIN_SHOT_DURATION, targetDuration - previousDuration)
  const shots = timeline.value.shots.map((shot, index) => index === timeline.value.shots.length - 1 ? { ...shot, duration: lastDuration } : shot)
  mutateTimeline({ ...timeline.value, shots })
}

function selectMotionKeyframe(track, keyframe) {
  selectedObjectId.value = track.objectId
  selectedMotionTrackId.value = track.id
  selectedMotionKeyframeId.value = keyframe.id
  keyframePanelOpen.value = true
  setCurrentTime(keyframe.time)
}

function updateSelectedMotionKeyframe(field, value) {
  if (!selectedMotionTrack.value || !selectedMotionKeyframe.value) return
  const keyframeId = selectedMotionKeyframe.value.id
  const motionTracks = timeline.value.motionTracks.map((track) => track.id === selectedMotionTrack.value.id ? {
    ...track,
    keyframes: track.keyframes
      .map((keyframe) => keyframe.id === keyframeId ? { ...keyframe, [field]: value } : keyframe)
      .sort((left, right) => left.time - right.time),
  } : track)
  mutateTimeline({ ...timeline.value, motionTracks })
}

function applyKeyframeSpeedPreset(preset) {
  if (!preset) return
  const current = selectedMotionKeyframe.value
  if (!current) return
  const keyframeId = current.id
  const motionTracks = timeline.value.motionTracks.map((track) => track.id === selectedMotionTrack.value?.id ? {
    ...track,
    keyframes: track.keyframes.map((keyframe) => keyframe.id === keyframeId ? {
      ...keyframe,
      easing: preset.easing,
      speedPreset: preset.name,
    } : keyframe),
  } : track)
  mutateTimeline({ ...timeline.value, motionTracks })
}

function resetSelectedMotionKeyframe() {
  if (!selectedMotionKeyframe.value) return
  const keyframeId = selectedMotionKeyframe.value.id
  const motionTracks = timeline.value.motionTracks.map((track) => track.id === selectedMotionTrack.value?.id ? {
    ...track,
    keyframes: track.keyframes.map((keyframe) => keyframe.id === keyframeId ? {
      ...keyframe,
      easing: 'linear',
      speedPreset: '无',
      pathMode: 'curve',
      roll: 0,
    } : keyframe),
  } : track)
  mutateTimeline({ ...timeline.value, motionTracks })
}

function applyCurrentViewToKeyframe() {
  if (!selectedMotionKeyframe.value || !selectedMotionTrack.value) return
  const object = timeline.value.objects.find((entry) => entry.id === selectedMotionTrack.value.objectId)
  if (!object) return
  let transform = object.transform
  if (object.type === 'camera') {
    const camera = viewer.value?.scene?.mainCamera
    if (camera) transform = {
      ...transform,
      position: cameraVector(camera.position, transform.position),
      rotation: [...transform.rotation],
    }
  }
  const keyframeId = selectedMotionKeyframe.value.id
  const motionTracks = timeline.value.motionTracks.map((track) => track.id === selectedMotionTrack.value.id ? {
    ...track,
    keyframes: track.keyframes.map((keyframe) => keyframe.id === keyframeId ? {
      ...keyframe,
      position: [...transform.position],
      rotation: [...transform.rotation],
      scale: [...transform.scale],
    } : keyframe),
  } : track)
  mutateTimeline({ ...timeline.value, motionTracks })
}

function deleteSelectedMotionKeyframe() {
  if (!selectedMotionKeyframe.value || !selectedMotionTrack.value) return
  const keyframeId = selectedMotionKeyframe.value.id
  const motionTracks = timeline.value.motionTracks.map((track) => track.id === selectedMotionTrack.value.id ? {
    ...track,
    keyframes: track.keyframes.filter((keyframe) => keyframe.id !== keyframeId),
  } : track)
  mutateTimeline({ ...timeline.value, motionTracks })
  selectedMotionKeyframeId.value = ''
  keyframePanelOpen.value = false
}

function objectName(objectId) {
  return timeline.value.objects.find((object) => object.id === objectId)?.name || '运动轨道'
}

function keyframeStyle(keyframe) {
  return { left: `${Math.max(0, Math.min(100, keyframe.time / duration.value * 100))}%` }
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
  const recordingCanvas = document.createElement('canvas')
  recordingCanvas.width = canvasRef.value.width
  recordingCanvas.height = canvasRef.value.height
  const recordingContext = recordingCanvas.getContext('2d', { alpha: false })
  if (!recordingContext) throw new Error('无法创建视频录制画布')
  const copyViewportFrame = () => {
    try {
      recordingContext.drawImage(canvasRef.value, 0, 0, recordingCanvas.width, recordingCanvas.height)
    } catch (error) {
      throw new Error(`视频录制失败，可能存在未允许跨域读取的纹理：${error?.message || '画布不可读取'}`)
    }
  }
  copyViewportFrame()
  const stream = recordingCanvas.captureStream(timeline.value.sequence.fps)
  const videoTrack = stream.getVideoTracks?.()[0]
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
      videoTrack?.requestFrame?.()
      const tick = (now) => {
        if (exportCancelled.value) {
          if (recorder.state !== 'inactive') recorder.stop()
          return
        }
        const elapsed = Math.max(0, (now - startedAt) / 1000)
        if (elapsed >= total) {
          setCurrentTime(total)
          exportProgress.value = 100
          viewer.value?.setDirty?.()
          copyViewportFrame()
          videoTrack?.requestFrame?.()
          setTimeout(() => {
            if (recorder.state !== 'inactive') {
              recorder.requestData?.()
              recorder.stop()
            }
          }, 100)
          return
        }
        setCurrentTime(elapsed)
        viewer.value?.setDirty?.()
        copyViewportFrame()
        videoTrack?.requestFrame?.()
        exportProgress.value = Math.min(99, Math.round(elapsed / total * 100))
        exportFrame = requestAnimationFrame(tick)
      }
      exportFrame = requestAnimationFrame(tick)
    })
    if (exportCancelled.value) throw new Error('已取消视频导出')
    const blob = new Blob(chunks, { type: mimeType })
    if (blob.size < 1024) throw new Error('WebM 录制未产生有效视频帧')
    return blob
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
  exportCancelled.value = false
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
  exportCancelled.value = false
  exportProgress.value = 0
  try {
    const blob = await recordTimelineBlob()
    assetStatus.value = '正在提交服务端转码…'
    const created = await directorExportAPI.create(props.drama.id, blob, timeline.value)
    if (!created?.task_id) throw new Error('服务端未返回导出任务')
    activeExportTaskId.value = created.task_id
    const task = await waitForDirectorExportTask({
      getTask: async (taskId) => {
        const next = await taskAPI.get(taskId)
        exportProgress.value = Math.max(1, Math.min(99, Number(next?.progress) || 1))
        return next
      },
      taskId: created.task_id,
      maxAttempts: Math.max(1, Math.min(180, Number(created.poll_max_attempts) || 180)),
      isCancelled: () => exportCancelled.value,
    })
    const result = parseDirectorExportResult(task.result)
    const url = directorExportDownloadUrl(result)
    if (!url) throw new Error('导出任务完成但没有下载地址')
    const response = await fetch(url)
    if (!response.ok) throw new Error(`导出视频下载失败（${response.status}）`)
    const contentType = String(response.headers.get('content-type') || '')
    if (!contentType.startsWith('video/') && contentType !== 'application/octet-stream') {
      throw new Error(`导出视频响应类型错误：${contentType || 'unknown'}`)
    }
    const downloadUrl = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = directorExportFilename(props.drama?.title, 'mp4')
    link.click()
    setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000)
    assetStatus.value = '视频已导出（MP4）'
    exportProgress.value = 100
  } catch (error) {
    assetStatus.value = error?.message || '服务端导出失败'
  } finally {
    exporting.value = false
    activeExportTaskId.value = ''
    exportProgress.value = 0
  }
}

async function cancelExport() {
  exportCancelled.value = true
  if (activeExportTaskId.value) await taskAPI.cancel(activeExportTaskId.value, { reason: '用户取消导演台导出' }).catch(() => {})
  assetStatus.value = '已取消视频导出'
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

function makeHumanoidObject(kind, customColor = '') {
  const role = ROLE_ARCHETYPES.find((item) => item.kind === kind) || ROLE_ARCHETYPES[0]
  const group = new Group()
  const isChibi = role.kind === 'chibi'
  const headRadius = isChibi ? role.height * 0.24 : role.height * 0.11
  const torsoHeight = role.height * (isChibi ? 0.3 : 0.32)
  const legHeight = role.height * (isChibi ? 0.22 : 0.47)
  const armHeight = role.height * (isChibi ? 0.26 : 0.34)
  const limbRadius = Math.max(0.045, role.width * 0.105)
  const halfArm = armHeight / 2
  const halfLeg = legHeight / 2
  const surface = /^#[0-9a-f]{6}$/i.test(customColor) ? Number.parseInt(customColor.slice(1), 16) : role.color
  const makeEllipsoid = (radius, scale, color = surface) => {
    const mesh = makeObject('sphere', { radius, widthSegments: 24, heightSegments: 16 }, color)
    mesh?.scale.set(...scale)
    return mesh
  }
  const makeTapered = (height, top, bottom, depthScale = 1, color = surface) => {
    const mesh = makeObject('cylinder', { radiusTop: top, radiusBottom: bottom, height, radialSegments: 20, heightSegments: 2 }, color)
    if (mesh) mesh.scale.z = depthScale
    return mesh
  }
  const chest = makeEllipsoid(role.width * 0.39, [1, torsoHeight * 0.72 / (role.width * 0.78), 0.62])
  const abdomen = makeEllipsoid(role.width * 0.25, [1, 1.28, 0.65])
  const pelvis = makeEllipsoid(role.width * 0.29, [1, 0.78, 0.72])
  const neck = makeTapered(headRadius * 0.72, headRadius * 0.42, headRadius * 0.48, 0.92)
  const head = makeEllipsoid(headRadius, [0.82, 1.08, 0.9])
  const jaw = makeEllipsoid(headRadius * 0.72, [0.78, 0.7, 0.8])
  const nose = makeEllipsoid(headRadius * 0.15, [0.65, 0.9, 1.35])
  const upperArms = [makeTapered(halfArm, limbRadius * 1.2, limbRadius, 0.94), makeTapered(halfArm, limbRadius * 1.2, limbRadius, 0.94)]
  const lowerArms = [makeTapered(halfArm, limbRadius, limbRadius * 0.72, 0.92), makeTapered(halfArm, limbRadius, limbRadius * 0.72, 0.92)]
  const upperLegRadius = limbRadius * 1.55
  const lowerLegRadius = limbRadius * 1.2
  const upperLegs = [makeTapered(halfLeg, upperLegRadius, upperLegRadius * 0.78, 1.08), makeTapered(halfLeg, upperLegRadius, upperLegRadius * 0.78, 1.08)]
  const lowerLegs = [makeTapered(halfLeg, lowerLegRadius, lowerLegRadius * 0.72, 1.02), makeTapered(halfLeg, lowerLegRadius, lowerLegRadius * 0.72, 1.02)]
  const shoulderCaps = [makeEllipsoid(limbRadius * 1.34, [1, 1, 1]), makeEllipsoid(limbRadius * 1.34, [1, 1, 1])]
  const elbowCaps = [makeEllipsoid(limbRadius, [1, 1, 1]), makeEllipsoid(limbRadius, [1, 1, 1])]
  const kneeCaps = [makeEllipsoid(lowerLegRadius, [1, 0.86, 1]), makeEllipsoid(lowerLegRadius, [1, 0.86, 1])]
  const hands = [new Group(), new Group()]
  const palms = [makeEllipsoid(limbRadius * 0.92, [0.78, 1.15, 0.48]), makeEllipsoid(limbRadius * 0.92, [0.78, 1.15, 0.48])]
  const fingers = hands.map((hand, side) => Array.from({ length: 5 }, (_, index) => {
    const finger = makeTapered(limbRadius * (index === 0 ? 1.05 : 1.28 - Math.abs(index - 2) * 0.08), limbRadius * 0.18, limbRadius * 0.13, 0.88)
    finger.position.set((index - 2) * limbRadius * 0.28, -limbRadius * 1.5, index === 0 ? limbRadius * 0.12 : 0)
    finger.rotation.z = index === 0 ? (side ? -0.52 : 0.52) : (index - 2) * 0.025
    hand.add(finger)
    return finger
  }))
  hands.forEach((hand, index) => hand.add(palms[index]))
  const feet = [makeEllipsoid(lowerLegRadius, [0.92, 0.58, 1.65]), makeEllipsoid(lowerLegRadius, [0.92, 0.58, 1.65])]
  const meshes = [chest, abdomen, pelvis, neck, head, jaw, nose, ...upperArms, ...lowerArms, ...upperLegs, ...lowerLegs, ...shoulderCaps, ...elbowCaps, ...kneeCaps, ...palms, ...fingers.flat(), ...feet]
  if (!meshes.every(Boolean)) return null

  const root = new Group(); const spine = new Group(); const headPivot = new Group()
  const leftShoulder = new Group(); const rightShoulder = new Group(); const leftElbow = new Group(); const rightElbow = new Group()
  const leftHip = new Group(); const rightHip = new Group(); const leftKnee = new Group(); const rightKnee = new Group()
  const poseBones = {
    root, spine, head: headPivot,
    leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist: hands[0], rightWrist: hands[1],
    leftHip, rightHip, leftKnee, rightKnee, leftAnkle: feet[0], rightAnkle: feet[1],
  }

  spine.position.set(0, legHeight, 0)
  pelvis.position.set(0, torsoHeight * 0.08, 0)
  abdomen.position.set(0, torsoHeight * 0.34, 0)
  chest.position.set(0, torsoHeight * 0.7, 0)
  headPivot.position.set(0, legHeight + torsoHeight, 0)
  neck.position.set(0, headRadius * 0.2, 0)
  head.position.set(0, headRadius * 1.2, 0)
  jaw.position.set(0, headRadius * 0.9, headRadius * 0.16)
  nose.position.set(0, headRadius * 1.28, headRadius * 0.84)
  const shoulderY = legHeight + torsoHeight * 0.77
  leftShoulder.position.set(-role.width / 2, shoulderY, 0)
  rightShoulder.position.set(role.width / 2, shoulderY, 0)
  shoulderCaps[0].position.set(0, 0, 0); shoulderCaps[1].position.set(0, 0, 0)
  upperArms[0].position.set(0, -halfArm / 2, 0); upperArms[1].position.set(0, -halfArm / 2, 0)
  leftElbow.position.set(0, -halfArm, 0); rightElbow.position.set(0, -halfArm, 0)
  elbowCaps[0].position.set(0, 0, 0); elbowCaps[1].position.set(0, 0, 0)
  lowerArms[0].position.set(0, -halfArm / 2, 0); lowerArms[1].position.set(0, -halfArm / 2, 0)
  hands[0].position.set(0, -halfArm - limbRadius * 0.75, limbRadius * 0.16); hands[1].position.set(0, -halfArm - limbRadius * 0.75, limbRadius * 0.16)
  leftHip.position.set(-role.width * 0.18, legHeight, 0)
  rightHip.position.set(role.width * 0.18, legHeight, 0)
  upperLegs[0].position.set(0, -halfLeg / 2, 0); upperLegs[1].position.set(0, -halfLeg / 2, 0)
  leftKnee.position.set(0, -halfLeg, 0); rightKnee.position.set(0, -halfLeg, 0)
  kneeCaps[0].position.set(0, 0, lowerLegRadius * 0.12); kneeCaps[1].position.set(0, 0, lowerLegRadius * 0.12)
  lowerLegs[0].position.set(0, -halfLeg / 2, 0); lowerLegs[1].position.set(0, -halfLeg / 2, 0)
  feet[0].position.set(0, -halfLeg - lowerLegRadius * 0.25, lowerLegRadius * 0.68); feet[1].position.set(0, -halfLeg - lowerLegRadius * 0.25, lowerLegRadius * 0.68)

  spine.add(pelvis, abdomen, chest); headPivot.add(neck, head, jaw, nose)
  leftElbow.add(elbowCaps[0], lowerArms[0], hands[0]); rightElbow.add(elbowCaps[1], lowerArms[1], hands[1])
  leftShoulder.add(shoulderCaps[0], upperArms[0], leftElbow); rightShoulder.add(shoulderCaps[1], upperArms[1], rightElbow)
  leftKnee.add(kneeCaps[0], lowerLegs[0], feet[0]); rightKnee.add(kneeCaps[1], lowerLegs[1], feet[1])
  leftHip.add(upperLegs[0], leftKnee); rightHip.add(upperLegs[1], rightKnee)
  root.add(spine, headPivot, leftShoulder, rightShoulder, leftHip, rightHip)
  const rigControls = Object.values(poseBones).map((bone) => {
    const marker = makeObject('sphere', { radius: Math.max(0.018, role.height * 0.012), widthSegments: 14, heightSegments: 10 }, 0x72e7f2)
    if (marker?.material) {
      marker.material.emissive?.set?.(0x285a63)
      marker.material.depthTest = false
      marker.material.depthWrite = false
    }
    if (marker) { marker.visible = false; marker.renderOrder = 100; bone.add(marker) }
    return marker
  }).filter(Boolean)
  group.add(root)
  group.userData = { ...(group.userData || {}), poseBones, rigControls }
  return group
}

function addObject(key, object) {
  if (!object || !viewer.value) return
  object.userData = { ...(object.userData || {}), directorKey: key }
  viewer.value.scene.addObject(object, { addToRoot: true })
  stageObjects.set(key, object)
}

function clearStageObjects() {
  stageBuildToken += 1
  transformControls?.detach?.()
  for (const object of stageObjects.values()) {
    object.parent?.remove?.(object)
    object.dispose?.()
  }
  stageObjects.clear()
  characterObjects.clear()
  characterModels.clear()
  characterPlaceholders.clear()
  proceduralCharacterIds.value = new Set()
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

  propsList.value.forEach((prop, index) => {
    const object = makeObject('box', { width: 0.55, height: 0.55, depth: 0.55 }, 0xfbbf24)
    if (!object) return
    object.position.set((index - (propsList.value.length - 1) / 2) * 1.2, 0.28, -1.35)
    object.name = prop.name || `道具 ${index + 1}`
    rememberBaseTransform(object)
    root.add(object)
    stageObjects.set(`prop:${prop.id || index}`, object)
  })

  timeline.value.objects.forEach((entry) => {
    if (entry.type === 'group') {
      const group = new Group()
      group.name = entry.name
      group.visible = entry.visible
      group.position.set(...entry.transform.position)
      group.rotation.set(...entry.transform.rotation)
      group.scale.set(...entry.transform.scale)
      rememberBaseTransform(group)
      stageObjects.set(`custom:${entry.id}`, group)
      return
    }
    if (entry.type === 'light') {
      const light = new DirectionalLight(entry.light.color, entry.light.intensity)
      light.name = entry.name
      light.visible = entry.visible
      light.castShadow = true
      light.shadow.radius = entry.light.type === 'soft' ? 4 : 0
      light.position.set(...entry.transform.position)
      light.rotation.set(...entry.transform.rotation)
      light.scale.set(...entry.transform.scale)
      rememberBaseTransform(light)
      stageObjects.set(`custom:${entry.id}`, light)
      return
    }
    if (entry.type === 'humanoid' || entry.type === 'character') {
      const humanoid = makeHumanoidObject(entry.assetRef?.kind, entry.assetRef?.color)
      if (!humanoid) return
      const characterId = String(entry.assetRef?.characterId || entry.id)
      humanoid.name = entry.name
      humanoid.visible = entry.visible
      humanoid.position.set(...entry.transform.position)
      humanoid.rotation.set(...entry.transform.rotation)
      humanoid.scale.set(...entry.transform.scale)
      rememberBaseTransform(humanoid)
      stageObjects.set(`custom:${entry.id}`, humanoid)
      for (const [semantic, rotation] of Object.entries(entry.poseRotations || {})) humanoid.userData.poseBones?.[semantic]?.rotation?.set?.(...rotation)
      if (entry.type === 'character' && entry.assetRef?.characterId) {
        characterObjects.set(entry.assetRef.characterId, humanoid)
      } else {
        characterObjects.set(characterId, humanoid)
      }
      characterPlaceholders.set(characterId, [humanoid])
      proceduralCharacterIds.value = new Set([...proceduralCharacterIds.value, characterId])
      return
    }
    const type = entry.type === 'sphere' ? 'sphere' : 'box'
    const params = type === 'sphere'
      ? { radius: 0.5, widthSegments: 20, heightSegments: 14 }
      : { width: entry.type === 'camera' ? 0.5 : 1, height: entry.type === 'camera' ? 0.32 : 1, depth: entry.type === 'camera' ? 0.7 : 1 }
    const object = makeObject(type, params, entry.type === 'camera' ? 0x38bdf8 : 0xa78bfa)
    if (!object) return
    object.name = entry.name
    object.visible = entry.visible
    object.position.set(...entry.transform.position)
    object.rotation.set(...entry.transform.rotation)
    object.scale.set(...entry.transform.scale)
    rememberBaseTransform(object)
    stageObjects.set(`custom:${entry.id}`, object)
  })

  timeline.value.objects.forEach((entry) => {
    const object = stageObjects.get(`custom:${entry.id}`)
    if (!object) return
    const parent = entry.parentId ? stageObjects.get(`custom:${entry.parentId}`) : null
    ;(parent || root).add(object)
  })

  for (const entry of timeline.value.objects) {
    if (entry.type !== 'character' && entry.type !== 'humanoid') continue
    const characterId = String(entry.assetRef?.characterId || entry.id)
    if (timeline.value.characterAssets?.[characterId]?.modelUrl) void loadCharacterModel(characterId, buildToken)
  }

  viewer.value.setDirty?.()
  applySceneEnvironment()
  applyTimelineFrame()
  restoreTransformSelection()
}

function setCamera(position, target = [0, 0.8, 0], quaternion = null) {
  const camera = viewer.value?.scene?.mainCamera
  if (!camera) return
  camera.position.set(...position)
  camera.target?.set?.(...target)
  if (Array.isArray(quaternion) && quaternion.length === 4) camera.quaternion.set(...quaternion)
  else camera.lookAt?.(...target)
  camera.setDirty?.()
}

function setCameraForShot(shot) {
  if (!shot) return
  const boundCamera = timeline.value.cameras.find((camera) => camera.id === shot.cameraId)
  const cameraObject = boundCamera && timeline.value.objects.find((object) => object.id === boundCamera.objectId)
  if (boundCamera && cameraObject) {
    const camera = viewer.value?.scene?.mainCamera
    if (camera) {
      camera.fov = Number(boundCamera.fov) || 50
      camera.aspect = Number(boundCamera.aspect) || camera.aspect
      camera.updateProjectionMatrix?.()
    }
    const followObject = timeline.value.objects.find((object) => object.id === boundCamera.followTargetId)
    const lookAtObject = boundCamera.lookAtMode === 'object' ? timeline.value.objects.find((object) => object.id === boundCamera.lookAtTargetId) : null
    const follow = followObject?.transform?.position || [0, 0, 0]
    const position = cameraObject.transform.position.map((value, index) => value + follow[index])
    const target = lookAtObject?.transform?.position || boundCamera.target || [0, 0.8, 0]
    setCamera(position, target, lookAtObject ? null : boundCamera.quaternion)
    if (camera && (lookAtObject || !boundCamera.quaternion)) camera.rotation.z = Number(boundCamera.roll || 0) * Math.PI / 180
    return
  }
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
  proceduralCharacterIds.value = new Set([...proceduralCharacterIds.value].filter((id) => id !== String(characterId)))
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
    const gltf = await loadDirectorGltf(loader, url)
    if (disposed || expectedBuildToken !== stageBuildToken || !stageRoot) return
    const model = gltf.scene
    const animations = Array.isArray(gltf.animations) ? gltf.animations : []
    let visibleMeshCount = 0
    const directorObject = timeline.value.objects.find((entry) => (
      (entry.type === 'character' || entry.type === 'humanoid')
      && String(entry.assetRef?.characterId || entry.id) === normalizedId
    ))
    model.position.set(...(directorObject?.transform.position || [0, 0, 0]))
    model.rotation.set(...(directorObject?.transform.rotation || [0, 0, 0]))
    const objectScale = directorObject?.transform.scale || [1, 1, 1]
    const assetScale = Math.max(0.01, Number(asset.scale) || 1)
    model.scale.set(objectScale[0] * assetScale, objectScale[1] * assetScale, objectScale[2] * assetScale)
    model.name = characterName(normalizedId)
    model.userData = { ...(model.userData || {}), directorKey: `custom:${directorObject?.id || `project-character:${normalizedId}`}` }
    model.traverse?.((child) => {
      child.castShadow = true
      child.receiveShadow = true
      if (child?.isMesh && child.visible !== false) visibleMeshCount += 1
    })
    if (!visibleMeshCount) throw new Error('角色模型不含可见网格')
    const bones = new Map()
    let boneCount = 0
    model.traverse?.((child) => {
      if (!child?.isBone) return
      boneCount += 1
      if (child.name) bones.set(child.name, child)
    })
    rememberBaseTransform(model)
    removeCharacterPlaceholder(normalizedId)
    stageRoot.add(model)
    stageObjects.set(`custom:${directorObject?.id || `project-character:${normalizedId}`}`, model)
    characterObjects.set(normalizedId, model)
    characterModels.set(normalizedId, {
      url,
      root: model,
      mixer: new AnimationMixer(model),
      animations,
      actionClips: {},
      loadingActions: new Set(),
      activeClipKey: '',
      bones,
    })
    characterBones.value = {
      ...characterBones.value,
      [normalizedId]: [...bones.values()].map((bone) => ({ name: bone.name })),
    }
    if (selectedCharacterId.value === normalizedId && !bones.has(selectedBoneName.value)) {
      selectedBoneName.value = bones.keys().next().value || ''
    }
    applyBoneRotations(normalizedId)
    const modelMessage = `${characterName(normalizedId)}模型已加载 · 可见网格 ${visibleMeshCount} · 骨骼 ${boneCount} · 动画 ${animations.length}`
    assetStatus.value = modelMessage
    setResourceState('model', normalizedId, url, { status: 'ready', message: modelMessage })
    if (animations.length) {
      const embeddedActions = new Set(timeline.value.tracks
        .filter((track) => String(track.characterId) === normalizedId)
        .flatMap((track) => track.clips || [])
        .filter((clip) => !resolveDirectorAssetUrl(asset?.actions?.[clip.action]))
        .map((clip) => clip.action))
      for (const actionName of embeddedActions) {
        setResourceState('action', normalizedId, url, {
          status: 'ready',
          message: `${characterName(normalizedId)}使用模型内置动画 ${animations.length}：${actionName}`,
        }, actionName)
      }
    }
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
    const gltf = await loadDirectorGltf(loader, url)
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
  if (workspaceMode.value !== 'animation' || timeline.value.sequence.animationViewMode === 'follow') {
    setCameraForShot(activeShot.value)
  }
  for (const track of timeline.value.motionTracks || []) {
    const transform = interpolateMotionTransform(timeline.value, track.objectId, currentTime.value)
    const object = stageObjects.get(`custom:${track.objectId}`)
    if (!transform || !object) continue
    object.position.set(...transform.position)
    object.rotation.set(...transform.rotation)
    object.scale.set(...transform.scale)
    const activeCameraId = timeline.value.sequence.activeCameraId || activeShot.value?.cameraId
    const activeCamera = timeline.value.cameras.find((camera) => camera.id === activeCameraId && camera.objectId === track.objectId)
    if (activeCamera && timeline.value.sequence.animationViewMode === 'follow') {
      const nextKeyframe = track.keyframes.find((keyframe) => keyframe.time > currentTime.value)
      const target = timeline.value.sequence.orientationMode === 'path' && nextKeyframe
        ? nextKeyframe.position
        : activeCamera.target || [0, 0.8, 0]
      setCamera(transform.position, target)
    }
  }
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
  for (const characterId of characterModels.keys()) applyBoneRotations(characterId)
  viewer.value.setDirty?.()
}

function resetCamera() {
  viewMode.value = 'director'
  setCamera([6.8, 4.8, 8.6])
}

function setViewportPreset(preset) {
  viewMode.value = 'director'
  if (preset === 'top') setCamera([0, 12, 0.01], [0, 0, 0])
  else if (preset === 'front') setCamera([0, 1.6, 9], [0, 1.2, 0])
}

function focusSelectedObject() {
  if (selectedObjectId.value) focusItem(`custom:${selectedObjectId.value}`)
}

function setView(mode) {
  viewMode.value = mode
  if (mode === 'camera') setCameraForShot(selectedShot.value)
  else resetCamera()
}

function focusItem(key) {
  const object = stageObjects.get(key)
  if (!object) return
  const target = object.position.clone()
  if (object.userData?.poseBones) {
    setCamera([target.x, target.y + 1.35, target.z + 4.5], [target.x, target.y + 1.35, target.z])
  } else {
    setCamera([target.x + 3.4, target.y + 2.1, target.z + 4.8], [target.x, target.y, target.z])
  }
  viewer.value?.getPlugin?.(PickingPlugin)?.setSelectedObject?.(object, false)
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
      new TransformControlsPlugin(true),
      new Object3DWidgetsPlugin(false),
      EditorViewWidgetPlugin,
    ])
    nextViewer.scene.setBackgroundColor(timeline.value.environment.backgroundColor || '#0f172a')
    groundGrid = new GridHelper(20, 20, 0x334155, 0x1e293b)
    nextViewer.scene.addObject(groundGrid, { addToRoot: true })
    ambientLight = new HemisphereLight(0xffffff, 0x334155, timeline.value.environment.ambientIntensity)
    nextViewer.scene.addObject(ambientLight, { addToRoot: true })
    keyLight = new DirectionalLight(0xffffff, timeline.value.environment.directionalIntensity)
    keyLight.position.set(4, 7, 5)
    nextViewer.scene.addObject(keyLight, { addToRoot: true })
    viewer.value = nextViewer
    const transformPlugin = nextViewer.getPlugin(TransformControlsPlugin)
    transformPlugin.selectionFilterTest = (object) => directorStageObjectForSelection(object)
    transformControls = transformPlugin?.transformControls || null
    if (transformControls) {
      transformControls.mode = transformMode.value
      transformControls.space = transformSpace.value
      transformControls.addEventListener('mouseDown', rememberTransformControlStart)
      transformControls.addEventListener('mouseUp', persistTransformControlChange)
    }
    pickingPlugin = nextViewer.getPlugin(PickingPlugin)
    pickingPlugin?.addEventListener?.('selectedObjectChanged', syncTransformSelection)
    await applyEnvironment()
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
  window.addEventListener('keydown', onDirectorKeydown)
  window.addEventListener('keyup', onDirectorKeyup)
  await nextTick()
  dialogRef.value?.focus()
  await loadProjectAssets()
  await nextTick()
  applyTimelineState(props.initialState || createDirectorTimeline(characters.value), { emitChange: false })
  await initialize()
  applyEntryContext()
})

watch(() => props.drama?.id, () => {
  void loadProjectAssets()
})

watch(() => props.entryContext, applyEntryContext, { deep: true })

watch(selectedCharacterId, (characterId) => {
  const bones = characterBones.value[String(characterId)] || []
  if (!bones.some((bone) => bone.name === selectedBoneName.value)) selectedBoneName.value = bones[0]?.name || ''
})

watch(aiImportOpen, async (open) => {
  await nextTick()
  if (open) aiImportModalRef.value?.querySelector('button')?.focus()
  else if (props.visible) aiImportButtonRef.value?.focus()
})

watch(helpOpen, async (open) => {
  await nextTick()
  if (open) helpModalRef.value?.querySelector('button')?.focus()
  else if (props.visible) helpButtonRef.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDirectorKeydown)
  window.removeEventListener('keyup', onDirectorKeyup)
  disposed = true
  stopPlayback()
  transformControls?.removeEventListener?.('mouseDown', rememberTransformControlStart)
  transformControls?.removeEventListener?.('mouseUp', persistTransformControlChange)
  pickingPlugin?.removeEventListener?.('selectedObjectChanged', syncTransformSelection)
  clearStageObjects()
  viewer.value?.dispose?.(true)
  viewer.value = null
  ambientLight = null
  keyLight = null
  transformControls = null
  pickingPlugin = null
  if (aiImportPreview.value) URL.revokeObjectURL(aiImportPreview.value)
  if (panoramaReferencePreview.value) URL.revokeObjectURL(panoramaReferencePreview.value)
})
</script>

<style scoped>
.director-stage { position: fixed; inset: 0; z-index: 80; display: flex; flex-direction: column; background: #101014; color: #e4e4e7; }
.director-stage__header, .director-stage__footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 20px; border-bottom: 1px solid #343438; background: #202020; }
.director-stage__header { position: relative; min-height: 62px; box-sizing: border-box; }
.director-stage__view-switch { position: absolute; left: 50%; display: flex; padding: 4px; border: 1px solid #3a3a3d; border-radius: 22px; transform: translateX(-50%); background: #171719; }
.director-stage__view-switch button { min-width: 96px; border: 0; border-radius: 17px; background: transparent; }
.director-stage__view-switch button.active { background: #353537; color: #fff; }
.director-stage__footer { border-top: 1px solid #27272a; border-bottom: 0; color: #71717a; font-size: 12px; }
.director-stage__footer-actions { display: flex; align-items: center; gap: 8px; }
.director-stage__header strong { font-size: 20px; }
.director-stage__hint { margin-left: 10px; color: #818cf8; font-size: 11px; }
.director-stage__header-actions { display: flex; align-items: center; gap: 8px; }
.director-stage__header button, .director-stage__footer button, .small-button, .danger-button { border: 1px solid #3f3f46; border-radius: 9px; padding: 7px 12px; background: #18181b; color: #d4d4d8; cursor: pointer; }
.director-stage__header button.active { border-color: #818cf8; background: rgba(129, 140, 248, 0.16); color: #c4b5fd; }
.director-stage__header .close-button { width: 34px; padding: 4px; font-size: 22px; line-height: 1; }
.director-stage__save-state { color: #34d399; font-size: 11px; }
.director-stage__save-state.dirty { color: #fbbf24; }
.director-stage__body { flex: 1; display: flex; min-height: 0; }
.director-stage__sidebar { width: 300px; flex: 0 0 300px; padding: 22px 16px; overflow-y: auto; border-right: 1px solid #343438; background: #202020; }
.director-stage__left-tabs, .director-asset-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin: -8px 0 18px; padding: 4px; border: 1px solid #343438; border-radius: 10px; background: #18181b; }
.director-stage__left-tabs button, .director-asset-tabs button { min-width: 0; border: 0; border-radius: 7px; padding: 8px 5px; background: transparent; color: #8b8b92; cursor: pointer; font-size: 11px; }
.director-stage__left-tabs button.active, .director-asset-tabs button.active { background: #38383b; color: #fff; }
.director-outline-counts { display: flex; flex-wrap: wrap; gap: 8px; margin: -10px 0 12px; color: #8b8b92; font-size: 10px; }
.director-outline-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.director-asset-tabs { grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0 0 10px; }
.director-asset-library > input, .director-ai-panel input { box-sizing: border-box; width: 100%; margin-bottom: 10px; border: 1px solid #3f3f46; border-radius: 8px; padding: 8px; background: #111114; color: #e4e4e7; }
.director-asset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-bottom: 10px; }
.director-asset-card { display: grid; gap: 5px; min-height: 74px; border: 1px solid #3f3f46; border-radius: 9px; padding: 8px; background: #18181b; color: #d4d4d8; cursor: pointer; font-size: 10px; }
.director-asset-card:hover { border-color: #6366f1; background: #27272a; }
.director-asset-card__preview { display: grid; place-items: center; color: #a5b4fc; font-size: 25px; }
.director-ai-panel { display: grid; gap: 8px; }
.director-ai-panel p { margin: 0 0 6px; color: #8b8b92; font-size: 11px; line-height: 1.55; }
.director-stage__inspector { width: 360px; flex: 0 0 360px; padding: 20px 18px; overflow-y: auto; border-left: 1px solid #343438; background: #202020; }
.director-stage__inspector-title { margin: -2px 0 18px; color: #f4f4f5; font-size: 20px; font-weight: 700; }
.director-stage__inspector-tabs { display: flex; gap: 8px; margin-bottom: 18px; border-bottom: 1px solid #343438; padding-bottom: 10px; }
.director-stage__inspector-tabs button { border: 0; border-radius: 9px; padding: 8px 16px; background: transparent; color: #8b8b92; cursor: pointer; }
.director-stage__inspector-tabs button.active { background: #39393c; color: #fff; }
.character-body-types { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 12px 0; }
.character-body-types strong, .character-body-types label { grid-column: 1 / -1; }
.character-body-types button, .pose-mirror-actions button, .ik-endpoint-controls button { border: 1px solid #3f3f46; border-radius: 7px; padding: 7px; background: #18181b; color: #a1a1aa; cursor: pointer; font-size: 10px; }
.character-body-types button.active, .ik-endpoint-controls button.active { border-color: #72e7f2; color: #fff; }
.pose-mirror-actions, .ik-endpoint-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.ik-endpoint-controls button.locked { background: rgba(114, 231, 242, .12); }
.director-pose-panel > strong { display: block; margin: 14px 0 8px; color: #d4d4d8; font-size: 13px; }
.lighting-presets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin: 12px 0 18px; }
.lighting-presets .small-button { min-width: 0; padding: 7px 5px; font-size: 10px; }
.light-list-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; }
.light-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 12px; }
.light-list > button { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 8px; border: 1px solid #3f3f46; border-radius: 7px; background: #18181b; color: #d4d4d8; text-align: left; }
.light-list > button.active { border-color: #72e7f2; color: #fff; box-shadow: 0 0 0 1px rgba(114, 231, 242, 0.25); }
.light-color-dot { flex: 0 0 10px; width: 10px; height: 10px; border: 1px solid rgba(255,255,255,.55); border-radius: 50%; }
.light-editor { padding: 10px; border: 1px solid #343438; border-radius: 8px; background: #151517; }
.light-color-presets { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; margin-top: 7px; }
.light-color-presets button { width: 100%; aspect-ratio: 1; min-height: 20px; padding: 0; border: 1px solid rgba(255,255,255,.45); border-radius: 5px; }
.director-stage__inspector > label, .director-stage__inspector .inspector-group > label { display: grid; gap: 5px; margin: 12px 0; color: #a1a1aa; font-size: 11px; }
.director-stage__inspector input { width: 100%; box-sizing: border-box; border: 1px solid #3f3f46; border-radius: 7px; padding: 7px 8px; background: #111114; color: #e4e4e7; }
.director-stage__inspector .visibility-row { display: flex; align-items: center; }
.director-stage__inspector .visibility-row input { width: auto; }
.ai-reference-description { margin: 12px 0; padding: 10px; border: 1px solid #3f3f46; border-radius: 8px; background: #111114; color: #a1a1aa; font-size: 11px; }
.ai-reference-description strong { color: #d4d4d8; }
.ai-reference-description p { margin: 6px 0 0; white-space: pre-wrap; line-height: 1.5; }
.director-modal { position: absolute; inset: 0; z-index: 95; display: grid; place-items: center; padding: 24px; background: rgba(0, 0, 0, .72); }
.director-modal__panel { display: grid; gap: 12px; width: min(520px, 100%); max-height: calc(100vh - 48px); overflow-y: auto; box-sizing: border-box; padding: 18px; border: 1px solid #3f3f46; border-radius: 12px; background: #18181b; box-shadow: 0 20px 70px rgba(0, 0, 0, .45); }
.director-modal__panel--compact { width: min(420px, 100%); }
.director-modal__header { display: flex; align-items: center; justify-content: space-between; }
.director-modal__panel label { display: grid; gap: 6px; color: #a1a1aa; font-size: 12px; }
.director-modal__panel input, .director-modal__panel select, .director-modal__panel textarea { box-sizing: border-box; width: 100%; border: 1px solid #3f3f46; border-radius: 8px; padding: 8px; background: #111114; color: #e4e4e7; }
.director-modal__panel button { border: 1px solid #4f46e5; border-radius: 8px; padding: 8px 12px; background: #312e81; color: #e0e7ff; cursor: pointer; }
.director-modal__panel button:disabled { opacity: .5; cursor: default; }
.director-modal__actions, .panorama-source-actions { display: flex; justify-content: flex-end; gap: 8px; }
.director-help-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.director-help-grid section { display: grid; gap: 4px; padding: 9px; border: 1px solid #343438; border-radius: 8px; background: #111114; font-size: 11px; }
.director-help-grid span { color: #8b8b92; }
.ai-import-preview { max-width: 100%; max-height: 240px; justify-self: center; border-radius: 8px; object-fit: contain; }
.inspector-group { margin: 16px 0; padding-top: 12px; border-top: 1px solid #303036; }
.inspector-group > strong { color: #d4d4d8; font-size: 12px; }
.vector-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.vector-row label { min-width: 0; }
.object-create-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-bottom: 8px; }
.role-create-library { margin-bottom: 10px; color: #a1a1aa; font-size: 11px; }
.role-create-library summary { padding: 6px 2px; cursor: pointer; }
.object-create-row--roles { margin-top: 6px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.stage-item.muted { opacity: .5; }
.scene-search { box-sizing: border-box; width: 100%; margin: 14px 0 20px; border: 0; border-radius: 11px; padding: 12px 14px; background: #343436; color: #e4e4e7; }
.stage-tree-row { display: flex; align-items: center; border-radius: 7px; }
.stage-tree-row.selected { background: rgba(129, 140, 248, 0.18); }
.stage-tree-row.muted { opacity: .58; }
.stage-tree-row__name { min-width: 0; flex: 1; }
.tree-icon-button { flex: 0 0 26px; width: 26px; height: 26px; border: 0; border-radius: 6px; padding: 0; background: transparent; color: #a1a1aa; cursor: pointer; font-size: 11px; }
.tree-icon-button:hover { background: #303036; color: #f4f4f5; }
.stage-item small { margin-left: auto; color: #71717a; font-size: 9px; }
.stage-section { margin-bottom: 18px; }
.stage-section__title { margin-bottom: 8px; color: #d4d4d8; font-size: 16px; font-weight: 700; }
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
.shot-cut-range { grid-column: 1 / -1; color: #a5b4fc; font-size: 11px; }
.shot-editor label { display: grid; gap: 4px; color: #a1a1aa; font-size: 10px; }
.shot-editor input, .shot-editor select, .action-add-row select { width: 100%; min-width: 0; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #18181b; color: #e4e4e7; font-size: 11px; }
.danger-button { margin-top: 3px; border-color: rgba(248, 113, 113, 0.5); color: #fca5a5; font-size: 11px; }
.action-add-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; }
.resource-editor { display: grid; gap: 7px; padding: 10px; border: 1px solid #3f3f46; border-radius: 10px; background: rgba(39, 39, 42, 0.42); }
.resource-editor .stage-section__title { margin-bottom: 0; }
.resource-editor label { display: grid; gap: 4px; color: #a1a1aa; font-size: 10px; }
.resource-editor input[type="text"], .resource-editor input[type="url"], .resource-editor input[type="number"] { width: 100%; min-width: 0; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #18181b; color: #e4e4e7; font-size: 11px; }
.resource-editor label input:not([type="file"]) { width: 100%; min-width: 0; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #18181b; color: #e4e4e7; font-size: 11px; }
.pose-presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; margin: 8px 0 12px; }
.pose-presets .small-button { min-width: 0; padding: 5px 2px; font-size: 10px; }
.semantic-pose-controls { display: grid; gap: 7px; margin-bottom: 12px; }
.semantic-pose-controls label { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 7px; color: #a1a1aa; font-size: 10px; }
.resource-upload-row { display: flex; align-items: center; gap: 6px; }
.resource-upload-row input[type="file"] { min-width: 0; flex: 1; color: #a1a1aa; font-size: 10px; }
.resource-character, .resource-tip, .resource-status { color: #71717a; font-size: 10px; }
.resource-status { color: #34d399; }
.resource-status--row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.resource-status[data-status='loading'] { color: #fbbf24; }
.resource-status[data-status='error'] { color: #fca5a5; }
.resource-status--row .small-button { min-height: 44px; }
.director-stage__viewport { position: relative; flex: 1; min-width: 0; min-height: 0; background: #050507; }
.director-stage__viewport--timeline { padding-bottom: 224px; }
.viewport-tools { position: absolute; top: 14px; left: 50%; z-index: 7; display: flex; gap: 5px; transform: translateX(-50%); padding: 5px; border: 1px solid #3f3f46; border-radius: 10px; background: rgba(24, 24, 27, .9); }
.viewport-tools button { border: 0; border-radius: 7px; padding: 6px 10px; background: transparent; color: #d4d4d8; cursor: pointer; }
.viewport-tools button.active { background: #4338ca; color: white; }
.composition-guides { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
.composition-guides > span { position: absolute; display: block; border-color: rgba(255, 255, 255, .42); }
.composition-guides__v { top: 0; bottom: 0; border-left: 1px dashed; }
.composition-guides__v--1 { left: 33.333%; }.composition-guides__v--2 { left: 66.666%; }
.composition-guides__h { left: 0; right: 0; border-top: 1px dashed; }
.composition-guides__h--1 { top: 33.333%; }.composition-guides__h--2 { top: 66.666%; }
.composition-guides__safe { inset: 8%; border: 1px solid rgba(255, 255, 255, .3); }
.director-stage__canvas { width: 100%; height: 100%; display: block; outline: none; }
.director-object-labels { position: absolute; top: 58px; left: 50%; z-index: 5; display: flex; max-width: min(70%, 760px); flex-wrap: wrap; justify-content: center; gap: 5px; transform: translateX(-50%); pointer-events: none; }
.director-object-labels button { display: grid; gap: 1px; max-width: 150px; border: 1px solid rgba(255,255,255,.14); border-radius: 7px; padding: 4px 8px; overflow: hidden; background: rgba(0,0,0,.68); color: #f4f4f5; cursor: pointer; font-size: var(--director-label-size); line-height: 1.1; text-overflow: ellipsis; white-space: nowrap; pointer-events: auto; }
.director-object-labels button.selected { border-color: #72e7f2; color: #72e7f2; }
.director-object-labels small { overflow: hidden; color: #8b8b92; font-size: 8px; text-overflow: ellipsis; }
.director-stage__legend { position: absolute; right: 16px; top: 16px; display: flex; gap: 12px; padding: 8px 10px; border: 1px solid rgba(82, 82, 91, 0.7); border-radius: 9px; background: rgba(24, 24, 27, 0.82); color: #a1a1aa; font-size: 11px; }
.director-stage__legend span { display: inline-flex; align-items: center; gap: 5px; }
.director-entry-reference { position: absolute; top: 54px; left: 16px; z-index: 4; display: grid; gap: 6px; width: 168px; padding: 10px; border: 1px solid rgba(129, 140, 248, 0.5); border-radius: 10px; background: rgba(9, 9, 11, 0.88); color: #d4d4d8; font-size: 10px; }
.director-entry-reference img { width: 100%; max-height: 120px; border-radius: 6px; object-fit: contain; background: #09090b; }
.director-entry-reference small { overflow: hidden; color: #a5b4fc; text-overflow: ellipsis; white-space: nowrap; }
.director-entry-reference span { color: #a1a1aa; line-height: 1.4; }
.director-stage__loading, .director-stage__error { position: absolute; inset: 50% auto auto 50%; transform: translate(-50%, -50%); color: #a1a1aa; font-size: 13px; }
.director-stage__error { color: #fca5a5; }
.timeline-panel { position: absolute; right: 12px; bottom: 74px; left: 12px; z-index: 3; padding: 10px 12px 12px; border: 1px solid #3f3f46; border-radius: 12px; background: rgba(24, 24, 27, 0.94); box-shadow: 0 12px 30px rgba(0, 0, 0, 0.32); backdrop-filter: blur(14px); }
.animation-studio-toolbar { display: flex; align-items: center; gap: 5px; margin-bottom: 8px; overflow-x: auto; padding-bottom: 5px; }
.animation-studio-toolbar button, .animation-studio-toolbar select, .animation-studio-toolbar input { min-height: 30px; border: 1px solid #3f3f46; border-radius: 6px; padding: 4px 7px; background: #27272a; color: #e4e4e7; white-space: nowrap; font-size: 10px; }
.animation-studio-toolbar label { display: flex; align-items: center; gap: 5px; color: #a1a1aa; white-space: nowrap; font-size: 10px; }
.animation-studio-toolbar input { width: 64px; }
.keyframe-detail-panel { position: absolute; right: 18px; bottom: calc(100% + 8px); z-index: 12; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; width: min(560px, calc(100% - 36px)); box-sizing: border-box; padding: 12px; border: 1px solid #3f3f46; border-radius: 10px; background: #18181b; box-shadow: 0 18px 45px rgba(0,0,0,.5); }
.keyframe-detail-panel__header, .keyframe-speed-presets, .keyframe-detail-actions { grid-column: 1 / -1; }
.keyframe-detail-panel__header { display: flex; align-items: center; justify-content: space-between; }
.keyframe-detail-panel label { display: grid; gap: 4px; color: #a1a1aa; font-size: 10px; }
.keyframe-detail-panel input, .keyframe-detail-panel select { border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #111114; color: #e4e4e7; }
.keyframe-speed-presets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
.keyframe-speed-presets button, .keyframe-detail-actions button { border: 1px solid #3f3f46; border-radius: 6px; padding: 6px; background: #27272a; color: #d4d4d8; cursor: pointer; }
.keyframe-speed-presets button.active { border-color: #72e7f2; color: #72e7f2; }
.keyframe-detail-actions { display: flex; justify-content: flex-end; gap: 6px; }
.director-stage__quick-toolbar { position: absolute; bottom: 22px; left: 50%; z-index: 9; display: flex; align-items: center; gap: 3px; max-width: calc(100% - 20px); transform: translateX(-50%); overflow: visible; padding: 6px; border: 1px solid #38383c; border-radius: 14px; background: rgba(31, 31, 32, .96); box-shadow: 0 14px 40px rgba(0, 0, 0, .4); }
.director-stage__quick-toolbar button { min-width: 34px; height: 34px; border: 0; border-radius: 8px; padding: 0 7px; background: transparent; color: #ededee; cursor: pointer; white-space: nowrap; font-size: 11px; }
.director-stage__quick-toolbar button[aria-label='选择画幅比例'], .director-stage__quick-toolbar button[aria-label='全景图'] { font-size: 11px; font-weight: 700; }
.director-stage__quick-toolbar button:hover, .director-stage__quick-toolbar button.active { background: #343437; color: #fff; }
.director-stage__quick-toolbar button:disabled { opacity: .45; cursor: default; }
.director-stage__quick-divider { width: 1px; height: 28px; margin: 0 3px; background: #3c3c40; }
.quick-toolbar-popover { position: fixed; bottom: 72px; z-index: 14; display: grid; gap: 8px; min-width: 190px; box-sizing: border-box; padding: 10px; border: 1px solid #3f3f46; border-radius: 10px; background: #18181b; box-shadow: 0 16px 40px rgba(0,0,0,.5); color: #d4d4d8; font-size: 10px; }
.quick-toolbar-popover label { display: flex; align-items: center; gap: 7px; }
.quick-toolbar-popover input[type='range'] { min-width: 100px; }
.aspect-popover { grid-template-columns: repeat(3, minmax(0, 1fr)); min-width: 230px; }
.aspect-popover button { min-width: 0; height: 30px; border: 1px solid #3f3f46; }
.composition-confirm-message { position: fixed; bottom: 72px; left: 50%; width: max-content; max-width: calc(100vw - 24px); transform: translateX(-50%); border: 1px solid #f97316; border-radius: 8px; padding: 8px 12px; background: #2b170d; color: #fdba74; font-size: 11px; }
.confirm-composition-button { background: #e5e7eb !important; color: #111827 !important; font-weight: 700; }
.timeline-panel.collapsed { overflow: hidden; }
.timeline-scroll-content { min-width: calc(100% * var(--timeline-zoom)); }
.timeline-zoom { min-width: 38px; color: #a1a1aa; text-align: center; font-size: 10px; }
.timeline-toolbar { display: flex; align-items: center; gap: 12px; }
.timeline-controls { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.timeline-controls button { width: 27px; height: 27px; border: 1px solid #3f3f46; border-radius: 6px; background: #27272a; color: #e4e4e7; cursor: pointer; }
.timeline-controls button.active { border-color: #818cf8; background: rgba(129, 140, 248, 0.22); color: #c4b5fd; }
.timeline-time { min-width: 90px; color: #d4d4d8; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.timeline-fps { color: #71717a; font-size: 10px; }
.timeline-scrubber { min-width: 96px; flex: 1; accent-color: #818cf8; }
.timeline-ruler { display: flex; justify-content: space-between; padding: 8px 0 4px 102px; color: #71717a; font-size: 10px; }
.timeline-track { display: flex; min-height: 30px; margin-top: 4px; }
.track-label { width: 92px; flex: 0 0 92px; padding: 8px 10px 0 0; overflow: hidden; color: #a1a1aa; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.track-lane { position: relative; flex: 1; min-width: 0; border-top: 1px solid rgba(63, 63, 70, 0.7); background: repeating-linear-gradient(90deg, rgba(63, 63, 70, 0.16) 0, rgba(63, 63, 70, 0.16) 1px, transparent 1px, transparent 10%); }
.timeline-block { position: absolute; top: 3px; min-width: 24px; height: 24px; overflow: hidden; border: 1px solid #6366f1; border-radius: 5px; padding: 2px 6px; background: rgba(99, 102, 241, 0.35); color: #eef2ff; text-align: left; cursor: pointer; }
.timeline-block.selected { border-color: #c4b5fd; box-shadow: 0 0 0 1px #c4b5fd; }
.timeline-action { border-color: #34d399; background: rgba(16, 185, 129, 0.3); }
.motion-keyframe { position: absolute; top: 2px; transform: translateX(-50%); border: 0; background: transparent; color: #fbbf24; cursor: pointer; }
.timeline-block strong, .timeline-block small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline-block strong { font-size: 10px; }
.timeline-block small { color: #c4b5fd; font-size: 9px; }
.timeline-empty { padding: 8px 0 0 102px; color: #71717a; font-size: 10px; }
@media (max-width: 1300px) {
  .director-stage__sidebar { width: 220px; flex-basis: 220px; }
  .director-stage__inspector { width: 250px; flex-basis: 250px; }
  .director-stage__hint { display: none; }
  .timeline-toolbar { gap: 8px; }
  .timeline-panel { right: 6px; bottom: 70px; left: 6px; }
}
@media (max-width: 680px) {
  .director-stage__header, .director-stage__footer { padding: 10px 12px; }
  .director-stage__sidebar { width: 210px; flex-basis: 210px; }
  .director-stage__inspector { display: none; }
  .director-stage__footer span { display: none; }
}
</style>
