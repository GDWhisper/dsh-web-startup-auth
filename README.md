# dsh-web-startup-auth

**中文** | [English](README.en.md)

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)远程 Web 启动 + 用户名/密码认证插件。

> **⚠️ 版本跟进声明**：本项目**只跟踪** `latest` dist-tag（官方稳定版），**不跟进** `next` dist-tag（alpha 通道）。

![登录页](docs/login-page.png)

原版 `@deepseek-ai/dsh-web-app/startup` 出于安全考虑**硬拒绝 `--host 0.0.0.0`**；本插件替换它，并配一个带登录/注册页的认证插件，让 `dsh web` 可以在局域网（或任何非回环接口）上安全暴露浏览器界面。

## 特性

- **远程启动**：`--host 0.0.0.0` 可用，替代原版启动器的硬性拒绝。
- **登录/注册页**：远程访问首次会引导设置管理员账号密码，之后进入登录页；与 DSH 黑白蓝风格一致。
- **免登录的本地访问**：判定依据是**请求本身**而非启动参数——TCP 对端地址与 `Host` 头都是回环时才免认证。所以本机浏览器直接访问 `http://127.0.0.1:<端口>/` 无需注册或登录；局域网客户端、以及反向代理转发来的请求（`Host` 是公网域名）一律需要会话。
- **会话认证**：登录后下发签名 cookie（`dsh_sid`，14 天有效，`HttpOnly` + `SameSite=Lax`）。
- **API 保护**：所有注册路由（`/api/*` 及第三方插件的 RPC 路由，除 `/api/auth/*` 与 `/login`）必须携带有效会话，否则返回 401/拒绝握手。
- **设置面板「认证」标签页**：向 DSH 设置面板注入"认证"页，提供**退出登录**、**修改用户名**与**修改密码**三个操作。
- **远程场景修复**（局域网 HTTP 访问的两个坑）：
  - `crypto.randomUUID` polyfill —— 非安全上下文下该 API 缺失，会导致所有 RPC 失败。
  - 特权 API 回环放行 —— DSH 将 `settings.*` / `credentials.*` 等敏感域、`authority: "loopback"` 的第三方 RPC channel（如 `/dsh-automation`、技能管理器）以及 WebSocket 事件流全部限制为仅回环 Host 可访问；认证通过后本插件以回环身份放行（Host/Origin 改写覆盖所有注册路由与升级握手，含先于本插件激活的第三方路由）。

## 安装

本插件是一个 DSH **bundle**（`package.json` 的 `dsh.bundle.patch` 声明了随包分发的 `cordis.patch.yml`）。用 `dsh plugin` 安装后，包会被加入 profile 的 `dsh.profile.bundles`，补丁层**自动生效**，无需手动编辑任何配置文件。

```sh
# 方式一：从源码安装
git clone <仓库地址>
cd dsh-web-startup-auth
npm install        # 安装构建依赖（typescript 等）
npm run build      # 编译 src/ 到 lib/（插件运行时加载 lib/ 下的产物）
dsh plugin --profile web add .

# 方式二：从 npm registry 安装（已装过旧版本时执行同一条命令即可升级）
dsh plugin --profile web add dsh-web-startup-auth@latest
```

> `dsh plugin` 是 pnpm 转发器，`--profile <name>` 必填；`add .` 会把当前目录以 `link:` 方式装进 profile。

启动：

```sh
dsh web --host 0.0.0.0
```

> 安装时已自动应用补丁，无需再用 `--patch` 叠加——重复叠加会把插件再插入一遍，导致重复。

## 使用

1. 浏览器访问 `http://<主机IP>:<端口>/`（在本机则用 `http://127.0.0.1:<端口>/`，无需登录）。
2. 远程访问首次会跳转到 `/login`，显示"设置管理员账号密码"注册表单。
3. 注册成功后自动登录并进入主界面；之后访问需登录。
4. 退出登录 / 修改用户名 / 修改密码：打开主界面**设置面板 → 认证**标签页（同时也是一个独立入口，`/api/auth/logout` 清除会话 cookie）。

凭据与会话密钥保存在 `~/.dsh/web-auth.json`：

- 密码使用 **scrypt**（随机盐，64 字节）散列存储，不保存明文。
- 会话 cookie 用随机生成的密钥做 **HMAC-SHA256** 签名，防伪造。
- **忘记密码**：在服务器本机执行 `dsh --profile web auth-reset`，交互式设置新密码（或 `dsh --profile web auth-reset --password <新密码>` 非交互）。重置会**轮换会话密钥，作废所有已签发的会话**。
- **修改用户名 / 修复含控制字符的用户名**：`dsh --profile web auth-reset --username <新用户名>`（可与 `--password` 同用）。同样轮换会话密钥。用户名在注册/登录/修改时统一剥除 C0 控制字符（0x00–0x1F）与 DEL（0x7F）——旧版本若已把含 DEL 的用户名原样存盘，用它即可修复。
- 兜底方案：删除 `~/.dsh/web-auth.json` 并重启，即可重新注册（同样会作废所有会话，但需重启服务）。

## 索引

如果您在寻找开箱即用的专为 Agent 时代研发的 IDE，推荐您使用 [Omniterm](https://github.com/GDWhisper/OmniTerm)

## 安全说明

- 本插件提供认证，但不提供传输加密。明文 HTTP 下凭据与流量可被同一网络中的抓包者看到，**建议仅在可信内网使用**，或在前面部署 HTTPS 反向代理。
- 会话 14 天有效；如需收紧可修改 `src/auth.ts` 中的 `SESSION_MAX_AGE_SEC`。
- 密码散列使用 Node 内置 `crypto.scryptSync`，无第三方依赖。
- **会话不可服务端撤销**：`dsh_sid` 是自包含签名 cookie，`/api/auth/logout` 只清除浏览器一侧的 cookie。cookie 一旦泄露（如明文 HTTP 下被嗅探），14 天有效期内无法单独吊销。**例外**：`dsh --profile web auth-reset`、设置面板的「修改密码」与「修改用户名」都会**轮换会话密钥**，一次性作废全部会话（操作后当前会话由服务端重新签发，保持登录）。
- **首次注册窗口**：凭据未设置时任何访问者都可注册为管理员。**在把服务暴露到不可信网络之前**请先完成首次注册。
- **登录防护**：登录失败按客户端 IP 限速——连续 5 次失败锁定 30 秒（纯内存、无持久化）；注册要求密码至少 8 个字符。限速覆盖 `/api/auth/login`、`/api/auth/change-password` 与 `/api/auth/change-username`（旧密码/当前密码错误同样计次）。如需更严格防护请在反向代理层增加通用限速。
- **凭据文件权限**：`~/.dsh/web-auth.json`（含密码哈希与会话签名密钥）以 `0600` 保存，目录以 `0700` 创建；插件启动时会自动修复旧版本遗留的过宽权限。
- **`--trusted-host`**：该参数仅为与原版 CLI 兼容而保留透传，**不参与本插件认证判断**——远程客户端一律需要有效会话，不存在"受信主机免登录"。
- **反向代理（nginx 等）部署**：可以放心的做法是 dsh 只监听 `127.0.0.1`，由代理做 SSL 卸载并转发。此时**代理必须转发真实 `Host`**（nginx 默认即为 `proxy_set_header Host $host;`，配上 `--trusted-host <域名>` 让 DSH 自身的 Host 围栏放行）；认证通过后插件会把 `Host`/`Origin` 改写成回环再交给下游，特权 API 依旧可用。反之，若代理把 `Host` 写死成 `127.0.0.1`，插件会认为请求来自本机从而**放行全部流量、不做认证**——不要这样配置。`X-Forwarded-For` 不被采信（客户端可伪造），信任判定只看 TCP 对端地址与 `Host`。
- **上游兼容层（dsh ≥ rc.8）**：dsh rc.8 起，设置面板依赖**前端 settings mirror** 的功能（提供方目录、插件配置表单）在远程浏览器下原本会报 `settings are unavailable in this browser`——DSH 前端用**浏览器地址栏 hostname** 判定是否回环，远程访问恒为非回环，mirror 走内存模式不发 RPC，插件配置卡片整个不渲染。本插件通过 `webServer.tapIndex` 向 SPA 注入脚本：在模块系统就绪后包装每个前端插件的 `apply`，于 connection 插件激活返回的瞬间把 `connection.isLoopback` 覆盖为恒 `true`（配合后端回环放行）——**早于任何 settings scope 的绑定**，因此 mirror 与所有配置 scope 都以 host 模式创建，无需刷新页面。前端插件另保留一份防御性覆盖与 mirror 兜底。该兼容层依赖 dsh 内部结构（`window.__ModuleLoader__`、`settingsScope.mirror`），以 rc.8 为准验证，上游改动可能需要同步更新。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsc -p tsconfig.json + tsdown，产物输出到 lib/
```

- `tsc` 编译 node 侧源码（`src/*.ts`）与类型声明到 `lib/`、`lib/types/`。
- `tsdown` 把前端插件（`src/client/index.tsx`）打包成浏览器 bundle `lib/client.js`（`window.__ModuleLoader__.load` 注册格式）。改前端代码后必须重新构建，profile 里 `link:` 安装会自动加载新产物。
- 前端插件依赖的 `@deepseek-ai/dsh-client-*` 包只用于类型与构建，运行时由 DSH 前端模块表提供。

## 许可证

[MIT](./LICENSE)
