# arena-agent-billing（油猴脚本 · 自动更新源）

Arena Agent 计费指纹与自动筛选 —— **单文件**油猴脚本（Tampermonkey / Violentmonkey）。
本仓库只托管**构建产物**与自动更新入口，源码在其开发工作区内维护。

## 安装 / 更新

```
https://raw.githubusercontent.com/20060404bcf-sys/arena-agent-billing/main/arena-agent-billing.user.js
```

- 第一次**点上面的链接装一次**（Tampermonkey 会弹出安装页），之后脚本头部自带的 `@updateURL` / `@downloadURL`
  会让它自动检查更新：`@version` 一递增就升级。也可以在 Tampermonkey 面板里手动「检查更新」。
- 装好后页面右上角面板的标题旁会显示一行 `v0.6.2` 形式的**运行版本标记**（截图时可直接作为版本绑定证据）。

## 当前版本

| 项 | 值 |
|---|---|
| `@version` | `0.6.2` |
| 字节 | 447533 |
| sha256 | `f83738d62a65cba8fa400d82f5756a6c9552143fe1155c67e8b84eba02339aa8` |
| KERNEL_HASH | `1fe2bbf7849e8ffbad8a74b5ea4efad0d7977999bc15dc0c99593bc24f1a03f1` |
| BUNDLE_HASH | `6cee163797e57b24f0f86ab215e7bbb461cb935006be45efb6be1b02f21993f6` |
| RULE_VERSION | `identify-rules-v1` |

## 0.6.2 相对 0.6.1 的行为变化

- **R1**：会话**没有费用证据**时一律**暂停、绝不归档**（旧版会归档）。
- **R2**：一旦观测到思考流（reasoning / thinking / thought 事件）就**恒定中断并归档**，不受「思考流要求」三档影响；回退点 = 常量 `AUTOMATION_THINKING_ALWAYS_ARCHIVE=false`。
- **R3**：面板「费用读数」在**折叠态**也显示费用速览；其基础是 50-cost 模块的既有实现（未归属改动，经独立审查判定**保留现状不回退**）。

## 边界

- 脚本只在本地页面运行，**不上传**费用、正文或凭据；产物内**不含**任何 `localhost` / `127.0.0.1` 依赖，也不加载外部资源（构建期有单文件契约断言把关）。
- 识别结果只给**候选集合**与未约束状态，不声称模型身份已被证明。
- 本仓库为公开仓库；若需停止分发，删除本仓库或把该文件改为占位即可。
