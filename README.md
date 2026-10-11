# arena-agent-billing（油猴脚本 · 自动更新源）

Arena Agent 计费指纹与自动筛选 —— **单文件**油猴脚本（Tampermonkey / Violentmonkey）。
本仓库只托管**构建产物**与自动更新入口，源码在其开发工作区内维护。

## 安装 / 更新

```
https://raw.githubusercontent.com/20060404bcf-sys/arena-agent-billing/main/arena-agent-billing.user.js
```

- 第一次**点上面的链接装一次**（Tampermonkey 会弹出安装页），之后脚本头部自带的 `@updateURL` / `@downloadURL`
  会让它自动检查更新：`@version` 一递增就升级。也可以在 Tampermonkey 面板里手动「检查更新」。
- 装好后页面右上角面板的标题旁会显示一行 `v0.6.7` 形式的**运行版本标记**（截图时可直接作为版本绑定证据）。

## 当前版本

| 项 | 值 |
|---|---|
| `@version` | `0.6.7` |
| 字节 | 476876 |
| sha256 | `70fec0898d673adf36d24db0a6047e8ff04ae468b563d3eebe20b10f988b79a5` |
| KERNEL_HASH | `1fe2bbf7849e8ffbad8a74b5ea4efad0d7977999bc15dc0c99593bc24f1a03f1` |
| BUNDLE_HASH | `6cee163797e57b24f0f86ab215e7bbb461cb935006be45efb6be1b02f21993f6` |
| RULE_VERSION | `identify-rules-v1` |
| 发布提交 | `3a36e7c72d4c8c46f124bf990f7dba7695c9e0e9` |

## 0.6.7 相对上一版的行为变化

用户指令（2026-10-11）：**「默认强制注入覆盖脚本，这样绕过 403 读取 cost」**
（背景：上一轮真机回报「读不到计费」，用户既有经验是「403 直接覆盖脚本走一次就行」）。

- **覆盖开关默认强制注入**：任意 `arena.ai` 页面的 `document-start` 就把 PostHog 计费开关写进**三处** ——
  ① `localStorage["ph_phc_*_posthog"].$override_feature_flags`（**真源**：页面自己的 `usePostHogToolbarSync`
  就是按它派生 cookie 的，也是**扛页面重载**的那一处）；② cookie `ph-toolbar-overrides`（**服务端逐请求读的就是它**）；
  ③ 页面 PostHog 实例（晚于 document-start 出现，由自愈周期补推）。值都是 `{"credit-system-m1":"cost-shown"}`。
  **只合并、不删除**用户其它 localStorage / PostHog 状态。
  旧行为只在 `/agent` 页面写一次 cookie ⇒ 页面按 localStorage 重写 cookie 时开关被清掉 ⇒ `/cost` 退回
  `403 {"error":"Unauthorized"}`。
- **自愈周期**：每 10 秒只读本地状态，发现 cookie 或 localStorage 覆盖丢了就补回来（**不发任何网络请求**）；
  PostHog 实例只在**启动后头 2 分钟**或「cookie 刚被清掉」时推一次（避免周期性触发 PostHog 重新取 flag）。
- **读到 403 ⇒ 自动重放覆盖开关并重试一次**：面板费用读数与自动化读价两条通路都有。**最多一次**，不循环、
  不放大请求量（真机已见过 `/cost` 429）；仍失败就照实报错。`401`（登录态失效）**不触发**重试。
- **只读复核入口**（页面控制台）：`__ARENA_AGENT_BILLING__.billingFlag.state()` →
  `{ local, cookie, posthog, at, tick }`；`…billingFlag.cookie()` 看 cookie 原文。
- **R1/R2/R3 与判定口径一律未变**；0.6.6 起「拿到本轮自己消息的**完整计价**即可判定」的口径继续生效
  （不再要求先观测到 Arena 的 `turn-complete`，且迟到的中断信号不会撤销已成立的完成）。
  回退点：常量 `AUTOMATION_THINKING_ALWAYS_ARCHIVE=false`（页面出现思考即中断+归档由该开关统管）。

## 边界

- 脚本只在本地页面运行，**不上传**费用、正文或凭据；产物内**不含**任何 `localhost` / `127.0.0.1` 依赖，也不加载外部资源（构建期有单文件契约断言把关）。
- 识别结果只给**候选集合**与未约束状态，不声称模型身份已被证明。
- **未做（如实标注）**：0.6.7 **尚未在真机跑过一轮**（改动只有单测 + DOM 桩端到端）。
- **关于 403 的准确预期**：开发工作区上一轮真机取证把当时那段 403 定性为**服务端临时拒绝窗口**（约 10 分钟后自行恢复，14/14 全 200），
  本版**不声称**消灭那类窗口；本版消灭的是**另一类确定存在的成因** —— 覆盖开关被页面自身 toolbar sync 清掉。
  即「开关不再会掉」+「万一仍 403，脚本会自己重放开关重试一次，而不是等你手点按钮」。
  若仍稳定 403，请回报并附上面板读数与 `billingFlag.state()`。
- 本仓库为公开仓库；若需停止分发，删除本仓库或把该文件改为占位即可。
