# 本插件架构总览

## 仓库文件布局

`src/*.ts`、`src/slider/*.ts` 与 `src/client/*.tsx`（源码，唯一修改入口）、`lib/`（构建产物，**入库**——`npm run build` 后随改动一并提交；发布时由 `files` 字段带上；删源码必须清理旧产物，否则死产物会跟着发布）、`tsdown.config.ts`（前端 bundle 打包）、`cordis.patch.yml`（bundle patch）、`tests/*.spec.ts`（vitest）、`renovate.json`（依赖更新机器人配置，见 `renovate.md`）、`README.md`（用户文档）、`AGENTS.md`（本索引）+ `docs/agent/`（本目录，按任务展开的细节）。

## 它做了什么（与原版的差异）

原版 `@deepseek-ai/dsh-web-app/startup`（`packages/bundle/web-app/src/startup.ts`）对 `--host` 值域设墙（rc.2：`0.0.0.0` 硬拒绝于 ~69 行；0.2.1 行反转：通配全拒、只收具体 IP 字面量）。本插件用两个子模块替换并补上认证：

1. **`remote-web-startup`**：行为与原版一致，只是**放开 `--host` 值域**——接受 `127.0.0.1`/`0.0.0.0`（rc.2 原样 + 拓宽 schema 供具体 IP 字面量）与任意具体 IPv4/IPv6 字面量（#35，上游 webserver 的 `host` schema 原地拓宽，见 `ipv6-bind.md`），并提供 `--public-url`/`--tls-cert`/`--tls-key` 官方新能力透传（0.2.1+，0.2.0 线明确报错拒绝）。安全责任转移到 auth 插件。
2. **`web-auth`**：强制远程访问者登录——登录/注册页（`/login`）+ 签名会话 cookie + 全部 `/api` 路由保护（`/api/auth/*` 除外）。免认证的只有**真正的回环请求**（见 `auth-mechanics.md`「信任判定」），与启动参数无关。**dsh 0.1.2 起**上游自带浏览器认证且回环不豁免，本插件额外做「原生 cookie 补签」桥接（见 `native-auth-bridge.md`）——0.1.1 时代的「Host/Origin 回环改写」已随上游删除 `PRIVILEGED_METHODS` 而移除。
3. **`auth-reset` 子命令**：`dsh --profile web auth-reset [--password <pwd>] [--username <name>]`，重设管理员密码和/或修改用户名并**轮换签名密钥**（所有已发会话 cookie 立即失效）——忘记密码、忘记用户名、修复含控制字符用户名的恢复路径。只给 `--username` 时密码保持不变；都不给时交互式输入新密码（历史行为）。
4. **设置面板「认证」标签页**：前端插件通过 `ctx.slots.inject('settings.section', …)` 注册，提供退出登录（调 `/api/auth/logout`）、修改用户名与修改密码（分别调 `/api/auth/change-username` / `/api/auth/change-password`，服务端校验当前密码后轮换密钥并重签当前会话）以及会话有效期档位选择（调 `/api/auth/session-max-age`，下拉即选即存）。详见 `settings-section.md`。

## 核心代码路径

| 文件 | 职责 |
|---|---|
| `src/startup.ts` | `remote-web-startup` 插件：commander 解析 `--host/--port/--trusted-host/--public-url/--tls-cert/--tls-key`（`--host` 经 `normalizeBindHost` 校验，`--public-url` 本地镜像上游校验器），`provide('webStartup', values)`——**`trustedHosts` = `--trusted-host` 条目 + `lanHosts(host)` 推导**（官方消费路径，patch 表达式直接读）；启动时拓宽 webserver host schema（`ensureIpv6BindSupport`）与 TLS 能力探测（`supportsTlsConfig`）；`auth-reset` 子命令（`runAuthReset`）；`WEB_STARTUP_SERVICE` 常量 |
| `src/ipv6-shim.ts` | `--host` 值域支持（#35 + 0.2.1 双时代，见 `ipv6-bind.md`）：原地拓宽 `WebServer.Config.dict.host`（通配经 schemastery union fallthrough）、`normalizeBindHost`、`lanHosts`（两时代 `connection` 信任围栏的权威列表）、`supportsTlsConfig`（boot 路径实例的 `Config.dict` 是否含 `tls` 成员） |
| `src/auth.ts` | `web-auth` 插件：登录页路由、`/api/auth/*` 端点（status/register/login/logout/change-password/change-username/policy/session-max-age/challenge/challenge-policy）、包装 `webServer.register`/`registerUpgrade`/`registerFallback` 做全路由保护（认证 + 原生 cookie 补签，见 `native-auth-bridge.md`）、`tapIndex` 注入 randomUUID polyfill + 未登录跳转、`provide('webAuth')` |
| `src/credential-store.ts` | 凭据持久化：scrypt 散列、`normalizeUsername`（剥 C0+DEL）/ `registerCredentials` / `validateCredentials` / `updateCredentials`（单次写+轮换）/ `resetPassword` / `changePassword` / `changeUsername` / `getUsername` / `signSession` / `verifySession` / `hasCredentials`；开关类配置 `requireLoopbackLogin` / `sessionMaxAgeDays` / `slideVerification`；`DSH_WEB_AUTH_FILE` 覆盖 |
| `src/slider/` | 滑块拼图验证（默认关闭、装饰性，见 `human-verification.md`）：`index.ts` 编排（`auth.ts` 只 import 它）、`challenge.ts` 领域（几何/容差/路径/剪影抽签——真缺口五种形状随机/假缺口生成，答案线上只走坐标点）、`render.ts` 表现（程序化背景 + 缺口 + 形状不同的假缺口 + 拼图块 → SVG） |
| `src/challenge-store.ts` | 一次性挑战表（工厂；TTL/上限/取即删），滑块签发与校验共用 |
| `src/session-limits.ts` | 会话有效期档位常量（`SESSION_MAX_AGE_CHOICES` / `DEFAULT_SESSION_MAX_AGE_DAYS` / `isValidSessionMaxAgeDays`）——node 半与 browser 半共享，必须保持零依赖 |
| `src/login-page.ts` | 自包含登录/注册页 HTML（黑白蓝风格 + brand wordmark SVG + 人机验证控件） |
| `src/client/index.tsx` | **前端插件**：向设置面板 `settings.section` 注册「认证」标签页（退出登录 + 修改用户名 + 修改密码 + 会话有效期 + 人机验证开关 UI），打包为 `lib/client.js` |
| `tsdown.config.ts` | 前端插件打包配置（`window.__ModuleLoader__.load` 格式、external 列表） |
| `src/index.ts` | 仅类型导出（`WebStartupValues`、`AuthConfig`、`WebAuthService`） |
| `cordis.patch.yml` | bundle patch：禁用 `web-startup`、insert 三个插件（含包根行 `dsh-web-startup-auth`，客户端扫描必需）、`connection` 注入 `[webServer, webStartup, webAuth]`（`webAuth` 是排序红线——auth 必须先于 connection 注册 API 路由激活；`webStartup` 是表达式访问的服务；`webServer` 是第三方 `connection.rpc.handle` 消费方必需，见 `docs/agent/ipv6-bind.md`「connection 行注入」）+ `trustedHosts: !!js ctx.webStartup.trustedHosts`（两时代通用的官方消费路径，LAN/IPv6 权威由本插件 startup 富化） |

## 对照原版与上游

- 想对照原版行为时看 harness 的 `packages/bundle/web-app/src/startup.ts`（原版 startup 逻辑）。
- 涉及 `--host` 绑定与信任权威时，对照 harness 的：
  - `packages/host/webserver/src/index.ts` — `WebServer.Config` 的 `host` 成员（rc.2：`127.0.0.1` | `0.0.0.0` union；0.2.1 行：任意具体 IP 字面量 + 通配硬拒）是本插件拓宽（`src/ipv6-shim.ts`）的对象，升级 dsh 后先 diff 它的形状；`tls` 成员是否存在是 `supportsTlsConfig` 的能力信号。
  - `packages/bundle/web-app/src/startup.ts` — `trustedHosts` 权威列表的生产者（本插件接管照做）；rc.2 的 LAN 推导在其 `resolveLanTrust`（只枚举 IPv4 且只对 `0.0.0.0` 绑定生效），0.2.1 已删除该函数，权威来源统一为 `webStartup.trustedHosts`。
  - `packages/bundle/web-app/src/public-url.ts` — `--public-url` 校验器（未导出子路径，本插件 `src/startup.ts` 本地镜像；升级先 diff）。
- 涉及认证/信任语义时，对照 harness 的：
  - `packages/client/connection/src/browser-auth.ts` — 0.1.2 原生浏览器认证：cookie 格式、secret 存储。**本插件「原生 cookie 补签」是对它的精确镜像，升级 dsh 后先 diff 此文件。**
  - `packages/client/connection/src/api-request-trust.ts` — 浏览器信任围栏（DNS rebinding / 跨站防护，403 部分）。
  - `packages/client/connection/src/rpc-host.ts` — `requestRejection` 双闸门（403 信任围栏 + 401 原生 cookie）。
  - 0.1.1 时代的 `PRIVILEGED_METHODS` 已在 0.1.2 删除，不要重建。
