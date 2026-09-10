import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, compileStyle, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import * as workspaceState from '../src/utils/redrawWorkspaceState.js'

// Budget assertions render the real Overview SFC. CSS/template contracts below
// establish structure only, not browser geometry, actual colors or accessibility.
function descriptor(relative) {
  const result = parse(readFileSync(new URL(relative, import.meta.url), 'utf8'), { filename: relative })
  assert.deepEqual(result.errors, [])
  return result.descriptor
}

function compiledStyle(component) {
  assert.equal(component.styles.length, 1)
  assert.equal(component.styles[0].scoped, true)
  const result = compileStyle({ source: component.styles[0].content, filename: component.filename,
    id: 'data-v-entry-test', scoped: true })
  assert.deepEqual(result.errors, [])
  return result.code
}

const overview = descriptor('../src/components/redraw/RedrawProjectOverview.vue')
const script = compileScript(overview, { id: 'entry-overview', inlineTemplate: true })
const modules = { vue, '@/utils/redrawWorkspaceState': workspaceState }
const code = script.content.replace(/^import\s+(\{[^}]*\})\s+from\s+(['"])([^'"\r\n]+)\2\s*;?/gm,
  (_whole, names, _quote, specifier) => {
    assert.ok(Object.hasOwn(modules, specifier), `unapproved Overview import: ${specifier}`)
    return `const ${names.replace(/\s+as\s+/g, ':')} = modules[${JSON.stringify(specifier)}];\n`
  })
assert.doesNotMatch(code, /^import\s/m)
const Overview = new Function('modules', code.replace('export default', 'return'))(modules)

function textOf(node) {
  return (node.text || '') + (node.children || []).map(textOf).join('')
}

function renderOverview(project) {
  const renderer = vue.createRenderer({
    createElement: tag => ({ tag, children: [], parent: null }),
    createText: text => ({ text }), createComment: () => ({}),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _old, value) => { node[key] = value },
    parentNode: node => node.parent, nextSibling: () => null,
    insert(node, parent) { node.parent = parent; parent.children.push(node) },
    remove(node) { node.parent?.children.splice(node.parent.children.indexOf(node), 1) },
  })
  const root = { children: [] }, app = renderer.createApp(Overview, { project })
  app.config.warnHandler = message => { throw Error(`Overview Vue warning: ${message}`) }
  app.config.errorHandler = error => { throw error }
  try {
    app.mount(root)
    const grid = root.children[0].children.find(node => node.class === 'overview-grid')
    assert.ok(grid, 'real Overview must render its policy/credits grid')
    return Object.fromEntries(grid.children.map(card => [textOf(card.children[0]), textOf(card.children[1])]))
  } finally { app.unmount() }
}

for (const [name, value] of [['null', null], ['undefined', undefined], ['empty', ''], ['whitespace', ' \t\n ']]) {
  test(`real Overview renders ${name} budget as unset`, () => {
    const cards = renderOverview({ effective_policy: { budget_limit_credits: value }, spent_credits: 0, reserved_credits: 0 })
    assert.equal(cards['预算上限'], '未设置')
    assert.equal(cards['已用积分'], '0 积分')
    assert.equal(cards['预留积分'], '0 积分')
  })
}

for (const [value, expected] of [[0, '0 积分'], ['0', '0 积分'], [25, '25 积分'], ['75', '75 积分'], [12.5, '12.5 积分']]) {
  test(`real Overview preserves numeric budget ${JSON.stringify(value)}`, () => {
    assert.equal(renderOverview({ policy: { budget_limit_credits: value } })['预算上限'], expected)
  })
}

test('real Overview keeps invalid and absent budgets unset', () => {
  for (const value of ['not-a-number', NaN, Infinity]) {
    assert.equal(renderOverview({ budget_limit_credits: value })['预算上限'], '未设置')
  }
  assert.equal(renderOverview({})['预算上限'], '未设置')
})

test('create dialog labels use a direct-child theme token without recoloring nested control spans', () => {
  const component = descriptor('../src/views/RedrawProjectList.vue')
  const css = compiledStyle(component)
  assert.match(component.template.content, /<el-dialog\b[^>]*title="新建转绘项目"/)
  assert.match(css, /\.create-field\s*>\s*span\[data-v-entry-test\]\s*\{[^}]*color:\s*var\(--el-text-color-regular\)/)
  assert.doesNotMatch(css, /\.create-field\s+span(?:\[|\s*\{)/)
})

test('source grid has two shrinkable columns and a full-row dedicated aspect-ratio field', () => {
  const component = descriptor('../src/components/redraw/RedrawSourceStep.vue')
  const css = compiledStyle(component)
  assert.match(css, /\.source-grid\[data-v-entry-test\]\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(component.template.content, /<label\s+class="field field--aspect-ratio">\s*<span>输出比例<\/span>\s*<el-segmented\s+v-model="aspectRatio"\s+:options="aspectRatioOptions"\s*\/>\s*<\/label>/)
  assert.match(css, /\.field--aspect-ratio\[data-v-entry-test\]\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/)
  assert.match(css, /@media\s*\(max-width:\s*920px\)\s*\{\s*\.source-grid\[data-v-entry-test\]\s*\{\s*grid-template-columns:\s*1fr/)
  assert.match(component.scriptSetup.content, /const aspectRatioOptions = \['1:1', '9:16', '16:9', '3:4', '4:3', '21:9'\]/)
  assert.doesNotMatch(css, /overflow:\s*hidden|text-overflow:\s*ellipsis/)
})

for (const [relative, tagClass, parentClass] of [
  ['../src/views/RedrawWorkspace.vue', 'redraw-workspace__status-tag', 'redraw-workspace__heading'],
  ['../src/components/redraw/RedrawSourceStep.vue', 'source-work-tag', 'section-heading'],
]) {
  test(`${tagClass} owns a scoped foreground/background stronger than the light-theme span selector`, () => {
    const component = descriptor(relative), css = compiledStyle(component)
    assert.match(component.template.content, new RegExp(`<el-tag\\b[^>]*class="${tagClass}"`))
    const rule = css.match(new RegExp(`\\.${parentClass}\\s+\\.${tagClass}\\[data-v-entry-test\\]\\s*\\{([^}]*)\\}`))
    assert.ok(rule, 'two local classes plus the scope attribute outrank html.light span structurally')
    assert.match(rule[1], /(?:^|;)\s*color:\s*#[\da-fA-F]{3,6}\s*;/)
    assert.match(rule[1], /(?:^|;)\s*background:\s*#[\da-fA-F]{3,6}\s*;/)
    assert.match(rule[1], /(?:^|;)\s*border-color:\s*#[\da-fA-F]{3,6}\s*;/)
  })
}
