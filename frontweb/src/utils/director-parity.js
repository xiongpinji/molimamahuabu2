import {
  appendDirectorObject,
  normalizeDirectorTimeline,
} from './directorTimeline.js'

export const DIRECTOR_PROP_ASSETS = [
  { name: '椅子', type: 'box', scale: [0.55, 0.9, 0.55] },
  { name: '方桌', type: 'box', scale: [1.25, 0.75, 1.25] },
  { name: '圆桌', type: 'sphere', scale: [1.15, 0.22, 1.15] },
  { name: '沙发', type: 'box', scale: [1.8, 0.75, 0.8] },
  { name: '墙段 2m', type: 'box', scale: [2, 2.4, 0.12] },
  { name: '墙段 3m', type: 'box', scale: [3, 2.4, 0.12] },
  { name: '柱子', type: 'box', scale: [0.45, 2.6, 0.45] },
  { name: '楼梯段', type: 'box', scale: [1.8, 0.8, 2.4] },
  { name: '小树', type: 'sphere', scale: [0.85, 1.8, 0.85] },
  { name: '大树', type: 'sphere', scale: [1.35, 3.1, 1.35] },
  { name: '石头', type: 'sphere', scale: [0.85, 0.55, 0.7] },
  { name: '灌木', type: 'sphere', scale: [1.2, 0.65, 0.9] },
  { name: '轿车', type: 'box', scale: [1.8, 0.7, 4.2] },
  { name: '自行车', type: 'box', scale: [0.18, 1.1, 1.7] },
  { name: '路灯', type: 'box', scale: [0.22, 3.8, 0.22] },
  { name: '长椅', type: 'box', scale: [1.9, 0.7, 0.65] },
  { name: '垃圾桶', type: 'box', scale: [0.55, 0.8, 0.55] },
  { name: '方向箭头', type: 'box', scale: [1.4, 0.08, 0.45] },
  { name: '区域标记', type: 'box', scale: [2, 0.04, 2] },
  { name: '图片板', type: 'box', scale: [1.6, 1.1, 0.08] },
]

export const DIRECTOR_CAMERA_ASSETS = [
  { name: '正面中景', position: [0, 1.6, 4.8], target: [0, 1.1, 0], fov: 50 },
  { name: '正面特写', position: [0, 1.65, 2.4], target: [0, 1.45, 0], fov: 42 },
  { name: '正面全景', position: [0, 2.2, 8.2], target: [0, 1, 0], fov: 58 },
  { name: '侧面跟拍', position: [5.2, 1.7, 0.8], target: [0, 1.1, 0], fov: 50 },
  { name: '侧面近景', position: [3.1, 1.65, 0.4], target: [0, 1.35, 0], fov: 42 },
  { name: '背面中景', position: [0, 1.7, -4.8], target: [0, 1.1, 0], fov: 50 },
  { name: '俯拍全景', position: [0, 8, 5], target: [0, 0, 0], fov: 58 },
  { name: '45° 俯拍', position: [5, 5, 5], target: [0, 1, 0], fov: 50 },
  { name: '低角度仰拍', position: [0, 0.35, 3.8], target: [0, 1.55, 0], fov: 48 },
  { name: '低角度广角', position: [0, 0.25, 5], target: [0, 1.4, 0], fov: 72 },
  { name: '过肩镜头', position: [-1.25, 1.65, 2.4], target: [0, 1.4, 0], fov: 42 },
  { name: '过肩镜头 (右)', position: [1.25, 1.65, 2.4], target: [0, 1.4, 0], fov: 42 },
  { name: '鸟瞰', position: [0, 10, 0.01], target: [0, 0, 0], fov: 55 },
  { name: '荷兰角', position: [3.8, 2, 4.4], target: [0, 1.1, 0], fov: 50, roll: -16 },
  { name: '远景跟踪', position: [7.5, 3.1, 10], target: [0, 1, 0], fov: 62 },
  { name: 'POV 第一视角', position: [0, 1.65, 0.2], target: [0, 1.65, -4], fov: 68 },
]

export const DIRECTOR_PERSON_ASSETS = [
  { name: '标准素体', kind: 'male' },
  { name: '女性素体', kind: 'female' },
  { name: '儿童素体', kind: 'child' },
  { name: '壮实素体', kind: 'muscular' },
  { name: '纤细素体', kind: 'slim' },
  { name: '群众 (3人)', crowd: 3 },
  { name: '群众 (5人)', crowd: 5 },
]

export const DIRECTOR_POSE_CONTROLS = [
  { label: '身体前倾', semantic: 'root', axis: 0, min: -45, max: 45 }, { label: '身体转身', semantic: 'root', axis: 1, min: -90, max: 90 }, { label: '身体侧倾', semantic: 'root', axis: 2, min: -45, max: 45 },
  { label: '躯干前倾', semantic: 'spine', axis: 0, min: -45, max: 45 }, { label: '躯干扭转', semantic: 'spine', axis: 1, min: -60, max: 60 }, { label: '躯干侧倾', semantic: 'spine', axis: 2, min: -45, max: 45 },
  { label: '头部点头', semantic: 'head', axis: 0, min: -60, max: 60 }, { label: '头部转头', semantic: 'head', axis: 1, min: -90, max: 90 }, { label: '头部歪头', semantic: 'head', axis: 2, min: -45, max: 45 },
  { label: '左肩前举', semantic: 'leftShoulder', axis: 0, min: -120, max: 120 }, { label: '左肩外展', semantic: 'leftShoulder', axis: 2, min: -150, max: 150 }, { label: '左肩扭转', semantic: 'leftShoulder', axis: 1, min: -120, max: 120 },
  { label: '右肩前举', semantic: 'rightShoulder', axis: 0, min: -120, max: 120 }, { label: '右肩外展', semantic: 'rightShoulder', axis: 2, min: -150, max: 150 }, { label: '右肩扭转', semantic: 'rightShoulder', axis: 1, min: -120, max: 120 },
  { label: '左肘弯曲', semantic: 'leftElbow', axis: 0, min: 0, max: 150 }, { label: '右肘弯曲', semantic: 'rightElbow', axis: 0, min: 0, max: 150 },
  { label: '左腕屈伸', semantic: 'leftWrist', axis: 0, min: -90, max: 90 }, { label: '左腕旋转', semantic: 'leftWrist', axis: 1, min: -120, max: 120 },
  { label: '右腕屈伸', semantic: 'rightWrist', axis: 0, min: -90, max: 90 }, { label: '右腕旋转', semantic: 'rightWrist', axis: 1, min: -120, max: 120 },
  { label: '左髋前抬', semantic: 'leftHip', axis: 0, min: -90, max: 120 }, { label: '左髋外展', semantic: 'leftHip', axis: 2, min: -90, max: 90 }, { label: '左髋扭转', semantic: 'leftHip', axis: 1, min: -90, max: 90 },
  { label: '右髋前抬', semantic: 'rightHip', axis: 0, min: -90, max: 120 }, { label: '右髋外展', semantic: 'rightHip', axis: 2, min: -90, max: 90 }, { label: '右髋扭转', semantic: 'rightHip', axis: 1, min: -90, max: 90 },
  { label: '左膝弯曲', semantic: 'leftKnee', axis: 0, min: 0, max: 150 }, { label: '右膝弯曲', semantic: 'rightKnee', axis: 0, min: 0, max: 150 },
  { label: '左踝勾绷', semantic: 'leftAnkle', axis: 0, min: -75, max: 75 }, { label: '左踝内外翻', semantic: 'leftAnkle', axis: 2, min: -60, max: 60 },
  { label: '右踝勾绷', semantic: 'rightAnkle', axis: 0, min: -75, max: 75 }, { label: '右踝内外翻', semantic: 'rightAnkle', axis: 2, min: -60, max: 60 },
]

export function isDirectorTouchpadGesture(event = {}) {
  const deltaX = Math.abs(Number(event.deltaX) || 0)
  const deltaY = Math.abs(Number(event.deltaY) || 0)
  return deltaX > 0 || (Number(event.deltaMode) === 0 && deltaY > 0 && deltaY < 50)
}

const CROWD_ROLE_KINDS = ['male', 'female', 'child', 'muscular', 'slim']

export function appendConfiguredCrowd(state, options = {}) {
  const rows = Math.max(1, Math.min(12, Math.floor(Number(options.rows) || 3)))
  const columns = Math.max(1, Math.min(12, Math.floor(Number(options.columns) || 3)))
  const spacing = Math.max(0.5, Math.min(6, Number(options.spacing) || 1.2))
  const current = normalizeDirectorTimeline(state)
  const groupNumber = current.objects.filter((object) => object.type === 'group' && object.name.startsWith('群众组')).length + 1
  let next = appendDirectorObject(current, 'group', {
    name: `群众组${groupNumber}`,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  })
  const groupId = next.objects.at(-1).id
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column
      next = appendDirectorObject(next, 'humanoid', {
        name: `群众${index + 1}`,
        parentId: groupId,
        assetRef: { assetId: null, url: '', kind: CROWD_ROLE_KINDS[index % CROWD_ROLE_KINDS.length] },
        transform: {
          position: [(column - (columns - 1) / 2) * spacing, 0, (row - (rows - 1) / 2) * spacing],
          rotation: [0, 0, 0],
          scale: [0.9, 0.9, 0.9],
        },
      })
    }
  }
  return normalizeDirectorTimeline(next)
}

export function releaseDirectorGroup(state, groupId) {
  const current = normalizeDirectorTimeline(state)
  const targetId = String(groupId || '')
  const group = current.objects.find((object) => object.id === targetId && object.type === 'group')
  if (!group) return current
  const objects = current.objects
    .filter((object) => object.id !== targetId)
    .map((object) => object.parentId === targetId ? {
      ...object,
      parentId: group.parentId || '',
      transform: {
        ...object.transform,
        position: object.transform.position.map((value, index) => value + group.transform.position[index]),
      },
    } : object)
  return normalizeDirectorTimeline({ ...current, objects, revision: current.revision + 1 })
}
