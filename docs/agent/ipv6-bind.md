# IPv6 绑定支持（issue #35）

> 覆盖：`--host ::` / 任意 IPv6 字面量、webserver host schema 拓宽、`connection` 信任围栏的 IPv6 LAN 权威、升级观察哨。改 `src/ipv6-shim.ts`、`src/startup.ts` 的 `--host` 处理或 `cordis.patch.yml` 的 `connection` 行前必读。

## 诉求与两个墙

纯 IPv6 网络（无可用 IPv4 路径）里 `--host 0.0.0.0` 不可达：`0.0.0.0` 是 IPv4 通配地址，Node 只绑 AF_INET。想改绑 `::` 撞两层墙：

1. **上游 schema**：`@deepseek-ai/dsh-host-webserver` 的 `WebServer.Config.host` 是 `z.union([z.const("127.0.0.1"), z.const("0.0.0.0")])`，web-app bundle patch 把 `ctx.webStartup.host ?? '127.0.0.1'` 原样喂进去——`::` 在启动时就是一次 schema 校验失败。Node 侧无阻碍（`listen(port, '::')` 原生支持；Linux `bindv6only=0` 时 `::` 双栈，实测同时响应 `127.0.0.1` 与 `::1`）。
2. **信任围栏**：`dsh-client-connection` 的 `isTrustedApiRequest` 对「Host 不是回环且不在 `trustedHosts`」的请求直接拒（403）。IPv4 场景下这些 LAN 字面量由 web-app 的 `resolveLanTrust`（`dsh-web-app/lib/index.js`）自动枚举并写入 `connection` 的 `trustedHosts` 配置，但它**只枚举 IPv4**（`family === 'IPv4'`）且**只对 `0.0.0.0` 绑定**生效。只放 schema 不改围栏，纯 IPv6 客户端连登录页都到不了。

`isTrustedOrigin`（本插件 auth 侧）与原生 cookie 补签对 IPv6 是现成的：Host 头 `[::1]` 在 `LOOPBACK_HOSTNAMES` 里、`requestAuthority` 用 `new URL(...)` 规范化出方括号形式，与上游 `browser-auth.ts` 同一形状——auth/补签零改动。

## 三处改动

### 1. `src/ipv6-shim.ts`：原地拓宽 schema（注意：是**启动路径那一份**）

`WebServer.Config` 是 schemastery 对象 schema：`dict` 是普通可写对象，把成员 `dict.host` 换成 `z.union([原成员, z.transform(z.string(), isIPv6 断言)])` 即完成拓宽，`port` / `compression` 等其余字段的校验路径不变。

- **为什么是原地换 `dict.host` 成员、不是替换 `WebServer.Config` 静态属性**：cordis 在 fiber 启动时读 `runtime.Config`（`resolveConfig` → `runtime.Config["~standard"].validate(config)`），运行期快照可能早于我们的 apply（快照持有的是 schema 对象引用本身）；替换静态属性对新旧引用生效时机不一，而改共享 schema 对象的 `dict.host` 成员对所有持有者立即生效。
- **为什么不能包 `~standard`**：它是 `Schema.prototype` 上的 getter，每次访问生成新对象，实例上不可写。
- **拓宽哪一份实例（E2E 抓到的坑，最重要）**：插件以 `link:` 装进 profile，本仓库 `node_modules` 里有一份 `@deepseek-ai/dsh-host-webserver`，而 `webserver` 行从 **profile 根**解析出的是**另一份**（本机是 dsh CLI 自带的嵌套副本）。两份 = 两个 `WebServer` 类 = 两个 schema 对象；拓宽 import 来的那份，启动时校验用的仍是 stock union（报错照旧），而单测看的是我们这份所以全绿。`ensureIpv6BindSupport(ctxBaseUrl(ctx))` 因此用 `createRequire(new URL('node_modules/.host-schema.cjs', baseUrl))` 从 **profile 根**解析并 `require`（Node ≥22.12 支持 require(esm)，与 row 的动态 import 同实例）那一份来拓宽；拿不到 baseUrl（单测）才回退到 import 的实例。**探测失败 → 返回 false → 只影响 IPv6 用户**（见下）。
- **探测与降级**：`widenHostMember` 校验 `dict` / `z.union` / `z.transform` / `z.ValidationError` 的形态，任一项不满足返回 `false` 且**不动 schema**；成员上打 `Symbol` 标记保证同一 schema 只拓宽一次。进程内只尝试一次（模块级标志）。
- `normalizeBindHost`：接受两个 IPv4 字面量与任意 IPv6 字面量（裸写或 URL 方括号形式 `[::1]`），**统一输出规范拼写**（`fd00:0:0:0:0:0:0:1` → `fd00::1`、`0:0:0:0:0:0:0:0` → `::`）——规范化是硬要求不是化妆：围栏对**每个** `trustedHosts` 条目做装载期断言（`dsh-client-connection` 的 `assertTrustedAuthority`：条目必须「WHATWG 解析不改写，大小写除外」），非规范拼写的条目会让 `connection` 行**激活即抛**、整树起不来；通配判定（`lanHosts` 的 `canonical === '::'`）同样吃规范拼写。另拒两类值：带 zone 的字面量（`fe80::1%eth0`，`isIPv6` 放行但 WHATWG 解析抛错）与 **IPv4-mapped**（`::ffff:192.168.1.5`——它按 IPv4 绑定，客户端的 `Host` 是 IPv4 裸形式，方括号 mapped 条目永远对不上，不如直说不让用）。DNS 名与畸形字面量照拒——只比 stock 多一个更好的人话报错。非法值在 commander action 里被接住并走 `program.error`（与 stock 拒绝 `0.0.0.0` 同一形态：一行错误 + exit 1；直接 throw 会变成「2 required plugins did not activate」的噪音堆栈，E2E 见过）。
- `lanHosts(bindHost)`（服务名 `webLanHosts`）：补齐 stock `resolveLanTrust` 产不出来的围栏权威，且**绝不宽于套接字实际服务面**：`::`（Linux 双栈通配）→ 全部非内部接口地址（IPv6 方括号 + IPv4 裸写——双栈套接字同时接 IPv4-mapped 客户端，而 stock 的 IPv4 推导只对 `0.0.0.0` 生效，第一版漏了这条，实测 `::` 绑定下 IPv4 LAN 客户端 403）；其他 IPv6 字面量（`::1`/`fd00::5`）→ 就只有该绑定地址本身；非 IPv6 绑定 → `[]`（`0.0.0.0` 的 IPv4 LAN 权威 stock 自己会推，回环绑定不服务远程）。条目一律**规范拼写 + 方括号**（WHATWG hostname 形态，围栏 `parseAuthority` 产出并比较的就是它；且必须过 `assertTrustedAuthority` 的「解析不改写」断言，见 `normalizeBindHost` 条）；条目无端口，`isTrustedAuthority` 里匹配任意端口；`%zone` 后缀剥离（绑定地址与接口地址同规则）。接口枚举失败（`networkInterfaces()` 抛错）返回 `[]`——表达式直接展开这个列表，信任面收窄是 fail-closed，把 `connection` 激活炸掉不是。

### 2. `src/startup.ts`：接线

`apply()` 里先 `ensureIpv6BindSupport(ctxBaseUrl(ctx))`，再 `ctx.provide('webLanHosts', lanHosts)`，然后照旧建 commander。action 里 `normalizeBindHost(options.host)`；IPv6 且探测失败 → `program.error`（升级不兼容时的唯一可见失败，非 IPv6 用户零影响）。

**顺序保证**：`webserver` 行 `inject: [webStartup]`，我们的插件先于 webserver Service 激活，拓宽必在其配置校验之前生效；`connection` 行注入 `webServer`/`webRuntime`/`webAuth`/`webLanHosts`，全在我们之后。

### 3. `cordis.patch.yml`：围栏字面量

`connection` 行的 `trustedHosts` 覆盖为 web-app 原表达式 + IPv6 权威（上游注释许可的部署侧拼接范式）：

```yaml
- id: connection
  inject: [webServer, webRuntime, webAuth, webLanHosts]
  config:
    trustedHosts: !!js "[...ctx.webRuntime.trustedHosts, ...ctx.webLanHosts?.(ctx.webServer.host) ?? []]"
```

- **`inject` 里必须列 `webLanHosts`**：cordis 对 `!!js` 表达式里的 `ctx.<服务名>` 访问做注入门禁——没在 `inject` 里声明的服务，访问直接抛 `cannot get property "webLanHosts" without inject`（E2E 抓过：不加这行，`connection` 激活失败、树起不来）。`?.()` 只是表达式的诚实性兜底。
- **表达式必须加双引号**：js-yaml 的普通标量不支持 `[` 开头与 `: `（`!!js` 是 `kind: "scalar"` 自定义 tag，先得过 YAML 解析），上游惯例见 `dsh-base/cordis.patch.yml` 的 `!!js "..."` 写法。

## 行为边界（对用户）

- `--host` 缺省 / `127.0.0.1` / `0.0.0.0`：**行为零变化**（schema 只是加成员，原两个值验证路径与返回原样）。
- `--host ::`：双栈（Linux `bindv6only=0`）同时监听 IPv6 与 IPv4-mapped，比 `0.0.0.0` 覆盖更全；`bindv6only=1` 系统上仅 IPv6。`--host ::1` 只监听 IPv6 回环（本机 `http://[::1]:<端口>/`）。
- `--host` 拼写：非规范 IPv6 拼写被规范化后放行（`fd00:0:0:0:0:0:0:1` ≡ `fd00::1`）；带 zone 的字面量与 IPv4-mapped（`::ffff:a.b.c.d`）拒绝（人话报错，理由见上文 `normalizeBindHost` 条）。
- LAN URL 打印：上游 `resolveLanTrust` 只枚举 IPv4，`::` 启动时终端**只打印回环 URL**，局域网 IPv6 地址需用户按 `http://[<地址>]:<端口>/` 手动拼（README 已注明）。且回环 URL 是上游硬编码的 `http://127.0.0.1:<端口>/`（`localWebUrl`）：`bindv6only=1` 的系统上 `::` 是纯 IPv6 套接字，这个打印出来的 URL 本身也不通，用 `http://[::1]:<端口>/`。
- 报错文案：host 的 schema 报错从两成员变三成员（末尾多 `| string`），只在启动失败时可见。

## 升级观察哨（每次 bump dsh 先跑）

1. **diff `packages/host/webserver/src/index.ts`**：`Config.host` 的 union 形状（`dict` 结构、`~standard` 入口）。形状变 → `widenHostMember` 返回 `false`，`--host ::` 报「当前 dsh 版本不支持 IPv6 绑定」。两个清理条件互相独立，别一起做：
   - **上游放开 host 值域（接受任意 IP 字面量）** → 只删 `src/ipv6-shim.ts` 的 widen 部分（`widenHostMember`/`ensureIpv6BindSupport`/探测），`startup.ts` 的调用与探测失败分支一并去。
   - **`resolveLanTrust` 开始推导 IPv6（见观察哨 3）** → 才删围栏部分：`connection` 表达式回退 `!!js ctx.webRuntime.trustedHosts`、注入里的 `webLanHosts`、`startup.ts` 的 provide。**只放开 schema 而围栏仍 IPv4-only 时删围栏部分 = 把本功能移除的墙原样装回**（LAN IPv6 客户端在登录页之前 403）。
2. **两份实例的分歧**：`ctx.baseUrl`（profile 根）解析出的包 vs 本仓库 `node_modules` 的包。上游若改变 `webserver` 行的解析方式（不再从 profile 根解析），`ensureIpv6BindSupport` 的指路失效 → 表现是 schema 报错照旧（fail-closed，靠观察哨第 1 条的报错发现）。仓库依赖与 dsh CLI 内嵌副本版本漂移时同理。
3. **diff `dsh-web-app` 的 `resolveLanTrust`**：它若开始枚举 IPv6（或对非 `0.0.0.0` 绑定也推导），我们的 `lanHosts` 可能与它重复/重复计数——重复条目无害（围栏是 `some` 匹配），但应同步简化。
4. **diff `dsh-client-connection` 的 `parseAuthority` / `isTrustedAuthority` / `assertTrustedAuthority`**：IPv6 方括号规范化、「无端口条目匹配任意端口」与「条目必须 WHATWG 解析不改写」是我们 `lanHosts` 输出 shape（规范拼写 + 方括号 + 无端口）的三条依据。
5. **`!!js` 表达式的注入门禁**：上游若改 cordis 的 `ctx.<service>` 访问语义，`connection` 行的 `webLanHosts` 注入可能不再足够（或不再必要）——症状是启动时 `cannot get property ... without inject` 或表达式静默取空。

## 实机验收（E2E 记录，2026-09-27，dsh 0.1.7-rc.1 + 本插件 link）

隔离实例 `DSH_WEB_AUTH_FILE=/tmp/.../web-auth.json`，`dsh web --host :: --port 3111 --no-open`：

- **双栈监听**：`::` 绑定后 `curl http://127.0.0.1:3111/` 与 `curl -g "http://[::1]:3111/"` 均通（后者 303 是回环补签，符合文档）。
- **IPv6 LAN 权威过围栏**（关键）：`POST /api/rpc` + 有效 `dsh_sid` + `Host: [<本机 IPv6>]:3111` → **401**（围栏放行、撞上游原生 cookie 闸门；浏览器侧由补签桥接补证：GET 303 mint 后跟随请求拿到 404 not found，即上游接受了该 authority 的 cookie）。对照 `Host: [2001:db8::99]:3111` → **403 forbidden**（围栏拒绝）。两条合起来证明：IPv6 权威确实来自我们的 `lanHosts`，且围栏未被放宽。
- **双栈绑定的 IPv4 面**（安全审核后补的洞，第一版漏了）：`::` 绑定 + `Host: [<本机 IPv4>]:3113` + 会话 → 曾经 **403**（stock 的 IPv4 LAN 推导只对 `0.0.0.0` 生效，我们当时也只补 IPv6）。修复后 `lanHosts('::')` 同时给两个家族 → **401**（过围栏）。陌生 IPv6 Host 仍 403。
- **`0.0.0.0` 回归**（3112 端口）：启动正常；`Host: [<本机 IPv4>]:3112` + 会话 → 401（web-app 的 IPv4 LAN 推导经我们的表达式原样保留）；`Host: [<本机 IPv6>]:3112` → **403**（IPv4 绑定不加 IPv6 权威，符合设计）。
- **非法 host**：`dsh web --host example.com` → 一行中文错误 + exit 1（与 stock 拒绝 `0.0.0.0` 同形态）。

注意：`/api/auth/status` 等由本插件注册的路由**不经** `connection.admit`，探围栏必须打 `/api/rpc` 且用 **POST**（GET/HEAD 会被补签桥的 303 拦在围栏之前，根本到不了 `admit`）。

## 测试要点（`tests/`）

- `tests/ipv6-shim.spec.ts`：`widenHostMember` 在独立 fixture schema 上验拓宽（`::`/`::1`/`fd00::1` ACCEPT 且值保持、`example.com` 仍拒、`port` 字段仍校验、其他成员默认值不变）、同 schema 幂等、异形 schema 返回 false；`ensureIpv6BindSupport` 的首次尝试语义（坏 baseUrl → false；无 baseUrl → 拓宽 import 实例；进程内幂等——`vi.resetModules()` + 动态 import 拿全新模块状态）；`canonicalIpv6`（规范拼写归一、拒 zone/DNS/畸形）；`normalizeBindHost` 值域（方括号归一、**非规范拼写规范化**、拒 DNS 名/畸形/**zone**/**IPv4-mapped**）；`lanHosts`（mock `node:os`：非 IPv6 绑定恒 `[]`、内部接口排除、`%zone` 剥离、**规范拼写 + 方括号 + 无端口且过围栏 `assertTrustedAuthority` 的「解析不改写」断言**、通配的展开拼写（`0:0:0:0:0:0:0:0`）等价于 `::`、接口枚举失败回 `[]`）。
- `tests/startup.spec.ts`：`--host ::` 与 `--host [::1]` 的 `webStartup.host` 归一、**非规范拼写经启动路径规范化**（`fd00:0:0:0:0:0:0:1` → `fd00::1`）；`webLanHosts` 服务已 provide（patch 表达式的依赖）。
- **单测摸不到启动路径的那份实例**（双实例分歧，见观察哨 2）：「拓宽后 `::` 能启动」这件事只有 E2E 能证明，单测全绿不等于能用——这正是本功能第一版翻车点。
- **commander 的 `program.error` 走 `process.exit`**，单测不触达非法 host 路径（与既有 `--port` 报错路径一致，靠 E2E 覆盖）。
