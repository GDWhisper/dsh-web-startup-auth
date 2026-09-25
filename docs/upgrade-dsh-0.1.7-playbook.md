# dsh 0.1.7 适配性检查（正式版前置核查）

> 触发：把本地 harness 源码拉到最新（`~/coding/research/deepseek-harness`，原本停在 `dsh-v0.1.1-rc.2`，落后 **6511 个提交**），`git pull --ff-only` 后 HEAD = `46a7f68b09`（`git describe` = `dsh-v0.1.7-rc.1`，2026-09-23）。
> npm dist-tags 现状：`latest` = **0.1.5-rc.3**、`next` = **0.1.7-rc.1**、`alpha` = 0.1.7-alpha.2。本插件依赖 `^0.1.5-rc.2`。
> **与 0.1.5 那次的关键差别**：`^0.1.5-rc.2` 是 caret 范围，**稳定版一发布就会被解析进来**（prerelease 只在同 `major.minor.patch` 元组内被允许，stable 版本不受此限）。也就是说正式版落地时，`npm install` 会自动把我们拉到稳定版——**不能等到发版当天才验证**。本次因此做了「静态 diff + 构建探针 + 0.1.7-rc.1 隔离实例实机」三层验证。
> **第二次核查（2026-09-24，见下方「C. 已发布 npm 产物复核」）**：首次核查以源码 tag 为准，第二次针对 npm 真正发布的产物复核，结论不变（插件存活、源码零改动），并**实测复现了 P2**。

## 结论速览

**插件存活，源码零改动。** 在 0.1.7-rc.1 上：`typecheck` 0 错误、`vitest` 101/101、`tsdown` 构建通过；隔离实例（独立 `DSH_HOME` + 独立端口 3099）上登录墙全链路、原生 cookie 补签、boot 图 client bundle、设置面板「认证」页、LAN isLoopback 钩子、`auth-reset` 会话轮换**全部实测通过**，服务端零告警、浏览器 56 请求 0 非 2xx。

~~需要跟进的是 **1 个新的条件性冲突**（DeepSeek 账号 OAuth 回调 `/oauth/callback` 会进我们的闸门）和 **1 个既有小瑕疵**（凭据文件不读 `$DSH_HOME`），均不阻塞升级。~~ **两项已随 v0.1.11 修复（2026-09-25），5 个依赖也 bump 到 `^0.1.7-rc.1`——基线正式推进到 0.1.7-rc.1。** 详见下方「执行记录」。

## 观察哨逐项（对照 0.1.5 手册的清单）

### 1. `browser-auth.ts`（补签强耦合点）——✅ 零语义变更

`0.1.5-rc.2 → 0.1.7-rc.1` 全文件 diff 仅 **2 处**，都是 303 重定向目标 `location: '/'` → `'./'`（改为目录相对，配合挂载点）：

- `COOKIE_PREFIX = 'dsh-auth-'`、`AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')`、`v1.<body>.<sig>` 值格式、`sha256(authority)` 名字算法、HMAC 签名、`authorizeIndex` / `isAuthenticated` 全部原样；
- → **补签逻辑（格式、cookie 名算法、secret 读取 key）零改动**。

### 2. `api-request-trust.ts` ——✅ 零 diff

`isTrustedApiRequest` 信任围栏逐字节未变。

### 3. `rpc-host.ts` / `/api` 挂载 ——✅ 闸门保留，新增官方扩展点

- `requestRejection`（403 信任围栏 + 401 原生 cookie）保留，语义不变；新增 `admit()` 包装它并附带 `PeerScope`/`OperatorPeer`（为共享 API 请求标注「代表 operator 说话」），403/401 判定未动；
- `/api` 的 prefix handler 仍是 `connection.admit(req)` → `bridge(...)`，但 `bridge` 调用被包进新的 waterfall 事件：`webCtx.waterfall('connection/request', req, res, () => bridge(...))`；
- `/api` 仍通过 `webCtx.webServer.register(route)` 注册 → **我们的 `register` 包装点原样有效**；
- **机会（非必需）**：`connection/request` 是上游正式开放的「认证后包裹共享 API 请求」扩展点，未来可用它替代 monkey-patch `webServer.register`，把包装从「拦注册」变成「官方事件」。当前不必动。

### 4. `startup.ts` 的 0.0.0.0 拒绝 ——✅ 还在

`0.1.5-rc.2 → 0.1.7-rc.1` 对 `packages/bundle/web-app/src/startup.ts` **零 diff**（`--host 0.0.0.0` 拒绝仍在 74-75 行）→ `remote-web-startup` 替换仍是刚需，且我们的分叉 delta 无需跟进。

### 5. patch 目标行与 inject 语义 ——✅ 全部健在，且确认是「叠加」

- `web-app/cordis.patch.yml` 仍有 `id: web-startup`（142 行，`name: '@deepseek-ai/dsh-web-app/startup'`）与 `id: connection`（197 行）；
- `connection` 插件自身仍是 `export const inject = ['credentials']`，web-app patch 行给它加 `inject: [webRuntime]`；
- **关键确认**：patch 的 `inject` 是**叠加**到插件自身 inject 上，不是替换——`cordis-plugin-loader` 里 `Inject.resolve(fiber.entry.options.inject, fiber.inject)`。所以我们 patch 的 `[webServer, webRuntime, webAuth]` **不会挤掉 `credentials`**（否则 connection 会因缺 secret 服务而挂，且它是必需条目）；
- `dsh --profile web --dump-config` 在 0.1.7-rc.1 上实测：`web-startup` disabled、`connection` inject `[webServer, webRuntime, webAuth]`、本插件三行齐全。

### 6. webserver 注册口 ——✅ 三个口都已覆盖

`WebServer` 仍是 `register` / `registerUpgrade` / **`registerFallback`** 三个注册口（`registerFallback` 在 0.1.5-rc.2 就有，不是新增），我们三者都包装（`src/auth.ts` 的 `wrapHandler` / `wrapUpgradeHandler` / `wrapFallback`），且对已注册路由做回溯包装。webserver 源码本次仅改 gzip 的 multipart 分支与一处类型断言。SPA index 仍走 `frontend-static` 的 `registerFallback` → 仍被我们守住。

### 7. 客户端 `isLoopback` 与 `__DSH_TRANSPORT__` ——✅ 钩子仍吃

- `apply()` 被重构为 `installConnection(ctx, options)`，但 `apply()` **仍然读** `globalThis.__DSH_TRANSPORT__` 并原样传入（`client/index.ts` 317-326 行）；
- 判定式逐字符不变：`isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)`（248 行）；
- 新增 `ClientTransportHooks.rpc` / `streamBaseUrl` 字段，我们只设 `ownsHost: true`，其余走默认 HTTP+WS 载体，不受影响；
- **实测**：LAN 浏览器里 `__DSH_TRANSPORT__ === {"ownsHost":true}`，设置面板「模型」页正常渲染、无 `settings are unavailable`。

### 8. 前端插件加载链 ——✅ 契约兼容，一处 URL 形状变化

- 注册契约仍是 `window.__ModuleLoader__.load({ id, factory, chunk? })`（`chunk` 可选）→ 我们 tsdown 的 banner 兼容；
- `dsh.client` 声明解析（`parseDshClient`：`platform` / `inject` / `external` / `immediately`）不变，`inject` 仍按**包名**匹配（`graphRows.get(packageName)`）→ 我们声明的 `["@deepseek-ai/dsh-client-ui-settings"]` 有效；
- **boot 图 URL 改成相对路径**：`plugins/??<id>/client.js&rev=<rev>`（原 `/plugins/...`）。功能无影响，但验收命令、文档里的 URL 形状要跟着改；
- 实测 boot 行：`{"id":"dsh-web-startup-auth","url":"plugins/??dsh-web-startup-auth/client.js&rev=375c4ed549ec","inject":["@deepseek-ai/dsh-client-ui-settings"]}`，匿名 401 / 已认证 200。

### 9. 设置面板 slot ——✅ 契约不变

- `settings.section` 的注册形状（`name` / `id` / `order` / `label` / `locale` / `inject`）未变；新增 `settings.launcher`（侧边栏账号入口，我们不使用）；
- `PropsRuntime` 仍从 `@deepseek-ai/dsh-client-ui-slots` 导出；
- ui-settings 内部把 `ctx.settingsScope` 改名为 `ctx.configForms`（`SettingsScopeBinder` → `ConfigForms`）——**我们不用这个服务**，零影响；
- 上游新增 `id: 'account'` 的 section（DeepSeek 云账号），与我们的 `id: 'auth'` **不冲突**，且它只在「已存 DeepSeek 凭据」时注册。

### 10. 导航图标 ——✅ 实测仍生效

`ui-settings-general` 的 `navIcon()` 新增了 `account` / `archived-sessions` 分支并换成 Medium 图标、`SettingsRoot.module.css` 有改动。我们的方案是 DOM 观察 + 字形替换（不改上游代码），实测「认证」行仍是我们的盾牌 SVG（`class="…navIcon"`），不是回退齿轮。即便未来 DOM 结构变动，也只是退回齿轮（纯外观降级，不会让面板坏掉）。

### 11. tsdown client preset ——⚠️ 上游大改，但我们自包含

`packages/client/tsdown.client.ts` 本次改动很大：新增 bundle 输入隔离门（`BundleInputIsolation`）、`chunkFileNames: 'client.[name].js'`、`banner` 函数化（非入口 chunk 带 `chunk:` 字段）、`require.async` 动态 chunk 改写、`clientBanner` 选项。**我们的 `tsdown.config.ts` 是自包含的模仿实现，不 import 上游 preset**，因此不受影响（构建实测通过，单入口单 chunk）。仅当将来我们引入动态 import 或 CSS Modules 时才需要跟这套机制。

### 12. 上游账号体系 ——✅ 不是替代品

新增 `dsh-api-account-controller` / `dsh-client-ui-settings-account` / `dsh-credentials-deepseek-account(-platform)`：是**登录 DeepSeek 云账号换取推理凭据**的 OAuth 流程（`settings.models.sign-in` slot、`/oauth/callback` 路由、PKCE），**不是**自托管的访问闸门，没有 account/password/revoke-for-remote 类能力。本插件「给 `--host 0.0.0.0` 提供登录墙」的存在理由不变。

### 13. 启动审计 ——⚠️ 失败会「响亮地挂」，不再静默

web-app 本次新增 `await auditStartupEntries(connectionCtx.root, 'dsh web', …)`。必需条目清单 = `agent-loop` / `webserver` / `modules` / `connection` / `headless-runner` / `acp` / `sdk-jsonrpc-server`：

- 我们自己的三行（`dsh-web-startup-auth` / `remote-web-startup` / `web-auth`）**不在**清单内 → 它们失败只 warn；
- 但 `connection` 在清单内，而我们的 patch 强制 `connection` 注入 `webAuth` → **若 auth 插件激活失败，connection 会 pending，进而硬启动失败**。这是 fail-loud（安全侧更优：不会出现「没设防还在跑」的窗口），代价是可用性——auth 插件一旦与新版不兼容，整个 `dsh web` 起不来。排查时先看这条因果链。

### 14. 版本与依赖面 ——✅ 无阻塞

- 依赖包 `dsh-credentials` / `dsh-cmdline` / `dsh-host-webserver` / `dsh-client-ui-settings` / `dsh-client-ui-slots` 在 0.1.7-rc.1 **全部已发布**；
- `credentialKey` 实现未变；`dsh-cmdline` 源码零 diff（`parseCmdline` 契约不变）；
- Node engine `^22.19.0 || >=24.0.0`；React 仍 `^18.2.0`（与我们 peerDependencies 一致，上游没有跳到 19）；
- 0.1.5-rc.3（当前 `latest`）相对 rc.2 **只有 package.json 版本号变化**（无源码 diff）→ 停在 rc.2 基线的用户无需为 rc.3 做任何事。

## 实机验证记录（2026-09-23，dsh 0.1.7-rc.1）

### A. 构建探针（临时副本，不动本仓库）

把仓库副本的 5 个 `@deepseek-ai/dsh-*` 依赖全部 bump 到 `0.1.7-rc.1` 后：

- `npm run typecheck` → 0 错误；
- `npm test` → **101/101 通过**（3 个 spec 文件）；
- `npm run build` → `lib/client.js` 42.57 kB、`lib/client.js.map` 60.14 kB，构建成功。

### B. 隔离实例（`DSH_HOME=/tmp/dsh017-home`，端口 3099，`--host 0.0.0.0`）

`dsh plugin --profile web add <探针目录>` 从官方 web 模板初始化 profile，`--dump-config` 确认 patch 生效后启动。

**curl（LAN 192.168.5.216:3099）**：

| 场景 | 结果 |
|---|---|
| 匿名 `GET /`（`Accept: text/html`） | **302 → /login** |
| `/login`、`/api/auth/status` | 200 |
| 匿名受保护 `/api/*` | **401** |
| 注册（首次） | 200，**2 个 Set-Cookie**（`dsh_sid` + 原生） |
| 登出 → 登录 | 200 |
| 带 `dsh_sid` 的 `GET /`（导航） | **200 + `Set-Cookie dsh-auth-<sha256(authority)>` + `meta refresh` 回原路径** |
| 双 cookie 重放 | 200，含 `__DSH_BOOT__` |
| 仅原生 cookie、无 `dsh_sid` | **302 → /login**（`dsh_sid` 仍是唯一边界） |
| client bundle 匿名 / 已认证 | **401 / 200**（42.6 kB，`__ModuleLoader__.load` banner） |
| 登出 | 双 cookie `Max-Age=0` |
| `auth-reset --password …` | 旧会话 **302**、新密码 200、旧密码 **401**（secret 轮换生效） |
| `/oauth/callback`（无登录尝试时） | 404（路由不存在，无从拦起） |

**真实浏览器（chromium headless via agent-browser，注入自签 `dsh_sid`，LAN 地址）**：

- 主界面完整加载（未被踢回登录页）；`globalThis.__DSH_TRANSPORT__ === {"ownsHost":true}`；
- 设置面板导航含 **通用设置 / 模型 / 内置插件 / Agent 预设 / 认证**；「认证」页四块内容齐全（账号 `probeadmin` + 退出登录、修改用户名、修改密码、登录要求、会话有效期 14 天）；
- 「模型」页正常渲染（DeepSeek provider 卡片），**无 `settings are unavailable`** → isLoopback 钩子生效；
- 「认证」导航行图标仍是我们的盾牌 SVG；
- 全程 **56 个请求、0 个非 2xx**；服务端日志零 error/pending/告警。

### C. 已发布 npm 产物复核（2026-09-24）

首次核查以 harness **源码 tag** 为准，本次针对 `npm i -g @deepseek-ai/dsh@0.1.7-rc.1` 真正落地的**已发布产物**复核，确认结论可从源码平移到产物。

**时间线**：`0.1.7-rc.1` 于 npm `2026-09-23T13:44Z` 发布，首次核查在 `15:30Z`（23:30 CST）→ 首次核查针对的就是这一版；此后上游零提交（`origin/master` 仍 = `46a7f68b09` = tag `dsh-v0.1.7-rc.1`），无 rc.2 / 无新分支。

**产物解包逐点核对**（`npm pack` 四个包，与源码结论逐字一致）：

| 耦合点 | 已发布产物实测 |
|---|---|
| 原生 cookie | `lib/index.js`：`COOKIE_PREFIX = "dsh-auth-"`、`AUTH_RECORD_KEY = credentialKey("client-connection","browser-session")`、名字 = prefix + base64url(sha256(authority))、值 `v1.<body>.<sig>`（HMAC-SHA256 over body）、`SameSite=Strict; HttpOnly; Path=/` |
| `/api` 闸门 | `requestRejection`（403 信任围栏 → 401 原生 cookie）、`admit()`、prefix 路由经 `webCtx.webServer.register(route)` + `waterfall("connection/request", …)` |
| webserver 注册口 | `register` / `registerUpgrade` / `registerFallback` 三口健在（`lib/index.js:177/191/206`） |
| 客户端信任钩子 | `__DSH_TRANSPORT__` 仍被读、`isLoopback: transport?.ownsHost === true \|\| pageLocation === undefined \|\| isLoopbackHostname(...)` 逐字未变 |
| `0.0.0.0` 拒绝 | `web-app/lib/startup.js:40` 仍在 → `remote-web-startup` 替换仍是刚需 |
| patch 目标 | 产物内 `cordis.patch.yml` 仍有 `id: web-startup`(142) 与 `id: connection`(197) |

本插件镜像常量与产物逐条相同（`src/auth.ts` 的 371 / 376 / 406 / 465 / 471 行）。

**实机复核**（`/tmp/dsh017` 装的 0.1.7-rc.1 CLI + 全新 `DSH_HOME=/tmp/dsh017-verify` + 端口 3099 + `--host 0.0.0.0`）：

- `typecheck` 0 错误、`vitest` **101/101**、`tsdown` `lib/client.js` **42.57 kB**（与首次核查完全一致）；
- `--dump-config`：`web-startup` disabled、`connection` inject `[webServer, webRuntime, webAuth]`、本插件三行齐全；
- curl：匿名 `/`（html 导航）→ **302 `/login`**、`/login` 与 `/api/auth/status` 200、匿名受保护 `/api/*` → **401**、注册 200（**2 个 Set-Cookie**）；
- **补签三段对照（关键证据）**：匿名 `/api/rpc` → `{"error":"unauthorized"}`（**本插件**闸门）；仅 `dsh_sid` 无原生 cookie → 纯文本 `unauthorized`（**上游** `requestRejection` 的 401）；双 cookie → 404（已穿过上游闸门）→ **证明补签出的原生 cookie 被上游自己的校验器接受**；
- 仅 `dsh_sid` 的导航 → **200 bounce + `Set-Cookie dsh-auth-<sha256(authority)>`**（authority = `192.168.5.216:3099`）；登出双 cookie `Max-Age=0`；`auth-reset` 后旧会话 **302**、旧密码 **401**、新密码 **200**；
- boot 图 `plugins/??dsh-web-startup-auth/client.js&rev=<rev>`（相对路径；**`&rev=` 不可省——省掉直接 404**），匿名 401 / 已认证 200（42,614 B）；
- 真实浏览器（chromium，LAN 地址）：登录表单 → 主界面；`__DSH_TRANSPORT__ === {"ownsHost":true}`；设置面板导航含「通用设置/模型/内置插件/Agent 预设/**认证**」，「认证」页四块内容齐全；「认证」行图标仍是我们的盾牌 SVG（`class="…navIcon"`）；「模型」页正常、**无 `settings are unavailable`**；全程 **50 请求 0 非 2xx**，服务端零告警。

## 待跟进清单（不阻塞升级，但正式版前应处理）

1. ✅ **P1｜`/oauth/callback` 会被登录墙拦住（新的条件性冲突）——已修复（v0.1.11，2026-09-25）**
   上游账号登录把回调注册在**同一个 webserver** 上（`webServer.register({ kind: 'exact', path: '/oauth/callback' })`，redirect URI = `window.location.origin + /oauth/callback`）。我们的 `isPublicRoute` 只豁免 `/login` 与 `/api/auth/*`，所以**当一次登录尝试正在进行时**，该回调会被包装器接管：
   - 同浏览器已登录（有 `dsh_sid`，`SameSite=Lax` 在顶层 GET 导航会带上）→ 放行，正常；
   - 浏览器没有 `dsh_sid`（换浏览器打开登录链接、清过 cookie、或平台侧在别的容器里打开）→ **302 `/login`，OAuth 回调丢失**。
   建议：把 `/oauth/callback` 加入 `isPublicRoute`（它本身由 `state` + PKCE 保护，且只在一段登录尝试期间存在，暴露面极小），并在 `docs/agent/auth-mechanics.md` 记一条。
   *第二次核查补充（2026-09-24）*：路径确认来自 `packages/credentials/deepseek-account-platform/src/index.ts:377`，**该包属于 base bundle 默认安装**（`bundle/base/package.json:125` + `cordis.patch.yml:113`，已发布产物里存在）；路由由 `ctx.effect(...)` 在**一次登录尝试期间**动态注册、尝试结束即 dispose → 与上述「条件性」判断一致。另确认 bounce 分支保留完整 request target（`src/auth.ts:1105` 用 `req.url`），所以**已登录用户的回调不会被 bounce 丢掉**（meta refresh 回带 `code`/`state`），丢失面仅限「无 `dsh_sid`」那一种。
2. ✅ **P2｜凭据文件硬编码 `~/.dsh`，不读 `$DSH_HOME`** —— **2026-09-24 实测复现，已修复（v0.1.11，2026-09-25）**
   `src/credential-store.ts` 用 `join(homedir(), '.dsh')`（仅 `DSH_WEB_AUTH_FILE` 覆盖）。第二次核查用全新 `DSH_HOME=/tmp/dsh017-verify` 起服务，`/api/auth/status` 直接返回 `{"registered":true}`、注册被拒「管理员账号已设置」——**它读的是宿主机真实的 `~/.dsh/web-auth.json`**（mtime 未变，未被写坏；改设 `DSH_WEB_AUTH_FILE` 后隔离才成立）。
   影响：`DSH_HOME` 自定义 / 多 profile / 多实例部署会**共用同一份凭据**（既可能串号，也可能让「隔离实例」意外拿到生产管理员账号）。建议改为优先读 `$DSH_HOME`。
3. **P3｜文档与验收命令的 URL 形状**
   boot 图引用已从 `/plugins/??…` 变为相对 `plugins/??…`；`docs/agent/*` 与验收清单里相关表述要更新。
4. **P4｜可选优化：改用官方 `connection/request` waterfall**
   比 monkey-patch `webServer.register` 更稳（上游显式开放的扩展点）。非必需，可作为独立重构。
5. **P5｜第三方 bundle 实测**
   dshmarket / dsh-better-sidebar / dsh-ntr 等随 `next` 浮动，正式版迁移时逐个升 + 重启验证（沿用 0.1.2 的教训）。

## 执行记录（2026-09-25，随 v0.1.11 落地）

清单 1–4 已全部执行，本节是执行留痕：

1. ✅ **依赖 bump**：5 个 `@deepseek-ai/dsh-*` `^0.1.5-rc.2` → `^0.1.7-rc.1`（`dsh-credentials` / `dsh-cmdline` / `dsh-host-webserver` / `dsh-client-ui-settings` / `dsh-client-ui-slots`），`npm install` 重生成锁文件（顺带把 `schemastery` 解析到 3.18.4，即 PR #32 想要的版本，该 PR 可关）。
2. ✅ **全链路**：`typecheck` 0 错误、`vitest` **180/180**（含滑块拼图新测试）、`build` 通过（新 build 脚本先清空 `lib/`，构建后 `git status` 对 `lib/` 零差异 = 产物可复现）。
3. ✅ **P1**：`src/auth.ts` 的 `isPublicRoute` 增加 `path === '/oauth/callback'`（注册后动态路由路径逐字匹配）；测试 `tests/auth.spec.ts` "leaves a dynamically registered /oauth/callback anonymous"（无会话的远程请求直达上游 handler）；机制记入 `docs/agent/auth-mechanics.md`「覆盖范围」。
4. ✅ **P2**：`src/credential-store.ts` 改为 `DSH_WEB_AUTH_FILE` > **`$DSH_HOME`** > `~/.dsh`（空/全空白视为未设置，与 harness `packages/util/home-paths` 的 `resolveDshHome` 同语义），`ensureDir` 与文件路径共用同一目录函数；测试两例（自建 home 写入生效 + 空值回落默认）。
5. ⬜ `--dump-config` + 实机验收：**rc.1 隔离实例与作者真实实例（0.1.7-rc.1 + 本插件 link）均已实测通过**（见「A. 构建探针」「B. 隔离实例」「C. 已发布 npm 产物复核」），本版相对 0.1.7-rc.1 仅增加上述两处小修，未改动补签/闸门/patch 逻辑。
6. ⬜ 真实 DeepSeek 账号 OAuth 回调端到端（隔离实例无 DeepSeek 凭据，仍无法实测——P1 修复的回归测试覆盖的是「不被登录墙吃掉」这一段）。
7. ✅ **文档**：README 双语 / AGENTS / `auth-mechanics` / `native-auth-bridge` 的基线与凭据路径表述同步到 0.1.7-rc.1。

## 正式版发布时的迁移动作（执行清单）

1. `npm i -g @deepseek-ai/dsh@<正式版>`；本仓库 5 个 `@deepseek-ai/dsh-*` 依赖 bump 到同一版本（`renovate.json` 清单已含 `dsh-credentials`），`npm install` 重生成锁文件。
2. 仓库层 `npm run typecheck && npm test && npm run build`（本手册的探针流程可直接复用：`/tmp/dsh-auth-probe` 是同一套脚本）。
3. 处理 P1（`/oauth/callback` 豁免）与 P2（`$DSH_HOME`）——两者都很小，建议与版本 bump 同一个 PR。
4. `dsh --profile web --dump-config` 复核：`web-startup` disabled、`connection` inject 三件套、本插件三行齐全。
5. 起服务跑验收：LAN + 回环双场景、双 cookie 补签、登出双 cookie 清除、`auth-reset` 轮换、认证标签页、模型页无 unavailable、client.js 匿名 401 / 已认证 200。
6. 若用户在 LAN 部署上使用 DeepSeek 账号登录，**额外手测一次真实账号 OAuth 回调**（这是本次唯一未能实测的路径——隔离实例没有 DeepSeek 凭据，无法发起真实登录）。
7. 更新 README / AGENTS.md 基线声明到正式版号，并按 `docs/release-guide.md` 发版。
