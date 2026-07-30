import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../src/views/DramaCanvas.vue', import.meta.url), 'utf8')

test('canvas wires connection drag start and end events', () => {
  assert.match(source, /@connect-start="onConnectStart"/)
  assert.match(source, /@connect-end="onConnectEnd"/)
  assert.match(source, /resolveCanvasConnectionDrop/)
})

test('blank connection drop keeps source until the created node is connected', () => {
  assert.match(source, /contextMenuConnectionSource/)
  assert.match(source, /if \(drop\?\.kind === 'create'\) \{\s*suppressPaneClick\(\)/)
  assert.match(source, /await createFreeCanvasNode\(type, flowPosition\)/)
  assert.match(source, /source:\s*connectionSource\.sourceNodeId/)
  assert.match(source, /target:\s*nodeId/)
})
