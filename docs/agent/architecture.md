# 本插件架构总览

## 仓库文件布局

`src/*.ts` 与 `src/client/*.tsx`（源码，唯一修改入口）、`lib/`（构建产物，不入库但发布时由 `files` 字段带上）、`tsdown.config.ts`（前端 bundle 打包）、`cordis.patch.yml`（bundle patch）、`tests/*.spec.ts`（vitest）、`renovate.json`（依赖更新机器人配置，见 `renovate.md`）、`README.md`（用户文档）、`AGENTS.md`（本索引）+ `docs/agent/`（本目录，按任务展开的细节）。

## 它做了什么（与原版的差异）

原版 `@deepseek-ai/dsh-web-app/startup`（`packages/bundle/web-app/src/startup.ts:69`）对 `--host 0.0.0.0` **硬拒绝**（`program.error('... intentionally not supported yet for safety ...')`）。本插件用两个子模块替换并补上认证：

1. **`remote-web-startup`**：行为与原版一致，只是**删掉 0.0.0.0 拒绝**。安全责任转移到 auth 插件。
2. **`web-auth`**：强制远程访问者登录——登录/注册页（`/login`）+ 签名会话 cookie + 全部 `/api` 路由保护（`/api/auth/*` 除外）。免认证的只有**真正的回环请求**（见 `auth-mechanics.md`「信任判定」），与启动参数无关。**dsh 0.1.2 起**上游自带浏览器认证且回环不豁免，本插件额外做「原生 cookie 补签」桥接（见 `native-auth-bridge.md`）——0.1.1 时代的「Host/Origin 回环改写」已随上游删除 `PRIVILEGED_METHODS` 而移除。
3. **`auth-reset` 子命令**：`dsh --profile web auth-reset [--password <pwd>] [--username <name>]`，重设管理员密码和/或修改用户名并**轮换签名密钥**（所有已发会话 cookie 立即失效）——忘记密码、忘记用户名、修复含控制字符用户名的恢复路径。只给 `--username` 时密码保持不变；都不给时交互式输入新密码（历史行为）。
4. **设置面板「认证」标签页**：前端插件通过 `ctx.slots.inject('settings.section', …)` 注册，提供退出登录（调 `/api/auth/logout`）、修改用户名与修改密码（分别调 `/api/auth/change-username` / `/api/auth/change-password`，服务端校验当前密码后轮换密钥并重签当前会话）以及会话有效期档位选择（调 `/api/auth/session-max-age`，下拉即选即存）。详见 `settings-section.md`。

## 核心代码路径

| 文件 | 职责 |
|---|---|
| `src/startup.ts` | `remote-web-startup` 插件：commander 解析 `--host/--port/--trusted-host`，`provide('webStartup', values)`；`auth-reset` 子命令（`runAuthReset`）；`WEB_STARTUP_SERVICE` 常量 |
| `src/auth.ts` | `web-auth` 插件：登录页路由、`/api/auth/*` 端点（status/register/login/logout/change-password/change-username）、包装 `webServer.register`/`registerUpgrade`/`registerFallback` 做全路由保护（认证 + 原生 cookie 补签，见 `native-auth-bridge.md`）、`tapIndex` 注入 randomUUID polyfill + 未登录跳转、`provide('webAuth')` |
| `src/credential-store.ts` | 凭据持久化：scrypt 散列、`normalizeUsername`（剥 C0+DEL）/ `registerCredentials` / `validateCredentials` / `updateCredentials`（单次写+轮换）/ `resetPassword` / `changePassword` / `changeUsername` / `getUsername` / `signSession` / `verifySession` / `hasCredentials`；`DSH_WEB_AUTH_FILE` 覆盖 |
| `src/session-limits.ts` | 会话有效期档位常量（`SESSION_MAX_AGE_CHOICES` / `DEFAULT_SESSION_MAX_AGE_DAYS` / `isValidSessionMaxAgeDays`）——node 半与 browser 半共享，必须保持零依赖 |
| `src/login-page.ts` | 自包含登录/注册页 HTML（黑白蓝风格 + brand wordmark SVG） |
| `src/client/index.tsx` | **前端插件**：向设置面板 `settings.section` 注册「认证」标签页（退出登录 + 修改用户名 + 修改密码 UI），打包为 `lib/client.js` |
| `tsdown.config.ts` | 前端插件打包配置（`window.__ModuleLoader__.load` 格式、external 列表） |
| `src/index.ts` | 仅类型导出（`WebStartupValues`、`AuthConfig`、`WebAuthService`） |
| `cordis.patch.yml` | bundle patch：禁用 `web-startup`、insert 三个插件（含包根行 `dsh-web-startup-auth`，客户端扫描必需）、`connection` 注入 `webAuth` |

## 对照原版与上游

- 想对照原版行为时看 harness 的 `packages/bundle/web-app/src/startup.ts`（原版 startup 逻辑）。
- 涉及认证/信任语义时，对照 harness 的：
  - `packages/client/connection/src/browser-auth.ts` — 0.1.2 原生浏览器认证：cookie 格式、secret 存储。**本插件「原生 cookie 补签」是对它的精确镜像，升级 dsh 后先 diff 此文件。**
  - `packages/client/connection/src/api-request-trust.ts` — 浏览器信任围栏（DNS rebinding / 跨站防护，403 部分）。
  - `packages/client/connection/src/rpc-host.ts` — `requestRejection` 双闸门（403 信任围栏 + 401 原生 cookie）。
  - 0.1.1 时代的 `PRIVILEGED_METHODS` 已在 0.1.2 删除，不要重建。
