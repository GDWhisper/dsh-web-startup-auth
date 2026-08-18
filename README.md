# dsh-web-startup-auth

DSH（DeepSeek Harness）远程 Web 启动 + 用户名/密码认证插件。

原版 `@deepseek-ai/dsh-web-app/startup` 出于安全考虑**硬拒绝 `--host 0.0.0.0`**；本插件替换它，并配一个带登录/注册页的认证插件，让 `dsh web` 可以在局域网（或任何非回环接口）上安全暴露浏览器界面。

## 特性

- **远程启动**：`--host 0.0.0.0` 可用，替代原版启动器的硬性拒绝。
- **登录/注册页**：首次访问引导设置管理员账号密码，之后进入登录页；与 DSH 黑白蓝风格一致。
- **会话认证**：登录后下发签名 cookie（`dsh_sid`，14 天有效，`HttpOnly` + `SameSite=Lax`）。
- **API 保护**：所有 `/api/*` 路由（除 `/api/auth/*`）必须携带有效会话，否则返回 401。
- **远程场景修复**（局域网 HTTP 访问的两个坑）：
  - `crypto.randomUUID` polyfill —— 非安全上下文下该 API 缺失，会导致所有 RPC 失败（详见下文"已知问题"）。
  - 特权 API 回环放行 —— DSH 将 `settings.*` / `credentials.*` 等敏感域强制限制在回环地址；认证通过后本插件以回环身份放行。

## 安装

本插件是一个 DSH **bundle**（`package.json` 的 `dsh.bundle.patch` 声明了随包分发的 `cordis.patch.yml`）。用 `dsh plugin` 安装后，包会被加入 profile 的 `dsh.profile.bundles`，补丁层**自动生效**，无需手动编辑任何配置文件。

```sh
# 方式一：从源码安装
git clone <仓库地址>
cd dsh-web-startup-auth
npm install        # 安装构建依赖（typescript 等）
npm run build      # 编译 src/ 到 lib/（插件运行时加载 lib/ 下的产物）
dsh plugin --profile web add .

# 方式二：从 npm registry 安装
dsh plugin --profile web add dsh-web-startup-auth
```

> `dsh plugin` 是 pnpm 转发器，`--profile <name>` 必填；`add .` 会把当前目录以 `link:` 方式装进 profile。

启动：

```sh
dsh web --host 0.0.0.0
```

> 若通过 `--patch ./cordis.patch.yml` 叠加，则为：
> `dsh --profile web --patch ./cordis.patch.yml --host 0.0.0.0`

## 使用

1. 浏览器访问 `http://<主机IP>:<端口>/`。
2. 首次访问会跳转到 `/login`，显示"设置管理员账号密码"注册表单。
3. 注册成功后自动登录并进入主界面；之后访问需登录。
4. 退出登录：`/api/auth/logout`（界面暂无退出按钮，可清 cookie）。

凭据与会话密钥保存在 `~/.dsh/web-auth.json`：

- 密码使用 **scrypt**（随机盐，64 字节）散列存储，不保存明文。
- 会话 cookie 用随机生成的密钥做 **HMAC-SHA256** 签名，防伪造。
- **忘记密码**：在服务器本机执行 `dsh --profile web auth-reset`，交互式设置新密码（或 `dsh --profile web auth-reset --password <新密码>` 非交互）。重置会**轮换会话密钥，作废所有已签发的会话**。
- 兜底方案：删除 `~/.dsh/web-auth.json` 并重启，即可重新注册（同样会作废所有会话，但需重启服务）。

## 工作原理

插件由两个子模块组成（通过 `package.json` 的 exports 分别暴露）：

| 子模块 | 插件名 | 职责 |
| --- | --- | --- |
| `dsh-web-startup-auth/startup` | `remote-web-startup` | 解析 Web 命令行参数（`--host` / `--port` / `--trusted-host`），提供 `webStartup` 服务；不拒绝 `0.0.0.0` |
| `dsh-web-startup-auth/auth` | `web-auth` | 登录页、认证 API、`/api` 路由保护、`webAuth` 服务 |

认证插件安装的防线：

1. **路由保护**：包装 `webServer.register`，所有 `/api` 前缀路由（`/api/auth/*` 除外）先校验会话 cookie。回环绑定（`127.0.0.1`）时隐式信任，不强制登录。
2. **索引注入**：向 SPA 的 `index.html` 注入检查脚本，无有效会话时重定向到 `/login`。
3. **认证服务**：提供 `webAuth.authenticate(req)`，`connection` 行注入 `webAuth` 后，事件流等下游层可复用同一认证结论。

## 已知问题（已修复）

### 非安全上下文下 `crypto.randomUUID` 缺失

通过**局域网 IP + 明文 HTTP** 访问时（如 `http://192.168.5.216:3080`），页面处于非安全上下文，`crypto.randomUUID` 不存在，DSH 前端每个 RPC（`host.describe`、`session.list` 等）都会抛 `TypeError: crypto.randomUUID is not a function`，表现为"WebSocket is closed before the connection is established" + 无限重连。

**修复**：本插件向 SPA 注入基于 `crypto.getRandomValues`（非安全上下文可用）的 `randomUUID` polyfill，在客户端 bundle 运行前生效。

### 特权 API 的回环限制

DSH 的 `dsh-client-connection` 把 `settings.*`、`credentials.*`、`agentPreset.*`、`llm.discoverModels` 等方法强制限制为**仅回环可访问**（原实现注释：`until a real authentication layer exists`）。远程访问时这些接口返回 403。

**修复**：认证通过后，本插件将请求的 `Host` / `Origin` 头临时改写为 `127.0.0.1:<port>` 再转发给下游 handler（处理完成后还原）。有效会话即认证层，等价于回环信任；匿名请求仍被 401 拦截。

## 安全说明

- 本插件提供认证，但不提供传输加密。明文 HTTP 下凭据与流量可被同一网络中的抓包者看到，**建议仅在可信内网使用**，或在前面部署 HTTPS 反向代理。
- 会话 14 天有效；如需收紧可修改 `src/auth.ts` 中的 `SESSION_MAX_AGE_SEC`。
- 密码散列使用 Node 内置 `crypto.scryptSync`，无第三方依赖。
- **会话不可服务端撤销**：`dsh_sid` 是自包含签名 cookie，`/api/auth/logout` 只清除浏览器一侧的 cookie。cookie 一旦泄露（如明文 HTTP 下被嗅探），14 天有效期内无法单独吊销。**唯一例外**：`dsh --profile web auth-reset` 会轮换会话密钥，一次性作废全部会话。
- **首次注册窗口**：凭据未设置时任何访问者都可注册为管理员。**在把服务暴露到不可信网络之前**请先完成首次注册。
- **登录防护**：登录失败按客户端 IP 限速——连续 5 次失败锁定 30 秒（纯内存、无持久化）；注册要求密码至少 8 个字符。限速仅覆盖 `/api/auth/login`，如需更严格防护请在反向代理层增加通用限速。
- **凭据文件权限**：`~/.dsh/web-auth.json`（含密码哈希与会话签名密钥）以 `0600` 保存，目录以 `0700` 创建；插件启动时会自动修复旧版本遗留的过宽权限。
- **`--trusted-host`**：该参数仅为与原版 CLI 兼容而保留透传，**不参与本插件认证判断**——远程客户端一律需要有效会话，不存在"受信主机免登录"。

## 开发

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsc -p tsconfig.json，产物输出到 lib/
```

## 许可证

[MIT](./LICENSE)（仓库内未含 LICENSE 文件时，默认按 package.json 的 MIT 声明授权）
