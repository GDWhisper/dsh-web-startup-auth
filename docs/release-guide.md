# 发布指导（Release Guide）

本文件规范 dsh-web-startup-auth 的发版流程。**全程不涉及网络/代理排障**——推送遇阻时按 memory 中的 GitHub 连通性经验处理，不属于本流程。

## 版本规则

- 版本号递增**修订号**（`0.1.x` 的第三位），feat/fix/refactor 都不加副版本。
- tag 与版本号严格一致：`v<版本号>`（如 `v0.1.7`），tag 推送触发 Actions「Publish to npm」。

## 发版流程

按顺序执行，任何一步失败先解决再继续：

### 1. 检查待发内容

```sh
git status                 # 工作区必须干净；有未提交改动先提交
git log origin/main..HEAD  # 列出待推送提交，这就是 release notes 的素材
```

### 2. 全链路验证

```sh
npm run typecheck && npm test && npm run build
```

全绿才继续（与 `prepack` 同款，测试不过 npm publish 也会失败）。

### 3. 升版本号并提交

```sh
npm version <x.y.z> --no-git-tag-version   # 同时改 package.json 与 package-lock.json
git add package.json package-lock.json
git commit -m "v<x.y.z>"
```

### 4. 推送 main 并打 tag

```sh
git push origin main
git tag v<x.y.z>
git push origin v<x.y.z>   # 这一步触发 Actions
```

### 5. 撰写 Release Notes

参照**上一版 release notes** 的结构与语言（中文 + 英文各一段，英文是中文的对译）。

**写法要求（重要）：**

- **面向用户，不写实现细节**：用户要知道的是「多了什么功能、修了什么问题、对我的部署有什么影响」。内部机制（文件名、数据流、为什么这么实现、踩了什么坑）一律不写——那些在 AGENTS.md 和提交信息里。
- **每条一行，带提交编号**：`- 功能一句话（用户视角的效果）(#<短提交号>)`。
- 按「新增 / 修复」分组，没有的组写「无 / Nothing」，不要硬凑。
- 结尾保留「验证」段：测试数量与 typecheck/build 状态。
- 标题：`v<x.y.z> — 一句话主题`。

**模板：**

```markdown
## 变更内容

dsh-web-startup-auth `v<x.y.z>`，以 dsh `next` 通道为基线（<当前基线版本>）。

### 新增
- <功能一句话>（#<短提交号>）。

### 修复
- <修复一句话>（#<短提交号>）。/ 无。

### 验证
- <N> 个 vitest 测试全绿；typecheck / build 干净。

---

## What's changed

<英文对译，结构同上>
```

### 6. 创建 Release 并确认发布

```sh
gh release create v<x.y.z> --title "v<x.y.z> — <一句话主题>" --notes-file <notes 文件>
```

gh 不可用时兜底：curl 调 REST API（`POST /repos/<owner>/<repo>/releases`，body 用 `jq -n --rawfile` 构造）。

最后确认 Actions「Publish to npm」跑完且 success，npm registry 上出现新版。

## 检查清单

- [ ] 工作区干净，待发提交明确
- [ ] typecheck / test / build 全绿
- [ ] 版本号已 bump 并提交
- [ ] main 与 tag 均已推送
- [ ] release notes：带提交编号、无实现细节、双语、参照上一版格式
- [ ] release 已创建，Actions success
