# dsh 0.1.2 升级适配手册与退役路线

> 写给接手本插件的 LLM/开发者。本文基于 harness 源码 tag `dsh-v0.1.2-alpha.1` 的实地核查（2026-08-29），不是猜测。
> **写作时点**：npm 官方 registry 尚未发布 0.1.2-alpha.1（`@deepseek-ai/dsh` latest/next = 0.1.1-rc.2），本机 dsh 也是 0.1.1-rc.2——**升级前本插件一切正常，本文是预演**。
> **2026-08-31 更新**：`0.1.2-alpha.2` 已发布，但**只在 `alpha` dist-tag**（registry 上 alpha.1 已撤，`next`/`latest` 仍是 0.1.1-rc.2）。当日做了实机兼容性测试（见文末「2026-08-31 实测记录」），破坏模式与本文预言完全一致；**决策：等 `next` 或 `latest` 推进到 0.1.2 再执行迁移**（裸 `npm i -g @deepseek-ai/dsh` 的用户暂时不会撞上），期间保持 0.1.1-rc.2。
> **2026-09-03 实施记录（目标 dsh-v0.1.2-rc.1，`/app-alpha`）**：P0 已落地并实机验证——
> ① `src/auth.ts` 删除 Host/Origin 改写；② 原生 cookie 补签：登录/注册/改密/改用户名响应同时下发 `dsh_sid` 与 `dsh-auth-<authority>`；③ wrapper 对通过认证但缺原生 cookie 的请求**同请求注入**（改 `req.headers.cookie` + Set-Cookie 持久化），升级握手同步注入；④ 客户端包与 `dsh.client.inject` 移除 `dsh-client-runtime`，类型面改用 `@deepseek-ai/cordis` 的 `Context` + `dsh-client-ui-renderer/client`。
> 实机证据（rc.1 源码 + 本插件 link 的临时 `DSH_HOME`，端口 3091/3092）：注册 200 双 Set-Cookie；回环 `/api/*` 404 + 原生 cookie 同请求注入通过上游双重闸门（401→404）；远程 Host + 有效 `dsh_sid` → 403(`forbidden`，信任围栏按 `trustedHosts` 判定，未配域名属预期) + 按真实 authority 补签；boot 图 47 个 client entry 全部 200、无 `dsh-client-runtime` 引用。剩：`next` 上线后由真实部署重启验证浏览器全链 + 未核查的第三方 channel 回环自检（P1 清单）。

## 触发条件（什么时候开始做）

满足任一条即按本文执行：

- `npm view @deepseek-ai/dsh dist-tags` 的 `next` **或 `latest`** 到达 `0.1.2` 线（含预发布）；
- 用户升级 dsh 后本插件远程登录失败（典型症状：拿到有效会话后访问 `/` 或 `/api` 仍返回 401，body 为 `unauthorized` 或 `dsh web authentication required; reopen the URL printed by dsh web.`）。

**2026-08-31 现况**：`0.1.2-alpha.2` 只发在 `alpha` tag（alpha.1 已从 registry 撤下），`next`/`latest` 仍是 `0.1.1-rc.2`——裸 `npm i -g @deepseek-ai/dsh` 的用户不会撞上。**决策（用户拍板）：不为 `alpha` tag 提前动工，等 `next`/`latest` 推进再执行本文**；只有上面第二条（真实用户报错）出现时才提前介入。

## 上游变化摘要（已核查的证据）

harness 仓库位置：`/home/pax/coding/research/deepseek-harness`。拉取新 tag 时 git 直连/flaky 时走代理：
`git -c http.version=HTTP/1.1 -c http.proxy=http://127.0.0.1:7897 fetch --depth 1 origin tag <tag>`（大 pack 传输易被截断，浅抓单 tag 最稳）。

### 破坏性（正面对撞本插件）

1. **dsh 原生新增浏览器认证**（`packages/client/connection/src/browser-auth.ts`，313 行）：
   - `dsh web` 启动打印带 `?token=` 的 URL（含 LAN 变体，`packages/bundle/web-app/src/index.ts:272-281`）；访问后 303 换取签名 cookie。
   - cookie 名 = `dsh-auth-` + base64url(sha256(authority))，**authority 取自请求 Host 头**；值 = `v1.` + base64url(JSON`{version:1,authority,issuedAt,expiresAt}`) + `.` + base64url(HMAC-SHA256(secret,body))；`HttpOnly; SameSite=Strict`；有效期默认 30 天（`cookieMaxAgeDays` 配置，`connection/src/index.ts` ConnectionConfig）。
   - 签名密钥 = 32 字节随机，base64url 后存 credentials 服务：`credentialKey('client-connection','browser-session')`，record `{kind:'grant', payload:{version:1, secret}}`；持久、跨重启不失效，**无账号概念、无撤销**。
   - `connection` 插件 `inject` 变为 `['webServer','credentials']`，`apply` 变 async。
2. **`/api` 双重闸门，无回环豁免**（`packages/client/connection/src/rpc-host.ts:96-99`）：`requestRejection = 信任围栏(403) + isAuthenticated(401)`。`index.html` 也被 `authorizeIndex` 把守（`packages/host/frontend-static/src/index.ts:89,139`）。**回环访问同样需要 token 换来的 cookie**——本插件「真回环免登录」语义与上游冲突了。
3. **`PRIVILEGED_METHODS` 与 `authority:"loopback"` channel 整体删除**——本插件「Host/Origin 回环改写」的靶子消失，且改写变为**主动有害**：改写后 Host 变成 `127.0.0.1:<port>`，原生认证按改写后的 authority 找 cookie 名，远程浏览器必然 401（自伤）。
4. **`trustedHosts` 增强**：web runtime 在 all-interface 绑定时自动派生 LAN IP 字面量进信任围栏（`connection/src/index.ts` ConnectionConfig 注释）——不改写 Host，LAN 请求凭真实 Host 也能过围栏。
5. **`@deepseek-ai/dsh-client-runtime` 包被删除**（全树零引用），其 `ClientContext` 类型不存在了。`packages/host/apiproxy` 整体删除，换成 Typert Remote 的 session/settings/workspace controller（与本插件无直接冲突，但对照原版行为时注意）。

### 不变的部分（已逐项验证，别多改）

- `--host 0.0.0.0` 的 CLI 硬拒绝**还在**（`packages/bundle/web-app/src/startup.ts:74-75`）→ `remote-web-startup` 替换仍是刚需。
- `webServer` API 仅增量加 gzip：`register/registerUpgrade/tapIndex`、私有路由表 `exact/prefixes/upgrades` 原样（`packages/host/webserver/src/index.ts:133-138`）→ 本插件的事后追溯包装机制不变。
- patch 行 id `web-startup` / `connection` 仍在；`webRuntime` 服务仍由 web-app 提供 → 我方 `cordis.patch.yml` 的 `connection inject: [webServer, webRuntime, webAuth]` 与包根行保持。
- 前端插件机制原样：`__ModuleLoader__`/`mode='live'`/`__DSH_BOOT__`/`dsh.client` 扫描。**注意（2026-08-31 实测）**：alpha.2 起 `client.js` 分发 URL 变为 `/plugins/??<id>/client.js&rev=…`（boot 图 entry 的 `url` 字段），旧路径 `/plugins/<id>/client.js` 变 404——验收时从 `__DSH_BOOT__` 里取真实 URL 请求。
- 浏览器 `isLoopback` 仍按页面 hostname 判定（`connection/src/client/index.ts:172`）、settings-scope 仍按它冻结 persistence（`ui-settings/src/client/settings-scope.ts:291`）→ **isLoopback getter 覆盖仍然必要且机制有效**。
- `settings.section` slot 契约与 `settingsScope` 服务健在 →「认证」标签页不用动。
- 本插件的 `/login` 与 `/api/auth/*` 是 **exact 路由**，查找时优先于 connection 的 `/api` prefix 路由 → 匿名可达性不受原生闸门影响。

## 升级后必改清单（按优先级）

### P0 — 不改就坏

1. **`src/auth.ts`：删除 Host/Origin 回环改写**。连带动作：
   - 改写相关代码与 `tests/auth.spec.ts` 对应用例删除；
   - AGENTS.md「特权 API 回环放行」整节重写/删除；
   - README.md / README.en.md 对应特性描述同步（「远程场景修复」里的「特权 API 回环放行」一条）。
2. **`src/auth.ts`：新增「原生 cookie 补签」**。登录成功（以及持有有效 `dsh_sid` 但缺原生 cookie 的请求经过包装器时）读取 `ctx.get('credentials')` 里 `credentialKey('client-connection','browser-session')` 的 secret，按上面的格式给浏览器 `Set-Cookie: dsh-auth-<sha256(真实 authority)>`（`HttpOnly; SameSite=Strict; Path=/; Max-Age` 对齐 `cookieMaxAgeDays`）。
   - **cookie 名必须用请求的真实 authority 计算，绝不能用改写后的**（改写已删，注意别在别处残留 Host 变换）。
   - secret 可能不存在（connection 插件初始化时才创建）：处理竞态——secret 缺席时本次不补签，下个请求重试；不要自己创建（密钥归上游所有）。
   - **这是对上游内部实现的耦合**：格式、cookie 名、存储 key 任一变更都要跟。升级 dsh 后先 diff `browser-auth.ts`。
3. **保留路由保护包装，语义升级**：`dsh_sid` 仍是唯一认证边界——没有它，即使带合法原生 cookie 也拒绝（原生 cookie 无状态、30 天不可撤销，我方「登出/改密/auth-reset」的可撤销性全靠包装器兜住）。登出时除清 `dsh_sid` 外，**追加一发 `Max-Age=0` 的同名原生 cookie**（cookie 名可算，不需要 secret），做客户端侧清理。
4. **`package.json` + `src/client/index.tsx`：清理 client-runtime**。
   - 删 dependencies 与 `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-runtime`；
   - `ClientContext` 类型 import 换成 alpha.1 实际可用的上下文类型（对照 `packages/client/ui-settings/src/client/index.ts` 和 `ui-model-selection` 等新版客户端插件的写法，动手前先读）。
5. **信任判定语义复审（设计决策，勿机械平移）**：上游回环也要登录了。本插件「真回环免登录」是否保留要重新想——保留意味着本机浏览器仍需 token 交换才能用（上游行为），我方免认证层要能自己签原生 cookie 才能闭环；放弃则本机也要注册。写进 README 的结论要与此一致。**AGENTS.md「信任判定」整节届时重写**。

### P1 — 体验与回归

6. **登录重定向脚本核对**：未登录时上游 `authorizeIndex` 返回的是**纯文本 401**（丑），确认我方 `/login` 重定向在其之前生效（前端注入脚本 + exact 路由优先，两者都在，跑通即可）。
7. **测试更新**：`tests/auth.spec.ts` 补签 cookie 的正反用例（secret 存在/缺席、cookie 名随 authority、篡改拒绝）；每个 fake 请求继续同时给 `socket.remoteAddress` 和 `headers.host`。
8. **版本 bump**：全部 `@deepseek-ai/*` 依赖升到新发布线；`npm install && npm run typecheck && npm test && npm run build` 全绿后才装进 profile。**同时核查 profile 里的第三方 bundle**（2026-08-31 实测：`dshmarket@1.29.2` 在 alpha.2 上因上游删除 `dsh-settings` 的 `installSettingsSection` 导出**直接启动失败**，升 1.38.1 才恢复——升级流程要包含逐个升第三方包并重启验证）。

### 升级后验收清单（逐条手测）

- [ ] LAN IP + 明文 HTTP：首次注册 → 登录 → 首页 200（非 401 纯文本）→ 会话可用；
- [ ] 设置面板可开、Models 页可用（isLoopback 覆盖生效）、插件配置页可保存；
- [ ] 退出登录后：访问 `/` 与任意 `/api` 均 401（即使浏览器曾有原生 cookie）；
- [ ] 改密 / `auth-reset` 后旧会话全部失效；
- [ ] 第三方 channel（`/dsh-automation`、技能管理器等）远程可用——**注意**：它们若有自己的回环检查，源码不在本仓库，删除 Host 改写后是否仍 403 属**未核查风险项**，实测暴露再处理；
- [ ] 反代场景（bind 127.0.0.1、Host 公网域名）：补签的 cookie 名用公网 authority；
- [ ] `curl -s <host>:<port>/ | grep -o '__DSH_BOOT__[^<]*'` 含 `dsh-web-startup-auth`；取该 entry 的 `url` 字段（0.1.2 起为 `/plugins/??dsh-web-startup-auth/client.js&rev=…`，旧平路径已 404）请求之，返回 200。

## 退役路线

### 阶段判断

| 阶段 | 上游状态 | 本插件形态 |
|---|---|---|
| 现在 → 0.1.2 | 原生只有 token-URL 共享（无账号、无撤销、CLI 仍拒 0.0.0.0） | 全文保留 + 上述适配 |
| 上游开放非回环绑定（CLI 支持 0.0.0.0 或 profile 可配） | `remote-web-startup` 失去意义 | **先删这个入口**，插件收缩为 auth + client 两行 |
| 上游支持持久凭据/账号登录（如接 credentials 的密码认证、多用户、登出撤销） | web-auth 的账号体系被吸收 | 只保留上游没补的洞（polyfill、isLoopback 覆盖若前端仍按 hostname 判定） |
| 上游补齐前端非安全上下文问题与 scope 远程持久化 | 无任何差异价值 | **整包退役**：存档仓库，README 顶部放公告 + `dsh plugin --profile web remove dsh-web-startup-auth` |

### 提前退役件（不用等上游）

- Host/Origin 回环改写：升级 0.1.2 当天即删（P0 第 1 条）。
- 登录页品牌 SVG：与上游 `ui-primitives/BrandWordmark.tsx` 保持同源，退役时一并消失。

### 观察哨（每次上游发版都跑）

1. diff `packages/client/connection/src/browser-auth.ts`（cookie 格式/密钥存储位置变了 → 补签逻辑要跟）；
2. 查 `packages/bundle/web-app/src/startup.ts` 的 0.0.0.0 拒绝是否还在；
3. 查 `connection/src/client/index.ts` 的 `isLoopback` 判定与 `ui-settings/src/client/settings-scope.ts` 的冻结逻辑是否还按浏览器 hostname；
4. 查上游 release notes / `packages/client/AGENTS.md` 是否出现「account / password / revoke / logout」类能力；
5. 查 `npm view @deepseek-ai/dsh dist-tags` 的 `next`/`latest`/`alpha` 分别指向哪里（触发条件看前两者）；顺带确认 profile 里第三方 bundle 与前端 `client.js` 分发 URL 格式有无再变。

## 给接手者的三句话

1. 本插件的存在理由 = 上游**没有**的东西：0.0.0.0 启动、账号/密码、可撤销会话。上游补哪块，删对应代码，别恋战。
2. 唯一必须长期维护的耦合是「补签原生 cookie」，它坏的最常见形式是上游改了 `browser-auth.ts` 的格式——升级 dsh 第一步就是 diff 这个文件。
3. 改完源码必须 `npm run build` 并重启 `dsh web`；所有「没生效」先查没构建、再查包根行、最后查 patch 缓存。

## 2026-08-31 实测记录（dsh 0.1.2-alpha.2 实机）

当日把本机全局 `@deepseek-ai/dsh` 升到 `0.1.2-alpha.2`（仅 `alpha` tag 有），装上本插件实跑，随后**完整回滚到 0.1.1-rc.2 并回归验证**。结论：

**观察哨结果（alpha.1 → alpha.2）**：`browser-auth.ts` 零改动；0.0.0.0 拒绝在；`/api` 双闸门（`requestRejection = isTrustedApiRequest + isAuthenticated`）与 `authorizeIndex` 原样；`isLoopback` 仍按页面 hostname；无账号/撤销能力迹象——**本文 P0 方案在 alpha.2 上依然全部适用，无需修订**。

**兼容性矩阵（实机）**：

| 场景 | 结果 |
|---|---|
| 启动（插件三个入口） | 正常加载，无缺模块错误；启动 URL 带 `?token=`（原生认证启用） |
| `/login`、`/api/auth/*`（匿名，含 LAN） | 200，行为不变 ✅ |
| 回环匿名 `/` | **401** 纯文本 `dsh web authentication required; reopen the URL printed by dsh web.`（旧版是 200 免登录） |
| 仅 `dsh_sid`（合法自签）访问 `/`、`/api` | **401**——登录后仍进不去，**P0 补签是刚需，实锤** |
| 原生 cookie + `dsh_sid` | 200 ✅ |
| 伪造公网 Host + 原生 cookie、无 `dsh_sid` | 我方包装器 401——**包装器与 `dsh_sid` 边界在 0.1.2 下仍完整生效** |
| token 交换 | 303 + `Set-Cookie`，cookie 名随请求 authority 变（回环与 LAN 各一个名），格式与本文第 1 条一致 |

**手册没预料到的两件事**：

1. **第三方 bundle 会先炸**：`dshmarket@1.29.2` 在 alpha.2 上因上游删除 `@deepseek-ai/dsh-settings` 的 `installSettingsSection` 导出**直接启动失败**（`SyntaxError`），升到 1.38.1 才恢复。已并入 P1 第 8 条与观察哨。
2. **前端 `client.js` 分发 URL 变了**：`/plugins/??<id>/client.js&rev=…`，旧平路径 404。本插件的 client.js 经新 URL 仍 200、仍在 `__DSH_BOOT__` 里，但**依赖旧路径的检查脚本/文档要改**（已并入「不变的部分」与验收清单）。

**测试方法备忘**：无法提供真实密码时，可用 `~/.dsh/web-auth.json` 的 `secret` 本地自签 `dsh_sid`（`base64url(JSON{u,e}).hexHMAC-SHA256(secret)`）验证会话路径——只读凭据文件，不改状态。

**处置**：测试后全局 dsh 与 `dshmarket` 均已回滚原版本、`dsh web --host 0.0.0.0` 重启回归通过。**维持「等 `next`/`latest` 推进再迁移」的决策**（见触发条件节）。
