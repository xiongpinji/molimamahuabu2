import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { fulfillEmptyProjectAssets, fulfillMockDrama } from './mockDrama.js'

const screenshotPath = fileURLToPath(new URL('../../.omx/evidence/local/20260717/smooth-humanoid.png', import.meta.url))

test.use({ viewport: { width: 1440, height: 900 } })

test('DR-002 默认角色渲染为光滑关节人形', async ({ page }) => {
  await page.route('**/api/v1/assets?**', (route) => fulfillEmptyProjectAssets(route))
  await page.route('**/api/v1/dramas/3', async (route) => {
    await fulfillMockDrama(route, {
      version: 2,
      sequence: { duration: 4, fps: 24 },
      shots: [{ id: 'visual-shot', name: '人形验收', camera: 'director', transition: 'cut', start: 0, duration: 4 }],
      objects: [{
        id: 'project-character:character-a', type: 'character', name: '角色A', visible: true, locked: false,
        assetRef: { kind: 'project-character', characterId: 'character-a' },
        poseRotations: { spine: [0.087, 0, 0], leftShoulder: [-0.436, 0, 0], rightShoulder: [0.436, 0, 0], leftHip: [0.436, 0, 0], rightHip: [-0.349, 0, 0], rightKnee: [0.436, 0, 0] },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }], cameras: [], tracks: [], characterAssets: {}, motionTracks: [],
      environment: { backgroundColor: '#08090c', sceneScale: 1.5, scenePosition: [0, 0, 0], sceneRotation: [0, 0, 0], showGround: true, groundOpacity: 0.42, groundHeight: 0 },
    }, { characters: [{ id: 'character-a', name: '角色A' }] })
  })

  await page.goto('/film/3/canvas')
  await page.getByRole('button', { name: '打开 3D 导演台' }).click()
  await page.getByRole('button', { name: '角色A character' }).click()
  await expect(page.locator('.stage-tree-row')).toHaveCount(1)
  await page.locator('.director-stage__viewport').screenshot({ path: screenshotPath })
})
