# 依赖更新（Renovate 机器人）

仓库挂了 **Mend 托管的 Renovate bot**（Community 免费计划，门户 `developer.mend.io/github/GDWhisper/dsh-web-startup-auth`），负责自动提依赖更新 PR。

## 配置

仓库根 `renovate.json`（`config:recommended` + `dependencyDashboard: true`）。三条定制规则：

- `@deepseek-ai/dsh-*`（除 `cordis`/`schemastery`）**跟随 `next` dist-tag** 并 bump range——这些包的 `latest` 是占位版本，真正的发布在 `next` 上（见 renovate.json 内注释）。
- **`react` / `@types/react` 禁用更新**（锁 18）：前端插件的 react 是 external，运行时用宿主 SPA 提供的 React 18（harness 锁 `^18.2.0`），本地升 19 会对不上运行时。改动这条前想清楚。
- **`typescript` 限制在 `6.x`**（`allowedVersions`，不是 `enabled: false`——6.x 的 patch/minor 照提）：基准是**对齐 harness 的 `^6.0.3`**，不跟 `latest`。7.0 是原生（Go）端口，`bin` 里去掉了 `tsserver`、`package.json` 不再有 `main`/`types`（programmatic TS API 消失），编辑器选 "use workspace version" 会没有语言服务；`tsdown` 依赖链里的 `rolldown-plugin-dts` 会 import TS API（现在没炸只是因为 `tsdown.config.ts` 写了 `dts: false`）。

## 运行方式

- 任务是**推送/手动触发**（Reason: `requested`），没有定时调度——推送到 main 才会跑。排查"机器人没动静"时别傻等。
- **Dependency Dashboard 是 issue #9**：bot 自动维护，汇总待合并/被限流（每小时最多开 2 个 PR）的更新；**不要关闭它**（关了会被重建）。被限流的更新会在后续运行自动补开，也可在 issue 里勾选复选框强制。

## 踩过的大坑：mend.io 的 Silent mode

开启后任务照跑（jobs 全 DONE）但**零产出**——不开 PR、不建 Dashboard。表现为"任务成功却毫无动静"。在门户仓库 Settings 里关闭，再手动触发一轮即恢复。排查顺序：门户 Recent jobs → Silent 开关 → job 日志。

## 处理它的 PR

- 分支 `renovate/*`、作者 `app/renovate`。本仓库**没有 PR 触发的 CI**（`publish.yml` 只在发布时跑），合并前必须本地验证：`npm install && npm run typecheck && npm test && npm run build`。major 更新要跑全链路。
- **当前基线**：`vitest ^5`（5.0.0）、CI/`@types/node` 为 **24**（`^24.13.4`）、`typescript ^6.0.3`（对齐 harness，机器人给的 7.x 已拒）。
- **一次多个依赖 PR 时注意合并顺序**：它们的 `package.json` / `package-lock.json` 改动可能互相冲突（实测 #10 node + #12 vitest 能干净叠加，但 #11 typescript 最后合就同时冲突两处——它新增的 `@typescript/*` 条目块正好插在 #12 重写的 `@vitest/*` 区域里）。用 `git merge-tree --write-tree <a> <b>` 先试推演，冲突的那条改成手动 `npm install` 重生成 lock。合并后**务必在拉到的 main 上再跑一遍全链路**，不是只看单个 PR 的分支。
- **注意**：`package-lock.json` 的 registry 指向 npmmirror 的问题尚未处理（用户决定暂缓）；若 Dashboard 出现大量 "Failed to look up" 条目，先怀疑它。
