import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const stageSource = readFileSync(fileURLToPath(new URL('../src/components/dramaCanvas/CanvasDirectorStage.vue', import.meta.url)), 'utf8')
const canvasSource = readFileSync(fileURLToPath(new URL('../src/views/DramaCanvas.vue', import.meta.url)), 'utf8')
const adapterSource = readFileSync(fileURLToPath(new URL('../src/utils/dramaCanvasAdapter.js', import.meta.url)), 'utf8')
const paritySource = readFileSync(fileURLToPath(new URL('../src/utils/director-parity.js', import.meta.url)), 'utf8')

test('DR-005 镜头可绑定持久化相机并驱动主相机', () => {
  assert.match(stageSource, /selectedShot\.cameraId/)
  assert.match(stageSource, /timeline\.value\.cameras\.find\(\(camera\) => camera\.id === shot\.cameraId\)/)
  assert.match(stageSource, /camera\.fov = Number\(boundCamera\.fov\)/)
  assert.match(stageSource, /const position = cameraObject\.transform\.position/)
  assert.match(stageSource, /const keepsTargetLocked = Boolean\(lookAtObject\) \|\| boundCamera\.lookAtMode === 'manual'/)
  assert.match(stageSource, /setCamera\(position, target, keepsTargetLocked \? null : boundCamera\.quaternion\)/)
  assert.match(stageSource, /camera\.quaternion\.set\(\.\.\.quaternion\)/)
})

test('DR-004 导演状态提供撤销重做并持久化恢复后的修订', () => {
  assert.match(stageSource, /const undoStack = ref\(\[\]\)/)
  assert.match(stageSource, /function undoDirector\(\)/)
  assert.match(stageSource, /function redoDirector\(\)/)
  assert.match(stageSource, /function persistHistoryState\(nextState\)/)
  assert.match(stageSource, /window\.addEventListener\('keydown', onDirectorKeydown\)/)
})

test('机位预设选择由状态控制且撤销重做后不会显示过期预设', () => {
  assert.match(stageSource, /const selectedCameraPresetName = ref\(''\)/)
  assert.match(stageSource, /aria-label="构图预设" :value="selectedCameraPresetName"/)
  assert.match(stageSource, /function resetSelectedCameraPreset\(\)/)
  assert.match(stageSource, /function undoDirector\(\)[\s\S]*?resetSelectedCameraPreset\(\)/)
  assert.match(stageSource, /function redoDirector\(\)[\s\S]*?resetSelectedCameraPreset\(\)/)
})

test('运动关键帧存在时不显示空轨道提示', () => {
  assert.match(stageSource, /v-if="!timeline\.tracks\.length && !timeline\.motionTracks\.length" class="timeline-empty"/)
})

test('DR-009 环境颜色、全景图和灯光参数连接真实场景', () => {
  assert.match(stageSource, /setBackgroundMap\(environment\.panoramaUrl, \{ setEnvironment: true \}\)/)
  assert.match(stageSource, /ambientLight\.intensity =/)
  assert.match(stageSource, /keyLight\.intensity =/)
  assert.match(stageSource, /@input="updateEnvironment\('ambientIntensity'/)
})

test('DR-003 分组对象在真实场景图中承载子对象', () => {
  assert.match(stageSource, /availableParentGroups/)
  assert.match(stageSource, /function updateObjectParent\(parentId\)/)
  assert.match(stageSource, /entry\.parentId \? stageObjects\.get/)
  assert.match(stageSource, /\(parent \|\| root\)\.add\(object\)/)
})

test('DR-002 项目场景、角色、道具和加载模型使用稳定场景键', () => {
  assert.match(stageSource, /stageObjects\.set\(`scene:\$\{scene\.id \|\| index\}`/)
  assert.match(stageSource, /entry\.type === 'humanoid' \|\| entry\.type === 'character'/)
  assert.match(stageSource, /characterObjects\.set\(entry\.assetRef\.characterId, humanoid\)/)
  assert.match(stageSource, /stageObjects\.set\(`prop:\$\{prop\.id \|\| index\}`/)
  assert.match(stageSource, /stageObjects\.set\(`custom:\$\{directorObject\?\.id/)
  assert.match(stageSource, /loadDirectorGltf\(loader, url\)/)
})

test('DR-007 骨骼树、关节旋转和刷新恢复连接导演状态', () => {
  assert.match(stageSource, /aria-label="骨骼姿态"/)
  assert.match(stageSource, /child\?\.isBone/)
  assert.match(stageSource, /function updateBoneRotation\(index, value\)/)
  assert.match(stageSource, /boneRotations:/)
  assert.match(stageSource, /applyBoneRotations\(normalizedId\)/)
  assert.match(stageSource, /模型不含骨骼/)
  assert.match(stageSource, /proceduralCharacterIds\.value\.has/)
  assert.match(stageSource, /proceduralCharacterIds\.value = new Set/)
})

test('DR-011 截图按哈希幂等上传并登记为项目领域资产', () => {
  assert.match(stageSource, /crypto\.subtle\.digest\('SHA-256'/)
  assert.match(stageSource, /uploadAPI\.uploadImage\(file, \{ dramaId \}\)/)
  assert.match(stageSource, /assetsAPI\.create\(\{/)
  assert.match(stageSource, /category: 'director-capture'/)
  assert.match(stageSource, /emit\('asset-created', asset\)/)
  assert.match(canvasSource, /projectImageAssets/)
  assert.match(canvasSource, /`project-asset:\$\{asset\.id\}`/)
  assert.match(adapterSource, /type: 'canvasProjectAsset'/)
  assert.match(adapterSource, /data: \{ asset \}/)
  assert.doesNotMatch(canvasSource, /temporary.*image/i)
})

test('G005 导演台提供完整机位预设与常用画幅比例', () => {
  assert.match(stageSource, /const CAMERA_PRESETS = \[/)
  for (const name of ['正面中景', '正面特写', '正面全景', '侧面跟拍', '侧面近景', '背面中景', '俯拍全景', '45° 俯拍', '低角度仰拍', '低角度广角', '过肩镜头', '过肩镜头 (右)', '鸟瞰', '荷兰角']) {
    assert.ok(paritySource.includes(name), `缺少机位预设：${name}`)
  }
  for (const ratio of ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']) assert.ok(stageSource.includes(ratio), `缺少画幅：${ratio}`)
  assert.match(stageSource, /applyCameraPreset/)
  assert.match(stageSource, /applyCameraAspect/)
})

test('G005 全局场景控件驱动真实场景根节点和地面网格', () => {
  for (const label of ['场景缩放', '场景平移', '场景旋转', '全景水平旋转', '全景球半径', '角色标签', '网格吸附', '地面吸附', '地面透明度', '地面高度']) {
    assert.ok(stageSource.includes(label), `缺少场景控件：${label}`)
  }
  assert.match(stageSource, /stageRoot\.position\.set/)
  assert.match(stageSource, /stageRoot\.rotation\.set/)
  assert.match(stageSource, /stageRoot\.scale\.setScalar/)
  assert.match(stageSource, /groundGrid\.visible/)
  assert.match(stageSource, /groundGrid\.material\.opacity/)
})

test('G005 时间轴支持持久化循环播放并在非循环结尾停止', () => {
  assert.match(stageSource, /aria-label="循环播放"/)
  assert.match(stageSource, /function toggleLoopPlayback/)
  assert.match(stageSource, /sequence\.loop/)
  assert.match(stageSource, /stopPlayback\(\)/)
  assert.match(stageSource, /next % duration\.value/)
})

test('G005 姿势预设和语义控制写入真实骨骼持久化状态', () => {
  for (const name of ['站立', 'T型', '行走', '跑步', '坐姿', '蹲下', '单膝跪', '双膝跪', '叉腰', '倚靠', '鞠躬', '思考', '格斗', '踢球', '投掷', '推', '招手', '指向', '抱臂', '看手机']) {
    assert.ok(stageSource.includes(`pose('${name}'`), `缺少姿势预设：${name}`)
  }
  for (const label of ['身体前倾', '身体转身', '身体侧倾', '躯干前倾', '躯干扭转', '躯干侧倾', '头部点头', '头部转头', '头部歪头']) {
    assert.ok(paritySource.includes(label), `缺少语义控制：${label}`)
  }
  assert.match(stageSource, /function resolveSemanticBone/)
  assert.match(stageSource, /function applyPosePreset/)
  assert.match(stageSource, /function persistBoneRotations/)
  assert.match(stageSource, /applyBoneRotations\(characterId\)/)
})

test('G005 自动关键帧驱动对象与绑定相机的插值运动', () => {
  assert.match(stageSource, /aria-label="自动关键帧"/)
  assert.match(stageSource, /aria-label="运动轨迹"/)
  assert.match(stageSource, /upsertMotionKeyframe/)
  assert.match(stageSource, /interpolateMotionTransform/)
  assert.match(stageSource, /object\.position\.set\(\.\.\.transform\.position\)/)
  assert.match(stageSource, /if \(activeCamera && timeline\.value\.sequence\.animationViewMode === 'follow'\)[\s\S]*?setCamera\(transform\.position, target\)/)
  assert.match(stageSource, /class="motion-keyframe"/)
})

test('G005 程序化角色库、空对象和群众阵列进入统一场景系统', () => {
  for (const label of ['标准素体', '女性素体', '宽厚素体', '壮实素体', '纤细素体', '少年素体', '儿童素体', '二头身', '+ 群众阵列', '+ 新建组']) {
    assert.ok(stageSource.includes(label), `缺少创建入口：${label}`)
  }
  assert.match(stageSource, /function makeHumanoidObject/)
  assert.match(stageSource, /function addRoleArchetype/)
  assert.match(stageSource, /function confirmCrowdArray/)
  assert.match(stageSource, /appendConfiguredCrowd/)
  assert.match(stageSource, /entry\.type === 'humanoid'/)
  assert.match(stageSource, /parentId: groupId/)
})

test('独立画布程序化角色进入角色列表并绑定动作播放对象', () => {
  assert.match(stageSource, /timeline\.value\.objects\.filter\(\(entry\) => entry\.type === 'humanoid'\)/)
  assert.match(stageSource, /entry\.assetRef\?\.characterId \|\| entry\.id/)
  assert.match(stageSource, /characterObjects\.set\(characterId, humanoid\)/)
})

test('DR-002 默认程序化角色使用光滑人体曲面而不是方块人偶', () => {
  assert.match(stageSource, /const makeEllipsoid =/)
  assert.match(stageSource, /const makeTapered =/)
  for (const anatomicalPart of ['chest', 'abdomen', 'pelvis', 'jaw', 'nose', 'hands', 'feet']) {
    assert.ok(stageSource.includes(anatomicalPart), `缺少人体部位：${anatomicalPart}`)
  }
  assert.doesNotMatch(stageSource, /const makeSegment = .*makeObject\('box'/)
})

test('G005 AI 识图导入连接真实识别、项目资产和可持久化场景对象', () => {
  for (const label of ['AI 识图导入', '开始识图', '识别描述', '导入 3D 场景', '导演台帮助']) {
    assert.ok(stageSource.includes(label), `缺少入口：${label}`)
  }
  assert.match(stageSource, /uploadAPI\.extractDescriptionFromImage/)
  assert.match(stageSource, /uploadAPI\.uploadImage/)
  assert.match(stageSource, /category: 'director-ai-reference'/)
  assert.match(stageSource, /assetsAPI\.create/)
  assert.match(stageSource, /description,/)
  assert.match(stageSource, /appendDirectorObject\(timeline\.value, objectType/)
})

test('G005 场景树支持搜索、显隐和持久化锁定', () => {
  assert.match(stageSource, /aria-label="搜索场景对象"/)
  assert.match(stageSource, /filteredDirectorObjects/)
  assert.match(stageSource, /toggleObjectVisibility/)
  assert.match(stageSource, /toggleObjectLock/)
  assert.match(stageSource, /selectedDirectorObject\.value\?\.locked/)
})

test('G005 相机支持跟随、注视目标、构图线和机位截图', () => {
  for (const label of ['相机跟随目标', '相机注视模式', '注视模式', '构图辅助线', '机位截图回写画布']) {
    assert.ok(stageSource.includes(label), `缺少相机交互：${label}`)
  }
  assert.match(stageSource, /boundCamera\.followTargetId/)
  assert.match(stageSource, /boundCamera\.lookAtTargetId/)
  assert.match(stageSource, /class="composition-guides"/)
  assert.match(stageSource, /@click="captureToCanvasAsset"/)
})

test('G005 视口变换工具写回对象状态且时间线支持缩放最小化', () => {
  for (const label of ['移动工具', '旋转工具', '缩放工具', '切换局部与世界坐标', '缩小时间线', '放大时间线', '最小化时间线']) {
    assert.ok(stageSource.includes(label), `缺少交互：${label}`)
  }
  assert.match(stageSource, /new TransformControlsPlugin\(true\)/)
  assert.match(stageSource, /transformControls\.addEventListener\('mouseUp', persistTransformControlChange\)/)
  assert.match(stageSource, /transformControls\.addEventListener\('mouseDown', rememberTransformControlStart\)/)
  assert.match(stageSource, /proportionalScaleFromAxis\(transformStartScale, object\.scale\.toArray\(\)\)/)
  assert.match(stageSource, /selectedObjectChanged', syncTransformSelection/)
  assert.match(stageSource, /setSelectedObject\?\.\(object, false\)/)
  assert.match(stageSource, /updateSelectedObject\(\{ transform:/)
})

test('人物任意子网格都归一到导演对象根节点后再移动和保存', () => {
  assert.match(stageSource, /function directorStageObjectForSelection\(object\)/)
  assert.match(stageSource, /return stageObjects\.get\(`custom:\$\{objectId\}`\) \|\| null/)
  assert.match(stageSource, /selectionFilterTest = \(object\) => directorStageObjectForSelection\(object\)/)
  assert.match(stageSource, /const object = directorStageObjectForSelection\(transformControls\?\.object\)/)
  assert.match(stageSource, /function restoreTransformSelection\(\)/)
  assert.match(stageSource, /pickingPlugin\?\.setSelectedObject\?\.\(object, false\)/)
})

test('摄影机角度控件驱动真实机位并完整持久化', () => {
  for (const label of ['方位角', '仰角', '机位距离', '横滚角']) {
    assert.ok(stageSource.includes(label), `缺少摄影机角度控件：${label}`)
  }
  assert.match(stageSource, /function updateCameraAngle\(field, value\)/)
  assert.match(stageSource, /cameraPositionFromAngles\(selectedCamera\.value\.target/)
  assert.match(stageSource, /cameraAnglesFromPosition\(preset\.position, preset\.target\)/)
  assert.match(stageSource, /quaternion:/)
})

test('灯光面板编辑真实独立光源并让三点布光创建三盏灯', () => {
  for (const label of ['灯光列表', '添加灯光', '硬光', '柔光', '方位角', '仰角', '灯光强度', '灯光颜色']) {
    assert.ok(stageSource.includes(label), `缺少灯光交互：${label}`)
  }
  assert.match(stageSource, /const selectedLightObject = computed/)
  assert.match(stageSource, /function updateSelectedLight\(field, value\)/)
  assert.match(stageSource, /preset\.lights\.map/)
  assert.match(stageSource, /new DirectionalLight\(entry\.light\.color, entry\.light\.intensity\)/)
  assert.match(stageSource, /\{[\s\S]*?name: '三点布光'[\s\S]*?lights:[\s\S]*?主光[\s\S]*?辅光[\s\S]*?轮廓光/)
})

test('G005 灯光、对象复制和镜头排序进入统一命令链', () => {
  for (const label of ['+ 添加灯光', '复制对象', '镜头前移', '镜头后移']) assert.ok(stageSource.includes(label), `缺少：${label}`)
  assert.match(stageSource, /entry\.type === 'light'/)
  assert.match(stageSource, /new DirectionalLight/)
  assert.match(stageSource, /duplicateDirectorObject/)
  assert.match(stageSource, /function moveSelectedShot\(direction\)/)
})

test('导演台可在播放头建立真实切点并选中新镜头', () => {
  assert.match(stageSource, /在播放头切开镜头/)
  assert.match(stageSource, /:disabled="!canSplitSelectedShot"/)
  assert.match(stageSource, /splitShotAtTime\(timeline\.value, selectedShot\.value\.id, currentTime\.value\)/)
  assert.match(stageSource, /selectedShotId\.value = next\.shots\[shotIndex \+ 1\]\.id/)
})

test('DR-013 导演台支持初始焦点、Esc 分层关闭、焦点圈闭与入口焦点返回', () => {
  assert.match(stageSource, /ref="dialogRef"[^>]+role="dialog"[^>]+tabindex="-1"/)
  assert.match(stageSource, /dialogRef\.value\?\.focus\(\)/)
  assert.match(stageSource, /if \(event\.key === 'Escape'\)/)
  assert.match(stageSource, /if \(aiImportOpen\.value\) aiImportOpen\.value = false/)
  assert.match(stageSource, /else if \(helpOpen\.value\) helpOpen\.value = false/)
  assert.match(stageSource, /else emit\('close'\)/)
  assert.match(stageSource, /if \(event\.key === 'Tab'\)/)
  assert.match(stageSource, /document\.activeElement === last/)
  assert.match(canvasSource, /directorReturnFocus = document\.activeElement/)
  assert.match(canvasSource, /directorReturnFocus\?\.focus\?\.\(\)/)
  assert.match(canvasSource, /@close="closeDirectorStage"/)
})

test('图片节点导演台入口显示当前参考图并保持其他入口兼容', () => {
  assert.match(stageSource, /entryContext: \{ type: Object, default: null \}/)
  assert.match(stageSource, /aria-label="图片节点参考图"/)
  assert.match(stageSource, /entryReferenceUrl/)
  assert.match(stageSource, /entryReferenceTitle/)
  assert.match(stageSource, /function applyEntryContext\(\)/)
  assert.match(canvasSource, /const directorStageEntry = ref\(null\)/)
  assert.match(canvasSource, /:entry-context="directorStageEntry"/)
  assert.match(canvasSource, /directorStageEntry\.value = DIRECTOR_STAGE_ENTRY_MODES\.has\(entryContext\?\.mode\)/)
  assert.match(canvasSource, /directorStageEntry\.value = null/)
})

test('图片节点灯光入口定位真实 3D 灯光控制且不修改原图', () => {
  assert.match(canvasSource, /const DIRECTOR_STAGE_ENTRY_MODES = new Set\(\['director_stage', 'lighting', 'angle', 'pose'\]\)/)
  assert.match(canvasSource, /DIRECTOR_STAGE_ENTRY_MODES\.has\(entryContext\?\.mode\)/)
  assert.match(stageSource, /const lightingEntry = computed\(\(\) => props\.entryContext\?\.mode === 'lighting'\)/)
  assert.match(stageSource, /3D 灯光预演，不直接修改原图/)
  assert.match(stageSource, /ref="environmentEditorRef"/)
  assert.match(stageSource, /if \(lightingEntry\.value\) \{[\s\S]*?const firstLight = lightObjects\.value\[0\][\s\S]*?else selectEnvironmentInspector\(\)/)
  assert.match(stageSource, /environmentEditorRef\.value\?\.scrollIntoView/)
  assert.match(stageSource, /环境光/)
  assert.match(stageSource, /方向光/)
  assert.match(stageSource, /if \(ambientLight\) ambientLight\.intensity/)
  assert.match(stageSource, /if \(keyLight\) keyLight\.intensity/)
})

test('图片节点角度入口定位真实机位控制且不静默创建机位', () => {
  assert.match(canvasSource, /const DIRECTOR_STAGE_ENTRY_MODES = new Set\(\['director_stage', 'lighting', 'angle', 'pose'\]\)/)
  assert.match(stageSource, /const angleEntry = computed\(\(\) => props\.entryContext\?\.mode === 'angle'\)/)
  assert.match(stageSource, /3D 机位角度预演，不直接修改原图/)
  assert.match(stageSource, /ref="addCameraButtonRef"/)
  assert.match(stageSource, /ref="cameraEditorRef"/)
  assert.match(stageSource, /findActiveCameraObject\(timeline\.value\)/)
  assert.match(stageSource, /if \(activeCameraObject\) selectSceneObject\(activeCameraObject\.id\)/)
  assert.match(stageSource, /if \(!angleEntry\.value\) return/)
  assert.match(stageSource, /if \(activeCameraObject\) cameraEditorRef\.value\?\.scrollIntoView/)
  assert.match(stageSource, /addCameraButtonRef\.value\?\.focus/)
  assert.doesNotMatch(stageSource, /if \(angleEntry\.value\)[\s\S]{0,220}addCamera\(\)/)
  assert.match(stageSource, /构图预设/)
  assert.match(stageSource, /视野 FOV/)
  assert.match(stageSource, /画幅比例/)
})

test('图片节点姿势入口定位真实 3D 角色骨骼且不静默创建角色', () => {
  assert.match(stageSource, /const poseEntry = computed\(\(\) => props\.entryContext\?\.mode === 'pose'\)/)
  assert.match(stageSource, /3D 角色姿势预演，不直接修改原图/)
  assert.match(stageSource, /ref="addRoleButtonRef"/)
  assert.match(stageSource, /ref="poseEditorRef"/)
  assert.match(stageSource, /\['character', 'humanoid'\]\.includes\(object\.type\)/)
  assert.match(stageSource, /if \(poseableObject\) selectSceneObject\(poseableObject\.id\)/)
  assert.match(stageSource, /if \(!poseEntry\.value\) return/)
  assert.match(stageSource, /if \(poseableObject\) poseEditorRef\.value\?\.focus/)
  assert.match(stageSource, /addRoleButtonRef\.value\?\.focus/)
  assert.doesNotMatch(stageSource, /if \(poseEntry\.value\)[\s\S]{0,260}addRoleArchetype\(/)
  assert.match(stageSource, /isSelectedProceduralCharacter \|\| selectedModelResourceState\.status === 'ready'/)
  assert.match(stageSource, /persistPoseRotations/)
  assert.match(stageSource, /poseRotations/)
})

test('DR-014 导演台卸载显式释放监听器、播放帧、场景对象和查看器', () => {
  assert.match(stageSource, /removeEventListener\('keydown', onDirectorKeydown\)/)
  assert.match(stageSource, /transformControls\?\.removeEventListener\?\.\('mouseUp', persistTransformControlChange\)/)
  assert.match(stageSource, /pickingPlugin\?\.removeEventListener\?\.\('selectedObjectChanged', syncTransformSelection\)/)
  assert.match(stageSource, /stopPlayback\(\)/)
  assert.match(stageSource, /clearStageObjects\(\)/)
  assert.match(stageSource, /viewer\.value\?\.dispose\?\.\(true\)/)
  assert.match(stageSource, /URL\.revokeObjectURL\(aiImportPreview\.value\)/)
})

test('导演台提供人物创建、女性体型切换与自由旋转入口', () => {
  assert.match(stageSource, /@click="addRoleArchetype\(ROLE_ARCHETYPES\[0\]\)">\+ 人物/)
  assert.match(stageSource, /v-for="role in \[ROLE_ARCHETYPES\[0\], ROLE_ARCHETYPES\[1\]/)
  assert.match(stageSource, /\{ mode: 'rotate', label: '旋转工具'/)
  assert.match(stageSource, /:aria-label="tool\.label" @click="setTransformMode\(tool\.mode\)"/)
})
