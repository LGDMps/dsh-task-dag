/**
 * Tests for the automatic task-description upkeep.
 *
 * The tracker folds each user message in a node's current session into a marked
 * section at the end of the node's task description. It exists because relying
 * only on the Agent calling `graph_update_node` proved unreliable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GraphStore } from '../src/store.js'
import { emptyGraph, nowIso } from '../src/model.js'
import {
  AUTO_DESCRIPTION_HEADING,
  handleSessionEvent,
  mergeAutoDescription,
  startDescriptionTracker,
} from '../src/description.js'

function userEvent(text, sourceKind = 'user') {
  return {
    type: 'user/message',
    data: {
      source: { kind: sourceKind },
      content: [{ type: 'text', text }],
    },
  }
}

async function makeWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'task-dag-desc-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const workspace = { workspaceId: 'ws_desc', path: dir, title: '描述测试', sessionIds: ['s_active', 's_old'] }
  const store = new GraphStore()
  const now = nowIso()
  const graph = emptyGraph({ workspaceId: workspace.workspaceId, workspacePath: dir, title: workspace.title })
  graph.nodes = [{
    id: 'n_1',
    title: '导出功能',
    status: 'todo',
    notes: '人工写下的背景。',
    conditions: [],
    sessions: [
      {
        sessionId: 's_old',
        slot: 1,
        titleSnapshot: '导出功能',
        attachedAt: now,
        retiredAt: now,
        handoff: { from: null, mode: 'manual' },
      },
      {
        sessionId: 's_active',
        slot: 2,
        titleSnapshot: '导出功能 · 续',
        attachedAt: now,
        retiredAt: null,
        handoff: { from: 's_old', mode: 'brief' },
      },
    ],
    position: null,
    agentPreset: null,
    model: null,
    reasoningEffort: null,
    schedule: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    failedAt: null,
  }]
  await store.commit(workspace, 0, () => ({ next: graph, event: { type: 'test/seed' } }))
  return { dir, workspace, store }
}

function makeContext(dir, handlers) {
  return {
    workspaceRegistry: { list: () => [{ id: 'ws_desc', path: dir, title: '描述测试', sessionIds: ['s_active', 's_old'] }] },
    sessions: { get: () => ({ header: { cwd: dir } }) },
    on(name, handler, options) {
      handlers.push({ name, handler, options })
      return () => {}
    },
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the description update')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('mergeAutoDescription keeps human text and appends a bounded request log', () => {
  const first = mergeAutoDescription('人工写下的背景。', '新增导出 CSV 的需求')
  assert.ok(first.startsWith('人工写下的背景。'))
  assert.ok(first.includes(AUTO_DESCRIPTION_HEADING))
  assert.ok(first.includes('- 新增导出 CSV 的需求'))

  assert.equal(mergeAutoDescription(first, '新增导出 CSV 的需求'), first, 'a repeated last message is a no-op')
  assert.equal(mergeAutoDescription(first, '# 交接简报：旧任务'), first, 'plugin briefs are ignored')
  assert.equal(mergeAutoDescription(first, '/compact'), first, 'slash commands are ignored')

  // An inline mention of the heading must not be mistaken for the auto section.
  const inline = '说明：内容会放进「' + AUTO_DESCRIPTION_HEADING + '」小节。\n\n尾注。'
  const inlineMerged = mergeAutoDescription(inline, '新增筛选需求')
  assert.ok(inlineMerged.startsWith(inline), 'inline heading mentions are preserved')
  assert.ok(
    inlineMerged.endsWith(AUTO_DESCRIPTION_HEADING + '\n- 新增筛选需求'),
    'the real section is appended at the end',
  )

  let notes = first
  for (let index = 0; index < 10; index += 1) {
    notes = mergeAutoDescription(notes, '需求 ' + String(index))
  }
  const bullets = notes.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(bullets.length, 6, 'only the latest six requests are kept')
  assert.ok(notes.includes('需求 9'))
  assert.equal(notes.includes('需求 0'), false, 'old entries roll off')
})

test('a user message updates only the current session node description', async (t) => {
  const { dir, workspace, store } = await makeWorkspace(t)
  const ctx = makeContext(dir, [])

  const changed = await handleSessionEvent(ctx, store, { id: 's_active' }, userEvent('新增导出 CSV 的需求'))
  assert.equal(changed, true)
  let notes = store.read(workspace).graph.nodes[0].notes
  assert.ok(notes.startsWith('人工写下的背景。'))
  assert.ok(notes.includes(AUTO_DESCRIPTION_HEADING))
  assert.ok(notes.includes('- 新增导出 CSV 的需求'))

  await handleSessionEvent(ctx, store, { id: 's_active' }, userEvent('还要支持按日期筛选'))
  notes = store.read(workspace).graph.nodes[0].notes
  assert.ok(notes.includes('- 新增导出 CSV 的需求'))
  assert.ok(notes.includes('- 还要支持按日期筛选'))

  const retiredChanged = await handleSessionEvent(ctx, store, { id: 's_old' }, userEvent('旧会话里的消息'))
  assert.equal(retiredChanged, false, 'retired sessions do not rewrite the current description')
  assert.equal(store.read(workspace).graph.nodes[0].notes.includes('旧会话里的消息'), false)

  const ignored = await handleSessionEvent(ctx, store, { id: 's_active' }, userEvent('new requirement', 'agent'))
  assert.equal(ignored, false, 'only user-sourced messages are recorded')
})

test('startDescriptionTracker wires session/event and can be disposed', async (t) => {
  const { dir, workspace, store } = await makeWorkspace(t)
  const handlers = []
  const ctx = makeContext(dir, handlers)
  const dispose = startDescriptionTracker(ctx, store)
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0].name, 'session/event')
  assert.equal(handlers[0].options?.global, true, 'session events must be subscribed globally')

  handlers[0].handler({ id: 's_active' }, userEvent('对话里新提出的筛选需求'))
  await waitFor(() => store.read(workspace).graph.nodes[0].notes.includes('对话里新提出的筛选需求'))

  dispose()
  const before = store.read(workspace).graph.nodes[0].notes
  handlers[0].handler({ id: 's_active' }, userEvent('订阅取消后不应写入'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(store.read(workspace).graph.nodes[0].notes, before)
})
