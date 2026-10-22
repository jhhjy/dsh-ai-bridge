/**
 * dsh-ai-bridge —— 浏览器半侧（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 在「设置」里加一页「接线板」：
 *   - 选目标会话（另一头 AI 的提示词会递进这里）；
 *   - 看入站队列、一键投递/丢弃；
 *   - 看自己的出站消息、手动补一条；
 *   - 复制「接入说明」，直接贴给另一个 AI——那边照着 POST 就能说话。
 *
 * 与宿主端只走同源 HTTP（/api/ai-bridge/*）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-bridge',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useRef = React.useRef
    var useState = React.useState

    var API = '/api/ai-bridge'
    var NS = 'dsh-ai-bridge'

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var msg = data && data.error ? data.error : ('HTTP ' + res.status)
          var err = new Error(msg)
          err.status = res.status
          throw err
        }
        return data
      })
    }

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body, token) {
      var headers = { 'content-type': 'application/json' }
      if (typeof token === 'string' && token !== '') headers['x-bridge-token'] = token
      return fetch(API + path, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    function timeLabel(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      var d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      var pad = function (x) { return x < 10 ? '0' + x : String(x) }
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    function shortId(id) {
      if (typeof id !== 'string') return ''
      return id.length <= 14 ? id : id.slice(0, 14) + '…'
    }

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
      }
      var area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      try { document.execCommand('copy') } catch (e) { /* 忽略 */ }
      document.body.removeChild(area)
      return Promise.resolve()
    }

    function readSessionId(props) {
      var p = props || {}
      var raw = p.sessionId
      if (typeof raw === 'function') { try { raw = raw() } catch (e) { raw = '' } }
      if (raw && typeof raw === 'object') {
        if (typeof raw.sessionId === 'string') return raw.sessionId
        if (typeof raw.id === 'string') return raw.id
        if (typeof raw.session === 'object' && raw.session !== null && typeof raw.session.id === 'string') return raw.session.id
      }
      return typeof raw === 'string' ? raw : ''
    }

    /** 给另一个 AI 看的接入说明（复制走）。 */
    function buildHandoff(data) {
      var origin = window.location.origin
      var target = data.resolvedTarget || '（未选择）'
      var lines = [
        '你现在可以通过本机 HTTP 与 DeepSeek Harness 里的另一个 AI 双向通信。',
        '',
        '服务地址：' + origin + API,
        '访问令牌：' + data.token,
        '目标会话：' + target,
        '',
        '① 给我发一条提示词（我会在下一个回合收到，并像用户消息一样处理）：',
        'POST ' + origin + API + '/post',
        '  header: x-bridge-token: ' + data.token,
        '  header: content-type: application/json',
        '  body: {"from":"你的名字","text":"你要对我说的话"}',
        '',
        '② 读我的回复（按时间戳增量拉取，第一次可不带 since）：',
        'GET ' + origin + API + '/outbox?token=' + data.token + '&since=<上次返回的 now>',
        '  返回 {"items":[{"at":"ISO 时间","text":"我的话","kind":"assistant"|"agent"}]}',
        '',
        '③ 中文必须按 UTF-8 发字节，否则对面收到的是一串 ???：',
        '$json = \'{"from":"Claude","text":"看一下这个报错"}\'',
        '$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)',
        'Invoke-RestMethod -Method Post -Uri "' + origin + API + '/post" -Headers @{"x-bridge-token"="' + data.token + '"} -ContentType "application/json; charset=utf-8" -Body $bytes',
        '',
        'curl 写法（文件里存 UTF-8 的 body.json）：',
        'curl.exe -X POST "' + origin + API + '/post" -H "x-bridge-token: ' + data.token + '" -H "content-type: application/json; charset=utf-8" --data-binary "@body.json"',
        '',
        '约定：先 POST 再轮询 outbox；同一句话不要重复 POST。',
        '如果对方读到的中文是 ? 或乱码，说明发送端把字符串按 ANSI/GBK 编了码——换成上面「先 GetBytes 再发」或 --data-binary 重发即可。',
      ]
      return lines.join('\n')
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      '.aib-root{--aib-fg:var(--dsw-alias-label-primary,#241f18);',
      '--aib-muted:var(--dsw-alias-label-secondary,#6f6558);',
      '--aib-faint:var(--dsw-alias-label-tertiary,#9a9084);',
      '--aib-card:var(--dsw-alias-bg-layer-1,#fffdf8);',
      '--aib-bar:var(--dsw-alias-bg-layer-2,#f6f2ea);',
      '--aib-field:var(--dsw-alias-bg-layer-3,#fbf8f2);',
      '--aib-line:var(--dsw-alias-border-l2,#e0d7c8);',
      '--aib-line-soft:var(--dsw-alias-border-l1,#ece5d8);',
      '--aib-brand:var(--dsw-alias-brand-primary,#3a6ea5);',
      '--aib-brand-fg:#fff;',
      '--aib-ok:var(--dsw-alias-state-success-primary,#2f6b46);',
      '--aib-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);',
      '--aib-err:var(--dsw-alias-state-error-primary,#a83a2c);',
      '--aib-err-bg:color-mix(in srgb, var(--aib-err) 10%, transparent);',
      '--aib-err-line:color-mix(in srgb, var(--aib-err) 35%, transparent);',
      'font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
      'color:var(--aib-fg);display:flex;flex-direction:column;gap:14px;padding:2px;box-sizing:border-box;max-width:100%;}',
      '.aib-head{display:flex;align-items:flex-start;gap:14px;}',
      '.aib-head-left{flex:1 1 auto;min-width:0;}',
      '.aib-h1{font-size:15px;font-weight:650;line-height:1.4;}',
      '.aib-sub{font-size:12.5px;color:var(--aib-muted);margin-top:4px;line-height:1.6;}',
      '.aib-live{margin-left:auto;flex:0 0 auto;font-size:11.5px;color:var(--aib-ok);white-space:nowrap;display:inline-flex;align-items:center;gap:5px;}',
      '.aib-live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;}',
      '.aib-card{background:var(--aib-card);border:1px solid var(--aib-line);border-radius:12px;overflow:hidden;}',
      '.aib-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--aib-line-soft);flex-wrap:wrap;}',
      '.aib-row:last-child{border-bottom:0;}',
      '.aib-label{font-size:12.5px;color:var(--aib-faint);flex:0 0 auto;min-width:84px;}',
      '.aib-select,.aib-input{flex:1 1 220px;min-width:0;font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;border:1px solid var(--aib-line-soft);background:var(--aib-field);color:var(--aib-fg);}',
      '.aib-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:4px 10px;border-radius:8px;border:1px solid var(--aib-line-soft);background:var(--aib-card);color:var(--aib-fg);cursor:pointer;white-space:nowrap;}',
      '.aib-btn:hover:not(:disabled){background:var(--aib-bar);}',
      '.aib-btn:disabled{opacity:.45;cursor:default;}',
      '.aib-btn-primary,.aib-btn-primary:hover:not(:disabled){background:var(--aib-brand);border-color:var(--aib-brand);color:var(--aib-brand-fg);font-weight:600;}',
      '.aib-body{padding:10px 12px;display:flex;flex-direction:column;gap:8px;}',
      '.aib-pre{margin:0;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;line-height:1.65;background:var(--aib-bar);border:1px solid var(--aib-line-soft);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;}',
      '.aib-msg{border:1px solid var(--aib-line-soft);border-radius:10px;padding:9px 11px;background:var(--aib-field);display:flex;flex-direction:column;gap:6px;}',
      '.aib-msg-head{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--aib-faint);}',
      '.aib-tag{font-size:10.5px;border:1px solid var(--aib-line-soft);border-radius:999px;padding:1px 7px;color:var(--aib-muted);}',
      '.aib-tag-new{color:var(--aib-warn);border-color:color-mix(in srgb, var(--aib-warn) 40%, transparent);}',
      '.aib-tag-ok{color:var(--aib-ok);border-color:color-mix(in srgb, var(--aib-ok) 40%, transparent);}',
      '.aib-msg-text{font-size:12.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;}',
      '.aib-msg-actions{display:flex;gap:6px;flex-wrap:wrap;}',
      '.aib-empty{padding:16px 12px;font-size:12.5px;color:var(--aib-muted);text-align:center;}',
      '.aib-textarea{width:100%;box-sizing:border-box;min-height:96px;resize:vertical;border:1px solid var(--aib-line-soft);border-radius:8px;background:var(--aib-field);color:var(--aib-fg);font:inherit;font-size:12.5px;line-height:1.7;padding:10px 12px;outline:none;}',
      '.aib-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 12px 10px;}',
      '.aib-toggles{display:flex;gap:16px;flex-wrap:wrap;padding:10px 12px;}',
      '.aib-check{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--aib-muted);cursor:pointer;}',
      '.aib-check input{accent-color:var(--aib-brand);cursor:pointer;}',
      '.aib-err{color:var(--aib-err);background:var(--aib-err-bg);border:1px solid var(--aib-err-line);font-size:12.5px;border-radius:10px;padding:10px 12px;line-height:1.6;word-break:break-word;}',
      '.aib-hint{font-size:11.5px;color:var(--aib-faint);line-height:1.6;padding:0 12px 10px;}',
      '.aib-toast{font-size:12px;color:var(--aib-ok);}',
      '@supports not (color:var(--dsw-alias-label-primary)){.aib-root{--aib-fg:#241f18;--aib-muted:#6f6558;--aib-faint:#9a9084;--aib-card:#fffdf8;--aib-bar:#f6f2ea;--aib-field:#fbf8f2;--aib-line:#e0d7c8;--aib-line-soft:#ece5d8;--aib-brand:#3a6ea5;--aib-ok:#2f6b46;--aib-warn:#8a6a2f;--aib-err:#a83a2c}}',
    ].join('')

    // ---- 组件 -------------------------------------------------------------

    function MessageCard(props) {
      var item = props.item
      var inbound = props.inbound
      var pending = item.status === 'new'
      return h('div', { className: 'aib-msg' },
        h('div', { className: 'aib-msg-head' },
          h('span', null, incomingLabel(item)),
          h('span', { style: { marginLeft: 'auto' } }, timeLabel(item.at)),
          inbound
            ? h('span', { className: 'aib-tag ' + (pending ? 'aib-tag-new' : 'aib-tag-ok') }, pending ? '未投递' : (item.via === 'prompt' ? '已投递' : '已处理'))
            : h('span', { className: 'aib-tag' }, item.kind === 'assistant' ? '我的回复' : '我发出的'),
        ),
        h('div', { className: 'aib-msg-text' }, item.text),
        h('div', { className: 'aib-msg-actions' },
          inbound
            ? h('button', { className: 'aib-btn aib-btn-primary', disabled: props.busy || !pending, onClick: function () { props.onDeliver(item.id) } }, pending ? '投递进会话' : '已投递')
            : h('button', { className: 'aib-btn', onClick: function () { props.onCopy(item.text) } }, '复制'),
          inbound ? h('button', { className: 'aib-btn', disabled: props.busy || !pending, onClick: function () { props.onAck(item.id) } }, '丢弃') : null,
        ),
      )
    }

    function incomingLabel(item) {
      return (item.from || '外部 AI') + (item.sessionId ? ' · ' + shortId(item.sessionId) : '')
    }

    function BridgeSection(props) {
      var sessionId = readSessionId(props)
      var [data, setData] = useState(null)
      var [error, setError] = useState('')
      var [busy, setBusy] = useState(false)
      var [draft, setDraft] = useState('')
      var [toast, setToast] = useState('')
      var mounted = useRef(true)

      useEffect(function () {
        mounted.current = true
        return function () { mounted.current = false }
      }, [])

      var load = useCallback(function () {
        var suffix = sessionId !== '' ? ('?session=' + encodeURIComponent(sessionId)) : ''
        return apiGet('/state' + suffix).then(function (value) {
          if (!mounted.current) return
          setData(value)
          setError('')
        }).catch(function (err) {
          if (!mounted.current) return
          setError(String(err && err.message ? err.message : err))
        })
      }, [sessionId])

      useEffect(function () {
        load()
        var timer = setInterval(load, 5000)
        return function () { clearInterval(timer) }
      }, [load])

      var token = data !== null && data !== undefined ? data.token : ''

      var run = useCallback(function (label, operation) {
        setBusy(true)
        setToast('')
        return operation().then(function (result) {
          if (label !== '') setToast(label)
          return load().then(function () { return result })
        }).catch(function (err) {
          setError(String(err && err.message ? err.message : err))
        }).then(function (result) {
          if (mounted.current) setBusy(false)
          return result
        })
      }, [load])

      var saveConfig = useCallback(function (patch) {
        return run('已保存', function () { return apiPost('/config', patch, token) })
      }, [run, token])

      var onDeliver = useCallback(function (id) {
        return run('已投递', function () { return apiPost('/deliver', { id: id }, token) })
      }, [run, token])

      var onAck = useCallback(function (id) {
        return run('已丢弃', function () { return apiPost('/ack', { ids: [id] }, token) })
      }, [run, token])

      var onCopy = useCallback(function (text) {
        copyText(text).then(function () { if (mounted.current) setToast('已复制') })
      }, [])

      var sendReply = useCallback(function () {
        var text = draft.trim()
        if (text === '') return Promise.resolve()
        return run('已发出（对方拉取 outbox 可见）', function () {
          return apiPost('/reply', { text: text, kind: 'agent', sessionId: data && data.resolvedTarget ? data.resolvedTarget : '' }, token)
        }).then(function () { if (mounted.current) setDraft('') })
      }, [draft, run, token, data])

      if (error !== '' && data === null) {
        return h('div', { className: 'aib-root' },
          h('div', { className: 'aib-h1' }, 'AI 接线板'),
          h('div', { className: 'aib-err' }, error),
          h('button', { className: 'aib-btn', onClick: load }, '重试'),
        )
      }
      if (data === null) return h('div', { className: 'aib-root' }, h('div', { className: 'aib-sub' }, '正在连接宿主…'))

      var inbox = Array.isArray(data.inbox) ? data.inbox : []
      var outbox = Array.isArray(data.outbox) ? data.outbox : []
      var targets = Array.isArray(data.targets) ? data.targets : []
      var pending = inbox.filter(function (item) { return item.status === 'new' }).length
      var origin = window.location.origin

      var targetOptions = [h('option', { key: '', value: '' }, '跟随最近活跃会话')].concat(targets.map(function (row) {
        var label = (row.cwd ? row.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] : row.sessionId) + (row.running ? ' · 运行中' : '') + ' · ' + shortId(row.sessionId)
        return h('option', { key: row.sessionId, value: row.sessionId }, label)
      }))

      return h('div', { className: 'aib-root' },
        h('div', { className: 'aib-head' },
          h('div', { className: 'aib-head-left' },
            h('div', { className: 'aib-h1' }, 'AI 接线板'),
            h('div', { className: 'aib-sub' }, '让别的 AI 通过本机 HTTP 给我发提示词；我的回复也同步到 outbox，对方可读 —— 双向。'),
          ),
          h('span', { className: 'aib-live' }, '本页已连接宿主'),
        ),

        error !== ''
          ? h('div', { className: 'aib-err' }, error)
          : null,

        toast !== ''
          ? h('div', { className: 'aib-toast' }, toast)
          : null,

        h('div', { className: 'aib-card' },
          h('div', { className: 'aib-row' },
            h('span', { className: 'aib-label' }, '目标会话'),
            h('select', {
              className: 'aib-select',
              value: data.targetSessionId || '',
              disabled: busy,
              onChange: function (event) { saveConfig({ targetSessionId: event.target.value }) },
            }, targetOptions),
          ),
          h('div', { className: 'aib-toggles' },
            h('label', { className: 'aib-check' },
              h('input', { type: 'checkbox', checked: data.enabled === true, onChange: function (e) { saveConfig({ enabled: e.target.checked }) } }),
              '启用接线板'),
            h('label', { className: 'aib-check' },
              h('input', { type: 'checkbox', checked: data.autoDeliver === true, onChange: function (e) { saveConfig({ autoDeliver: e.target.checked }) } }),
              '收到就自动投递'),
            h('label', { className: 'aib-check' },
              h('input', { type: 'checkbox', checked: data.autoRelay === true, onChange: function (e) { saveConfig({ autoRelay: e.target.checked }) } }),
              '我的回复同步到 outbox'),
          ),
          h('div', { className: 'aib-hint' },
            '当前生效目标：' + (data.resolvedTarget || '（无）') + '　·　队列：入站 ' + pending + ' 条待处理 / 出站 ' + outbox.length + ' 条　·　数据目录 ' + data.dir,
          ),
        ),

        h('div', { className: 'aib-card' },
          h('div', { className: 'aib-row' },
            h('span', { className: 'aib-label' }, '接入说明'),
            h('button', {
              className: 'aib-btn aib-btn-primary',
              onClick: function () { onCopy(buildHandoff(data)) },
            }, '复制给另一个 AI'),
            h('button', { className: 'aib-btn', onClick: function () { run('令牌已更换', function () { return apiPost('/rotate-token', {}, token) }) } }, '换令牌'),
          ),
          h('div', { className: 'aib-body' },
            h('pre', { className: 'aib-pre' },
              'POST ' + origin + API + '/post\ntoken: ' + data.token + '\n\nGET ' + origin + API + '/outbox?token=' + data.token,
            ),
          ),
          h('div', { className: 'aib-hint' }, '对方只需要这段地址 + 令牌；「复制给另一个 AI」会把完整用法（含 PowerShell 例子）一起复制走。'),
        ),

        h('div', { className: 'aib-card' },
          h('div', { className: 'aib-row' },
            h('span', { className: 'aib-label' }, '入站'),
            h('span', { className: 'aib-sub', style: { marginTop: 0, flex: '1 1 auto' } }, pending > 0 ? (pending + ' 条未投递') : '暂无待处理'),
            h('button', { className: 'aib-btn', onClick: function () { load() } }, '刷新'),
          ),
          inbox.length === 0
            ? h('div', { className: 'aib-empty' }, '还没有外部 AI 发消息过来。把「接入说明」贴给另一个 AI 试试。')
            : h('div', { className: 'aib-body' }, inbox.map(function (item) {
                return h(MessageCard, {
                  key: item.id,
                  item: item,
                  inbound: true,
                  busy: busy,
                  onDeliver: onDeliver,
                  onAck: onAck,
                  onCopy: onCopy,
                })
              })),
        ),

        h('div', { className: 'aib-card' },
          h('div', { className: 'aib-row' }, h('span', { className: 'aib-label' }, '出站')),
          outbox.length === 0
            ? h('div', { className: 'aib-empty' }, '这里会出现我的回复（自动同步），以及我主动发给对方的话。')
            : h('div', { className: 'aib-body' }, outbox.map(function (item) {
                return h(MessageCard, {
                  key: item.id,
                  item: item,
                  inbound: false,
                  busy: busy,
                  onDeliver: onDeliver,
                  onAck: onAck,
                  onCopy: onCopy,
                })
              })),
        ),

        h('div', { className: 'aib-card' },
          h('div', { className: 'aib-body' },
            h('textarea', {
              className: 'aib-textarea',
              placeholder: '我主动发给另一个 AI 的话（写进 outbox，对方按 since 拉取）',
              value: draft,
              onChange: function (e) { setDraft(e.target.value) },
            }),
          ),
          h('div', { className: 'aib-actions' },
            h('button', { className: 'aib-btn aib-btn-primary', disabled: busy || draft.trim() === '', onClick: sendReply }, '发出'),
            h('button', { className: 'aib-btn', disabled: draft.trim() === '', onClick: function () { setDraft('') } }, '清空'),
          ),
        ),
      )
    }

    var ErrorBoundary = (function () {
      function EB(props) {
        Component.call(this, props)
        this.state = { error: null }
      }
      EB.prototype = Object.create(Component.prototype)
      EB.prototype.constructor = EB
      EB.prototype.componentDidCatch = function (error) {
        this.setState({ error: String((error && error.message) || error) })
      }
      EB.getDerivedStateFromError = function (error) {
        return { error: String((error && error.message) || error) }
      }
      EB.prototype.render = function () {
        if (this.state.error !== null) {
          return h('div', { className: 'aib-root' },
            h('div', { className: 'aib-h1' }, 'AI 接线板'),
            h('div', { className: 'aib-err' }, '这一页渲染失败：' + this.state.error),
            h('div', { className: 'aib-hint' }, '刷新页面通常即可恢复；宿主端注入不受影响。'),
          )
        }
        return this.props.children
      }
      return EB
    })()

    function apply(ctx) {
      ctx.effect(function () {
        var id = 'dsh-ai-bridge-styles'
        if (document.getElementById(id) === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS
          document.head.appendChild(style)
        }
        return function () {
          var el = document.getElementById(id)
          if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
        }
      }, 'dsh-ai-bridge: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'ai-bridge',
          order: 47,
          locale: NS,
          label: function () { return '接线板' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          return h(ErrorBoundary, null, h(BridgeSection, p))
        })
      })
    }

    module.exports = {
      name: 'ai-bridge',
      inject: ['slots'],
      apply: apply,
    }
    return module.exports
  },
})
