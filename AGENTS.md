# AGENTS.md

dsh 插件 `dsh-web-startup-auth` 的入场指南。

**本文件是渐进式披露索引：只放每次会话必载的内容。** 踩坑记录、机制细节、实测数据按任务在 `docs/agent/` 下展开——先在这里定位「要做什么」，再读对应文档，不要一次全读。

**路径约定（fork 参与者必读）**：`~/coding/research/deepseek-harness` 是**作者（@GDWhisper）本机**的 dsh 本体（harness）源码位置，仅用于对照上游机制——在你的机器上获取 harness 源码后，请把该前缀替换为实际路径。`~/.dsh/` 是 dsh 框架默认数据目录（`$DSH_HOME` 未设置时），对所有用户通用。文中未加前缀的 `packages/...` 路径均相对于 harness 源码根。

## 速览

- 这是一个 **dsh 插件包（bundle）**：**替换** dsh 原生的 Web 启动器 + 加一层登录认证，让 `dsh web --host 0.0.0.0` 可以安全地暴露到局域网/非回环接口。
- 三个插件入口（`package.json` 的 `exports` 子路径分别暴露）：
  - `dsh-web-startup-auth/startup` → 插件 id `remote-web-startup`（`src/startup.ts`）：与原版 `@deepseek-ai/dsh-web-app/startup` 唯一区别是**不拒绝 `--host 0.0.0.0`**，提供同名 `webStartup` 服务。
  - `dsh-web-startup-auth/auth` → 插件 id `web-auth`（`src/auth.ts`）：登录/注册页、会话 cookie、`/api` 路由保护、原生浏览器认证 cookie 补签（0.1.2 上游的 `dsh-auth-*` 签名 cookie）、**可选滑块拼图验证**（`src/slider/`，默认关闭，装饰性——见 `docs/agent/human-verification.md`）、`webAuth` 服务。
  - `dsh-web-startup-auth/client` → 前端插件（`src/client/index.tsx`，产物 `lib/client.js`）：向 DSH 设置面板 `settings.section` slot 注册「认证」标签页（退出登录 + 修改用户名 + 修改密码 + 会话有效期 + 拼图验证开关）。
- 构建流水线：`src/*.ts` → `tsc` → `lib/*.js`，前端插件额外 `tsdown` → `lib/client.js`（**必须 `npm run build` 后插件才能加载**，`exports` 指向 `lib/`）。`build` 会先清空 `lib/`——它**是入库的**，`tsc` 不会删除孤儿产物，不清理的话删掉一个源文件后旧产物仍会随 `npm pack` 发布。
- 母体（原版 web-app bundle）在 `~/coding/research/deepseek-harness/packages/bundle/web-app/`（作者本机路径，见上方「路径约定」），涉及对比/移植时先对照它。

## 常用命令

```sh
cd <本插件仓库路径>
npm run typecheck  # tsc --noEmit
npm test           # vitest run tests（凭据文件用临时目录隔离，不碰真实凭据）
npm run build      # 先清空 lib/ 再 tsc + tsdown；不构建等于没改（lib/ 是入库的，删源码后必须清理，否则死产物会跟着发布）

dsh plugin --profile web add .   # 在仓库目录内执行：写 bundles + link: 本地依赖；仓库改名/移动后必须重新 add
dsh web --host 0.0.0.0             # 启动（改 patch 或前端插件后必须重启才生效）
dsh --profile web --dump-config    # 打印组合后的插件树（排查 patch 是否生效）
dsh --profile web auth-reset [--password <pwd>] [--username <name>]   # 重设密码/用户名并轮换密钥（忘记密码的恢复路径；未注册时会报错，首次建号只能走 /login 注册表单）
```

卸载：`dsh plugin --profile web remove dsh-web-startup-auth`。

部署后验证：浏览器访问 `http://<主机IP>:<端口>/` → 首次显示注册页（设置管理员账号密码），之后显示登录页；未登录访问 `/api/*` 返回 401。忘记密码的两个恢复路径：`auth-reset`（推荐，轮换密钥使旧会话失效），或删除 `~/.dsh/web-auth.json` 重启后重新注册。

## 红线（改这些前先读对应文档）

1. **不要删/改 `cordis.patch.yml` 里的 `connection.inject: [webAuth]`**——它保证 auth 插件在 connection 注册 API 路由之前激活，是 API 不设防与设防的区别（`docs/agent/auth-mechanics.md`「路由保护顺序」）。
2. **不要删 `cordis.patch.yml` 里的「包根行」**（`- id: dsh-web-startup-auth / name: dsh-web-startup-auth`）——前端插件进 `__DSH_BOOT__` 的前提，删掉后设置面板「认证」标签页消失（`docs/agent/settings-section.md`）。
3. **改源码后必须 `npm run build`**，否则 profile 里跑的还是旧产物；发布前必须保证 `npm pack` 全链路（prepack：typecheck + test + build）通过。
4. **改认证/信任逻辑前先读 harness 对应机制**：`browser-auth.ts`（原生 cookie 格式与 secret 存储，本插件「补签」的精确镜像）、`api-request-trust.ts`、`rpc-host.ts`；**不要重建已被 0.1.2 删除的 Host/Origin 回环改写**（`docs/agent/native-auth-bridge.md`）。
5. **登录页品牌元素必须照搬原版 SVG**（从 `BrandWordmark.tsx` 提取），不要用 CSS 手绘模拟（`docs/agent/auth-mechanics.md`「登录页品牌字标」）。
6. **发版按 `docs/release-guide.md` 执行**；release notes 面向用户：每条一行带短提交号，只写「新增了什么/修复了什么」，不写实现细节，中英双语。
7. **改完更新 `README.md`、本文件与 `docs/agent/` 的对应段落**——三处是同一份事实，不要只改一处。
8. **拼图验证的文案就是"没什么用"**：它是应网友要求加的彩蛋，不是安全边界（答案画在图上，30 行脚本 100% 读出，实测见 `docs/agent/human-verification.md`）。设置页/README/文档三处保持一致，**不要把它改写成安全承诺**。
9. **登录页必须"任何失败都重取挑战"**：验证在密码之前执行，所以每一次被拒的登录都已消耗挑战；只按 `challengeExpired` 重取会让输错密码后的重试必然先失败一次（E2E 抓过一次）。另两条钉在同一处：拼图是**二维自由拖动**、起始角**不在缺口那一行**（`START_Y - MAX_ANSWER_Y > TOLERANCE`，对齐要两轴都做功）；拼图输错（`challengeExpired`）要**清空密码框**再聚焦——密码错不清空。
10. **改滑块渲染后必须看渲染图**：拼图块要整体裁剪（只裁纹理会变成不透明矩形）、暗色底要保持中间调（太暗则缺口和待拖块都看不见）、**缺口只填色不描边**（描边是机器可读的边缘信号；拼图块自身的白描边不在此列）——这些是单测抓不到、看渲染图/像素校验才发现的。改 `src/slider/render.ts` 后重跑 `tests/slider.spec.ts` 的"纹理同源"断言与像素级对齐校验（含缺口无描边校验，五种剪影 × 明暗都过一遍）。**真缺口的剪影每张图从五种里随机**（凸块朝右/左/上/下，或无凸方块——`ALL_TABS`，`pickAnswer` 抽签），每张图另画一个**形状永远不同**的假缺口（避开真缺口与起始角，永不进接受窗口）——辨认靠形状，它是彩蛋的一部分，不挡脚本。

## 索引：按任务选文档

| 任务 | 读 |
|---|---|
| 了解 dsh 插件机制、profile/patch/安装卸载、前端插件原理、启动排查 | `docs/agent/dsh-plugin-basics.md` |
| 了解本项目结构、与原版差异、核心代码路径、对照上游源码 | `docs/agent/architecture.md` |
| 改登录/会话/凭据/信任判定/路由保护/auth-reset/登录页 | `docs/agent/auth-mechanics.md` |
| 改滑块拼图验证、登录限流（每 IP + 全局退避） | `docs/agent/human-verification.md` |
| 改原生 cookie 补签、`__DSH_TRANSPORT__` hook、升级 dsh 后的适配 | `docs/agent/native-auth-bridge.md`（升级先看 `docs/upgrade-dsh-0.1.2-playbook.md` / `docs/upgrade-dsh-0.1.5-playbook.md` / `docs/upgrade-dsh-0.1.7-playbook.md` 的观察哨，第一步 diff `browser-auth.ts`） |
| 正式版发布前确认插件是否还活着 | `docs/upgrade-dsh-0.1.7-playbook.md`（0.1.7-rc.1 三层验证：静态 diff + 构建探针 + 隔离实例实机；含待跟进 P1 `/oauth/callback`、P2 `$DSH_HOME`） |
| 改设置面板「认证」标签页、slot 注册、导航图标、暗黑模式、预取与状态未知态 | `docs/agent/settings-section.md` |
| 处理 Renovate 依赖更新 PR | `docs/agent/renovate.md` |
| 发版 | `docs/release-guide.md` |

## 上游源码地图（harness 源码根，作者本机位于 `~/coding/research/deepseek-harness`，见「路径约定」）

| 路径 | 用途 |
|---|---|
| `packages/bundle/web-app/src/startup.ts` | 原版 web-startup（0.0.0.0 拒绝在 ~69 行） |
| `packages/bundle/web-app/src/index.ts` | web-app bundle（webserver 行、`webStartup` 服务消费方） |
| `packages/client/connection/src/browser-auth.ts` | 0.1.2 原生浏览器认证（原生 cookie 签名/校验；本插件「补签」的镜像对象，升级先 diff） |
| `packages/client/connection/src/rpc-host.ts` | `requestRejection` 双闸门（403 信任围栏 + 401 原生 cookie） |
| `packages/client/connection/src/api-request-trust.ts` | 浏览器信任围栏（DNS rebinding / 跨站防护） |
| `packages/client/ui-primitives/src/BrandWordmark.tsx` | 登录页品牌字标 SVG 的出处 |
| `packages/client/modules/src/index.ts` | `ClientModuleRegistry`（前端插件 boot 图组合、`dsh.client` 扫描） |
| `packages/client/ui-settings/src/client/contract/slots.ts` | `settings.section` 等设置面板 slot 契约 |
| `packages/client/ui-settings-models/src/client/index.ts:118` | 前端插件向 `settings.section` 注册标签页的范本 |
| `packages/client/tsdown.client.ts` | 前端插件 bundle 的 `clientBundle` preset（`tsdown.config.ts` 的模仿对象） |
| `packages/bundle/web-app/cordis.patch.yml` | 前端插件「包根行」的官方写法 |

## 作者本机环境（仅对作者本机成立）

- profile 现状（作者本机）：`~/.dsh/profiles/web/` 以 `link:` 方式安装本插件（指向作者本机的仓库路径）；`dsh.profile.bundles` 含 `dsh-web-startup-auth`。改动后重启 `dsh web` 生效。
- 版本跟进基线：README 声明跟进官方 `next` dist-tag（不跟 `alpha`）。当前基线 dsh 0.1.5-rc.2（0.1.5-rc.1 适配核查见 `docs/upgrade-dsh-0.1.5-playbook.md`，rc.2 经产物对比与 rc.1 零代码差异；0.1.2 迁移手册见 `docs/upgrade-dsh-0.1.2-playbook.md`）。
- **正式版前置核查（2026-09-23）**：harness 源码已拉到 `dsh-v0.1.7-rc.1`（`next` 指向它，`latest` = 0.1.5-rc.3）。核查结论 = **插件存活、源码零改动**，且依赖是 caret 范围（稳定版一发布就会被 `npm install` 解析进来），故已在 0.1.7-rc.1 上完成构建探针 + 隔离实例实机验证。完整证据、待跟进项与迁移清单见 `docs/upgrade-dsh-0.1.7-playbook.md`。
- **第二次核查（2026-09-24）**：针对 npm 已发布产物（而非仅源码 tag）复核，结论不变（101/101、dump-config、登录墙/补签/登出/`auth-reset`/设置面板「认证」页全部实测通过）；同时**实测复现 P2**（`DSH_HOME` 被忽略，隔离实例读到宿主机真实 `~/.dsh/web-auth.json`，需用 `DSH_WEB_AUTH_FILE` 才能真正隔离）。详见 playbook「C. 已发布 npm 产物复核」。
