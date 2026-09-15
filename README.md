# dsh-web-startup-auth

**中文** | [English](README.en.md)

[DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)远程 Web 启动 + 用户名/密码认证插件。

> **⚠️ 版本跟进声明**：本项目只跟进官方 dsh 的正式发布通道（`next` dist-tag），不跟进 `alpha` 预览通道（当前基线：dsh 0.1.5-rc.2）。

![登录页](docs/login-page.png)

原版 `@deepseek-ai/dsh-web-app/startup` 出于安全考虑**硬拒绝 `--host 0.0.0.0`**；本插件替换它，并配一个带登录/注册页的认证插件，让 `dsh web` 可以在局域网（或任何非回环接口）上安全暴露浏览器界面。

## 特性

- **远程启动**：`--host 0.0.0.0` 可用，替代原版启动器的硬性拒绝。
- **登录/注册页**：远程访问首次会引导设置管理员账号密码，之后进入登录页；与 DSH 黑白蓝风格一致；颜色跟随系统明暗偏好（`prefers-color-scheme`）。
- **免登录的本地访问**：判定依据是**请求本身**而非启动参数——TCP 对端地址与 `Host` 头都是回环时才免认证。所以本机浏览器直接访问 `http://127.0.0.1:<端口>/` 无需注册或登录；局域网客户端、以及反向代理转发来的请求（`Host` 是公网域名）一律需要会话。免登录**不等于已登录**：本机没有会话 cookie，认证页显示的是「管理员账号」而不是「当前登录」，也不会给出退出登录入口（没有会话可退）。
- **可选的「本机登录校验」**：默认本机免登录；管理员可在**设置面板 → 认证 → 登录要求**里把这个开关打开，之后连本机地址也要求会话（多人共享服务器时用它禁止同机其他账号免登录）。开关须先有管理员账号才能启用（未注册时后端会拒绝，设置页会先引导去注册）。
- **会话认证**：登录后下发签名 cookie（`dsh_sid`，默认 14 天有效、可在设置面板调节（3–180 天档位），`HttpOnly` + `SameSite=Lax`）。
- **API 保护**：所有注册路由（`/api/*` 及第三方插件的 RPC 路由，除 `/api/auth/*` 与 `/login`）必须携带有效会话，否则返回 401/拒绝握手。
- **设置面板「认证」标签页**：向 DSH 设置面板注入"认证"页，提供**退出登录**（仅在持有会话时出现）、**修改用户名**、**修改密码**与**会话有效期**档位选择。标签在导航栏里显示**盾牌+勾**图标（上游不允许注册方指定图标，由本插件在前端替换默认的齿轮）。界面颜色全部使用 DSH 主题 token，**跟随明/暗主题自动切换**（#25）。
- **远程场景修复**（局域网 HTTP 访问的坑）：
  - `crypto.randomUUID` polyfill —— 非安全上下文下该 API 缺失，会导致所有 RPC 失败。
  - 原生浏览器认证桥接 —— dsh 0.1.2 起（当前基线 0.1.5）上游自带浏览器认证（`dsh-auth-*` 签名 cookie），`/api` 与 `index.html` 一律要求携带、**连回环都不豁免**（本机也得先换 token URL）。本插件为已通过自己认证（`dsh_sid` 会话，或 TCP 对端 + `Host` 双回环的本地请求）的访问者**自动补发该 cookie**：页面导航经一次 303 跳转即带上、登录响应直接下发，全程无需接触启动打印的 token URL——「账号/密码 + 可撤销会话」仍是唯一认证入口，上游 cookie 只是通过上游闸门的凭据。

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
4. 退出登录 / 修改用户名 / 修改密码 / 调整会话有效期：打开主界面**设置面板 → 认证**标签页（同时也是一个独立入口，`/api/auth/logout` 清除会话 cookie）。

**如果需要在本地设置账号密码**（本机默认免登录，界面不会自动跳登录页）：

1. 浏览器打开 `http://127.0.0.1:<端口>/login` —— 未注册时该页直接显示注册表单。
2. 或进**设置面板 → 认证**，页顶「尚未设置管理员账号」处点「前往设置管理员账号」。

注册后本机仍免登录；想让本机也要登录，到**认证 → 登录要求**打开「本机登录校验」（需先有账号）。开关打开后本机也要走 `/login`（页面会立即跳过去），登录后认证页才会显示「当前登录」和退出登录入口。

凭据与会话密钥保存在 `~/.dsh/web-auth.json`：

- 密码使用 **scrypt**（随机盐，64 字节）散列存储，不保存明文。
- 会话 cookie 用随机生成的密钥做 **HMAC-SHA256** 签名，防伪造。有效期档位（`sessionMaxAgeDays`，默认 14）也存在这个文件里，可在设置面板调节；调整只对新签发的会话生效。
- **忘记密码**：在服务器本机执行 `dsh --profile web auth-reset`，交互式设置新密码（或 `dsh --profile web auth-reset --password <新密码>` 非交互）。重置会**轮换会话密钥，所有已登录的浏览器都需要重新登录一次**。
- **修改用户名 / 修复含控制字符的用户名**：`dsh --profile web auth-reset --username <新用户名>`（可与 `--password` 同用）。同样轮换会话密钥。用户名在注册/登录/修改时统一剥除 C0 控制字符（0x00–0x1F）与 DEL（0x7F）——旧版本若已把含 DEL 的用户名原样存盘，用它即可修复。
- 兜底方案：删除 `~/.dsh/web-auth.json` 并重启，即可重新注册。这只影响登录状态——已登录的浏览器需要再登录一次，**不会删除任何会话记录或历史数据**（它们存在 `~/.dsh/sessions/` 等位置，与本文件无关）。
- **`auth-reset` 不能用来首次创建账号**：它要求已有凭据，否则报「尚未注册管理员账号，无需重置」。首次只能用上面的注册页。

## 索引

如果您在寻找开箱即用的专为 Agent 时代研发的 IDE，推荐您使用 [Omniterm](https://github.com/GDWhisper/OmniTerm)

## 安全说明

- 本插件提供认证，但不提供传输加密。明文 HTTP 下凭据与流量可被同一网络中的抓包者看到，**建议仅在可信内网使用**，或在前面部署 HTTPS 反向代理。
- 会话有效期默认 14 天，可在设置面板「认证」标签页调节（3/7/14/30/60/90/180 天档位，持久化于 `~/.dsh/web-auth.json`）；调整只影响新签发的会话，已登录的会话保持签发时的有效期。
- 密码散列使用 Node 内置 `crypto.scryptSync`，无第三方依赖。
- **会话不可服务端撤销**：`dsh_sid` 是自包含签名 cookie，`/api/auth/logout` 只清除浏览器一侧的 cookie。cookie 一旦泄露（如明文 HTTP 下被嗅探），在有效期内无法单独吊销（上限即设置面板所选的会话有效期档位）。**例外**：`dsh --profile web auth-reset`、设置面板的「修改密码」与「修改用户名」都会**轮换会话密钥**，一次性让所有已登录的浏览器重新登录（操作者自己的当前会话由服务端重新签发，保持登录）。
- **首次注册窗口**：凭据未设置时任何访问者都可注册为管理员。**在把服务暴露到不可信网络之前**请先完成首次注册。
- **登录防护**：登录失败按客户端 IP 限速——连续 5 次失败锁定 30 秒（纯内存、无持久化）；注册要求密码至少 8 个字符。限速覆盖 `/api/auth/login`、`/api/auth/change-password` 与 `/api/auth/change-username`（旧密码/当前密码错误同样计次）。如需更严格防护请在反向代理层增加通用限速。
- **凭据文件权限**：`~/.dsh/web-auth.json`（含密码哈希与会话签名密钥）以 `0600` 保存，目录以 `0700` 创建；插件启动时会自动修复旧版本遗留的过宽权限。
- **`--trusted-host`**：该参数仅为与原版 CLI 兼容而保留透传，**不参与本插件认证判断**——远程客户端一律需要有效会话，不存在"受信主机免登录"。
- **反向代理（nginx 等）部署**：可以放心的做法是 dsh 只监听 `127.0.0.1`，由代理做 SSL 卸载并转发。此时**代理必须转发真实 `Host`**（nginx 默认即为 `proxy_set_header Host $host;`，配上 `--trusted-host <域名>` 让 DSH 自身的 Host 围栏放行）；认证通过后插件按**请求的真实 `Host`（公网域名）**补发上游原生浏览器 cookie，上游闸门据此放行。反之，若代理把 `Host` 写死成 `127.0.0.1`，插件会认为请求来自本机从而**放行全部流量、不做认证**——不要这样配置。`X-Forwarded-For` 不被采信（客户端可伪造），信任判定只看 TCP 对端地址与 `Host`。
- **上游兼容层（dsh 0.1.5 基线）**：dsh rc.8–0.1.1 时代，DSH 前端用**浏览器地址栏 hostname** 判定 `connection.isLoopback`，远程浏览器下的 settings mirror 走内存模式、插件配置卡片与 Models 页不可用；本插件当时通过 `webServer.tapIndex` 注入脚本在 connection 激活瞬间把该标志覆盖为恒 `true`。0.1.2 上游引入真实 cookie 认证后**能进 UI**，但 settings mirror 仍按同一标志判定——LAN 浏览器依旧得到从不读 host 的 `memory` mirror，设置面板的 Models（提供方目录）会报 "settings are unavailable in this browser"。直接恢复旧的 getter 覆盖会破坏 web boot（A/B 实测 26 个前端插件 pending），因此 0.1.2 起改用**注入 `window.__DSH_TRANSPORT__ = { ownsHost: true }`**：connection client 构造时据此把 `isLoopback` 报为 `true`（api/rpc 字段缺省时安全回退，且不重写 cordis 服务），LAN 与回环浏览器的全部设置面（含 Models）都正常渲染。当前保留的浏览器侧 shim：该 transport hook 与 `crypto.randomUUID` polyfill（明文 HTTP 非安全上下文所需）。

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
