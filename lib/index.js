/**
 * dsh-ai-bridge —— 宿主半：AI 接线板。
 *
 * 目标：让**别的 AI**（另一个窗口里的 Claude/ChatGPT、本机脚本、自动化流程）
 * 能通过本机 HTTP 把提示词递进你正在跑的会话；也能把你（模型）说的话读回去。
 * 两个方向都走同一份持久化队列，所以对方断线/重启不会丢消息。
 *
 *   外部 → 我：POST /api/ai-bridge/post   （进 inbox，可自动投递成这个会话的一条用户消息）
 *   我 → 外部：GET  /api/ai-bridge/outbox  （outbox：我的回复 + 我主动发的话）
 *
 * 投递机制：优先 `sessionController.prompt()`（官方 prompt 入口，会是真正的用户消息，
 * 并唤醒 agent）；拿不到该服务时退化为 `agent.inject()` + `agent.followup()`。
 *
 * 数据落在 <DSH_HOME>/ai-bridge/：state.json / inbox.jsonl / outbox.jsonl。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const name = 'ai-bridge'

/** webServer 是硬依赖（提供同源 HTTP）；其余服务一律 ctx.get 可选读取。 */
export const inject = ['webServer']

const API_PREFIX = '/api/ai-bridge'
const MAX_TEXT = 16000
const MAX_BODY = 1024 * 1024

const DEFAULT_CONFIG = {
  enabled: true,
  /** 空串表示「跟随最近活跃会话」。 */
  targetSessionId: '',
  /** 对方 POST 进来就立刻投递给模型（否则只排队，由人/模型决定）。 */
  autoDeliver: true,
  /** 模型的每条回复自动同步到 outbox（对方能读到我的回答）。 */
  autoRelay: true,
  token: '',
}

/** 内存态。启动时从磁盘读回。 */
const state = {
  config: { ...DEFAULT_CONFIG },
  inbox: [],
  outbox: [],
  lastError: '',
  lastDeliver: null,
  /** 页面握手证据：设置页打开时会打 /state。 */
  bridge: { lastSeen: null, count: 0 },
}

function homeDir() {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env !== '' ? env : path.join(os.homedir(), '.dsh')
}

function dirOf() {
  return path.join(homeDir(), 'ai-bridge')
}

function statePath() {
  return path.join(dirOf(), 'state.json')
}

function inboxPath() {
  return path.join(dirOf(), 'inbox.jsonl')
}

function outboxPath() {
  return path.join(dirOf(), 'outbox.jsonl')
}

function newTok() {
  return randomBytes(12).toString('hex')
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

function ensureDir() {
  try {
    mkdirSync(dirOf(), { recursive: true })
  } catch {
    // 读不到 DSH_HOME 时后面每个操作都会各自失败并记录原因，不影响宿主启动
  }
}

function readLines(file, limit) {
  try {
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    const picked = limit > 0 ? lines.slice(-limit) : lines
    const out = []
    for (const line of picked) {
      try {
        out.push(JSON.parse(line))
      } catch {
        // 半行/坏行直接跳过：队列不能因为一行损坏整体失效
      }
    }
    return out
  } catch {
    return []
  }
}

function appendLine(file, value) {
  ensureDir()
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

function loadAll() {
  ensureDir()
  try {
    if (existsSync(statePath())) {
      const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
      if (parsed !== null && typeof parsed === 'object') {
        if (typeof parsed.enabled === 'boolean') state.config.enabled = parsed.enabled
        if (typeof parsed.targetSessionId === 'string') state.config.targetSessionId = parsed.targetSessionId
        if (typeof parsed.autoDeliver === 'boolean') state.config.autoDeliver = parsed.autoDeliver
        if (typeof parsed.autoRelay === 'boolean') state.config.autoRelay = parsed.autoRelay
        if (typeof parsed.token === 'string' && parsed.token !== '') state.config.token = parsed.token
      }
    }
  } catch {
    // 坏配置回默认
  }
  if (state.config.token === '') {
    state.config.token = newTok()
    saveConfig()
  }
  state.inbox = readLines(inboxPath(), 400)
  state.outbox = readLines(outboxPath(), 400)
}

function saveConfig() {
  try {
    ensureDir()
    const file = statePath()
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(state.config, null, 2)}\n`, 'utf8')
    writeFileSync(file, readFileSync(tmp))
  } catch (error) {
    state.lastError = `配置写入失败：${String((error && error.message) || error)}`
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** 从一条消息里抽出纯文本（content 可能是字符串或 block 数组）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

export function apply(ctx) {
  loadAll()

  const service = (key) => {
    try {
      const viaGet = typeof ctx.get === 'function' ? ctx.get(key) : undefined
      if (viaGet !== undefined && viaGet !== null) return viaGet
    } catch {
      // 忽略：可选服务缺失
    }
    return ctx[key]
  }

  /** 找一个能当投递目标的会话：配置优先，其次最近活跃。 */
  function resolveTarget() {
    const configured = state.config.targetSessionId
    if (typeof configured === 'string' && configured !== '') return configured
    const sessions = service('sessions')
    if (sessions === null || sessions === undefined || typeof sessions.list !== 'function') return ''
    try {
      const list = sessions.list()
      let best = ''
      let bestStamp = -1
      for (const session of list) {
        const stamp = Number(session?.header?.createdAt ?? 0)
        const id = String(session?.header?.id ?? session?.id ?? '')
        if (id !== '' && stamp >= bestStamp) {
          bestStamp = stamp
          best = id
        }
      }
      return best
    } catch {
      return ''
    }
  }

  /** 目标会话列表（给设置页的下拉用）。 */
  async function listTargets() {
    const rows = []
    const sc = service('sessionController')
    if (sc !== null && sc !== undefined && typeof sc.list === 'function') {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 2500)
        const value = await sc.list({}, controller.signal)
        clearTimeout(timer)
        const items = Array.isArray(value?.items) ? value.items : []
        for (const item of items) {
          rows.push({
            sessionId: String(item.sessionId ?? ''),
            cwd: typeof item.cwd === 'string' ? item.cwd : '',
            running: item.running === true,
            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
            blank: item.blank === true,
          })
        }
      } catch {
        // 列表拿不到时退回内存里的 live sessions
      }
    }
    if (rows.length === 0) {
      const sessions = service('sessions')
      if (sessions !== null && sessions !== undefined && typeof sessions.list === 'function') {
        try {
          for (const session of sessions.list()) {
            rows.push({
              sessionId: String(session?.header?.id ?? session?.id ?? ''),
              cwd: String(session?.header?.cwd ?? ''),
              running: false,
              updatedAt: Number(session?.header?.createdAt ?? 0),
              blank: false,
            })
          }
        } catch {
          // 忽略
        }
      }
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows.slice(0, 40)
  }

  /**
   * 真正把一段文本变成「模型下个回合会看到的东西」。
   *
   * 走 sessionController.prompt 时它就是一条真正的用户消息（会唤醒 agent）；
   * 退化路径只能塞进 agent 的 inbox，需要 agent 正在跑才会被吃到。
   */
  async function deliverText(text, meta) {
    const sessionId = resolveTarget()
    if (sessionId === '') return { ok: false, reason: '还没有可投递的会话（先在设置里选一个目标会话）' }

    const from = typeof meta?.from === 'string' && meta.from !== '' ? meta.from : '外部 AI'
    const composed = `【外部 AI 输入 · 来自 ${from}】\n${text}\n\n（这条消息由 DSH「AI 接线板」投递；你的回复会自动写入 outbox 供对方读取。）`

    const sc = service('sessionController')
    if (sc !== null && sc !== undefined && typeof sc.prompt === 'function') {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15000)
        await sc.prompt(
          {
            requestId: newId('bridge-req'),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: composed }],
          },
          controller.signal,
        )
        clearTimeout(timer)
        return { ok: true, via: 'prompt', sessionId }
      } catch (error) {
        state.lastError = `prompt 投递失败：${String((error && error.message) || error)}`
      }
    }

    const agents = service('agents')
    const agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (agent !== undefined && agent !== null && typeof agent.inject === 'function') {
      try {
        agent.inject([{ type: 'text', text: composed }])
        if (typeof agent.followup === 'function') agent.followup()
        return { ok: true, via: 'inject', sessionId }
      } catch (error) {
        state.lastError = `inject 投递失败：${String((error && error.message) || error)}`
        return { ok: false, reason: state.lastError }
      }
    }
    return { ok: false, reason: state.lastError !== '' ? state.lastError : '找不到可用的投递通道' }
  }

  function queueInbound(body) {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') throw new Error('text 不能为空')
    const item = {
      id: newId('in'),
      at: new Date().toISOString(),
      from: typeof body.from === 'string' && body.from.trim() !== '' ? body.from.trim().slice(0, 80) : '外部 AI',
      text: text.slice(0, MAX_TEXT),
      status: 'new',
      deliveredAt: null,
      via: null,
    }
    appendLine(inboxPath(), item)
    state.inbox.push(item)
    if (state.inbox.length > 400) state.inbox = state.inbox.slice(-400)
    return item
  }

  async function deliverInbound(item) {
    const result = await deliverText(item.text, { from: item.from })
    if (result.ok) {
      item.status = 'delivered'
      item.deliveredAt = new Date().toISOString()
      item.via = result.via
      appendLine(inboxPath(), { ...item, status: 'delivered' })
      state.lastDeliver = { at: item.deliveredAt, id: item.id, via: result.via, sessionId: result.sessionId }
    } else {
      state.lastError = result.reason
    }
    return result
  }

  /** 入站：对方 POST 一条提示词（可自动投递）。 */
  async function handlePost(req, res) {
    if (!state.config.enabled) return sendJson(res, 409, { ok: false, error: '接线板已关闭' })
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
    let item
    try {
      item = queueInbound(body)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
    }
    let delivery = { ok: false, reason: '已入队，未投递（autoDeliver 关闭）' }
    if (state.config.autoDeliver) delivery = await deliverInbound(item)
    return sendJson(res, 200, {
      ok: true,
      id: item.id,
      delivered: delivery.ok === true,
      via: delivery.via ?? null,
      reason: delivery.ok === true ? null : delivery.reason ?? null,
    })
  }

  /** 出站：我这边追加一条给对方的消息。 */
  function queueOutbound(body) {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') throw new Error('text 不能为空')
    const item = {
      id: newId('out'),
      at: new Date().toISOString(),
      kind: typeof body.kind === 'string' ? body.kind : 'agent',
      text: text.slice(0, MAX_TEXT),
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
      seq: typeof body.seq === 'number' ? body.seq : null,
    }
    appendLine(outboxPath(), item)
    state.outbox.push(item)
    if (state.outbox.length > 400) state.outbox = state.outbox.slice(-400)
    return item
  }

  function inboxView() {
    return state.inbox.slice(-60).reverse().map((item) => ({
      id: item.id,
      at: item.at,
      from: item.from,
      text: item.text,
      status: item.status === 'delivered' ? 'delivered' : 'new',
      via: item.via ?? null,
    }))
  }

  function outboxView() {
    return state.outbox.slice(-60).reverse().map((item) => ({
      id: item.id,
      at: item.at,
      kind: item.kind ?? 'assistant',
      text: item.text,
      sessionId: item.sessionId ?? '',
    }))
  }

  // ---- 模型回复自动同步到 outbox ----------------------------------------
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        if (!state.config.enabled || !state.config.autoRelay) return
        if (event === null || event === undefined || event.type !== 'assistant/message') return
        const target = resolveTarget()
        const sid = String(session?.header?.id ?? session?.id ?? '')
        if (sid === '' || (target !== '' && sid !== target)) return
        const text = textOfContent(event.data?.message?.content)
        if (text === '') return
        queueOutbound({ text, kind: 'assistant', sessionId: sid, seq: event.seq })
      }),
    'dsh-ai-bridge: relay assistant messages',
  )

  // ---- 同源 HTTP ---------------------------------------------------------
  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      const query = queryOf(req)
      const token = req.headers['x-bridge-token'] ?? query.get('token') ?? ''
      const authed = typeof token === 'string' && token === state.config.token

      try {
        if (route === '/state' && req.method === 'GET') {
          state.bridge.lastSeen = new Date().toISOString()
          state.bridge.count += 1
          const sessionParam = query.get('session') ?? ''
          const targets = await listTargets()
          return sendJson(res, 200, {
            enabled: state.config.enabled,
            targetSessionId: state.config.targetSessionId,
            resolvedTarget: resolveTarget(),
            autoDeliver: state.config.autoDeliver,
            autoRelay: state.config.autoRelay,
            token: state.config.token,
            dir: dirOf(),
            inbox: inboxView(),
            outbox: outboxView(),
            targets,
            sessionParam,
            bridge: { ...state.bridge },
            lastDeliver: state.lastDeliver,
            lastError: state.lastError !== '' ? state.lastError : null,
          })
        }

        if (!authed) return sendJson(res, 401, { ok: false, error: 'token 不对（见设置页）' })

        if (route === '/post' && req.method === 'POST') return await handlePost(req, res)

        if (route === '/outbox' && req.method === 'GET') {
          const since = Number(query.get('since') ?? '0')
          const items = Number.isFinite(since) && since > 0
            ? state.outbox.filter((item) => Number(new Date(item.at)) > since)
            : state.outbox.slice(-50)
          return sendJson(res, 200, {
            ok: true,
            now: Date.now(),
            items: items.map((item) => ({
              id: item.id,
              at: item.at,
              kind: item.kind ?? 'assistant',
              text: item.text,
              sessionId: item.sessionId ?? '',
            })),
          })
        }

        if (route === '/reply' && req.method === 'POST') {
          const body = await readBody(req)
          const item = queueOutbound(body)
          return sendJson(res, 200, { ok: true, id: item.id })
        }

        if (route === '/deliver' && req.method === 'POST') {
          const body = await readBody(req)
          const id = typeof body.id === 'string' ? body.id : ''
          const item = state.inbox.find((entry) => entry.id === id)
          if (item === undefined) return sendJson(res, 404, { ok: false, error: '找不到这条消息' })
          const result = await deliverInbound(item)
          return sendJson(res, 200, { ok: result.ok === true, via: result.via ?? null, reason: result.reason ?? null })
        }

        if (route === '/ack' && req.method === 'POST') {
          const body = await readBody(req)
          const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)) : []
          let changed = 0
          for (const item of state.inbox) {
            if (ids.includes(item.id) && item.status !== 'delivered') {
              item.status = 'delivered'
              item.deliveredAt = new Date().toISOString()
              item.via = 'manual-ack'
              changed += 1
            }
          }
          if (changed > 0) {
            try {
              writeFileSync(inboxPath(), state.inbox.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8')
            } catch {
              // 内存态已经更新，磁盘失败不阻塞
            }
          }
          return sendJson(res, 200, { ok: true, changed })
        }

        if (route === '/config' && req.method === 'POST') {
          const body = await readBody(req)
          if (typeof body.enabled === 'boolean') state.config.enabled = body.enabled
          if (typeof body.autoDeliver === 'boolean') state.config.autoDeliver = body.autoDeliver
          if (typeof body.autoRelay === 'boolean') state.config.autoRelay = body.autoRelay
          if (typeof body.targetSessionId === 'string') state.config.targetSessionId = body.targetSessionId.slice(0, 200)
          saveConfig()
          return sendJson(res, 200, { ok: true, targetSessionId: state.config.targetSessionId })
        }

        if (route === '/rotate-token' && req.method === 'POST') {
          state.config.token = newTok()
          saveConfig()
          return sendJson(res, 200, { ok: true, token: state.config.token })
        }

        if (route === '/diag' && req.method === 'GET') {
          const target = resolveTarget()
          const agents = service('agents')
          const agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(target) : undefined
          const sc = service('sessionController')
          return sendJson(res, 200, {
            ok: true,
            target,
            hasAgent: agent !== undefined && agent !== null,
            agentKeys: agent !== null && agent !== undefined ? Object.keys(agent) : [],
            agentMethods: agent !== null && agent !== undefined
              ? {
                  inject: typeof agent.inject,
                  followup: typeof agent.followup,
                  session: typeof agent.session,
                }
              : {},
            hasSessionController: sc !== null && sc !== undefined,
            promptType: sc !== null && sc !== undefined ? typeof sc.prompt : 'missing',
            homeDir: homeDir(),
          })
        }

        return sendJson(res, 404, { ok: false, error: `未知接口 ${route}` })
      } catch (error) {
        state.lastError = String((error && error.message) || error)
        return sendJson(res, 500, { ok: false, error: state.lastError })
      }
    },
  })

  // ---- 给模型的工具：我主动往外发 / 看队列 ------------------------------
  ctx.effect(() => {
    const tools = service('tools')
    if (tools === null || tools === undefined || typeof tools.register !== 'function') return () => {}
    return tools.register({
      name: 'ai_bridge',
      description:
        'AI 接线板：与其他 AI 双向通信。action=status 查看接线板状态与队列；action=inbox 读出站（对方发来、尚未处理）的消息；action=send 把我的一段话写进 outbox（外部 AI 可通过 GET /api/ai-bridge/outbox 读到）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'inbox', 'send'] },
          text: { type: 'string', description: 'action=send 时要发给对方的内容' },
          to: { type: 'string', description: '可选：称呼对方（仅记录在消息里）' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
          },
          additionalProperties: true,
        },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const action = typeof args?.action === 'string' ? args.action : 'status'
        if (action === 'send') {
          const text = typeof args?.text === 'string' ? args.text.trim() : ''
          if (text === '') return { ok: false, message: 'text 不能为空' }
          const item = queueOutbound({ text, kind: 'agent', sessionId: resolveTarget() })
          return { ok: true, message: `已写入 outbox（${item.id}），对方拉取 /api/ai-bridge/outbox 即可读到` }
        }
        if (action === 'inbox') {
          const pending = inboxView().filter((item) => item.status === 'new')
          return { ok: true, message: pending.length === 0 ? '没有未处理的入站消息' : `未处理 ${pending.length} 条`, items: pending }
        }
        return {
          ok: true,
          message: '接线板状态',
          enabled: state.config.enabled,
          target: resolveTarget(),
          autoDeliver: state.config.autoDeliver,
          autoRelay: state.config.autoRelay,
          inboxNew: inboxView().filter((item) => item.status === 'new').length,
          outboxCount: state.outbox.length,
          lastError: state.lastError !== '' ? state.lastError : null,
        }
      },
    })
  }, 'dsh-ai-bridge: tool')
}
