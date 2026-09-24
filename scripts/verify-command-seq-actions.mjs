// 相对路径(从脚本自身位置解析;2026-10-08 改为相对 —— 原实现写死本机绝对落点,
// 既是内部痕迹,也换台机器/公开仓就跑不了)。
const { createEditorApi } = await import(new URL('../lib/host-core.js', import.meta.url).href)
const { createMarkerGuard } = await import(new URL('../lib/prewrite-guard.js', import.meta.url).href)

// ── 造一个含 command/run 的会话（seq 连续，surface.nodes 为节点序列）
function mkSession() {
  const events = []
  const put = (seq, type, data) => { events[seq] = { seq, type, data } }
  put(0, 'turn/start', { turn: 0 })
  put(1, 'step/start', { turn: 0, step: 1 })
  put(2, 'command/run', { commandId: 'cmd-x', name: 'goal', args: ' 完成 L1 点火并取得验收证据', source: { kind: 'user' } })
  put(3, 'assistant/message', { message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] } })
  put(4, 'turn/end', { turn: 0 })
  put(5, 'turn/start', { turn: 1 })
  put(6, 'user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
  put(7, 'assistant/message', { message: { source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'hi' }] } })
  return { id: 's1', header: { version: 3 }, events, surface: { nodes: [2, 3, 6, 7] } }
}
const mkApi = () => {
  const calls = []
  const session = mkSession()
  const api = createEditorApi({}, new Map([['s1', session]]), new Map([['s1', { status: 'idle', followup: () => {} }]]), () => {}, {
    writeMarker: async (s, span, meta) => { calls.push({ span, meta }); return { seq: 900, type: 'user/message', data: { role: 'user', id: 'retrace-recall-test', content: [{ type: 'text', text: 'marker' }], source: { kind: 'model', provider: 'p', model: 'm' } }, surfaceOp: { op: 'replace', start: span.start, end: span.end }, sourceEventSeqs: [1, ...(span.shadowedSeqs ?? [])] } },
  })
  return { api, calls }
}

// ① recall by seq on a command/run target
{
  const { api, calls } = mkApi()
  const r = await api.recall({ sessionId: 's1', seq: 2 })
  const ok = r?.ok === true && calls.length === 1 && calls[0].span?.start === 2 &&
    calls[0].meta?.op === 'recall' && calls[0].meta?.originalText === '完成 L1 点火并取得验收证据' &&
    calls[0].meta?.explicitUserTarget === true
  console.log('① recall by seq(command):', ok ? '✅ PASS' : '❌ FAIL', JSON.stringify({ start: calls[0]?.span?.start, text: calls[0]?.meta?.originalText, explicit: calls[0]?.meta?.explicitUserTarget, viaSeq: r?.value?.viaSeq }))
}
// ② editAndResend by seq on a command/run target（应不再抛 not-user-message）
{
  const { api, calls } = mkApi()
  const r = await api.editAndResend({ sessionId: 's1', seq: 2, text: '改过的目标文本' })
  const ok = r?.ok === true && calls.length === 1 && calls[0].meta?.op === 'edit' &&
    calls[0].meta?.originalText === '完成 L1 点火并取得验收证据' && calls[0].meta?.explicitUserTarget === true
  console.log('② edit by seq(command):', ok ? '✅ PASS' : '❌ FAIL', JSON.stringify(r?.error ?? { start: calls[0]?.span?.start, text: calls[0]?.meta?.originalText }))
}
// ③ messageId 路径不受影响（回归）
{
  const { api, calls } = mkApi()
  const r = await api.recall({ sessionId: 's1', messageId: 'u1' })
  const ok = r?.ok === true && calls.length === 1 && calls[0].meta?.explicitUserTarget !== true
  console.log('③ recall by messageId(回归):', ok ? '✅ PASS' : '❌ FAIL', JSON.stringify(r?.error ?? { start: calls[0]?.span?.start, explicit: calls[0]?.meta?.explicitUserTarget }))
}
// ④ 守卫 A/B：同一大 range，显式用户操作应放行、非显式应拒绝
{
  const events = new Array(2500).fill(null).map((_, i) => ({ seq: i, type: 'assistant/message', data: {} }))
  const session = { id: 'big', events, surface: { nodes: [] } }
  const seqs = Array.from({ length: 99 }, (_, i) => i + 2)   // 2..100
  const envelope = { type: 'user/message', data: { id: 'retrace-recall-x' }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 100 }, sourceEventSeqs: [1, ...seqs] }
  const fake = () => ({ validateAppend: () => ({ ok: true, violations: [] }), validateEdit: () => ({ ok: true, violations: [] }) })
  const gA = createMarkerGuard({ log: () => {}, prewriterFactory: fake })
  const gB = createMarkerGuard({ log: () => {}, prewriterFactory: fake })
  let aThrew = false, bThrew = false
  try { await gA.validateMarkerAppend(session, envelope, { phase: 'pair', audit: {}, explicitUserTarget: true }) } catch { aThrew = true }
  try { await gB.validateMarkerAppend(session, envelope, { phase: 'pair', audit: {} }) } catch { bThrew = true }
  console.log('④ 守卫 A/B（显式应放行/非显式应拒）:', (!aThrew && bThrew) ? '✅ PASS' : '❌ FAIL', JSON.stringify({ explicitThrew: aThrew, implicitThrew: bThrew }))
}
