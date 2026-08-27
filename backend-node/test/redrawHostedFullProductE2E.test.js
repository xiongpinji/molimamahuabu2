const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const frontendPackage = JSON.parse(readFileSync(
  path.resolve(__dirname, '../../frontweb/package.json'),
  'utf8',
))
const frontendWorkflow = readFileSync(
  path.resolve(__dirname, '../../.github/workflows/frontend-e2e.yml'),
  'utf8',
)
const backendWorkflow = readFileSync(
  path.resolve(__dirname, '../../.github/workflows/backend-node-tests.yml'),
  'utf8',
)

test('前端必须提供串行运行通用整集产品链的独立 E2E 命令', () => {
  assert.equal(
    frontendPackage.scripts['test:e2e:redraw-full-product'],
    'playwright test e2e/redraw-full-product.spec.js --workers=1',
  )
})

test('Hosted Canvas E2E 必须以零真实供应商模式运行通用整集产品链', () => {
  assert.match(frontendWorkflow, /name: Run redraw full product E2E/)
  assert.match(frontendWorkflow, /REDRAW_E2E_FAKE_PROVIDER:\s*'1'/)
  assert.match(frontendWorkflow, /run: npm run test:e2e:redraw-full-product/)
})

test('修改 Hosted Canvas E2E 工作流时必须触发后端合同测试', () => {
  assert.match(backendWorkflow, /- '\.github\/workflows\/frontend-e2e\.yml'/)
})
