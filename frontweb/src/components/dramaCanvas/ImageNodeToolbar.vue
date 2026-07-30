<template>
  <div
    ref="toolbarRef"
    class="image-node-toolbar nodrag nopan"
    :class="{ 'place-below': toolbarPlacement === 'below' }"
    @mouseenter="updateToolbarPlacement"
    @focusin="updateToolbarPlacement"
    @click.stop
    @mousedown.stop
  >
    <div class="toolbar-menu-wrap portrait-menu-wrap" @mouseenter="openToolbarMenu('portrait')" @mouseleave="scheduleMenuClose">
      <button
        type="button"
        :disabled="nodeBusy"
        :title="busyTitle('人像质感调节')"
        @click="toggleMenu('portrait')"
      >
        <User class="toolbar-icon" />
        人像质感调节
        <span class="new-badge">NEW</span>
        <ArrowDown class="toolbar-chevron" :class="{ open: openMenu === 'portrait' }" />
      </button>
      <div v-if="openMenu === 'portrait'" class="toolbar-menu portrait-menu">
        <button
          v-for="item in portraitActions"
          :key="item.operation"
          type="button"
          :class="{ unavailable: !operationCapability(item.operation).available }"
          :disabled="nodeBusy || !operationCapability(item.operation).available"
          :title="operationTitle(item)"
          @click="selectOperation(item)"
        >
          <component :is="item.icon" class="menu-icon" />
          <span>{{ item.label }}</span>
        </button>
      </div>
    </div>

    <button
      v-for="item in quickActions"
      :key="item.operation"
      type="button"
      :class="{ unavailable: !operationCapability(item.operation).available }"
      :disabled="nodeBusy || !operationCapability(item.operation).available"
      :title="operationTitle(item)"
      @click="selectOperation(item)"
    >
      <component :is="item.icon" class="toolbar-icon" />
      {{ item.label }}
    </button>

    <span class="toolbar-separator" />
    <div class="toolbar-menu-wrap" @mouseenter="openToolbarMenu('tools')" @mouseleave="scheduleMenuClose">
      <button
        type="button"
        :disabled="nodeBusy"
        :title="busyTitle('工具')"
        @click="toggleMenu('tools')"
      >
        <Operation class="toolbar-icon" />
        工具
        <ArrowDown class="toolbar-chevron" :class="{ open: openMenu === 'tools' }" />
      </button>
      <div v-if="openMenu === 'tools'" class="toolbar-menu">
        <button
          v-for="item in toolActions"
          :key="item.label"
          type="button"
          :class="{ unavailable: !itemAvailable(item) }"
          :disabled="nodeBusy || !itemAvailable(item)"
          :title="itemTitle(item)"
          @click="selectOperation(item)"
        >
          <component :is="item.icon" class="menu-icon" />
          <span>{{ item.label }}</span>
        </button>
      </div>
    </div>

    <div class="toolbar-menu-wrap" @mouseenter="openToolbarMenu('settings')" @mouseleave="scheduleMenuClose">
      <button
        type="button"
        :disabled="nodeBusy"
        :title="busyTitle('设定')"
        @click="toggleMenu('settings')"
      >
        <Setting class="toolbar-icon" />
        设定
        <ArrowDown class="toolbar-chevron" :class="{ open: openMenu === 'settings' }" />
      </button>
      <div v-if="openMenu === 'settings'" class="toolbar-menu settings-menu">
        <button
          v-for="item in settingActions"
          :key="item.label"
          type="button"
          :class="{ unavailable: !operationCapability(item.operation).available }"
          :disabled="nodeBusy || !operationCapability(item.operation).available"
          :title="operationTitle(item)"
          @click="selectOperation(item)"
        >
          <component :is="item.icon" class="menu-icon" />
          <span>{{ item.label }}</span>
        </button>
      </div>
    </div>

    <span class="toolbar-separator" />
    <button type="button" :title="busyTitle('标记色')" :disabled="nodeBusy" @click="cycleMarkerColor">
      <span class="marker-dot" :style="{ background: data.imageMarkerColor || markerColors[0] }" />
    </button>
    <button type="button" title="处理历史" aria-label="处理历史" @click="toggleHistory"><Clock class="toolbar-icon icon-only" /></button>
    <button
      type="button"
      :title="busyTitle('替换图片')"
      aria-label="替换图片"
      :disabled="nodeBusy"
      @click="replaceInput?.click()"
    >
      <Picture class="toolbar-icon icon-only" />
    </button>
    <button type="button" title="下载图片" aria-label="下载图片" @click="downloadImage"><Download class="toolbar-icon icon-only" /></button>
    <button type="button" title="全屏预览" aria-label="全屏预览" @click="requestFullscreen"><FullScreen class="toolbar-icon icon-only" /></button>
    <input
      ref="replaceInput"
      class="replace-input"
      type="file"
      accept=".png,.jpg,.jpeg,.webp"
      @change="replaceImage"
    />

    <div
      v-if="data.imageToolStatus === 'failed' && data.imageToolError"
      class="toolbar-error"
      role="alert"
    >
      <span>{{ data.imageToolError }}</span>
      <button
        type="button"
        :disabled="nodeBusy || !data.imageToolRetryOperation"
        @click="retryLastOperation"
      >
        重试
      </button>
    </div>

    <div v-if="historyVisible" class="toolbar-history">
      <strong>处理历史</strong>
      <span v-if="!resolvedHistory.length">暂无记录</span>
      <div v-for="item in resolvedHistory" :key="item.taskId" class="history-item">
        <span>{{ operationLabel(item.operation) }}</span>
        <small>{{ item.status === 'completed' || item.status === 'success' ? '已完成' : item.status }}</small>
      </div>
    </div>

    <el-dialog
      v-model="editorVisible"
      class="image-tool-dialog immersive"
      :title="editorTitle"
      width="calc(100vw - 32px)"
      top="16px"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      @closed="destroyEditor"
    >
      <div v-if="['crop', 'compress', 'mirror', 'rotate'].includes(editorOperation)" class="operation-tabs">
        <button
          v-for="item in primaryEditorOperations"
          :key="item.operation"
          type="button"
          :class="{ active: editorOperation === item.operation }"
          :disabled="nodeBusy"
          @click="switchEditorOperation(item.operation)"
        >
          {{ item.label }}
        </button>
      </div>

      <div
        class="image-editor-workspace"
        :class="{ 'single-stage': ['crop', 'selection_cutout', 'markup_retouch'].includes(editorOperation) }"
      >
      <section
        v-if="!['crop', 'selection_cutout', 'markup_retouch'].includes(editorOperation)"
        class="editor-preview"
        aria-label="图片效果预览"
      >
        <div class="preview-badge">
          <span>{{ previewOriginal ? '原图' : '实时预览' }}</span>
          <button
            v-if="['adjust', 'lut'].includes(editorOperation)"
            type="button"
            @pointerdown="previewOriginal = true"
            @pointerup="previewOriginal = false"
            @pointerleave="previewOriginal = false"
          >
            按住看原图
          </button>
        </div>
        <div class="preview-canvas">
          <img
            :src="data.url"
            :alt="`${operationLabel(editorOperation)}预览`"
            :style="editorPreviewStyle"
            draggable="false"
          />
          <div
            v-if="editorOperation === 'grid_crop'"
            class="grid-preview grid-selection"
            :style="gridPreviewStyle"
            aria-label="宫格选择"
          >
            <button
              v-for="cell in gridCells"
              :key="cell.key"
              type="button"
              :class="{ selected: gridSelectedCells.includes(cell.key) }"
              :aria-label="`第 ${cell.row + 1} 行第 ${cell.column + 1} 列`"
              :aria-pressed="gridSelectedCells.includes(cell.key)"
              @click="toggleGridCell(cell.key)"
            />
          </div>
        </div>
        <div class="preview-caption">
          <strong>{{ operationLabel(editorOperation) }}</strong>
          <span>{{ editorPreviewHint }}</span>
        </div>
      </section>

      <div v-if="['crop', 'selection_cutout'].includes(editorOperation)" class="crop-stage">
        <p v-if="editorOperation === 'selection_cutout'" class="crop-hint">
          框选需要保留的主体区域；本地抠图模型只处理该区域并生成透明 PNG。
        </p>
        <div class="crop-stage-toolbar" aria-label="裁剪快捷控制">
          <template v-if="editorOperation === 'selection_cutout'">
            <button
              type="button"
              :class="{ active: selectionMode === 'rectangle' }"
              @click="setSelectionMode('rectangle')"
            >
              矩形选区
            </button>
            <button
              type="button"
              :class="{ active: selectionMode === 'brush' }"
              @click="setSelectionMode('brush')"
            >
              画笔选区
            </button>
            <label v-if="selectionMode === 'brush'" class="selection-brush-width">
              笔宽
              <input v-model.number="selectionBrushWidth" type="range" min="0.02" max="0.2" step="0.01" />
            </label>
          </template>
          <template v-if="editorOperation === 'crop'">
            <button
              v-for="preset in cropAspectPresets"
              :key="preset.label"
              type="button"
              :class="{ active: sameAspectRatio(cropAspectRatio, preset.value) }"
              @click="setCropAspectRatio(preset.value)"
            >
              {{ preset.label }}
            </button>
          </template>
          <button type="button" @click="resetCropSelection">重置选区</button>
        </div>
        <div
          v-if="editorOperation === 'selection_cutout' && selectionMode === 'brush'"
          class="selection-brush-canvas"
        >
          <img :src="data.url" alt="画笔选区预览" draggable="false" />
          <svg
            ref="selectionBrushSurface"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            aria-label="画笔选区画布"
            @pointerdown="beginSelectionBrush"
            @pointermove="extendSelectionBrush"
            @pointerup="finishSelectionBrush"
            @pointercancel="finishSelectionBrush"
          >
            <polyline
              v-for="(stroke, index) in selectionBrushStrokes"
              :key="index"
              :points="markupPolylinePoints(stroke)"
              :stroke-width="stroke.width * 1000"
              fill="none"
              stroke="#60a5fa"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <img v-else ref="cropImage" :src="data.url" alt="框选预览" @load="initCropper" />
      </div>

      <div v-else-if="editorOperation === 'markup_retouch'" class="markup-editor">
        <p class="crop-hint">
          在需要修改的位置画线，再填写修图要求。原图和标记图会共同提交给已审计的参考图编辑模型。
        </p>
        <div class="markup-stage">
          <div class="markup-canvas">
            <img :src="data.url" alt="标记修图预览" draggable="false" />
            <svg
              ref="markupSurface"
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              @pointerdown="beginMarkupStroke"
              @pointermove="extendMarkupStroke"
              @pointerup="finishMarkupStroke"
              @pointercancel="finishMarkupStroke"
            >
              <template v-for="(stroke, index) in markupStrokes" :key="index">
                <text
                  v-if="stroke.visible !== false && ['number', 'text'].includes(stroke.kind)"
                  :x="stroke.points[0].x * 1000"
                  :y="stroke.points[0].y * 1000"
                  :fill="stroke.color"
                  :font-size="Math.max(24, stroke.width * 4000)"
                  font-family="sans-serif"
                  font-weight="700"
                >{{ stroke.label }}</text>
                <polyline
                  v-else-if="stroke.visible !== false"
                  :points="markupPolylinePoints(stroke)"
                  :stroke="stroke.color"
                  :stroke-width="stroke.width * 1000 * (stroke.kind === 'mosaic' ? 3 : 1)"
                  :stroke-opacity="stroke.kind === 'mosaic' ? 0.65 : 1"
                  fill="none"
                  :stroke-linecap="stroke.kind === 'mosaic' ? 'square' : 'round'"
                  stroke-linejoin="round"
                />
              </template>
            </svg>
          </div>
        </div>
        <div class="markup-controls">
          <div class="markup-tools" aria-label="标记工具">
            <button
              v-for="tool in markupTools"
              :key="tool.value"
              type="button"
              :class="{ active: markupTool === tool.value }"
              @click="markupTool = tool.value"
            >
              {{ tool.label }}
            </button>
          </div>
          <span>标记颜色</span>
          <button
            v-for="color in MARKUP_COLORS"
            :key="color"
            type="button"
            class="markup-color"
            :class="{ active: markupColor === color }"
            :style="{ background: color }"
            :aria-label="`选择标记颜色 ${color}`"
            @click="markupColor = color"
          />
          <label class="markup-width">
            粗细
            <input v-model.number="markupWidth" type="range" min="0.005" max="0.08" step="0.005" />
          </label>
          <label v-if="markupTool === 'text'" class="markup-text">
            文字
            <input v-model.trim="markupText" maxlength="32" placeholder="输入文字后点击图片放置" />
          </label>
          <el-button size="small" :disabled="!markupStrokes.length" @click="undoMarkupStroke">
            撤销
          </el-button>
          <el-button size="small" :disabled="!markupRedoStrokes.length" @click="redoMarkupStroke">
            重做
          </el-button>
          <el-button size="small" :disabled="!markupStrokes.length" @click="clearMarkupStrokes">
            清空
          </el-button>
        </div>
        <div class="markup-layers" aria-label="标记图层">
          <strong>图层（{{ markupStrokes.length }}）</strong>
          <div v-for="(stroke, index) in [...markupStrokes].reverse()" :key="markupStrokes.length - index - 1">
            <button type="button" @click="toggleMarkupLayer(markupStrokes.length - index - 1)">
              {{ stroke.visible === false ? '显示' : '隐藏' }}
            </button>
            <span>{{ markupToolLabel(stroke.kind) }} {{ stroke.label || `#${markupStrokes.length - index}` }}</span>
            <button type="button" @click="removeMarkupLayer(markupStrokes.length - index - 1)">删除</button>
          </div>
        </div>
        <details class="markup-tutorial">
          <summary>标记工具教程</summary>
          <p>选择工具后在图片上拖动；文字和数字工具点击图片即可放置。隐藏的图层不会提交。</p>
        </details>
        <el-form label-position="top">
          <el-form-item label="修图要求">
            <el-input
              v-model="markupInstruction"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="例如：删除标记区域的杂物，并自然补全背景"
            />
          </el-form-item>
        </el-form>
      </div>

      <el-form v-else label-position="top">
        <template v-if="editorOperation === 'portrait_texture'">
          <el-form-item label="人像质感">
            <el-select v-model="portraitTextureForm.preset">
              <el-option label="自然真实" value="natural" />
              <el-option label="清爽通透" value="clean" />
              <el-option label="电影质感" value="cinematic" />
            </el-select>
          </el-form-item>
          <el-form-item :label="`调节强度 ${portraitTextureForm.intensity}/5`">
            <el-slider v-model="portraitTextureForm.intensity" :min="1" :max="5" :step="1" />
          </el-form-item>
          <el-form-item label="补充要求（可选）">
            <el-input
              v-model="portraitTextureForm.description"
              type="textarea"
              :rows="3"
              maxlength="300"
              show-word-limit
              placeholder="例如：保留自然雀斑和眼下细纹"
            />
          </el-form-item>
          <p class="crop-hint">
            通过真实参考图模型生成同尺寸新素材，保留人物身份、构图和原图；不会覆盖源图片。
          </p>
        </template>

        <template v-else-if="editorOperation === 'portrait_emotion'">
          <section class="portrait-face-stage" aria-label="选择需要调节的人脸">
            <div class="portrait-face-toolbar">
              <strong>选择人物</strong>
              <el-button size="small" @click="detectPortraitFaces">自动识别</el-button>
              <el-button size="small" @click="useManualPortraitFaceSelection">手动框选</el-button>
            </div>
            <p class="crop-hint">{{ portraitFaceMessage }}</p>
            <div v-if="portraitFaces.length > 1" class="portrait-face-options">
              <button
                v-for="(face, index) in portraitFaces"
                :key="index"
                type="button"
                :class="{ active: sameFaceRegion(face, portraitFaceRegion) }"
                @click="selectPortraitFace(face)"
              >
                人物 {{ index + 1 }}
              </button>
            </div>
            <div class="portrait-face-cropper">
              <img
                ref="portraitFaceImage"
                :src="data.url"
                alt="人脸自动识别与手动框选"
                @load="preparePortraitFaceSelection"
              />
            </div>
          </section>

          <el-form-item label="情绪定位">
            <div class="emotion-picker">
              <span class="emotion-axis emotion-axis-top">激动</span>
              <span class="emotion-axis emotion-axis-bottom">平静</span>
              <span class="emotion-axis emotion-axis-left">亲近</span>
              <span class="emotion-axis emotion-axis-right">疏离</span>
              <div class="emotion-grid">
                <button
                  v-for="emotion in portraitEmotions"
                  :key="emotion"
                  type="button"
                  :class="{ active: portraitEmotionForm.emotion === emotion }"
                  @click="portraitEmotionForm.emotion = emotion"
                >
                  {{ emotion }}
                </button>
              </div>
            </div>
          </el-form-item>
          <el-form-item :label="`情绪强度 ${portraitEmotionForm.intensity}/5`">
            <el-slider v-model="portraitEmotionForm.intensity" :min="1" :max="5" :step="1" />
          </el-form-item>
          <p class="crop-hint">
            完整原图与选中人脸裁片共同提交，只改变目标人物表情并生成同尺寸新素材。
          </p>
        </template>

        <template v-else-if="editorOperation === 'upscale'">
          <el-form-item label="增强倍率">
            <el-select v-model="upscaleScale">
              <el-option label="2x" :value="2" />
              <el-option label="3x" :value="3" />
              <el-option label="4x" :value="4" />
            </el-select>
          </el-form-item>
          <p class="crop-hint">
            使用已审计的高清增强处理器生成 PNG 新素材；轻量服务器优先使用远程模型，原图保持不变。
          </p>
        </template>

        <template v-else-if="editorOperation === 'detail_enhance'">
          <el-form-item label="增强强度">
            <el-select v-model="detailEnhancePreset">
              <el-option label="自然" value="natural" />
              <el-option label="标准" value="balanced" />
              <el-option label="强烈" value="strong" />
            </el-select>
          </el-form-item>
          <p class="crop-hint">
            使用已审计的细节增强处理器改善纹理并保持原尺寸；轻量服务器优先使用远程模型，原图保持不变。
          </p>
        </template>

        <template v-else-if="editorOperation === 'outpaint'">
          <el-form-item label="目标画幅">
            <el-select v-model="outpaintForm.aspectRatio">
              <el-option label="横屏 16:9" value="16:9" />
              <el-option label="竖屏 9:16" value="9:16" />
              <el-option label="方形 1:1" value="1:1" />
              <el-option label="横幅 4:3" value="4:3" />
              <el-option label="竖幅 3:4" value="3:4" />
            </el-select>
          </el-form-item>
          <el-form-item label="扩展方向">
            <el-select v-model="outpaintForm.direction">
              <el-option label="自动" value="auto" />
              <el-option label="向左扩展" value="left" />
              <el-option label="向右扩展" value="right" />
              <el-option label="向上扩展" value="top" />
              <el-option label="向下扩展" value="bottom" />
              <el-option label="向四周扩展" value="all" />
            </el-select>
          </el-form-item>
          <div class="outpaint-sides" aria-label="扩边范围">
            <el-form-item :label="`上方 ${outpaintForm.top}%`">
              <el-slider v-model="outpaintForm.top" :min="0" :max="100" :step="5" />
            </el-form-item>
            <el-form-item :label="`下方 ${outpaintForm.bottom}%`">
              <el-slider v-model="outpaintForm.bottom" :min="0" :max="100" :step="5" />
            </el-form-item>
            <el-form-item :label="`左侧 ${outpaintForm.left}%`">
              <el-slider v-model="outpaintForm.left" :min="0" :max="100" :step="5" />
            </el-form-item>
            <el-form-item :label="`右侧 ${outpaintForm.right}%`">
              <el-slider v-model="outpaintForm.right" :min="0" :max="100" :step="5" />
            </el-form-item>
          </div>
          <el-button class="adjust-reset" @click="resetOutpaintSides">重置扩边</el-button>
          <el-form-item label="补充描述（可选）">
            <el-input
              v-model="outpaintForm.prompt"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="例如：向右补出落地窗和连续的室内灯光"
            />
          </el-form-item>
          <p class="crop-hint">
            使用已配置的参考图供应商生成新素材；原图保持不变。
          </p>
        </template>

        <template v-else-if="['panorama', 'panorama_scene'].includes(editorOperation)">
          <el-form-item label="补充要求（可选）">
            <el-input
              v-model="panoramaDescription"
              type="textarea"
              :rows="3"
              maxlength="300"
              show-word-limit
              placeholder="例如：保持中央主体并补全四周连续环境"
            />
          </el-form-item>
          <p class="crop-hint">
            使用已配置的参考图供应商生成等距柱状全景；固定输出 3840×1920 PNG，原图保持不变。
          </p>
        </template>

        <template v-else-if="REFERENCE_VARIATION_OPERATIONS.includes(editorOperation)">
          <div
            v-if="referenceVariationTags.length"
            class="variation-tags"
            :aria-label="`${operationLabel(editorOperation)}灵感标签`"
          >
            <button
              v-for="tag in referenceVariationTags"
              :key="tag"
              type="button"
              :class="{ active: referenceVariationDescription.includes(tag) }"
              @click="toggleVariationTag(tag)"
            >
              {{ tag }}
            </button>
          </div>
          <el-form-item label="补充要求（可选）">
            <el-input
              v-model="referenceVariationDescription"
              type="textarea"
              :rows="3"
              maxlength="300"
              show-word-limit
              placeholder="例如：联想为雨后黄昏，但保留中央人物"
            />
          </el-form-item>
          <p class="crop-hint">
            使用已配置的参考图供应商生成新素材；三视图固定 2048×1536，九宫格固定 3072×3072，
            其余操作保持原尺寸；原图保持不变。
          </p>
        </template>

        <template v-else-if="editorOperation === 'cinematic_relight'">
          <el-form-item label="光影预设">
            <el-select v-model="relightForm.preset">
              <el-option label="电影感" value="cinematic" />
              <el-option label="黄金时刻" value="golden_hour" />
              <el-option label="月夜" value="moonlight" />
              <el-option label="影棚柔光" value="studio_soft" />
              <el-option label="高反差" value="high_contrast" />
            </el-select>
          </el-form-item>
          <el-form-item :label="`校正强度 ${relightForm.intensity}/5`">
            <el-slider v-model="relightForm.intensity" :min="1" :max="5" :step="1" />
          </el-form-item>
          <el-form-item label="补充要求（可选）">
            <el-input
              v-model="relightForm.description"
              type="textarea"
              :rows="3"
              maxlength="300"
              show-word-limit
              placeholder="例如：保留人物面部，增加窗外暖色轮廓光"
            />
          </el-form-item>
          <p class="crop-hint">
            使用已配置的参考图供应商生成同尺寸新素材；原图保持不变。
          </p>
        </template>

        <template v-else-if="editorOperation === 'compress'">
          <el-form-item label="输出格式">
            <el-select v-model="compressForm.format">
              <el-option label="WebP" value="webp" />
              <el-option label="JPEG" value="jpeg" />
              <el-option label="PNG" value="png" />
            </el-select>
          </el-form-item>
          <el-form-item :label="`质量 ${compressForm.quality}`">
            <el-slider v-model="compressForm.quality" :min="1" :max="100" />
          </el-form-item>
        </template>

        <el-form-item v-else-if="editorOperation === 'mirror'" label="镜像方向">
          <el-radio-group v-model="mirrorDirection">
            <el-radio-button value="horizontal">水平</el-radio-button>
            <el-radio-button value="vertical">垂直</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-else-if="editorOperation === 'rotate'" label="旋转角度">
          <el-radio-group v-model="rotateAngle">
            <el-radio-button :value="90">顺时针 90°</el-radio-button>
            <el-radio-button :value="180">180°</el-radio-button>
            <el-radio-button :value="270">逆时针 90°</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <template v-else-if="editorOperation === 'grid_crop'">
          <div class="grid-quick-sizes" aria-label="手动网格">
            <button
              v-for="size in gridQuickSizes"
              :key="size"
              type="button"
              :class="{ active: gridForm.rows === size && gridForm.columns === size }"
              @click="applyGridSize(size)"
            >
              {{ size }}x{{ size }}
            </button>
          </div>
          <el-form-item label="行数">
            <el-input-number v-model="gridForm.rows" :min="1" :max="7" @change="resetGridSelection" />
          </el-form-item>
          <el-form-item label="列数">
            <el-input-number v-model="gridForm.columns" :min="1" :max="7" @change="resetGridSelection" />
          </el-form-item>
          <el-form-item :label="`宫格间距 ${gridForm.spacing}px`">
            <el-slider v-model="gridForm.spacing" :min="0" :max="48" :step="1" />
          </el-form-item>
          <div class="grid-selection-actions">
            <el-button size="small" @click="selectAllGridCells">全选</el-button>
            <el-button size="small" @click="gridSelectedCells = []">取消全选</el-button>
            <el-button size="small" @click="invertGridSelection">反选</el-button>
            <el-button size="small" :disabled="!gridSelectedCells.length" @click="duplicateGridSelection">
              复制选区（{{ gridDuplicateCells.length }}）
            </el-button>
            <el-button size="small" @click="redetectGrid">重新识别</el-button>
            <el-checkbox v-model="gridSnapEnabled">吸附对齐</el-checkbox>
            <span>已选择 {{ gridSelectedCells.length }} / {{ gridCells.length }} 格</span>
          </div>
          <p class="crop-hint">点击左侧宫格选择需要分别导出的区域，每个选中区域会生成一份新素材。</p>
        </template>

        <template v-else-if="editorOperation === 'adjust'">
          <div class="adjust-tabs" role="tablist" aria-label="图片调整分类">
            <button
              v-for="section in adjustSections"
              :key="section.key"
              type="button"
              role="tab"
              :aria-selected="adjustSection === section.key"
              :class="{ active: adjustSection === section.key }"
              @click="adjustSection = section.key"
            >
              {{ section.label }}
            </button>
          </div>
          <div class="adjust-presets" aria-label="图片调整预设">
            <button v-for="preset in adjustPresets" :key="preset.name" type="button" @click="applyAdjustPreset(preset)">
              {{ preset.name }}
            </button>
          </div>
          <template v-if="adjustSection === 'light'">
            <el-form-item :label="`曝光 ${formatSigned(adjustForm.exposure)}`">
              <el-slider v-model="adjustForm.exposure" :min="-2" :max="2" :step="0.1" />
            </el-form-item>
            <el-form-item :label="`亮度 ${Math.round(adjustForm.brightness * 100)}`">
              <el-slider v-model="adjustForm.brightness" :min="0.1" :max="2" :step="0.05" />
            </el-form-item>
            <el-form-item :label="`对比度 ${Math.round(adjustForm.contrast * 100)}`">
              <el-slider v-model="adjustForm.contrast" :min="0.1" :max="2" :step="0.05" />
            </el-form-item>
            <el-form-item v-for="control in lightToneControls" :key="control.key" :label="`${control.label} ${Math.round(adjustForm[control.key] * 100)}`">
              <el-slider v-model="adjustForm[control.key]" :min="-1" :max="1" :step="0.05" />
            </el-form-item>
          </template>
          <template v-else-if="adjustSection === 'color'">
            <el-form-item :label="`自然饱和度 ${Math.round(adjustForm.vibrance * 100)}`">
              <el-slider v-model="adjustForm.vibrance" :min="0" :max="2" :step="0.05" />
            </el-form-item>
            <el-form-item :label="`饱和度 ${Math.round(adjustForm.saturation * 100)}`">
              <el-slider v-model="adjustForm.saturation" :min="0" :max="2" :step="0.05" />
            </el-form-item>
            <el-form-item :label="`色温 ${Math.round(adjustForm.temperature * 100)}`">
              <el-slider v-model="adjustForm.temperature" :min="-1" :max="1" :step="0.05" />
            </el-form-item>
            <el-form-item :label="`色调 ${Math.round(adjustForm.tint * 100)}`">
              <el-slider v-model="adjustForm.tint" :min="-1" :max="1" :step="0.05" />
            </el-form-item>
            <el-form-item :label="`色相 ${Math.round(adjustForm.hue)}°`">
              <el-slider v-model="adjustForm.hue" :min="-180" :max="180" :step="1" />
            </el-form-item>
          </template>
          <template v-else-if="adjustSection === 'detail'">
            <el-form-item :label="`锐化 ${Math.round(adjustForm.sharpness * 100)}`">
              <el-slider v-model="adjustForm.sharpness" :min="0" :max="1" :step="0.05" />
            </el-form-item>
            <el-form-item :label="`清晰度 ${Math.round(adjustForm.clarity * 100)}`">
              <el-slider v-model="adjustForm.clarity" :min="0" :max="1" :step="0.05" />
            </el-form-item>
            <el-form-item :label="`颗粒 ${Math.round(adjustForm.grain * 100)}`">
              <el-slider v-model="adjustForm.grain" :min="0" :max="1" :step="0.05" />
            </el-form-item>
          </template>
          <template v-else>
            <el-form-item :label="`柔光 ${Math.round(adjustForm.blur * 10)}`">
              <el-slider v-model="adjustForm.blur" :min="0" :max="2" :step="0.1" />
            </el-form-item>
            <el-form-item v-for="control in effectControls" :key="control.key" :label="`${control.label} ${Math.round(adjustForm[control.key] * 100)}`">
              <el-slider v-model="adjustForm[control.key]" :min="0" :max="1" :step="0.05" />
            </el-form-item>
          </template>
          <section class="curve-panel" aria-label="RGB 曲线">
            <strong>RGB 曲线</strong>
            <div class="adjust-tabs">
              <button v-for="channel in curveChannels" :key="channel.key" type="button" :class="{ active: curveChannel === channel.key }" @click="curveChannel = channel.key">
                {{ channel.label }}
              </button>
            </div>
            <div v-for="(point, index) in adjustCurves[curveChannel].slice(1, -1)" :key="`${curveChannel}-${index}`" class="curve-point-row">
              <span>控制点 {{ index + 1 }}</span>
              <el-slider v-model="point[0]" :min="curvePointMin(curveChannel, index + 1)" :max="curvePointMax(curveChannel, index + 1)" :step="0.01" />
              <el-slider v-model="point[1]" :min="0" :max="1" :step="0.01" />
              <el-button size="small" @click="removeCurvePoint(curveChannel, index + 1)">删除</el-button>
            </div>
            <el-button size="small" :disabled="adjustCurves[curveChannel].length >= 7" @click="addCurvePoint(curveChannel)">添加控制点</el-button>
          </section>
          <el-button class="adjust-reset" @click="resetAdjustForm">全部重置</el-button>
        </template>

        <template v-else-if="editorOperation === 'lut'">
          <div class="adjust-tabs" role="tablist" aria-label="LUT 分类">
            <button v-for="category in lutCategories" :key="category.key" type="button" :class="{ active: lutCategory === category.key }" :disabled="category.key === 'recent' && !recentLutPresets.length" @click="lutCategory = category.key">
              {{ category.label }}
            </button>
          </div>
          <div class="lut-presets" aria-label="LUT 调色预设">
            <button
              v-for="preset in visibleLutPresets"
              :key="preset.value"
              type="button"
              :class="{ active: lutPreset === preset.value }"
              @click="selectLutPreset(preset)"
            >
              <span :class="`lut-swatch lut-${preset.value}`" />
              {{ preset.label }}
            </button>
          </div>
          <el-form-item :label="`LUT 强度 ${Math.round(lutIntensity * 100)}%`">
            <el-slider v-model="lutIntensity" :min="0" :max="1" :step="0.05" />
          </el-form-item>
          <div class="lut-upload">
            <el-button @click="lutFileInput?.click()">上传 3D LUT</el-button>
            <span v-if="customLut">{{ customLut.name }}（{{ customLut.size }}³）</span>
            <input
              ref="lutFileInput"
              type="file"
              accept=".cube,text/plain"
              @change="loadCubeLut"
            />
          </div>
          <section class="curve-panel" aria-label="LUT 手动微调">
            <strong>LUT 手动微调</strong>
            <el-form-item v-for="control in lutManualControls" :key="control.key" :label="`${control.label} ${formatSigned(lutManualForm[control.key])}`">
              <el-slider v-model="lutManualForm[control.key]" :min="control.min" :max="control.max" :step="0.05" />
            </el-form-item>
          </section>
          <el-button class="adjust-reset" @click="resetLutForm">重置调色</el-button>
        </template>
      </el-form>
      </div>

      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button
          v-if="editorOperation === 'markup_retouch'"
          :loading="submitting"
          :disabled="nodeBusy"
          @click="submitOperation('markup_only')"
        >
          仅确认标记
        </el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="nodeBusy || (editorOperation === 'markup_retouch' && !markupRetouchProviderAvailable)"
          :title="editorOperation === 'markup_retouch' && !markupRetouchProviderAvailable ? markupRetouchProviderReason : ''"
          @click="submitOperation('retouch')"
        >
          {{ submitting ? '处理中…' : editorOperation === 'markup_retouch' ? '标记并修改' : '应用并生成新素材' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Aim,
  ArrowDown,
  Brush,
  Clock,
  Crop,
  Download,
  FullScreen,
  Grid,
  MagicStick,
  Operation,
  Picture,
  PictureRounded,
  Rank,
  Refresh,
  Setting,
  Sunny,
  User,
  View,
  ZoomIn,
} from '@element-plus/icons-vue'
import { imageToolsAPI } from '@/api/imageTools'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  nodeId: { type: String, required: true },
  data: { type: Object, required: true },
})
const emit = defineEmits(['suspend-editor'])

const ctx = useCanvasContext()
const toolbarRef = ref(null)
const replaceInput = ref(null)
const lutFileInput = ref(null)
const cropImage = ref(null)
const selectionBrushSurface = ref(null)
const selectionMode = ref('rectangle')
const selectionBrushStrokes = ref([])
const selectionBrushWidth = ref(0.08)
const cropAspectRatio = ref(Number.NaN)
const cropAspectPresets = Object.freeze([
  { label: '自由', value: Number.NaN },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
])
const capabilities = ref({})
const openMenu = ref('')
const toolbarPlacement = ref('above')
const editorVisible = ref(false)
const previewOriginal = ref(false)
const editorOperation = ref('crop')
const editorVariantLabel = ref('')
const submitting = ref(false)
const historyVisible = ref(false)
const resolvedHistory = ref([])
const markerColors = ['#a1a1aa', '#60a5fa', '#34d399', '#fbbf24', '#f87171']
const compressForm = ref({ format: 'webp', quality: 80 })
const mirrorDirection = ref('horizontal')
const rotateAngle = ref(90)
const gridQuickSizes = Object.freeze([2, 3, 4, 5, 6, 7])
const gridForm = ref({ rows: 3, columns: 3, spacing: 0 })
const gridSelectedCells = ref([])
const gridDuplicateCells = ref([])
const gridSnapEnabled = ref(true)
const DEFAULT_ADJUST_FORM = Object.freeze({
  exposure: 0,
  brightness: 1,
  contrast: 1,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  hue: 0,
  sharpness: 0,
  clarity: 0,
  grain: 0,
  blur: 0,
  vignette: 0,
  softLight: 0,
  glow: 0,
})
const adjustForm = ref({ ...DEFAULT_ADJUST_FORM })
const createDefaultCurves = () => Object.fromEntries(
  ['rgb', 'red', 'green', 'blue'].map((channel) => [channel, [[0, 0], [0.5, 0.5], [1, 1]]]),
)
const adjustCurves = ref(createDefaultCurves())
const curveChannel = ref('rgb')
const curveChannels = Object.freeze([
  { key: 'rgb', label: 'RGB' },
  { key: 'red', label: 'R' },
  { key: 'green', label: 'G' },
  { key: 'blue', label: 'B' },
])
const lightToneControls = Object.freeze([
  { key: 'highlights', label: '高光' },
  { key: 'shadows', label: '阴影' },
  { key: 'whites', label: '白色色阶' },
  { key: 'blacks', label: '黑色色阶' },
])
const effectControls = Object.freeze([
  { key: 'vignette', label: '暗角' },
  { key: 'softLight', label: '柔光' },
  { key: 'glow', label: '辉光' },
])
const adjustSection = ref('light')
const adjustSections = Object.freeze([
  { key: 'light', label: '光线' },
  { key: 'color', label: '颜色' },
  { key: 'detail', label: '细节' },
  { key: 'effect', label: '效果' },
])
const adjustPresets = Object.freeze([
  { name: '原图', values: {} },
  { name: '鲜艳', values: { vibrance: 1.25, saturation: 1.15, contrast: 1.08 } },
  { name: '柔和', values: { brightness: 1.05, contrast: 0.9, saturation: 0.9, blur: 0.3 } },
  { name: '暖色', values: { temperature: 0.35, vibrance: 1.08 } },
  { name: '冷色', values: { temperature: -0.35, contrast: 1.05 } },
  { name: '电影', values: { exposure: -0.15, contrast: 1.18, saturation: 0.88, clarity: 0.35 } },
  { name: '复古', values: { temperature: 0.25, saturation: 0.78, contrast: 0.92, blur: 0.15 } },
  { name: '青橙', values: { temperature: 0.12, tint: -0.18, contrast: 1.16, saturation: 1.08 } },
  { name: '黑色电影', values: { exposure: -0.25, contrast: 1.32, saturation: 0.2, vignette: 0.55, grain: 0.2 } },
  { name: '金色时光', values: { exposure: 0.15, temperature: 0.5, highlights: 0.2, glow: 0.18 } },
  { name: '梦幻', values: { brightness: 1.08, saturation: 0.88, softLight: 0.35, glow: 0.3 } },
  { name: 'HDR', values: { contrast: 1.18, highlights: -0.2, shadows: 0.28, clarity: 0.55 } },
  { name: '黑白', values: { saturation: 0, contrast: 1.12 } },
  { name: '褐色', values: { saturation: 0.55, temperature: 0.42, contrast: 0.92 } },
  { name: '沉郁', values: { exposure: -0.3, saturation: 0.72, shadows: -0.2 } },
  { name: '高调', values: { exposure: 0.4, highlights: 0.25, contrast: 0.86 } },
  { name: '低调', values: { exposure: -0.45, blacks: -0.25, contrast: 1.2 } },
  { name: '森林', values: { tint: -0.2, saturation: 1.08, shadows: 0.12 } },
  { name: '人像', values: { temperature: 0.12, softLight: 0.12, clarity: 0.12 } },
  { name: '日落', values: { temperature: 0.58, tint: 0.12, highlights: 0.2 } },
  { name: '漂白', values: { saturation: 0.45, contrast: 1.28, whites: 0.18 } },
  { name: 'LOMO', values: { saturation: 1.22, contrast: 1.24, vignette: 0.48 } },
  { name: '复古暖调', values: { temperature: 0.38, saturation: 0.75, grain: 0.18 } },
  { name: '交叉冲洗', values: { tint: -0.3, hue: 12, contrast: 1.18 } },
  { name: '双色蓝', values: { temperature: -0.5, saturation: 0.75, contrast: 1.15 } },
  { name: '红外', values: { hue: 145, saturation: 1.35, contrast: 1.2 } },
  { name: '铬色', values: { saturation: 0.82, clarity: 0.45, contrast: 1.24 } },
  { name: '粉彩', values: { brightness: 1.08, saturation: 0.68, softLight: 0.2 } },
  { name: '霓虹', values: { saturation: 1.45, contrast: 1.3, glow: 0.28 } },
])
const lutPreset = ref('cinematic')
const lutIntensity = ref(1)
const lutCategory = ref('recommended')
const lutManualForm = ref({ exposure: 0, contrast: 1, saturation: 1, temperature: 0 })
const customLut = ref(null)
const recentLutPresets = ref([])
const lutCategories = Object.freeze([
  { key: 'recommended', label: '推荐' },
  { key: 'recent', label: '最近使用' },
  { key: 'film', label: '电影' },
  { key: 'stylized', label: '风格化' },
  { key: 'portrait', label: '人像' },
])
const lutPresets = Object.freeze([
  { label: '电影感', value: 'cinematic', categories: ['recommended', 'film'] },
  { label: '青橙', value: 'teal_orange', categories: ['recommended', 'film'] },
  { label: '胶片褪色', value: 'film_fade', categories: ['film'] },
  { label: '银幕冷调', value: 'silver_screen', categories: ['film'] },
  { label: '暖色', value: 'warm', categories: ['recommended', 'portrait'] },
  { label: '冷色', value: 'cool', categories: ['recommended', 'stylized'] },
  { label: '黑白', value: 'mono', categories: ['film', 'stylized'] },
  { label: '复古棕', value: 'vintage_brown', categories: ['stylized'] },
  { label: '森林', value: 'forest', categories: ['stylized'] },
  { label: '粉彩', value: 'pastel', categories: ['portrait', 'stylized'] },
  { label: '自然肤色', value: 'skin_natural', categories: ['portrait'] },
])
const visibleLutPresets = computed(() => {
  if (lutCategory.value === 'recent') {
    return recentLutPresets.value
      .map((value) => (
        value === 'custom' && customLut.value
          ? { label: customLut.value.name, value: 'custom', categories: ['recent'] }
          : lutPresets.find((preset) => preset.value === value)
      ))
      .filter(Boolean)
  }
  return lutPresets.filter((preset) => preset.categories.includes(lutCategory.value))
})
const lutManualControls = Object.freeze([
  { key: 'exposure', label: '曝光', min: -1, max: 1 },
  { key: 'contrast', label: '对比度', min: 0.5, max: 1.5 },
  { key: 'saturation', label: '饱和度', min: 0, max: 2 },
  { key: 'temperature', label: '色温', min: -1, max: 1 },
])
const upscaleScale = ref(2)
const detailEnhancePreset = ref('balanced')
const outpaintForm = ref({
  aspectRatio: '16:9',
  direction: 'auto',
  top: 25,
  bottom: 25,
  left: 25,
  right: 25,
  prompt: '',
})
const panoramaDescription = ref('')
const REFERENCE_VARIATION_OPERATIONS = Object.freeze([
  'image_ideation',
  'angle_ideation',
  'character_views',
  'narrative_grid',
  'frame_forward',
  'frame_backward',
])
const referenceVariationDescription = ref('')
const referenceVariationTagMap = Object.freeze({
  image_ideation: ['雨后黄昏', '电影叙事', '梦境氛围', '季节变化', '未来都市', '古典绘画'],
  angle_ideation: ['低机位仰拍', '高机位俯拍', '侧面跟拍', '过肩视角', '广角全景', '特写镜头'],
})
const relightForm = ref({
  preset: 'cinematic',
  intensity: 3,
  description: '',
})
const portraitFaceImage = ref(null)
const portraitTextureForm = ref({
  preset: 'natural',
  intensity: 3,
  description: '',
})
const portraitEmotionForm = ref({
  emotion: '浅然莞尔',
  intensity: 3,
})
const portraitFaceRegion = ref(null)
const portraitFaces = ref([])
const portraitFaceMessage = ref('正在检测人脸；自动识别不可用时请手动框选')
const portraitEmotions = Object.freeze([
  '强忍悲戚', '默然垂泪', '触景伤情', '哀悼压抑', '隐忍心伤',
  '浅然莞尔', '含情凝望', '满眼宠溺', '万般无奈', '欣然愉悦',
  '眉宇凝霜', '隐忍愠怒', '冷眼漠然', '积郁憋闷', '暴怒沉怒',
  '骤然错愕', '难以置信', '惊魂未定', '受惊后退', '心跳骤停',
  '淡然自若', '疏离冷淡', '欲言又止', '警觉审视', '疲惫失神',
])
const MARKUP_MAX_STROKES = 16
const MARKUP_MAX_POINTS = 128
const MARKUP_COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6']
const markupSurface = ref(null)
const markupStrokes = ref([])
const markupRedoStrokes = ref([])
const markupInstruction = ref('')
const markupColor = ref(MARKUP_COLORS[0])
const markupWidth = ref(0.02)
const markupTool = ref('brush')
const markupText = ref('')
let markupNumber = 1
const markupTools = Object.freeze([
  { label: '选择/移动', value: 'select' },
  { label: '画笔', value: 'brush' },
  { label: '直线', value: 'line' },
  { label: '箭头', value: 'arrow' },
  { label: '矩形', value: 'rectangle' },
  { label: '圆形', value: 'ellipse' },
  { label: '马赛克', value: 'mosaic' },
  { label: '数字标记', value: 'number' },
  { label: '文本', value: 'text' },
])
let cropper = null
let portraitCropper = null
let CropperClass = null
let activeMarkupStroke = null
let activeMarkupStart = null
let activeSelectionBrushStroke = null
let menuCloseTimer = null

const DIRECTOR_STAGE_OPERATIONS = new Set(['director_stage', 'lighting', 'angle', 'pose'])

const portraitActions = [
  { label: '人像调节', operation: 'portrait_texture', icon: User },
  { label: '情绪调节', operation: 'portrait_emotion', icon: Aim },
]

const quickActions = [
  { label: '720全景', operation: 'panorama', icon: PictureRounded },
  { label: '灯光', operation: 'lighting', icon: Sunny },
  { label: '高清', operation: 'upscale', icon: ZoomIn },
]

const primaryEditorOperations = [
  { label: '裁剪', operation: 'crop' },
  { label: '压缩', operation: 'compress' },
  { label: '镜像', operation: 'mirror' },
  { label: '旋转', operation: 'rotate' },
]

const toolActions = [
  { label: '裁剪/压缩/镜像', operation: 'crop', icon: Crop },
  { label: '标记修图', operation: 'markup_retouch', icon: Brush },
  { label: '宫格裁剪', operation: 'grid_crop', icon: Grid },
  { label: '智能抠图', operation: 'smart_cutout', icon: MagicStick },
  { label: '框选抠图', operation: 'selection_cutout', icon: Aim },
  { label: '图片调整', operation: 'adjust', icon: Operation },
  { label: 'LUT 调色', operation: 'lut', icon: PictureRounded },
  { label: '生成导演台', operation: 'director_stage', icon: Rank },
  { label: '姿势', operation: 'pose', icon: User },
  { label: '角度', operation: 'angle', icon: Refresh },
  { label: '扩图', operation: 'outpaint', icon: FullScreen },
  { label: '画面联想', operation: 'image_ideation', icon: View },
  { label: '角度联想', operation: 'angle_ideation', icon: Grid },
]

const settingActions = [
  { label: '生成全景场景', operation: 'panorama_scene', icon: PictureRounded },
  { label: '角色三视图', operation: 'character_views', icon: User },
  { label: '多机位叙事九宫格', operation: 'narrative_grid', icon: Grid },
  { label: '画面推演-3秒后', operation: 'frame_forward', icon: Refresh },
  { label: '画面推演-5秒前', operation: 'frame_backward', icon: Refresh },
  { label: '720全景', operation: 'panorama', icon: PictureRounded },
  { label: '电影级光影校正', operation: 'cinematic_relight', icon: Sunny },
  { label: '细节纹理增强', operation: 'detail_enhance', icon: MagicStick },
  { label: '全景镜头扩张', operation: 'outpaint', variant: 'panorama_lens', icon: FullScreen },
  { label: '背景重构', operation: 'image_ideation', variant: 'background_reconstruct', icon: PictureRounded },
  { label: '氛围重塑', operation: 'cinematic_relight', variant: 'atmosphere_reshape', icon: Sunny },
]

const history = computed(() => Array.isArray(props.data.imageToolHistory)
  ? props.data.imageToolHistory
  : [])
const busyReason = '图片节点正在生成或处理，请稍后'
const nodeBusy = computed(() => submitting.value
  || props.data.status === 'running'
  || props.data.imageToolStatus === 'running')
const markupRetouchProviderAvailable = computed(
  () => capabilities.value?.markup_retouch?.providerAvailable !== false,
)
const markupRetouchProviderReason = computed(
  () => capabilities.value?.markup_retouch?.providerReason || '未配置可用的标记修图模型',
)

const editorPreviewStyle = computed(() => {
  const style = {
    filter: 'none',
    transform: 'none',
  }
  if (previewOriginal.value) return style
  if (editorOperation.value === 'adjust') {
    const {
      exposure,
      brightness,
      saturation,
      vibrance,
      contrast,
      temperature,
      tint,
      hue,
      blur,
    } = adjustForm.value
    const warmth = temperature >= 0
      ? `sepia(${Math.abs(temperature) * 0.28}) saturate(${1 + temperature * 0.18})`
      : `hue-rotate(${temperature * 18}deg)`
    const tintRotation = tint * -12
    style.filter = [
      `brightness(${brightness * (2 ** exposure)})`,
      `saturate(${saturation * vibrance})`,
      `contrast(${contrast})`,
      `hue-rotate(${hue + tintRotation}deg)`,
      warmth,
      blur > 0 ? `blur(${blur}px)` : '',
    ].filter(Boolean).join(' ')
  } else if (editorOperation.value === 'lut') {
    const strength = lutIntensity.value
    const filters = {
      cinematic: `contrast(${1 + (0.12 * strength)}) saturate(${1 - (0.1 * strength)}) sepia(${0.08 * strength})`,
      warm: `sepia(${0.22 * strength}) saturate(${1 + (0.14 * strength)})`,
      cool: `hue-rotate(${14 * strength}deg) saturate(${1 - (0.18 * strength)})`,
      mono: `grayscale(${strength}) contrast(${1 + (0.08 * strength)})`,
    }
    style.filter = filters[lutPreset.value] || 'none'
  } else if (editorOperation.value === 'mirror') {
    style.transform = mirrorDirection.value === 'vertical' ? 'scaleY(-1)' : 'scaleX(-1)'
  } else if (editorOperation.value === 'rotate') {
    style.transform = `rotate(${rotateAngle.value}deg)`
  }
  return style
})

const gridPreviewStyle = computed(() => ({
  '--grid-rows': gridForm.value.rows,
  '--grid-columns': gridForm.value.columns,
}))
const gridCells = computed(() => Array.from(
  { length: gridForm.value.rows * gridForm.value.columns },
  (_, index) => {
    const row = Math.floor(index / gridForm.value.columns)
    const column = index % gridForm.value.columns
    return { row, column, key: `${row}:${column}` }
  },
))

const editorPreviewHint = computed(() => {
  if (['adjust', 'lut', 'mirror', 'rotate', 'grid_crop'].includes(editorOperation.value)) {
    return '参数变化会即时显示；应用后生成新素材，原图保持不变'
  }
  return '左侧保留原图作为生成参考；右侧设置参数后再提交处理'
})
const editorTitle = computed(() => editorVariantLabel.value || operationLabel(editorOperation.value))
const referenceVariationTags = computed(() => (
  referenceVariationTagMap[editorOperation.value] || []
))

onMounted(async () => {
  window.addEventListener('resize', updateToolbarPlacement)
  window.addEventListener('scroll', updateToolbarPlacement, true)
  nextTick(updateToolbarPlacement)
  try {
    const result = await imageToolsAPI.getCapabilities()
    capabilities.value = result?.operations || {}
  } catch {
    capabilities.value = {}
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateToolbarPlacement)
  window.removeEventListener('scroll', updateToolbarPlacement, true)
  destroyEditor()
})

function updateToolbarPlacement() {
  const node = toolbarRef.value?.closest('.vue-flow__node')
  const bounds = node?.getBoundingClientRect?.()
  toolbarPlacement.value = bounds && bounds.top < 88 ? 'below' : 'above'
}

function operationCapability(operation) {
  return capabilities.value?.[operation] || {
    available: false,
    reason: '处理能力尚未从本地服务加载',
  }
}

function itemAvailable(item) {
  return operationCapability(item.operation).available
}

function operationTitle(item) {
  if (nodeBusy.value) return `${item.label}：${busyReason}`
  const capability = operationCapability(item.operation)
  return capability.available ? item.label : `${item.label}：${capability.reason}`
}

function itemTitle(item) {
  return operationTitle(item)
}

function busyTitle(label) {
  return nodeBusy.value ? `${label}：${busyReason}` : label
}

function toggleMenu(menu) {
  if (nodeBusy.value) return
  emit('suspend-editor')
  clearTimeout(menuCloseTimer)
  openMenu.value = menu
  historyVisible.value = false
}

function openToolbarMenu(menu) {
  if (nodeBusy.value) return
  emit('suspend-editor')
  clearTimeout(menuCloseTimer)
  openMenu.value = menu
  historyVisible.value = false
}

function scheduleMenuClose() {
  clearTimeout(menuCloseTimer)
  menuCloseTimer = setTimeout(() => {
    openMenu.value = ''
  }, 140)
}

function selectOperation(item) {
  openMenu.value = ''
  if (nodeBusy.value) return
  emit('suspend-editor')
  const capability = operationCapability(item.operation)
  if (!capability.available) {
    ElMessage.warning(capability.reason || '该能力尚未接通')
    return
  }
  if (DIRECTOR_STAGE_OPERATIONS.has(item.operation)) {
    ctx?.openDirectorStage?.({
      mode: item.operation,
      imageUrl: props.data.url,
      sourceNodeId: props.nodeId,
      sourceTitle: props.data.title || '图片节点',
    })
    return
  }
  editorOperation.value = item.operation
  editorVariantLabel.value = item.variant ? item.label : ''
  if (!item.variant && item.operation === 'outpaint') {
    outpaintForm.value = {
      aspectRatio: '16:9',
      direction: 'auto',
      top: 25,
      bottom: 25,
      left: 25,
      right: 25,
      prompt: '',
    }
  } else if (!item.variant && REFERENCE_VARIATION_OPERATIONS.includes(item.operation)) {
    referenceVariationDescription.value = ''
  } else if (!item.variant && item.operation === 'cinematic_relight') {
    relightForm.value = { preset: 'cinematic', intensity: 3, description: '' }
  } else if (!item.variant && item.operation === 'portrait_texture') {
    portraitTextureForm.value = { preset: 'natural', intensity: 3, description: '' }
  } else if (!item.variant && item.operation === 'portrait_emotion') {
    destroyPortraitCropper()
    portraitEmotionForm.value = { emotion: '浅然莞尔', intensity: 3 }
    portraitFaceRegion.value = null
    portraitFaces.value = []
    portraitFaceMessage.value = '正在检测人脸；自动识别不可用时请手动框选'
  } else if (item.variant === 'panorama_lens') {
    outpaintForm.value = {
      ...outpaintForm.value,
      aspectRatio: '2:1',
      direction: 'all',
      prompt: '保持主体与透视一致，扩展为自然的超广角全景镜头画面',
    }
  } else if (item.variant === 'background_reconstruct') {
    referenceVariationDescription.value = '保留前景主体身份、姿态和轮廓，重新构建完整且透视一致的背景环境'
  } else if (item.variant === 'atmosphere_reshape') {
    relightForm.value = {
      ...relightForm.value,
      preset: 'cinematic',
      description: '保持主体与构图不变，重塑环境光、空气透视与整体氛围',
    }
  }
  if (item.operation === 'grid_crop') resetGridSelection()
  if (item.operation === 'selection_cutout') resetSelectionEditor()
  if (item.operation === 'markup_retouch') resetMarkupEditor()
  editorVisible.value = true
  if (['crop', 'selection_cutout'].includes(item.operation)) nextTick(initCropper)
}

function switchEditorOperation(operation) {
  if (nodeBusy.value) return
  const capability = operationCapability(operation)
  if (!capability.available) {
    ElMessage.warning(capability.reason || '该能力尚未接通')
    return
  }
  destroyCropper()
  editorOperation.value = operation
  editorVariantLabel.value = ''
  if (operation === 'grid_crop') resetGridSelection()
  if (operation === 'selection_cutout') resetSelectionEditor()
  if (['crop', 'selection_cutout'].includes(operation)) nextTick(initCropper)
}

async function initCropper() {
  if (
    !editorVisible.value
    || !['crop', 'selection_cutout'].includes(editorOperation.value)
    || (editorOperation.value === 'selection_cutout' && selectionMode.value === 'brush')
    || !cropImage.value
  ) return
  if (!CropperClass) {
    const [cropperModule] = await Promise.all([
      import('cropperjs'),
      import('cropperjs/dist/cropper.css'),
    ])
    CropperClass = cropperModule.default
  }
  if (
    !editorVisible.value
    || !['crop', 'selection_cutout'].includes(editorOperation.value)
    || (editorOperation.value === 'selection_cutout' && selectionMode.value === 'brush')
    || !cropImage.value
  ) return
  destroyCropper()
  cropper = new CropperClass(cropImage.value, {
    viewMode: 1,
    autoCropArea: 0.85,
    background: false,
    responsive: true,
    aspectRatio: editorOperation.value === 'crop' ? cropAspectRatio.value : Number.NaN,
  })
}

function destroyCropper() {
  cropper?.destroy()
  cropper = null
}

function destroyPortraitCropper() {
  portraitCropper?.destroy()
  portraitCropper = null
}

function clampFaceRegion(region) {
  const x = Math.max(0, Math.min(1, Number(region?.x || 0)))
  const y = Math.max(0, Math.min(1, Number(region?.y || 0)))
  const width = Math.max(0.01, Math.min(1 - x, Number(region?.width || 0)))
  const height = Math.max(0.01, Math.min(1 - y, Number(region?.height || 0)))
  return { x, y, width, height }
}

function sameFaceRegion(left, right) {
  if (!left || !right) return false
  return ['x', 'y', 'width', 'height'].every((key) => (
    Math.abs(Number(left[key]) - Number(right[key])) < 0.0001
  ))
}

function setPortraitCropperRegion(region) {
  const image = portraitFaceImage.value
  if (!image?.naturalWidth || !image?.naturalHeight || !portraitCropper) return
  const normalized = clampFaceRegion(region)
  portraitCropper.setData({
    x: normalized.x * image.naturalWidth,
    y: normalized.y * image.naturalHeight,
    width: normalized.width * image.naturalWidth,
    height: normalized.height * image.naturalHeight,
  })
}

function selectPortraitFace(region) {
  portraitFaceRegion.value = clampFaceRegion(region)
  setPortraitCropperRegion(portraitFaceRegion.value)
}

async function initPortraitCropper() {
  if (
    !editorVisible.value
    || editorOperation.value !== 'portrait_emotion'
    || !portraitFaceImage.value
  ) return
  if (!CropperClass) {
    const [cropperModule] = await Promise.all([
      import('cropperjs'),
      import('cropperjs/dist/cropper.css'),
    ])
    CropperClass = cropperModule.default
  }
  if (!portraitFaceImage.value || editorOperation.value !== 'portrait_emotion') return
  destroyPortraitCropper()
  portraitCropper = new CropperClass(portraitFaceImage.value, {
    viewMode: 1,
    autoCropArea: 0.4,
    background: false,
    responsive: true,
    aspectRatio: Number.NaN,
    ready() {
      if (portraitFaceRegion.value) setPortraitCropperRegion(portraitFaceRegion.value)
    },
    crop(event) {
      const image = portraitFaceImage.value
      if (!image?.naturalWidth || !image?.naturalHeight) return
      portraitFaceRegion.value = clampFaceRegion({
        x: event.detail.x / image.naturalWidth,
        y: event.detail.y / image.naturalHeight,
        width: event.detail.width / image.naturalWidth,
        height: event.detail.height / image.naturalHeight,
      })
    },
  })
}

async function useManualPortraitFaceSelection() {
  portraitFaces.value = []
  portraitFaceRegion.value = { x: 0.25, y: 0.15, width: 0.5, height: 0.7 }
  portraitFaceMessage.value = '请拖动裁剪框手动框选需要调节的人脸'
  await nextTick()
  await initPortraitCropper()
}

async function detectPortraitFaces() {
  if (editorOperation.value !== 'portrait_emotion' || !portraitFaceImage.value) return
  destroyPortraitCropper()
  if (typeof window.FaceDetector !== 'function') {
    portraitFaceMessage.value = '自动识别不可用，请手动框选需要调节的人脸'
    await useManualPortraitFaceSelection()
    return
  }
  try {
    const detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 10 })
    const detections = await detector.detect(portraitFaceImage.value)
    const image = portraitFaceImage.value
    portraitFaces.value = detections.map(({ boundingBox }) => clampFaceRegion({
      x: boundingBox.x / image.naturalWidth,
      y: boundingBox.y / image.naturalHeight,
      width: boundingBox.width / image.naturalWidth,
      height: boundingBox.height / image.naturalHeight,
    }))
    if (!portraitFaces.value.length) {
      portraitFaceMessage.value = '未自动识别到人脸，请手动框选'
      await useManualPortraitFaceSelection()
      return
    }
    portraitFaceRegion.value = { ...portraitFaces.value[0] }
    portraitFaceMessage.value = portraitFaces.value.length > 1
      ? `识别到 ${portraitFaces.value.length} 张人脸，请选择目标人物`
      : '已识别人脸，可拖动框线微调'
    await nextTick()
    await initPortraitCropper()
  } catch {
    portraitFaceMessage.value = '自动识别不可用，请手动框选需要调节的人脸'
    await useManualPortraitFaceSelection()
  }
}

async function preparePortraitFaceSelection() {
  if (portraitFaceRegion.value) {
    await initPortraitCropper()
    return
  }
  await detectPortraitFaces()
}

function setCropAspectRatio(value) {
  cropAspectRatio.value = value
  cropper?.setAspectRatio(value)
}

function sameAspectRatio(left, right) {
  return (Number.isNaN(left) && Number.isNaN(right)) || left === right
}

function resetCropSelection() {
  if (editorOperation.value === 'selection_cutout' && selectionMode.value === 'brush') {
    selectionBrushStrokes.value = []
    activeSelectionBrushStroke = null
    return
  }
  cropper?.reset()
  if (editorOperation.value === 'crop') cropper?.setAspectRatio(cropAspectRatio.value)
}

function resetSelectionEditor() {
  selectionMode.value = 'rectangle'
  selectionBrushStrokes.value = []
  activeSelectionBrushStroke = null
}

function setSelectionMode(mode) {
  if (!['rectangle', 'brush'].includes(mode) || selectionMode.value === mode) return
  destroyCropper()
  selectionMode.value = mode
  activeSelectionBrushStroke = null
  if (mode === 'rectangle') nextTick(initCropper)
}

function selectionBrushPoint(event) {
  const bounds = selectionBrushSurface.value?.getBoundingClientRect()
  if (!bounds?.width || !bounds?.height) return null
  return {
    x: Number(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)).toFixed(5)),
    y: Number(Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)).toFixed(5)),
  }
}

function beginSelectionBrush(event) {
  if (nodeBusy.value || event.button !== 0 || selectionBrushStrokes.value.length >= MARKUP_MAX_STROKES) return
  const point = selectionBrushPoint(event)
  if (!point) return
  const stroke = { width: selectionBrushWidth.value, points: [point] }
  selectionBrushStrokes.value.push(stroke)
  activeSelectionBrushStroke = stroke
  selectionBrushSurface.value?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function extendSelectionBrush(event) {
  if (!activeSelectionBrushStroke || activeSelectionBrushStroke.points.length >= MARKUP_MAX_POINTS) return
  const point = selectionBrushPoint(event)
  if (!point) return
  const previous = activeSelectionBrushStroke.points[activeSelectionBrushStroke.points.length - 1]
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.004) return
  activeSelectionBrushStroke.points.push(point)
  event.preventDefault()
}

function finishSelectionBrush(event) {
  if (!activeSelectionBrushStroke) return
  if (activeSelectionBrushStroke.points.length === 1) {
    activeSelectionBrushStroke.points.push({ ...activeSelectionBrushStroke.points[0] })
  }
  activeSelectionBrushStroke = null
  if (
    event?.pointerId !== undefined
    && selectionBrushSurface.value?.hasPointerCapture?.(event.pointerId)
  ) {
    selectionBrushSurface.value.releasePointerCapture(event.pointerId)
  }
}

function destroyEditor() {
  clearTimeout(menuCloseTimer)
  destroyCropper()
  destroyPortraitCropper()
  activeMarkupStroke = null
  activeSelectionBrushStroke = null
}

function resetMarkupEditor() {
  markupStrokes.value = []
  markupRedoStrokes.value = []
  markupInstruction.value = ''
  markupColor.value = MARKUP_COLORS[0]
  markupWidth.value = 0.02
  markupTool.value = 'brush'
  markupText.value = ''
  markupNumber = 1
  activeMarkupStroke = null
  activeMarkupStart = null
}

function markupPoint(event) {
  const bounds = markupSurface.value?.getBoundingClientRect()
  if (!bounds?.width || !bounds?.height) return null
  const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
  const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
  return {
    x: Number(x.toFixed(5)),
    y: Number(y.toFixed(5)),
  }
}

function beginMarkupStroke(event) {
  if (
    nodeBusy.value
    || markupTool.value === 'select'
    || markupStrokes.value.length >= MARKUP_MAX_STROKES
    || event.button !== 0
  ) return
  const point = markupPoint(event)
  if (!point) return
  const stroke = {
    kind: markupTool.value,
    color: markupColor.value,
    width: markupWidth.value,
    points: [point],
    visible: true,
  }
  if (markupTool.value === 'text') {
    if (!markupText.value) {
      ElMessage.warning('请先输入要放置的文字')
      return
    }
    stroke.label = markupText.value.slice(0, 32)
  }
  if (markupTool.value === 'number') {
    stroke.label = String(markupNumber)
    markupNumber += 1
  }
  if (['text', 'number'].includes(markupTool.value)) {
    stroke.points.push({ ...point })
  }
  markupStrokes.value.push(stroke)
  markupRedoStrokes.value = []
  activeMarkupStroke = markupStrokes.value[markupStrokes.value.length - 1]
  activeMarkupStart = point
  markupSurface.value?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function extendMarkupStroke(event) {
  if (!activeMarkupStroke || activeMarkupStroke.points.length >= MARKUP_MAX_POINTS) return
  const point = markupPoint(event)
  if (!point) return
  if (markupTool.value !== 'brush') {
    activeMarkupStroke.points = markupShapePoints(markupTool.value, activeMarkupStart, point)
    event.preventDefault()
    return
  }
  const previous = activeMarkupStroke.points[activeMarkupStroke.points.length - 1]
  const distance = Math.hypot(point.x - previous.x, point.y - previous.y)
  if (distance < 0.004) return
  activeMarkupStroke.points.push(point)
  event.preventDefault()
}

function finishMarkupStroke(event) {
  if (!activeMarkupStroke) return
  if (activeMarkupStroke.points.length === 1) {
    activeMarkupStroke.points.push({ ...activeMarkupStroke.points[0] })
  }
  activeMarkupStroke = null
  activeMarkupStart = null
  if (event?.pointerId !== undefined && markupSurface.value?.hasPointerCapture?.(event.pointerId)) {
    markupSurface.value.releasePointerCapture(event.pointerId)
  }
}

function markupShapePoints(tool, start, end) {
  if (!start || !end) return []
  if (tool === 'line') return [start, end]
  if (tool === 'arrow') {
    const angle = Math.atan2(end.y - start.y, end.x - start.x)
    const size = 0.035
    const wing = (offset) => ({
      x: Math.min(1, Math.max(0, end.x - (Math.cos(angle + offset) * size))),
      y: Math.min(1, Math.max(0, end.y - (Math.sin(angle + offset) * size))),
    })
    return [start, end, wing(Math.PI / 6), end, wing(-Math.PI / 6)]
  }
  if (tool === 'rectangle') {
    return [
      start,
      { x: end.x, y: start.y },
      end,
      { x: start.x, y: end.y },
      start,
    ]
  }
  if (tool === 'ellipse') {
    const centerX = (start.x + end.x) / 2
    const centerY = (start.y + end.y) / 2
    const radiusX = Math.abs(end.x - start.x) / 2
    const radiusY = Math.abs(end.y - start.y) / 2
    return Array.from({ length: 33 }, (_, index) => {
      const angle = (index / 32) * Math.PI * 2
      return {
        x: centerX + (Math.cos(angle) * radiusX),
        y: centerY + (Math.sin(angle) * radiusY),
      }
    })
  }
  return [start, end]
}

function markupPolylinePoints(stroke) {
  return stroke.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ')
}

function undoMarkupStroke() {
  activeMarkupStroke = null
  activeMarkupStart = null
  const stroke = markupStrokes.value.pop()
  if (stroke) markupRedoStrokes.value.push(stroke)
}

function redoMarkupStroke() {
  const stroke = markupRedoStrokes.value.pop()
  if (stroke) markupStrokes.value.push(stroke)
}

function clearMarkupStrokes() {
  activeMarkupStroke = null
  activeMarkupStart = null
  markupStrokes.value = []
  markupRedoStrokes.value = []
}

function markupToolLabel(kind) {
  return markupTools.find((tool) => tool.value === kind)?.label || '标记'
}

function toggleMarkupLayer(index) {
  const stroke = markupStrokes.value[index]
  if (stroke) stroke.visible = stroke.visible === false
}

function removeMarkupLayer(index) {
  if (index < 0 || index >= markupStrokes.value.length) return
  markupStrokes.value.splice(index, 1)
  markupRedoStrokes.value = []
}

function selectAllGridCells() {
  gridSelectedCells.value = gridCells.value.map((cell) => cell.key)
}

function applyGridSize(size) {
  gridForm.value = { ...gridForm.value, rows: size, columns: size }
  resetGridSelection()
}

function resetGridSelection() {
  gridDuplicateCells.value = []
  nextTick(selectAllGridCells)
}

function invertGridSelection() {
  const selected = new Set(gridSelectedCells.value)
  gridSelectedCells.value = gridCells.value
    .map((cell) => cell.key)
    .filter((key) => !selected.has(key))
}

function duplicateGridSelection() {
  gridDuplicateCells.value = [...gridSelectedCells.value]
}

async function redetectGrid() {
  try {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = reject
      image.src = props.data.url
    })
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const gray = (x, y) => {
      const offset = ((y * canvas.width) + x) * 4
      return (pixels[offset] * 0.2126) + (pixels[offset + 1] * 0.7152) + (pixels[offset + 2] * 0.0722)
    }
    const edgeProjection = (vertical) => Array.from(
      { length: (vertical ? canvas.width : canvas.height) - 1 },
      (_, position) => {
        let total = 0
        const crossSize = vertical ? canvas.height : canvas.width
        for (let cross = 0; cross < crossSize; cross += 1) {
          total += Math.abs(vertical
            ? gray(position + 1, cross) - gray(position, cross)
            : gray(cross, position + 1) - gray(cross, position))
        }
        return total / crossSize
      },
    )
    const boundaryCount = (projection) => {
      const mean = projection.reduce((sum, value) => sum + value, 0) / projection.length
      const deviation = Math.sqrt(projection.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / projection.length)
      const peaks = projection
        .map((value, index) => ({ value, index }))
        .filter(({ value, index }) => value > mean + deviation && index > 8 && index < 118)
        .sort((a, b) => b.value - a.value)
        .reduce((accepted, peak) => (
          accepted.some((item) => Math.abs(item.index - peak.index) < 8)
            ? accepted
            : [...accepted, peak]
        ), [])
      return Math.min(7, Math.max(2, peaks.slice(0, 6).length + 1))
    }
    gridForm.value = {
      ...gridForm.value,
      columns: boundaryCount(edgeProjection(true)),
      rows: boundaryCount(edgeProjection(false)),
    }
    resetGridSelection()
  } catch {
    ElMessage.warning('未能读取图像内容，请使用自定义行列')
  }
}

function toggleGridCell(key) {
  gridSelectedCells.value = gridSelectedCells.value.includes(key)
    ? gridSelectedCells.value.filter((value) => value !== key)
    : [...gridSelectedCells.value, key]
}

function toggleVariationTag(tag) {
  const tokens = referenceVariationDescription.value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const next = tokens.includes(tag)
    ? tokens.filter((item) => item !== tag)
    : [...tokens, tag]
  referenceVariationDescription.value = next.join('，')
}

function operationParameters() {
  if (editorOperation.value === 'selection_cutout' && selectionMode.value === 'brush') {
    if (!selectionBrushStrokes.value.length) throw new Error('请先用画笔涂选需要保留的主体')
    return {
      selectionMode: 'brush',
      brushStrokes: selectionBrushStrokes.value.map((stroke) => ({
        width: stroke.width,
        points: stroke.points.map((point) => ({ ...point })),
      })),
    }
  }
  if (['crop', 'selection_cutout'].includes(editorOperation.value)) {
    if (!cropper) throw new Error('裁剪器尚未就绪')
    const data = cropper.getData(true)
    return {
      left: data.x,
      top: data.y,
      width: data.width,
      height: data.height,
    }
  }
  if (editorOperation.value === 'compress') return { ...compressForm.value }
  if (editorOperation.value === 'mirror') return { direction: mirrorDirection.value }
  if (editorOperation.value === 'rotate') return { angle: rotateAngle.value }
  if (editorOperation.value === 'grid_crop') {
    if (!gridSelectedCells.value.length) throw new Error('请至少选择一个宫格区域')
    return {
      ...gridForm.value,
      selectedCells: [...gridSelectedCells.value],
      duplicateCells: [...gridDuplicateCells.value],
      spacing: gridForm.value.spacing,
      snap: gridSnapEnabled.value,
    }
  }
  if (editorOperation.value === 'adjust') return { ...adjustForm.value, curves: adjustCurves.value }
  if (editorOperation.value === 'lut') return {
    preset: lutPreset.value,
    intensity: lutIntensity.value,
    manual: { ...lutManualForm.value },
    ...(lutPreset.value === 'custom' && customLut.value
      ? { customLut: customLut.value }
      : {}),
  }
  if (editorOperation.value === 'upscale') return { scale: upscaleScale.value }
  if (editorOperation.value === 'detail_enhance') return { preset: detailEnhancePreset.value }
  if (editorOperation.value === 'outpaint') return { ...outpaintForm.value }
  if (['panorama', 'panorama_scene'].includes(editorOperation.value)) return {
    description: panoramaDescription.value.trim(),
  }
  if (REFERENCE_VARIATION_OPERATIONS.includes(editorOperation.value)) return {
    description: referenceVariationDescription.value.trim(),
  }
  if (editorOperation.value === 'portrait_texture') return {
    preset: portraitTextureForm.value.preset,
    intensity: portraitTextureForm.value.intensity,
    description: portraitTextureForm.value.description.trim(),
  }
  if (editorOperation.value === 'portrait_emotion') {
    if (!portraitFaceRegion.value) throw new Error('请先自动识别或手动框选需要调节的人脸')
    return {
      emotion: portraitEmotionForm.value.emotion,
      intensity: portraitEmotionForm.value.intensity,
      faceRegion: { ...portraitFaceRegion.value },
    }
  }
  if (editorOperation.value === 'cinematic_relight') return {
    preset: relightForm.value.preset,
    intensity: relightForm.value.intensity,
    description: relightForm.value.description.trim(),
  }
  if (editorOperation.value === 'markup_retouch') {
    const instruction = markupInstruction.value.trim()
    const visibleStrokes = markupStrokes.value.filter((stroke) => stroke.visible !== false)
    if (!visibleStrokes.length) throw new Error('请先在图片上标记需要修改的区域')
    return {
      instruction,
      strokes: visibleStrokes.map((stroke) => ({
        kind: stroke.kind,
        ...(stroke.label ? { label: stroke.label } : {}),
        color: stroke.color,
        width: stroke.width,
        points: stroke.points.map((point) => ({ ...point })),
      })),
    }
  }
  return {}
}

function resetAdjustForm() {
  adjustForm.value = { ...DEFAULT_ADJUST_FORM }
  adjustCurves.value = createDefaultCurves()
  curveChannel.value = 'rgb'
}

function addCurvePoint(channel) {
  const points = adjustCurves.value[channel]
  const largestGap = points.slice(0, -1)
    .map((point, index) => ({ index, gap: points[index + 1][0] - point[0] }))
    .sort((a, b) => b.gap - a.gap)[0]
  const left = points[largestGap.index]
  const right = points[largestGap.index + 1]
  points.splice(largestGap.index + 1, 0, [
    (left[0] + right[0]) / 2,
    (left[1] + right[1]) / 2,
  ])
}

function removeCurvePoint(channel, index) {
  if (index > 0 && index < adjustCurves.value[channel].length - 1) {
    adjustCurves.value[channel].splice(index, 1)
  }
}

function curvePointMin(channel, index) {
  return Math.min(0.95, adjustCurves.value[channel][index - 1][0] + 0.01)
}

function curvePointMax(channel, index) {
  return Math.max(0.05, adjustCurves.value[channel][index + 1][0] - 0.01)
}

function resetLutForm() {
  lutPreset.value = 'cinematic'
  lutIntensity.value = 1
  lutCategory.value = 'recommended'
  lutManualForm.value = { exposure: 0, contrast: 1, saturation: 1, temperature: 0 }
  customLut.value = null
  if (lutFileInput.value) lutFileInput.value.value = ''
}

function selectLutPreset(preset) {
  lutPreset.value = preset.value
  recentLutPresets.value = [
    preset.value,
    ...recentLutPresets.value.filter((value) => value !== preset.value),
  ].slice(0, 6)
}

async function loadCubeLut(event) {
  const file = event.target?.files?.[0]
  if (!file) return
  try {
    if (file.size > 512 * 1024) throw new Error('3D LUT 文件不能超过 512 KB')
    const lines = (await file.text())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    const sizeLine = lines.find((line) => /^LUT_3D_SIZE\s+/i.test(line))
    const size = Number(sizeLine?.split(/\s+/)[1])
    if (!Number.isInteger(size) || size < 2 || size > 17) {
      throw new Error('仅支持尺寸 2 到 17 的 .cube 3D LUT')
    }
    const values = lines
      .filter((line) => /^[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s+[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s+[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(line))
      .map((line) => line.split(/\s+/).map(Number))
    if (values.length !== size ** 3 || values.some((entry) => entry.some((value) => value < 0 || value > 1))) {
      throw new Error(`3D LUT 应包含 ${size ** 3} 行 0–1 RGB 数据`)
    }
    customLut.value = { name: file.name.slice(0, 80), size, values }
    lutPreset.value = 'custom'
    recentLutPresets.value = [
      'custom',
      ...recentLutPresets.value.filter((value) => value !== 'custom'),
    ].slice(0, 5)
    ElMessage.success('3D LUT 已载入，可调整强度后应用')
  } catch (error) {
    customLut.value = null
    lutPreset.value = 'cinematic'
    if (event.target) event.target.value = ''
    ElMessage.error(error?.message || '3D LUT 解析失败')
  }
}

function resetOutpaintSides() {
  outpaintForm.value = {
    ...outpaintForm.value,
    top: 25,
    bottom: 25,
    left: 25,
    right: 25,
  }
}

function applyAdjustPreset(preset) {
  resetAdjustForm()
  adjustForm.value = { ...adjustForm.value, ...(preset?.values || {}) }
}

function formatSigned(value) {
  const numeric = Number(value) || 0
  return `${numeric > 0 ? '+' : ''}${numeric.toFixed(1)}`
}

async function submitOperation(markupMode = 'retouch') {
  if (nodeBusy.value) return
  submitting.value = true
  try {
    if (typeof ctx?.runImageNodeTool !== 'function') {
      throw new Error('请先将本地节点接入项目画布后再使用图片模型工具')
    }
    const parameters = operationParameters()
    if (editorOperation.value === 'markup_retouch') {
      parameters.mode = markupMode
      if (markupMode === 'retouch' && !parameters.instruction) {
        throw new Error('请填写修图要求')
      }
    }
    await ctx?.runImageNodeTool?.(
      props.nodeId,
      editorOperation.value,
      parameters,
    )
    editorVisible.value = false
    ElMessage.success('图片处理完成，已生成新素材')
  } catch (error) {
    ElMessage.error(error?.message || '图片处理失败')
  } finally {
    submitting.value = false
  }
}

async function retryLastOperation() {
  const operation = String(props.data.imageToolRetryOperation || '').trim()
  const parameters = props.data.imageToolRetryParameters
  if (!operation || !parameters || nodeBusy.value) return
  submitting.value = true
  try {
    if (typeof ctx?.runImageNodeTool !== 'function') {
      throw new Error('请先将本地节点接入项目画布后再使用图片模型工具')
    }
    await ctx?.runImageNodeTool?.(props.nodeId, operation, parameters)
    ElMessage.success('图片处理重试成功，已生成新素材')
  } catch (error) {
    ElMessage.error(error?.message || '图片处理重试失败')
  } finally {
    submitting.value = false
  }
}

function operationLabel(operation) {
  const labels = {
    crop: '裁剪',
    compress: '压缩',
    mirror: '镜像',
    rotate: '旋转',
    grid_crop: '宫格裁剪',
    smart_cutout: '智能抠图',
    selection_cutout: '框选抠图',
    upscale: '高清增强',
    detail_enhance: '细节纹理增强',
    outpaint: '扩图',
    markup_retouch: '标记修图',
    panorama: '720全景',
    panorama_scene: '生成全景场景',
    image_ideation: '画面联想',
    angle_ideation: '角度联想',
    character_views: '角色三视图',
    narrative_grid: '多机位叙事九宫格',
    frame_forward: '画面推演-3秒后',
    frame_backward: '画面推演-5秒前',
    portrait_texture: '人像调节',
    portrait_emotion: '情绪调节',
    cinematic_relight: '电影级光影校正',
    adjust: '图片调整',
    lut: 'LUT 调色',
  }
  return labels[operation] || operation || '图片处理'
}

async function toggleHistory() {
  emit('suspend-editor')
  historyVisible.value = !historyVisible.value
  openMenu.value = ''
  if (!historyVisible.value) return
  resolvedHistory.value = await Promise.all(history.value.map(async (item) => {
    try {
      const task = await imageToolsAPI.getOperation(item.taskId)
      return { ...item, status: task?.status || item.status }
    } catch {
      return item
    }
  }))
}

function cycleMarkerColor() {
  const current = markerColors.indexOf(props.data.imageMarkerColor)
  const next = markerColors[(current + 1) % markerColors.length]
  ctx?.setFreeCanvasNodeMarker?.(props.nodeId, next)
}

async function replaceImage(event) {
  const file = event?.target?.files?.[0]
  if (!file) return
  try {
    await ctx?.replaceFreeCanvasNodeImage?.(props.nodeId, file)
    ElMessage.success('图片已替换并存入素材库')
  } catch (error) {
    ElMessage.error(error?.message || '替换图片失败')
  } finally {
    if (event?.target) event.target.value = ''
  }
}

function downloadImage() {
  const link = document.createElement('a')
  link.href = props.data.url
  const title = String(props.data.title || 'image').replace(/\.(png|jpe?g|webp)$/i, '')
  link.download = `${title}.${downloadExtension(props.data.url)}`
  link.rel = 'noopener'
  link.click()
}

function downloadExtension(url) {
  try {
    const pathname = new URL(url, window.location.origin).pathname
    const extension = pathname.match(/\.(png|jpe?g|webp)$/i)?.[1]?.toLowerCase()
    return extension === 'jpeg' ? 'jpg' : (extension || 'png')
  } catch {
    return 'png'
  }
}

function requestFullscreen() {
  const image = toolbarRef.value
    ?.closest('.vue-flow__node')
    ?.querySelector('.node-media')
  image?.requestFullscreen?.()
}
</script>

<style scoped>
.image-node-toolbar {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 10px);
  z-index: 12;
  display: none;
  align-items: center;
  gap: 3px;
  width: max-content;
  max-width: 960px;
  padding: 8px 10px;
  border: 1px solid #34343a;
  border-radius: 999px;
  background: rgba(21, 21, 23, 0.98);
  box-shadow: 0 14px 38px rgba(0, 0, 0, 0.45);
  transform: translateX(-50%);
}

.image-node-toolbar.place-below {
  top: calc(100% + 10px);
  bottom: auto;
}

:global(.home-canvas-node:hover .image-node-toolbar),
:global(.vue-flow__node.selected .image-node-toolbar),
.image-node-toolbar:focus-within {
  display: flex;
}

.image-node-toolbar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-width: 32px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: 15px;
  background: transparent;
  color: #d4d4d8;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.image-node-toolbar button:hover {
  background: #3f3f46;
  color: #fff;
}

.image-node-toolbar button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.image-node-toolbar button:disabled:hover {
  background: transparent;
  color: inherit;
}

.image-node-toolbar button.unavailable {
  color: #71717a;
}

.toolbar-menu-wrap {
  position: relative;
}

.new-badge {
  padding: 2px 7px;
  border-radius: 999px;
  color: #dff8ff;
  background: #27758a;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.4;
}

.portrait-menu {
  width: 190px;
}

.toolbar-menu {
  position: absolute;
  top: 38px;
  left: 0;
  z-index: 20;
  display: grid;
  width: 228px;
  max-height: 420px;
  padding: 10px 8px;
  overflow: auto;
  border: 1px solid #3f3f46;
  border-radius: 14px;
  background: rgba(24, 24, 27, 0.99);
  box-shadow: 0 16px 42px rgba(0, 0, 0, 0.5);
}

.toolbar-menu button {
  display: grid;
  grid-template-columns: 22px 1fr;
  justify-content: start;
  gap: 10px;
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  text-align: left;
}

.toolbar-icon,
.menu-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.toolbar-icon.icon-only {
  width: 19px;
  height: 19px;
}

.toolbar-chevron {
  width: 14px;
  height: 14px;
  transition: transform 140ms ease;
}

.toolbar-chevron.open {
  transform: rotate(180deg);
}

.settings-menu {
  width: 230px;
}

.toolbar-separator {
  width: 1px;
  height: 22px;
  margin: 0 3px;
  background: #3f3f46;
}

.marker-dot {
  display: inline-block;
  width: 15px;
  height: 15px;
  border: 2px solid #d4d4d8;
  border-radius: 50%;
}

.replace-input {
  display: none;
}

.toolbar-error {
  position: absolute;
  top: 44px;
  left: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 360px;
  padding: 9px 10px;
  border: 1px solid #7f1d1d;
  border-radius: 10px;
  background: #2a1215;
  color: #fecaca;
  font-size: 12px;
}

.toolbar-error span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbar-error button {
  flex: 0 0 auto;
  border: 1px solid #b91c1c;
  color: #fecaca;
}

.toolbar-history {
  position: absolute;
  top: 44px;
  right: 0;
  display: grid;
  gap: 6px;
  width: 230px;
  padding: 12px;
  border: 1px solid #3f3f46;
  border-radius: 12px;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
}

.history-item {
  display: flex;
  justify-content: space-between;
  color: #a1a1aa;
}

.operation-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.operation-tabs button {
  height: 32px;
  padding: 0 16px;
  border: 1px solid #d4d4d8;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.operation-tabs button.active {
  border-color: #6366f1;
  background: #6366f1;
  color: white;
}

.adjust-tabs,
.adjust-presets {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  overflow-x: auto;
}

.adjust-tabs button,
.adjust-presets button {
  flex: 0 0 auto;
  padding: 7px 12px;
  color: #aeb1ba;
  background: #202126;
  border: 1px solid #33353c;
  border-radius: 999px;
  cursor: pointer;
}

.adjust-tabs button.active,
.adjust-tabs button:hover,
.adjust-presets button:hover {
  color: #fff;
  background: #34363e;
  border-color: #555863;
}

.adjust-reset {
  width: 100%;
  margin-top: 4px;
}

.lut-presets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}

.lut-presets button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  color: #c4c6ce;
  background: #202126;
  border: 1px solid #33353c;
  border-radius: 10px;
  cursor: pointer;
}

.lut-presets button.active {
  color: #fff;
  border-color: #7c83ff;
  box-shadow: 0 0 0 1px #7c83ff inset;
}

.lut-swatch {
  width: 34px;
  height: 24px;
  border-radius: 6px;
  background: linear-gradient(135deg, #172033, #d7a66a);
}

.lut-warm {
  background: linear-gradient(135deg, #5f2415, #ffc77d);
}

.lut-cool {
  background: linear-gradient(135deg, #173b60, #b8e1ff);
}

.lut-mono {
  background: linear-gradient(135deg, #171717, #e5e5e5);
}

.outpaint-sides {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 18px;
}

.variation-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.variation-tags button {
  padding: 7px 12px;
  color: #aeb1ba;
  background: #202126;
  border: 1px solid #373941;
  border-radius: 999px;
  cursor: pointer;
}

.variation-tags button.active {
  color: #fff;
  background: #4f46e5;
  border-color: #6366f1;
}

.image-editor-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(300px, 0.75fr);
  gap: 22px;
  min-height: 520px;
}

.image-editor-workspace.single-stage {
  display: block;
  min-height: 0;
}

.image-editor-workspace > .el-form {
  min-width: 0;
  padding: 18px;
  border: 1px solid #3f3f46;
  border-radius: 14px;
  background: #18181b;
}

.portrait-face-stage {
  margin-bottom: 18px;
}

.portrait-face-toolbar,
.portrait-face-options {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.portrait-face-toolbar strong {
  margin-right: auto;
}

.portrait-face-options button,
.emotion-grid button {
  border: 1px solid #3f3f46;
  border-radius: 8px;
  color: #d4d4d8;
  background: #27272a;
  cursor: pointer;
}

.portrait-face-options button {
  padding: 6px 10px;
}

.portrait-face-options button.active,
.emotion-grid button.active {
  border-color: #818cf8;
  color: #fff;
  background: #4f46e5;
}

.portrait-face-cropper {
  height: 250px;
  overflow: hidden;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  background: #09090b;
}

.portrait-face-cropper img {
  display: block;
  max-width: 100%;
}

.emotion-picker {
  position: relative;
  width: 100%;
  padding: 24px 32px;
}

.emotion-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
}

.emotion-grid button {
  min-height: 48px;
  padding: 5px;
  font-size: 11px;
  line-height: 1.25;
}

.emotion-axis {
  position: absolute;
  color: #a1a1aa;
  font-size: 11px;
}

.emotion-axis-top,
.emotion-axis-bottom {
  left: 50%;
  transform: translateX(-50%);
}

.emotion-axis-top { top: 0; }
.emotion-axis-bottom { bottom: 0; }
.emotion-axis-left,
.emotion-axis-right {
  top: 50%;
  transform: translateY(-50%);
  writing-mode: vertical-rl;
}
.emotion-axis-left { left: 4px; }
.emotion-axis-right { right: 4px; }

.editor-preview {
  position: relative;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  min-width: 0;
  overflow: hidden;
  border: 1px solid #3f3f46;
  border-radius: 14px;
  background: #09090b;
}

.preview-badge {
  position: absolute;
  top: 14px;
  left: 14px;
  z-index: 2;
  padding: 5px 10px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 999px;
  background: rgba(9, 9, 11, 0.76);
  color: #e4e4e7;
  font-size: 12px;
  backdrop-filter: blur(8px);
}

.preview-badge {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-badge button {
  padding: 2px 7px;
  color: #fff;
  background: #3f3f46;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.preview-canvas {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 430px;
  overflow: hidden;
  background:
    linear-gradient(45deg, #18181b 25%, transparent 25%),
    linear-gradient(-45deg, #18181b 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #18181b 75%),
    linear-gradient(-45deg, transparent 75%, #18181b 75%);
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  background-size: 20px 20px;
}

.preview-canvas img {
  display: block;
  max-width: 100%;
  max-height: 430px;
  object-fit: contain;
  transition: filter 160ms ease, transform 160ms ease;
}

.grid-preview {
  position: absolute;
  inset: 0;
  display: grid;
  pointer-events: none;
}

.grid-selection {
  grid-template-columns: repeat(var(--grid-columns), 1fr);
  grid-template-rows: repeat(var(--grid-rows), 1fr);
  pointer-events: auto;
}

.grid-selection button {
  position: relative;
  z-index: 1;
  min-width: 0;
  padding: 0;
  background: rgb(9 9 11 / 58%);
  border: 1px solid rgb(255 255 255 / 72%);
  cursor: pointer;
}

.grid-selection button.selected {
  background: rgb(99 102 241 / 16%);
  box-shadow: 0 0 0 2px #818cf8 inset;
}

.grid-selection-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: #a1a1aa;
}

.grid-quick-sizes {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 6px;
  margin-bottom: 14px;
}

.grid-quick-sizes button {
  padding: 8px;
  color: #d4d4d8;
  background: #232429;
  border: 1px solid #3f4148;
  border-radius: 8px;
  cursor: pointer;
}

.grid-quick-sizes button.active {
  color: #fff;
  background: #4338ca;
  border-color: #6366f1;
}

.grid-preview::before {
  grid-area: 1 / 1 / -1 / -1;
  content: "";
  background:
    repeating-linear-gradient(to right, transparent 0, transparent calc(100% - 1px), rgba(255, 255, 255, 0.76) calc(100% - 1px), rgba(255, 255, 255, 0.76) 100%),
    repeating-linear-gradient(to bottom, transparent 0, transparent calc(100% - 1px), rgba(255, 255, 255, 0.76) calc(100% - 1px), rgba(255, 255, 255, 0.76) 100%);
  background-size: calc(100% / var(--grid-columns)) 100%, 100% calc(100% / var(--grid-rows));
}

.preview-caption {
  display: grid;
  gap: 4px;
  padding: 14px 16px;
  border-top: 1px solid #27272a;
  color: #f4f4f5;
}

.preview-caption span {
  color: #a1a1aa;
  font-size: 12px;
}

.crop-stage {
  position: relative;
  height: 430px;
  overflow: hidden;
  background: #09090b;
}

.crop-stage-toolbar {
  position: absolute;
  z-index: 4;
  bottom: 14px;
  left: 50%;
  display: flex;
  gap: 6px;
  padding: 7px;
  background: rgb(20 20 24 / 90%);
  border: 1px solid #404047;
  border-radius: 10px;
  transform: translateX(-50%);
}

.crop-stage-toolbar button {
  padding: 6px 9px;
  color: #c4c4cc;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}

.crop-stage-toolbar button.active,
.crop-stage-toolbar button:hover {
  color: #fff;
  background: #4f46e5;
}

.selection-brush-width {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 5px;
  color: #d4d4d8;
  font-size: 11px;
}

.selection-brush-width input {
  width: 72px;
}

.selection-brush-canvas {
  position: relative;
  display: flex;
  width: fit-content;
  max-width: 100%;
  height: 100%;
  margin: 0 auto;
}

.selection-brush-canvas img {
  width: auto;
  max-width: 100%;
  height: 100%;
  object-fit: contain;
}

.selection-brush-canvas svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: rgb(15 23 42 / 18%);
  cursor: crosshair;
  touch-action: none;
}

.crop-hint {
  margin: 0;
  padding: 10px 14px;
  color: #d4d4d8;
  background: #18181b;
}

.crop-stage img {
  display: block;
  max-width: 100%;
}

.markup-editor {
  display: grid;
  gap: 12px;
}

.markup-stage {
  position: relative;
  display: flex;
  justify-content: center;
  max-height: 380px;
  overflow: hidden;
  border: 1px solid #3f3f46;
  border-radius: 10px;
  background: #09090b;
}

.markup-canvas {
  position: relative;
  display: inline-block;
  max-width: 100%;
  max-height: 380px;
  line-height: 0;
}

.markup-stage img {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 380px;
  user-select: none;
}

.markup-stage svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
  touch-action: none;
}

.markup-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  color: #a1a1aa;
  font-size: 12px;
}

.markup-tools {
  display: flex;
  gap: 6px;
  width: 100%;
}

.markup-tools button {
  padding: 6px 10px;
  color: #a1a1aa;
  background: #232429;
  border: 1px solid #3f4148;
  border-radius: 7px;
  cursor: pointer;
}

.markup-tools button.active {
  color: #fff;
  background: #4f46e5;
  border-color: #6366f1;
}

.markup-width {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.markup-width input {
  width: 90px;
}

.markup-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.markup-text input {
  width: 190px;
  padding: 6px 8px;
  color: #f4f4f5;
  background: #18181b;
  border: 1px solid #3f4148;
  border-radius: 7px;
}

.markup-layers {
  display: grid;
  gap: 6px;
  max-height: 150px;
  padding: 10px;
  overflow: auto;
  color: #d4d4d8;
  background: #18181b;
  border: 1px solid #303136;
  border-radius: 10px;
}

.markup-layers > div {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
}

.markup-layers button,
.markup-tutorial summary {
  color: #a5b4fc;
  cursor: pointer;
}

.markup-tutorial {
  color: #a1a1aa;
  font-size: 12px;
}

.markup-controls .markup-color {
  width: 24px;
  min-width: 24px;
  height: 24px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
}

.markup-controls .markup-color.active {
  border-color: #fff;
  box-shadow: 0 0 0 2px #52525b;
}

.lut-upload {
  display: flex;
  gap: 10px;
  align-items: center;
  color: #a1a1aa;
  font-size: 12px;
}

.lut-upload input {
  display: none;
}

:global(.image-tool-dialog) {
  max-width: calc(100vw - 48px);
  border: 1px solid #3f3f46;
  border-radius: 18px;
  background: #111113;
}

:global(.image-tool-dialog.immersive) {
  height: calc(100vh - 32px);
  margin: 0 auto;
}

:global(.image-tool-dialog .el-dialog__header) {
  margin: 0;
  padding: 20px 24px 16px;
  border-bottom: 1px solid #27272a;
}

:global(.image-tool-dialog .el-dialog__body) {
  height: calc(100% - 142px);
  max-height: none;
  padding: 20px 24px;
  overflow: auto;
}

:global(.image-tool-dialog .el-dialog__footer) {
  padding: 14px 24px 18px;
  border-top: 1px solid #27272a;
}

@media (max-width: 820px) {
  .image-editor-workspace {
    grid-template-columns: 1fr;
  }

  .preview-canvas {
    min-height: 300px;
  }
}
</style>
