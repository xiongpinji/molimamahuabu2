export const DIRECTOR_RESOURCE_STATUSES = ['idle', 'loading', 'ready', 'error']

const RESOURCE_STATUS_LABELS = {
  idle: '未加载',
  loading: '加载中',
  ready: '已就绪',
  error: '加载失败',
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || ''
}

/**
 * 将资产接口返回的 url/local_path/path 统一为浏览器可加载地址。
 * 相对路径只允许指向本地静态资源，避免把路径直接当成当前页面相对地址。
 */
export function resolveDirectorAssetUrl(asset) {
  const value = typeof asset === 'string'
    ? asset
    : firstString(asset?.url, asset?.local_path, asset?.path)
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  if (/^(?:https?:|blob:|data:|\/)/i.test(normalized)) return normalized
  return `/static/${normalized.replace(/^\/+/, '')}`
}

export function createDirectorResourceState(kind = 'model', asset = '') {
  return {
    kind: String(kind || 'model'),
    status: 'idle',
    url: resolveDirectorAssetUrl(asset),
    message: '',
  }
}

export function updateDirectorResourceState(current, patch = {}) {
  const nextStatus = patch.status === undefined ? current?.status : patch.status
  if (!DIRECTOR_RESOURCE_STATUSES.includes(nextStatus)) throw new Error('资源状态无效')
  return {
    kind: String(patch.kind || current?.kind || 'model'),
    status: nextStatus,
    url: patch.url === undefined ? String(current?.url || '') : resolveDirectorAssetUrl(patch.url),
    message: patch.message === undefined ? String(current?.message || '') : String(patch.message || ''),
  }
}

export function directorResourceStatusLabel(state) {
  return RESOURCE_STATUS_LABELS[state?.status] || RESOURCE_STATUS_LABELS.idle
}

function animationTrackTarget(track) {
  const raw = String(track?.name || '').split('.')[0]
  return raw.split(/[|/]/).pop().replace(/\[.*\]$/, '')
}

/**
 * 动作 GLB 必须至少有一个动画轨道能绑定到当前角色的对象树。
 * 这不是骨骼重定向，只是避免把明显不兼容的动作标成已加载。
 */
export function isDirectorAnimationCompatible(root, animations) {
  if (!root || !Array.isArray(animations) || !animations.length) return false
  const objectNames = new Set()
  root.traverse?.((object) => {
    if (object?.name) objectNames.add(String(object.name))
  })
  const tracks = animations.flatMap((clip) => Array.isArray(clip?.tracks) ? clip.tracks : [])
  return tracks.some((track) => {
    const target = animationTrackTarget(track)
    return Boolean(target) && (objectNames.has(target) || target === String(root.name || ''))
  })
}

const GLTF_MIME_TYPES = ['model/gltf-binary', 'model/gltf+json', 'application/octet-stream', 'application/json']

export async function loadDirectorGltf(loader, url, fetchImpl = fetch) {
  const response = await fetchImpl(url)
  if (response.status === 401 || response.status === 403) throw new Error(`无权限访问三维资源（${response.status}）`)
  if (response.status === 404) throw new Error('三维资源不存在（404）')
  if (!response.ok) throw new Error(`三维资源请求失败（${response.status}）`)
  const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !GLTF_MIME_TYPES.includes(contentType)) throw new Error(`三维资源 MIME 类型错误：${contentType}`)
  const buffer = await response.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const isGlb = bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
  let isJson = false
  if (!isGlb) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes))
      isJson = parsed?.asset?.version != null
    } catch (_) {}
  }
  if (!isGlb && !isJson) throw new Error('三维资源文件损坏或格式无效')
  const baseUrl = String(url).replace(/[^/]*([?#].*)?$/, '')
  try {
    return await loader.parseAsync(buffer, baseUrl)
  } catch (error) {
    throw new Error(`三维资源文件损坏或格式无效：${error?.message || '解析失败'}`)
  }
}
