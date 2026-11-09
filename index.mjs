// LightVela → an OpenAI-compatible provider for magpie / OpenCode.
//
// 用你的 LightVela 账号登录，把它账号里那个 OpenAI 兼容端点的 API key
// 读出来，交给 magpie 当一个普通 provider 用 —— 不用再手动走
// 「云存储 → Agent 数据 → 显示隐藏文件 → 下载 .env → 找 key」那一串。
//
// 登录走平台自己的短信接口（POST /auth/sms/send、/auth/sms/verify），
// 全程在一个只监听 127.0.0.1 的本地页面上完成，不碰浏览器 cookie。
// 登录后的会话 token 只用来读你自己账号的实例配置和积分，不外发。
//
// 插卡式：`magpie plugin rm lightvela` 或删掉本目录即彻底消失，
// magpie 的其它 provider 与配置一概不动。

import { createServer } from "node:http"

const PROVIDER = "lightvela"
const API = "https://api.lightvela.com"
const SITE = "https://lightvela.com"
const ICON = `${SITE}/lightvela-icon.png`
const TOKEN_BASE = "https://token.lightvela.com/v1"
const SIGN_IN_TIMEOUT = 5 * 60_000
const USAGE_TTL = 5 * 60_000

// 登录前先声明这两个，登录后 magpie 会拿账号自己的 /v1/models 覆盖它。
const SEED_MODELS = [
  { id: "auto", name: "Auto（自动选路）", context: 128000 },
  { id: "deepseek-v4-pro-202606", name: "DeepSeek V4 Pro", context: 128000 },
]

// 平台对模型的展示名：`/v1/models` 只给 id，这里补一份好看的。
const NAMES = {
  auto: "Auto（自动选路）",
  "deepseek-v4-pro-202606": "DeepSeek V4 Pro",
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const trim = (v) => (typeof v === "string" ? v.trim() : "")
const nameOf = (id) => NAMES[id] || id

// ---------------------------------------------------------------- LightVela API

async function call(path, { method = "GET", body, token, signal } = {}) {
  const headers = {}
  if (body !== undefined) headers["Content-Type"] = "application/json"
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(API + path, {
    method,
    headers,
    signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const raw =
      data?.error?.message ?? data?.message ?? data?.error ?? (typeof data === "string" ? data : "")
    const err = new Error(trim(String(raw)) || `LightVela answered ${res.status}`)
    err.status = res.status
    throw err
  }
  return data
}

// sessionToken 在 /auth/sms/verify 和 /auth/session 的两种外形里都见过。
function tokenOf(payload) {
  const seen = [payload, payload?.session, payload?.data, payload?.data?.session]
  for (const box of seen) {
    const t = trim(box?.sessionToken ?? box?.session_token ?? box?.token)
    if (t) return t
  }
  return ""
}

function userOf(payload) {
  return payload?.user ?? payload?.session?.user ?? payload?.data?.user ?? null
}

// 云端实例里读 .env：只要 CUSTOM_API_KEY 与 CUSTOM_BASE_URL 两行，别的都不碰。
const READ_ENV = `set -e
ENV="\${HERMES_HOME:-$HOME/.hermes}/.env"
if [ ! -f "$ENV" ]; then echo "NO_ENV"; exit 0; fi
K=$(grep -E '^[[:space:]]*CUSTOM_API_KEY=' "$ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\\r')
B=$(grep -E '^[[:space:]]*CUSTOM_BASE_URL=' "$ENV" | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\\r')
printf 'KEY=%s\\nBASE=%s\\n' "$K" "$B"`

// 从账号里挑一个能读的实例：Running 优先，其次任何一个。
async function pickInstance(token) {
  const list = await call("/v1/instances?page=1&page_size=100", { token })
  const items = list?.data?.items ?? list?.items ?? []
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("这个 LightVela 账号下还没有 Agent 实例，先在 lightvela.com 建一个再来")
  }
  const usable = items.filter((i) => i && i.instance_id)
  const running = usable.find((i) => String(i.status).toLowerCase() === "running")
  return running ?? usable[0]
}

async function readKey(token, log) {
  const inst = await pickInstance(token)
  log?.(`LightVela: reading ${inst.name || inst.instance_id} (${inst.status || "?"})`)
  const out = await call(`/v1/instances/${encodeURIComponent(inst.instance_id)}/debug/exec`, {
    method: "POST",
    token,
    body: { command: READ_ENV },
  })
  const text = String(out?.data?.output ?? out?.output ?? "")
  if (text.includes("NO_ENV")) {
    throw new Error("这个实例里还没有 .env（实例可能刚创建、还没初始化完），过一会儿再试")
  }
  const key = trim(/^KEY=(.*)$/m.exec(text)?.[1])
  const base = trim(/^BASE=(.*)$/m.exec(text)?.[1])
  if (!key) {
    throw new Error("实例的 .env 里没有 CUSTOM_API_KEY —— 这个账号可能还没配好模型")
  }
  return {
    key,
    baseURL: base || TOKEN_BASE,
    instanceId: inst.instance_id,
    instanceName: inst.name || inst.instance_id,
  }
}

// 用 key 读一次模型列表：既拿到真名单，也顺带确认这把 key 现在能用。
async function listModels(key, baseURL = TOKEN_BASE) {
  const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`这把 key 现在调不通（${res.status}）：${trim(text).slice(0, 160)}`)
  }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  const rows = Array.isArray(data?.data) ? data.data : []
  // 只留能按 OpenAI 协议调的：`ep-*` 那类 advanced_custom 没有可用的端点类型，
  // `llmgw-mock-chat` 是平台的假模型，列出来只会让人误选。
  const usable = rows.filter((m) => {
    if (!m || typeof m.id !== "string" || !m.id) return false
    if (/mock/i.test(m.id)) return false
    // advanced_custom（ep-*）这类是平台内部端点，owned_by 不是 openai
    if (m.owned_by && m.owned_by !== "openai") return false
    const types = m.supported_endpoint_types
    if (Array.isArray(types) && types.length && !types.includes("openai")) return false
    return true
  })
  return usable.map((m) => m.id)
}

// 账号的套餐与积分：magpie 的用量卡片就用这里的数据。
async function readUsage(token) {
  const payload = await call("/v1/passes", { token })
  const passes = payload?.data?.passes ?? payload?.passes ?? []
  const p = Array.isArray(passes) ? passes.find((x) => x && x.status === "active") ?? passes[0] : null
  if (!p) return null

  const total = Number(p.credit_total) || 0
  const left = Number(p.credit_available) || 0
  const used = Math.max(0, total - left)
  const windows = []
  if (total > 0) {
    const reset = Number(p.credit_next_reset_time) || 0
    windows.push({
      name: "积分",
      used: (100 * used) / total,
      amount: used,
      limit: total,
      display: `${left}/${total}`,
      unit: "credits",
      span: 30 * 24 * 3600,
      ...(reset > 0 ? { resetsAt: new Date(reset * 1000).toISOString() } : {}),
    })
  }
  // 赠送的体验积分（如果有）单独一栏，不占套餐额度。
  const freeTotal = Number(p.free_credit_total) || 0
  if (freeTotal > 0) {
    const freeLeft = Number(p.free_credit_available) || 0
    windows.push({
      name: "体验积分",
      used: (100 * (freeTotal - freeLeft)) / freeTotal,
      amount: freeTotal - freeLeft,
      limit: freeTotal,
      display: `${freeLeft}/${freeTotal}`,
      unit: "credits",
      aside: true,
    })
  }
  return {
    plan: p.bundle_name || "LightVela",
    windows,
    ...(p.expired_time ? { until: p.expired_time } : {}),
  }
}

// ------------------------------------------------------------------ sign-in page

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 LightVela</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e8ee;--dim:#8b93a5;--accent:#3b82f6;--ok:#22c55e;--bad:#ef4444}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .card{width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 26px 24px}
  h1{margin:0 0 6px;font-size:18px;font-weight:600;letter-spacing:.2px}
  p.sub{margin:0 0 22px;color:var(--dim);font-size:12.5px}
  label{display:block;font-size:12px;color:var(--dim);margin:0 0 6px}
  input{width:100%;padding:10px 12px;background:#0d1017;border:1px solid var(--line);border-radius:9px;color:var(--text);font-size:14px;outline:none;transition:border-color .15s}
  input:focus{border-color:var(--accent)}
  .row{display:flex;gap:8px}
  .row input{flex:1}
  button{padding:10px 14px;border:1px solid var(--line);border-radius:9px;background:#1e2330;color:var(--text);font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s}
  button:hover:not(:disabled){background:#252c3b}
  button:disabled{opacity:.45;cursor:default}
  button.primary{width:100%;margin-top:18px;background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.primary:hover:not(:disabled){background:#2f74e8}
  .msg{margin-top:14px;font-size:12.5px;min-height:18px}
  .msg.bad{color:var(--bad)}
  .msg.ok{color:var(--ok)}
  .hint{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:11.5px;line-height:1.65}
  .done{text-align:center;padding:10px 0}
  .done .tick{font-size:34px;line-height:1;color:var(--ok)}
  .done h2{margin:14px 0 6px;font-size:16px}
  .done p{margin:0;color:var(--dim);font-size:12.5px}
</style></head>
<body>
<div class="card" id="card">
  <h1>登录 LightVela</h1>
  <p class="sub">用手机号收验证码</p>
  <label for="phone">手机号</label>
  <input id="phone" inputmode="numeric" autocomplete="tel" placeholder="11 位手机号" maxlength="11" autofocus>
  <div style="height:12px"></div>
  <label for="code">短信验证码</label>
  <div class="row">
    <input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="验证码" maxlength="8">
    <button id="send">发送</button>
  </div>
  <button class="primary" id="go">登录并读取 API key</button>
  <div class="msg" id="msg"></div>
  <div class="hint">
    登录只为了读你自己账号里那个实例的 <code>CUSTOM_API_KEY</code> 与套餐积分。
    凭证不会离开这台电脑，也不会写进日志。
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id)
const msg = $("msg")
let left = 0, timer = null

function say(text, kind) {
  msg.textContent = text || ""
  msg.className = "msg" + (kind ? " " + kind : "")
}
function tick() {
  if (left <= 0) { $("send").disabled = false; $("send").textContent = "发送"; clearInterval(timer); return }
  $("send").disabled = true
  $("send").textContent = left + "s"
  left--
}
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok || data.ok === false) throw new Error(data.error || "请求失败")
  return data
}
$("send").onclick = async () => {
  const phone = $("phone").value.trim()
  if (!/^1[3-9]\\d{9}$/.test(phone)) return say("请输入正确的 11 位手机号", "bad")
  $("send").disabled = true
  say("正在发送…")
  try {
    const d = await post("/api/send", { phone })
    left = Math.max(1, d.cooldown || 60)
    tick(); timer = setInterval(tick, 1000)
    say("验证码已发送，注意查收短信", "ok")
    $("code").focus()
  } catch (e) {
    $("send").disabled = false
    say(e.message, "bad")
  }
}
$("go").onclick = async () => {
  const phone = $("phone").value.trim(), code = $("code").value.trim()
  if (!/^1[3-9]\\d{9}$/.test(phone)) return say("请输入正确的 11 位手机号", "bad")
  if (!/^\\d{4,8}$/.test(code)) return say("请输入短信里的验证码", "bad")
  $("go").disabled = true
  say("登录中，正在读实例配置…")
  try {
    const d = await post("/api/verify", { phone, code })
    $("card").innerHTML = '<div class="done"><div class="tick">✓</div><h2>已登录</h2><p>' +
      (d.account ? "账号：" + d.account + "<br>" : "") +
      (d.instance ? "实例：" + d.instance + "<br>" : "") +
      (d.models ? "模型：" + d.models + "<br>" : "") +
      "可以关掉这个页面了</p></div>"
  } catch (e) {
    $("go").disabled = false
    say(e.message, "bad")
  }
}
</script>
</body></html>`
}

// ---------------------------------------------------------------- sign-in server

// 起一个只监听 127.0.0.1 的小服务：页面在这儿，短信接口由它代转，
// 登录成功后它自己把结果交回 authorize 的 callback。
function signInServer(log) {
  return new Promise((resolve, reject) => {
    let settled = false
    let settle
    const done = new Promise((r) => (settle = r))
    const finish = (result) => {
      if (settled) return
      settled = true
      settle(result)
    }
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const json = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
        res.end(JSON.stringify(body))
      }
      const readBody = () =>
        new Promise((r) => {
          let raw = ""
          req.on("data", (c) => (raw += c))
          req.on("end", () => {
            try {
              r(JSON.parse(raw || "{}"))
            } catch {
              r({})
            }
          })
        })

      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        return res.end(page())
      }
      if (url.pathname === "/api/send" && req.method === "POST") {
        const { phone } = await readBody()
        const p = trim(phone)
        if (!/^1[3-9]\d{9}$/.test(p)) return json(400, { ok: false, error: "手机号格式不对" })
        try {
          const out = await call("/auth/sms/send", { method: "POST", body: { phone: p } })
          return json(200, { ok: true, cooldown: Number(out?.cooldownSeconds ?? out?.cooldown_seconds ?? 60) || 60 })
        } catch (e) {
          return json(400, { ok: false, error: e.message })
        }
      }
      if (url.pathname === "/api/verify" && req.method === "POST") {
        const { phone, code } = await readBody()
        const p = trim(phone)
        const c = trim(code)
        try {
          const payload = await call("/auth/sms/verify", { method: "POST", body: { phone: p, code: c } })
          const token = tokenOf(payload)
          if (!token) throw new Error("登录成功，但没拿到会话 token")
          const user = userOf(payload)
          const got = await readKey(token, log)
          // 用真 key 试一次模型列表：key 现在就不能用的话，这里当场说清楚，
          // 不要等 magpie 配好了才发现。
          let ids = []
          try {
            ids = await listModels(got.key, got.baseURL)
          } catch (e) {
            log?.(`LightVela: key check failed — ${e.message}`)
            throw new Error(`读到 key 了，但它现在调不通：${e.message}`)
          }
          finish({
            type: "success",
            access: got.key,
            refresh: JSON.stringify({
              token,
              instanceId: got.instanceId,
              baseURL: got.baseURL,
              models: ids,
            }),
            expires: 0,
            accountId: user?.name || user?.phone || p,
          })
          return json(200, {
            ok: true,
            account: user?.name || user?.phone || p,
            instance: got.instanceName,
            models: ids.map(nameOf).join("、"),
          })
        } catch (e) {
          return json(400, { ok: false, error: e.message })
        }
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("not found")
    })

    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      const timer = setTimeout(() => {
        finish({ type: "failed", error: "登录超时了（5 分钟），再点一次重新开始" })
      }, SIGN_IN_TIMEOUT)
      done.then(() => {
        clearTimeout(timer)
        setTimeout(() => server.close(), 3_000).unref?.()
      })
      resolve({
        url: `http://127.0.0.1:${port}/`,
        instructions: "在打开的页面里输入手机号和短信验证码；登录成功后它会自己关掉。",
        method: "auto",
        async callback() {
          return await done
        },
      })
    })
  })
}

// 手动粘 token 的兜底路径：和页面里走的是同一套读 key 逻辑。
async function fromToken(token, log) {
  const clean = trim(token)
  if (!clean) throw new Error("请填入 LightVela 的会话 token")
  const got = await readKey(clean, log)
  const ids = await listModels(got.key, got.baseURL).catch(() => [])
  let user = null
  try {
    user = userOf(await call("/auth/session", { token: clean }))
  } catch {}
  return {
    type: "success",
    access: got.key,
    refresh: JSON.stringify({ token: clean, instanceId: got.instanceId, baseURL: got.baseURL, models: ids }),
    expires: 0,
    accountId: user?.name || user?.phone || "LightVela",
  }
}

// ---------------------------------------------------------------------- plugin

function metaOf(auth) {
  try {
    const raw = auth?.refresh
    if (typeof raw === "string" && raw.trim().startsWith("{")) return JSON.parse(raw)
  } catch {}
  return {}
}

function modelEntry(m, baseURL) {
  const id = typeof m === "string" ? m : m.id
  const label = typeof m === "string" ? undefined : m.name
  const ctx = typeof m === "string" ? undefined : m.context
  return [
    id,
    {
      id,
      name: label || nameOf(id),
      provider: { npm: "@ai-sdk/openai-compatible", api: baseURL },
      limit: { context: ctx || 128000, output: 8192 },
      reasoning: true,
      tool_call: true,
      attachment: false,
      modalities: { input: ["text"], output: ["text"] },
    },
  ]
}

export async function LightVelaAuthPlugin({ client, magpie } = {}, options = {}) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "lightvela-auth", level: "info", message } })
    } catch {}
  }
  // 积分读一次缓存几分钟，Providers 页面反复刷时不去打平台接口。
  let cachedUsage = null
  let cachedAt = 0

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      const base = was.api || TOKEN_BASE
      cfg.provider[PROVIDER] = {
        name: "LightVela",
        npm: "@ai-sdk/openai-compatible",
        api: base,
        ...was,
        models: {
          ...Object.fromEntries(SEED_MODELS.map((m) => modelEntry(m, base))),
          ...(was.models ?? {}),
        },
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const meta = metaOf(auth)
        const base = meta.baseURL || provider?.api || TOKEN_BASE
        if (auth?.access) {
          try {
            const ids = await listModels(auth.access, base)
            if (ids.length) return Object.fromEntries(ids.map((id) => modelEntry(id, base)))
          } catch (e) {
            log(`LightVela: model list failed — ${e.message}`)
          }
        }
        const known = Array.isArray(meta.models) ? meta.models : []
        if (known.length) return Object.fromEntries(known.map((id) => modelEntry(id, base)))
        return provider?.models ?? Object.fromEntries(SEED_MODELS.map((m) => modelEntry(m, base)))
      },
    },

    auth: {
      provider: PROVIDER,
      single: false,
      icon: ICON,
      methods: [
        {
          type: "oauth",
          label: "LightVela 登录（手机验证码）",
          authorize: () => signInServer(log),
        },
        {
          type: "oauth",
          label: "LightVela：粘贴已有会话 token",
          prompts: [
            {
              type: "text",
              key: "token",
              message: "lc_session 的值（浏览器开发者工具 → Application → Cookies → api.lightvela.com）",
            },
          ],
          // magpie 的 oauth 方法只认 {url, callback} 这种「流程」对象，
          // 结果必须由 callback() 交回去，不能直接返回 {type:"success"}。
          authorize: (inputs) => ({
            url: "",
            instructions: "正在用这把会话 token 读 LightVela 实例里的 key…",
            method: "auto",
            async callback() {
              try {
                return await fromToken(inputs?.token, log)
              } catch (e) {
                return { type: "failed", error: e.message }
              }
            },
          }),
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.access) return {}
        const meta = metaOf(auth)
        return {
          baseURL: meta.baseURL || TOKEN_BASE,
          apiKey: auth.access,
        }
      },
      // magpie 的用量卡片：套餐名、积分余额、到期日。
      async usage(getAuth) {
        const auth = await getAuth()
        const meta = metaOf(auth)
        if (!auth?.access) return null
        if (!meta.token) return { plan: "LightVela", signIn: "kept" }
        if (cachedUsage && Date.now() - cachedAt < USAGE_TTL) return cachedUsage
        try {
          const got = await readUsage(meta.token)
          if (!got) return { plan: "LightVela", signIn: "kept" }
          const out = { ...got, ...(auth.accountId ? { user: String(auth.accountId) } : {}), signIn: "kept" }
          cachedUsage = out
          cachedAt = Date.now()
          return out
        } catch (e) {
          if (e?.status === 401) {
            // 会话 token 过期了，但 key 还能用：只影响这张卡片和模型刷新，
            // 推理不受影响，所以不把账号标成掉线。
            return { plan: "LightVela", error: "会话已过期（key 仍可用），重新登录可恢复积分显示", signIn: "kept" }
          }
          return { plan: "LightVela", error: e.message, signIn: "kept" }
        }
      },
    },
  }
}

// for tests
export const _internal = {
  call,
  tokenOf,
  userOf,
  readKey,
  pickInstance,
  listModels,
  readUsage,
  page,
  metaOf,
  modelEntry,
  nameOf,
  READ_ENV,
  PROVIDER,
  TOKEN_BASE,
  API,
  ICON,
}
