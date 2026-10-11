# arena-agent-billing（油猴脚本 · 自动更新源）

Arena Agent 计费指纹与自动筛选 —— **单文件**油猴脚本（Tampermonkey / Violentmonkey）。
本仓库只托管**构建产物**与自动更新入口，源码在其开发工作区内维护。

## 安装 / 更新

```
https://raw.githubusercontent.com/20060404bcf-sys/arena-agent-billing/main/arena-agent-billing.user.js
```

- 第一次**点上面的链接装一次**（Tampermonkey 会弹出安装页），之后脚本头部自带的 `@updateURL` / `@downloadURL`
  会让它自动检查更新：`@version` 一递增就升级。也可以在 Tampermonkey 面板里手动「检查更新」。
- 装好后页面右上角面板的标题旁会显示一行 `v0.6.5` 形式的**运行版本标记**（截图时可直接作为版本绑定证据）。

## 当前版本

| 项 | 值 |
|---|---|
| `@version` | `0.6.5` |
| 字节 | 464566 |
| sha256 | `d51f4b03a160ed5e1b2d33b703559e6f28b45cbb0b79e7d381e8488143cf14d3` |
| KERNEL_HASH | `1fe2bbf7849e8ffbad8a74b5ea4efad0d7977999bc15dc0c99593bc24f1a03f1` |
| BUNDLE_HASH | `6cee163797e57b24f0f86ab215e7bbb461cb935006be45efb6be1b02f21993f6` |
| RULE_VERSION | `identify-rules-v1` |
| 发布提交 | `95289e86e456e1453256b60aae2d9223fc6e014f` |

## 0.6.5 相对上一版的行为变化

- **R2 的思考判据从「流量」改为「页面」**：只有页面**渲染出 `thinking` 标签**（思考进行中）时才立即停止生成并归档；
  已结束的 `Thought for n second` **不触发**。
- **SSE 里出现 `reasoning-*` 事件不再中断或归档**（真机反例：同一条回答里有 7 个 reasoning 部件、文本全空，
  页面根本没显示 Think；按流量判会误归档）。
- **不再掐断流读取** ⇒ 能读到 `turn-complete`，随消除「等待输出完成」永久卡住、取不到完整计价、不返回模型名的问题。
- **R1 未变**：会话**没有费用证据**时一律**暂停、绝不归档**。
- **R3 未变**：面板「费用读数」在**折叠态**也显示费用速览。
- 回退点：常量 `AUTOMATION_THINKING_ALWAYS_ARCHIVE=false`（页面出现思考即中断+归档的行为由该开关统管）。

## 边界

- 脚本只在本地页面运行，**不上传**费用、正文或凭据；产物内**不含**任何 `localhost` / `127.0.0.1` 依赖，也不加载外部资源（构建期有单文件契约断言把关）。
- 识别结果只给**候选集合**与未约束状态，不声称模型身份已被证明。
- **未做（如实标注）**：0.6.5 发行件**未在真机浏览器里跑过**；页面 `thinking`（思考中）那一瞬目前只用真机 DOM 验证了
  「已结束态正确地不触发」，正例需要一轮真跑；「无思考会话一路走到识别并在面板上显示模型名」尚未真机验证。
- 本仓库为公开仓库；若需停止分发，删除本仓库或把该文件改为占位即可。
