# dsh 0.1.5-rc.1 适配性检查（观察哨）

> 触发：`@deepseek-ai/dsh`（CLI 主包）dist-tag 变动——`next` **和 `latest`** 都推进到 `0.1.5-rc.1`（2026-09-10）。本机当前 dsh = `0.1.2-rc.1`，插件依赖 = `^0.1.2-rc.1`。
> **注意与 0.1.2 时代不同**：当时 `latest` 停留在 0.1.1-rc.2、只有 `next` 触发迁移；现在 `latest` 也指向 0.1.5-rc.1，**裸 `npm i -g @deepseek-ai/dsh` 的用户会直接装到 0.1.5-rc.1**，迁移紧迫性高于上次。
> 本文基于 npm registry 产物对比（0.1.2-rc.1 vs 0.1.5-rc.1，逐包 tarball 解包核对），harness git 仓库直连 fetch 超时未用。

## 结论速览

**观察哨全部通过，P0/P1 方案（0.1.2 迁移产物）在 0.1.5-rc.1 上依然全部适用，无需修订。** 唯一结构性变化（connection 的 `/api` 挂载改条件注入）对我方**有利**（见下）。**建议执行 0.1.5 迁移**，流程复用 `upgrade-dsh-0.1.2-playbook.md`，差异点已在本文件补记。

## 观察哨逐项（对照 upgrade-dsh-0.1.2-playbook.md「观察哨」清单）

### 1. `browser-auth.ts`（原生 cookie 格式/密钥存储）——✅ 零改动

对比 `@deepseek-ai/dsh-client-connection` 编译产物：

- `lib/index.js`（node 半）整体 diff 仅 **250 行**，全部为请求体流式处理重构（`bridge` 函数：新增 streaming body mode、`requestBodyMode` 分派、`Readable.toWeb`）与 recovery 配置新增；
- **认证面逐标记核对**：`dsh-auth-` cookie 名前缀、`isTrustedApiRequest` 信任围栏、`authorizeIndex`、`browser-session` 密钥存储 key、`v1.` cookie 值前缀——全部 0.1.2 vs 0.1.5 命中数一致；
- `requestRejection` 双闸门（`isTrustedApiRequest` + `isAuthenticated`）在 `/api` 挂载 handler 里**原样保留**。

→ 补签逻辑（格式、cookie 名算法、secret 读取 key）零变更，**无需改代码**。

### 2. `startup.ts` 的 0.0.0.0 拒绝——✅ 还在

`@deepseek-ai/dsh-web-app` 0.1.5 产物 grep `intentionally not supported` 命中 1 处（与 0.1.2 相同）→ `remote-web-startup` 替换仍是刚需。

### 3. `isLoopback` 判定 / settings mirror——✅ 钩子仍吃

`dsh-client-connection/lib/client.js` 0.1.5 的 `isLoopback` 计算式**与 0.1.2 逐字符一致**：

```js
isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)
```

→ 我方 `window.__DSH_TRANSPORT__ = { ownsHost: true }` 方案（LAN 浏览器 settings mirror）继续有效。

### 4. 上游账号/撤销类能力——✅ 无

0.1.3-alpha.2 / 0.1.5-alpha.1 / 0.1.5-alpha.2 / 0.1.5-rc.1 的 release notes 全部为功能新增（文件上传、右侧 Sidebar、子代理消息队列/Steer、动态系统提示词、Open-In-App 等），**无 account/password/revoke/logout 类能力** → 本插件账号体系存在理由不变。

### 5. dist-tags 与第三方 bundle——⚠️ 注意

- `@deepseek-ai/dsh`: `next` = `latest` = `0.1.5-rc.1`（alpha = 0.1.5-alpha.2）→ 触发条件 A 满足（且 latest 也满足，比 0.1.2 更紧迫）；
- 我方依赖的 `@deepseek-ai/*` 子包 `next` 全部 = `0.1.5-rc.1`；
- profile 里第三方 bundle（dshmarket `^1.45.1` 等）随 `next` 浮动，**实机兼容性未测**（沿用 0.1.2 教训：dshmarket 曾因上游删导出而启动失败，需逐个升 + 重启验证）。

## 上游 0.1.2 → 0.1.5 关键变化（已核查证据）

### A. connection 的 `/api` 挂载改为条件注入（对我方有利）

- 0.1.2：connection 包默认 `inject = ["webServer","credentials"]`，`apply` 里直接 `ctx.effect(() => ctx.webServer.register(route))`；
- 0.1.5：默认 `inject = ["credentials"]`，`/api` 路由改在 `ctx.inject(["webServer"], (webCtx) => { … register … })` 内条件挂载（webServer 缺席时连接服务照常提供、不挂 `/api`）。
- **对我方的影响**：我方 `cordis.patch.yml` 给 connection 追加 `inject: [webServer, webRuntime, webAuth]` **仍然有效**（行 id `connection` 健在，0.1.5:181），且强制 connection 等 `webAuth` 就绪 → 路由保护顺序（auth 先包装、connection 后注册）**比上游默认更严格**。上游的条件注入是额外兜底，两者不冲突。
- `requestRejection` 双闸门在条件挂载 handler 里原样调用，认证语义不变。

### B. 请求体流式处理重构（无影响）

connection `/api` 的 `bridge` 函数新增 streaming body mode（`requestBodyMode`、`Readable.toWeb`、未读请求关闭连接）。HTTP 对外语义一致（buffered 路径行为不变），我方包装器不感知。

### C. 断线恢复（recovery）机制（无影响）

connection 新增 `ConnectionRecoveryConfig`（backoff 参数）与 `__DSH_CONNECTION_RECOVERY__` 页面注入；client.js 新增 recovery 解析。与认证无关，我方不依赖。

### D. web-app 新插件行（无影响）

0.1.5 web-app patch 新增 `open-in-app`、`workspace-files`、`resources`、`file-upload`、`ui-sidebar-right`、`ui-sidebar-documentpreview`、`ui-sidebar-files` 等行，`tool-str-replace-editor` 的 disable 被移除——均与我方 patch 目标行（`web-startup`、`connection`、插入行）无重叠。`webRuntime` 服务仍由 web-app 提供（`WEB_RUNTIME_SERVICE` 命中 2 处）。

### E. CLI 主包（dsh）内部重构（无影响）

`lib/bin.js` 及分块文件仅 hash 文件名变化（`dump-config-*`、`plugin-*`、`profile-boot-*`），`--dump-config`/`--profile`/`--version` 等命令面 grep 一致。`launchedThroughSsh` 从 web-app 内联函数移入 `dsh-launch-environment` 导出（行为等价，不影响 `--host 0.0.0.0` 语义）。

## 适配判断

| 观察哨项 | 结论 |
|---|---|
| 补签 cookie（格式/密钥） | 零变更，代码不动 |
| 0.0.0.0 拒绝 | 还在，startup 替换保留 |
| isLoopback 钩子 | 原样，`__DSH_TRANSPORT__.ownsHost` 方案保留 |
| 账号/撤销能力 | 上游没有，插件存在理由不变 |
| `/api` 路由挂载 | 条件注入化，我方强制注入兼容且更稳 |
| dist-tag | latest 也到 0.1.5-rc.1，迁移紧迫 |

**结论：0.1.5-rc.1 与本插件完全适配，无需改插件代码。** 迁移动作 = 升级全局 dsh + 更新依赖（Renovate PR 已备好，见 `renovate-prs-review-2026-09-10.md`）+ profile 第三方 bundle 逐个验证 + 按 0.1.2 验收清单手测。

## 迁移改动清单（仓库层，逐项确认后执行）

> 源码层（`src/`）**无必改项**（认证面零变更、webserver 私有结构原样），但仓库层有明确的文件改动任务，迁移时逐项落地：

1. **`package.json` 依赖 bump**：合并 Renovate PR（#15/#16/#19/#20），并**手动补 `dsh-credentials` → `^0.1.5-rc.1`**（Renovate 配置缺口导致它无 PR，不补会版本偏斜）；`npm install` 重生成锁文件。
2. **`renovate.json`**：`matchPackageNames` 清单补 `"@deepseek-ai/dsh-credentials"`（堵住缺口，否则下轮升级又偏斜）。
3. **`README.md` / `README.en.md` 版本基线**：把「dsh 0.1.2 起」类表述更新为 0.1.5（涉及「原生浏览器认证桥接」段落的功能描述句；基线声明段跟进 `next` 不变，指向 0.1.5-rc.1）。
4. **`AGENTS.md` 版本基线段落**：`当前基线 dsh 0.1.2-rc.1` → `0.1.5-rc.1`；「原生浏览器认证桥接（dsh 0.1.2 起…）」的版本注记同步；观察哨指引（`upgrade-dsh-0.1.2-playbook.md`）补一句 0.1.5 已核查结论见本文档。
5. **`docs/upgrade-dsh-0.1.2-playbook.md`**：文首加一行「0.1.5-rc.1 适配核查结论见 `upgrade-dsh-0.1.5-playbook.md`」的指路（该手册主体仍有效，不重写）。
6. **第三方 bundle 实测**：dshmarket 等随 `next` 浮动，0.1.2 时代踩过启动失败（上游删 `installSettingsSection` 导出），0.1.5 同样先升后测。
7. **验收手测**：沿用 0.1.2 验收清单（LAN + 回环双场景、补签双 cookie、登出双 cookie 清除、认证标签页、`/plugins/??<id>/client.js&rev=` URL），加测文件上传（0.1.5 新功能）走我方包装器时的未认证 401 / 已认证 200。

## 2026-09-10 实测记录（dsh 0.1.5-rc.1 实机迁移）

当日执行本手册：全局 dsh `0.1.2-rc.1 → 0.1.5-rc.1`，插件依赖全部 bump `^0.1.5-rc.1`（含手动补 `dsh-credentials`），`renovate.json` 补缺口，README/AGENTS 基线更新。仓库层 `npm run typecheck && npm test && npm run build` 全绿（93/93）。**源码零改动**，与本文结论一致。

**插件树**（`dsh --profile web --dump-config`）：`web-startup` 仍 `disabled`；三条本插件行（包根 + `remote-web-startup` + `web-auth`）齐全；`connection` 行 inject `[webServer, webRuntime, webAuth]` 保留 → 路由保护顺序不变。

**curl 验收（LAN 192.168.5.216:3080 + 回环）**：

- 匿名 LAN `GET /`（`Accept: text/html`）→ 302 `/login`；`/login`、`/api/auth/status` → 200；受保护 `/api/*` → 401。
- 自签 `dsh_sid`（`web-auth.json` secret）LAN `GET /` → 303 + `Set-Cookie dsh-auth-<sha256(192.168.5.216:3080)>`（cookie 名与算法核对一致），带双 cookie 重放 → 200 且含 `__DSH_BOOT__`。
- 仅原生 cookie 无 `dsh_sid` → 302 `/login`（`dsh_sid` 仍是唯一边界）。
- 登出 → 双 cookie `Max-Age=0`。
- client.js（boot 图 URL `/plugins/??dsh-web-startup-auth/client.js&rev=…`）已认证 200 / 未认证 401。
- 0.1.5 新增文件上传路由 `POST /api/session/uploadFileBinary`：未认证 401；已认证进入上游（400/415 为上游参数/媒体类型校验，非 401，说明已过认证边界）。
- 回环补签：GET `/`、GET `/api` 缺 cookie → 303 + Set-Cookie；POST RPC → 401（303 会把 POST 变 GET，故不跳）。远程 token URL 被登录墙拦为 302 `/login`（**顺带修正 AGENTS「0.1.2 的回环体验闭环」一节的旧表述**）。

**真实 LAN 浏览器（chromium headless via agent-browser，注入自签 `dsh_sid`）**：主界面正常加载；设置面板全部 section（通用设置/模型/插件/Agent 预设/插件市场/认证/侧边卡片）渲染；**Models「提供方目录」完整渲染、无 "settings are unavailable"**——`__DSH_TRANSPORT__.ownsHost` hook 在 0.1.5 生效（观察哨第 3 项实测确认）；认证标签页显示账号 `wpxxl` + 退出登录 + 修改用户名/密码 + 登录要求；全量 API 请求 200，第三方 `dshmarket/client.js`、`sidebar/api/*` 均 200；服务启动日志零 error/pending。

**结论**：0.1.5-rc.1 迁移完成，插件源码零改动；第三方 bundle（dshmarket 1.45.1、dsh-better-sidebar 0.18.1、dsh-llm-pi-ai-pro、dsh-tui）随 0.1.5 启动正常。
