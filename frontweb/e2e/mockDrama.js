export function createMockDrama(directorTimeline = null, overrides = {}) {
  return {
    id: 3,
    title: '画布导演台回归项目',
    metadata: {
      canvas_layout: directorTimeline ? { director_timeline: directorTimeline } : {},
    },
    characters: [
      { id: 'character-a', name: '角色A' },
      { id: 'character-b', name: '角色B' },
    ],
    scenes: [],
    props: [],
    episodes: [],
    ...overrides,
  }
}

export async function fulfillMockDrama(route, directorTimeline = null, overrides = {}) {
  if (route.request().method() !== 'GET') return route.continue()
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: createMockDrama(directorTimeline, overrides) }),
  })
}

export async function fulfillEmptyProjectAssets(route) {
  if (route.request().method() !== 'GET') return route.continue()
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ success: true, data: { items: [], total: 0 } }),
  })
}
