import { ref } from 'vue'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'

/**
 * 加载当前剧集分镜的 images / videos 列表（与 FilmCreate.loadStoryboardMedia 对齐）
 *
 * 优化点：
 * 1. 缓存去重：相同 storyboard_ids 集合在 30 秒内复用结果，避免重复请求
 * 2. 批量并发控制：最多同时 6 个分镜请求，防止雪崩
 * 3. 命中缓存时立即展示，后台静默刷新
 */
export function useCanvasStoryboardMedia() {
  const imagesBySbId = ref({})
  const videosBySbId = ref({})
  const mediaLoading = ref(false)

  const cacheStore = new Map()
  const CACHE_TTL = 30 * 1000
  const MAX_CONCURRENT = 6

  function buildCacheKey(sbIds) {
    return [...sbIds].sort((a, b) => a - b).join(',')
  }

  function isCacheValid(entry) {
    return entry && Date.now() - entry.timestamp < CACHE_TTL
  }

  async function fetchForStoryboard(sbId) {
    try {
      const [imgRes, vidRes] = await Promise.all([
        imagesAPI.list({ storyboard_id: sbId, page: 1, page_size: 100 }),
        videosAPI.list({ storyboard_id: sbId, page: 1, page_size: 50 }),
      ])
      return {
        images: imgRes?.items || [],
        videos: vidRes?.items || [],
      }
    } catch (_) {
      return { images: [], videos: [] }
    }
  }

  async function batchLoadWithLimit(items, limit, worker) {
    const results = new Array(items.length)
    let cursor = 0
    async function runner() {
      while (cursor < items.length) {
        const idx = cursor++
        results[idx] = await worker(items[idx])
      }
    }
    const runners = Array.from({ length: Math.min(limit, items.length) }, runner)
    await Promise.all(runners)
    return results
  }

  async function refreshInBackground(sbIds, cacheKey) {
    try {
      const fetchedData = await batchLoadWithLimit(sbIds, MAX_CONCURRENT, fetchForStoryboard)
      const imagesById = {}
      const videosById = {}
      sbIds.forEach((sbId, idx) => {
        imagesById[sbId] = fetchedData[idx].images
        videosById[sbId] = fetchedData[idx].videos
      })
      cacheStore.set(cacheKey, {
        timestamp: Date.now(),
        data: { imagesById, videosById },
      })
      const nextImages = { ...imagesBySbId.value }
      const nextVideos = { ...videosBySbId.value }
      sbIds.forEach((sbId) => {
        nextImages[sbId] = imagesById[sbId]
        nextVideos[sbId] = videosById[sbId]
      })
      imagesBySbId.value = nextImages
      videosBySbId.value = nextVideos
    } catch (_) {
      // 静默失败
    }
  }

  async function loadForStoryboards(storyboards) {
    const boards = storyboards || []
    if (!boards.length) {
      imagesBySbId.value = {}
      videosBySbId.value = {}
      return
    }

    const sbIds = boards.map((sb) => Number(sb.id)).filter(Number.isFinite)
    const cacheKey = buildCacheKey(sbIds)
    const cached = cacheStore.get(cacheKey)
    if (isCacheValid(cached)) {
      const cachedImages = {}
      const cachedVideos = {}
      for (const sbId of sbIds) {
        cachedImages[sbId] = cached.data.imagesById?.[sbId] || []
        cachedVideos[sbId] = cached.data.videosById?.[sbId] || []
      }
      imagesBySbId.value = cachedImages
      videosBySbId.value = cachedVideos
      refreshInBackground(sbIds, cacheKey).catch(() => {})
      return
    }

    mediaLoading.value = true
    try {
      const nextImages = { ...imagesBySbId.value }
      const nextVideos = { ...videosBySbId.value }
      const fetchedData = await batchLoadWithLimit(sbIds, MAX_CONCURRENT, fetchForStoryboard)
      const imagesById = {}
      const videosById = {}
      sbIds.forEach((sbId, idx) => {
        const data = fetchedData[idx]
        nextImages[sbId] = data.images
        nextVideos[sbId] = data.videos
        imagesById[sbId] = data.images
        videosById[sbId] = data.videos
      })
      imagesBySbId.value = nextImages
      videosBySbId.value = nextVideos
      cacheStore.set(cacheKey, {
        timestamp: Date.now(),
        data: { imagesById, videosById },
      })
    } finally {
      mediaLoading.value = false
    }
  }

  function invalidateCache() {
    cacheStore.clear()
  }

  async function loadForDrama(drama, episodeId = null) {
    const episodes = episodeId
      ? (drama?.episodes || []).filter((ep) => ep.id === episodeId)
      : (drama?.episodes || [])
    const boards = episodes.flatMap((ep) => ep.storyboards || [])
    await loadForStoryboards(boards)
  }

  return {
    imagesBySbId,
    videosBySbId,
    mediaLoading,
    loadForStoryboards,
    loadForDrama,
    invalidateCache,
  }
}
