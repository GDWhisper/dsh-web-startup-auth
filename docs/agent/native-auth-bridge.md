# 原生浏览器认证桥接与 isLoopback 覆盖

> 两个针对 dsh 0.1.2+ 上游机制的前端/补签适配。升级 dsh 后必须先 diff `packages/client/connection/src/browser-auth.ts`（本文件是对它的精确镜像）。

## 原生浏览器认证桥接（dsh 0.1.2 起，当前基线 0.1.5，替代旧「特权 API 回环放行」）

0.1.2 上游自带浏览器认证（`packages/client/connection/src/browser-auth.ts`）：`/api` 闸门 = 信任围栏（`isTrustedApiRequest`，403）+ 原生签名 cookie 检查（`isAuthenticated`，401），`index.html` 也被 `authorizeIndex` 把守，**无回环豁免**（回环也要原生 cookie）。旧版靠「Host/Origin 改写绕过 `PRIVILEGED_METHODS`」的靶子（`PRIVILEGED_METHODS` 与 `authority:"loopback"` channel）**已被上游删除**——改写若还在反而自伤（原生按改写后 authority 找 cookie 名必 401），故 0.1.2 迁移时整段删除。

新机制：**原生 cookie 补签**——凡通过我方认证（有效 `dsh_sid` 或真回环，`isTrustedOrigin`）的请求，若缺原生 cookie，则用上游存于 credentials 服务的签名密钥（`credentialKey('client-connection','browser-session')`，只读不建）按**请求的真实 authority**（`new URL('http://'+Host).host` 规范化）补发 `dsh-auth-<sha256(authority)>` cookie（值 = `v1.<base64url(payload)>.<base64url(HMAC)>`，30 天，格式逐字节对齐上游）。

- **页面导航（GET/HEAD）**缺原生 cookie → 包装器直接回 **200 + Set-Cookie + `meta refresh` 回原路径**（跳板页；**不用 3xx**——重定向响应里新设的 cookie 在 Safari/Firefox 上不会带给重定向目标，303 补签会被逐跳重放直到 `ERR_TOO_MANY_REDIRECTS`，见 PR #31 / issue #30），下一请求即过原生闸门；**非导航 GET/HEAD**（fetch/EventSource，`sec-fetch-mode` 非 `navigate`/`nested-navigate`）仍走 **303** 单跳（fetch 类客户端透明跟随）；**RPC（POST）** 不跳（303 会把 POST 变 GET），转发下游（浏览器已从页面跳拿到 cookie）。
- **未认证的页面导航** → 302 `/login`（上游只会回 401 纯文本，丑）；未认证 RPC/静态资源 → 401。
- **secret 缺席竞态**：connection 插件激活时才建 secret，可能晚于本插件——secret 缺席时本次不补签、下请求重试；**绝不自己创建**（密钥归上游）。缓存按 credentials 服务实例做 WeakMap，实例更换（重启/重装）自动失效。
- **补签是强耦合点**：cookie 格式、名称算法、存储 key 任一上游变更都要跟——升级 dsh 后第一步 diff `browser-auth.ts`（`docs/upgrade-dsh-0.1.2-playbook.md` 观察哨；0.1.5-rc.1 已逐项核查零变更，见 `docs/upgrade-dsh-0.1.5-playbook.md`；0.1.5-rc.2 经 npm tarball 产物对比确认与 rc.1 零代码差异；**0.1.7-rc.1 源码 diff 仅 303 重定向目标 `'/'` → `'./'`，cookie 面零变更，并在隔离实例上实测补签通过**，见 `docs/upgrade-dsh-0.1.7-playbook.md`）。
- **`dsh_sid` 仍是唯一认证边界**：只带原生 cookie 不带 `dsh_sid` 的请求照样拒绝——原生 cookie 无账号、30 天不可撤销，登出/改密/`auth-reset` 的可撤销性全靠包装器兜住。登出响应除清 `dsh_sid` 外追加 `Max-Age=0` 的同名原生 cookie（名字可算、不需 secret）。

## 「浏览器端 scope gate」isLoopback 覆盖——0.1.2 换用 transport hook（重要）

DSH 前端 `connection.isLoopback` 由**浏览器地址栏 hostname** 判定（`connection/src/client/index.ts`；rc.1 编译产物里 `isLoopback: transport?.ownsHost === true || … || isLoopbackHostname(pageLocation.hostname)`），远程浏览器恒为 false。

**0.1.2 上游真实 cookie 认证只解决了"进 UI"，没解决 settings mirror**：`ui-settings` 的 mirror 持久化判定读 `ctx.remote.$host.isLoopback`（rc.1 `lib/client.js` 的 `apply`；api-gateway 的 `$host` getter 转写 `connection.isLoopback`）——LAN 浏览器得 `memory` 模式，mirror **永不读 host**（`ensure`/`load` 直接 resolve），于是任何依赖 describe 应答的设置面（Models「提供方目录」）抛 **"settings are unavailable in this browser"**（`ui-settings-models/src/client/store.ts` 在 `mirrored.view === undefined` 时 throw），其他设置面则静默空转。

**实测（2026-09-03，LAN 192.168.5.216 真实浏览器）**：通用设置/插件/插件市场/认证都渲染，唯独 Models 必现此错——**早前"0.1.2 LAN 五 section 全部渲染、无 unavailable"的验收结论是把回环验证当成了 LAN，不实，已废**。

- **为什么不能恢复旧 getter 覆盖**：rc.8–0.1.1 的 node 侧 tapIndex 注入在 connection `apply` 返回后把 `isLoopback` getter 改恒 true，0.1.2 A/B（2026-09-03）证明会破坏 web boot（`web boot: 26 entries did not activate`，session/uiSession/remote.session 等 pending）——0.1.2 存在按该标志门控的回环专属路径。
- **正解（2026-09-03 新解法）**：`web-auth` 的 tapIndex 注入脚本在客户端 bundle 运行前声明 **`window.__DSH_TRANSPORT__ = window.__DSH_TRANSPORT__ || { ownsHost: true }`**——connection client 构造时读此 hook，`ownsHost === true` 使 `isLoopback` 直接为 true（不再看 hostname）；api/rpc 读取该对象时安全降级（无 `createApiClient` → `WebApiClient`，无 `fetch` → `globalThis.fetch`），且**不重写 cordis 服务**。实测 LAN 与回环 boot 都正常、Models 面渲染 provider directory、无 4xx/console 错误。上游若改 `isLoopback` 计算或删 `__DSH_TRANSPORT__` 钩子，观察哨要跟。
- **曾试过但失败的路**：在 `cordis.patch.yml` 给 `ui-settings` 行追加 inject 等 marker 让 browser 端 ui-settings 排在我们 client bundle 之后——cordis patch 作用于 node half，导致 server boot 直接卡死（`@deepseek-ai/dsh-client-ui-settings: pending (waiting for service: …)`），client half 依赖由 `dsh.client.inject` 声明、patch 改不到，方向作废（git 历史见 `webAuthMirrorHookReady`）。
- 旧解法若需恢复，参考 git 历史里 tapIndex 的 `installIsLoopbackOverride`。
