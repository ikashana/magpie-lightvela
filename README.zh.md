# @magpie-community/opencode-lightvela-auth

[English](README.md)

在 OpenCode 或 magpie 里登录 **LightVela** 账号，直接用它那个 OpenAI 兼容端点。

LightVela 给每个账号配一个 OpenAI 兼容的模型端点，凭证放在账号名下实例的
`~/.hermes/.env` 里。这个插件把它读出来交给 magpie，省掉「云存储 → Agent
数据 → 显示隐藏文件 → 下载 .env → 找 key」那一串手工操作。

## 它到底在做什么

| 项 | 值 |
|---|---|
| 端点 | `https://token.lightvela.com/v1` |
| 认证 | `Authorization: Bearer <CUSTOM_API_KEY>` |
| key 位置 | 实例里的 `~/.hermes/.env` 的 `CUSTOM_API_KEY` |
| 模型 | 以 `/v1/models` 实时返回为准 |

插件只做两步：

1. 用你的 LightVela 账号登录，拿一个**会话 token**；
2. 用这个 token 在你自己的实例上执行一段只读命令，把上面那两行读出来。

key 不出这台电脑，不经过任何第三方，也不写进日志。

## 登录

`magpie plugin login lightvela`，或者 magpie 界面里 Providers › LightVela。

### 1. 手机验证码（推荐）

插件会起一个只监听 `127.0.0.1` 的页面：

1. 填 11 位手机号 → 发送验证码
2. 填短信里的验证码 → 登录

登录成功后页面会显示账号、实例名和读到的模型，插件自动把 key 交给 magpie。

### 2. 粘贴会话 token

已经登录过网页版的话，从浏览器里捞：

> 开发者工具 → Application → Cookies → `api.lightvela.com` → `lc_session`

粘进提示框即可，不用发短信；过期了再换一个。

## 登录之后

- 模型列表由账号自己的 `/v1/models` 决定，登录时读一次，之后每次刷新也读；
- `ep-*`（平台内部端点）和 `llmgw-mock-chat`（假模型）会被过滤掉，免得误选；
- key 存在 magpie 的 auth 里，会话 token 只存在 `refresh` 里（用于刷新模型和积分）。

## 用量卡片

积分来自 `GET /v1/passes`：套餐名、`credit_available / credit_total`、重置时间和
套餐到期日。读一次缓存五分钟，Providers 页面反复刷不会一直打平台接口。

会话 token 过期但 key 还能用时，卡片会写明这一点，推理照常；重新登录只是把卡片恢复。

## 注意事项

- 这个 key 是**给账号名下那个实例用的**。把它拿到本地接到 magpie 技术上可行，
  但属于超出平台设计用途的用法，**上游有可能识别并吊销 key**。当备用通道用，
  别把日常主力全压上去。
- 实例必须是 `Running` 状态；刚创建、还没初始化完的实例读不到 `.env`。
- 会话 token 只用来读你自己账号的实例配置和积分。

## 卸载

```bash
magpie plugin rm lightvela
```

插件只往 magpie 的 provider 列表里加了一个 `lightvela`，删掉即彻底清除。

## 许可

MIT
