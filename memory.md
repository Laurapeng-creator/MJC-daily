---
name: mjc-daily-design
description: 新传考研每日热点网页 — 设计偏好、踩坑、约定
metadata:
  type: reference
---

# MJC Daily 设计记录

## 视觉风格（已确定）
- 暖白底 `#fafaf8`，纯黑强调色 `#111110`，灰度文字层次
- 字体：DM Sans（正文）+ Noto Serif SC（备用）
- 布局：单列 720px 居中，卡片圆角 12px，头部导航 + 底部固定操作栏
- 暗色：dark dataset toggle，变量替换，非 class 切换

## API 相关（已踩坑）
- NewsNow API 端点是 `/api/s?id=weibo`，不是 `/api/news`
- CORS 问题：通过 `corsproxy.io` 代理绕过
- source 参数不存在，使用 `id` 参数
- 返回字段：title, url, id, rank（需自己编号），无 rank/datetime 字段

## 实现顺序（确认有效）
1. 基础框架 + 热点抓取 → 2. AI 生成 → 3. 编辑筛选 → 4. 导出历史 → 5. 暗色模式

## localStorage Key 约定
- `mjc_apikey` — API Key
- `mjc_dark` — 暗色模式（1/0）
- `mjc_edits` — 编辑内容（按日期索引）
- `mjc_dailycount` — 每日条数

## AI 生成细节
- MiniMax API 端点：`https://api.minimaxi.chat/v1/text/chatcompletion_v2`
- 模型：`abab6.5s-chat`
- 生成间隔 800ms 防限流
- 解析用正则 + fallback，不依赖 JSON 输出

## 导出格式
- Markdown，含平台标签、原文链接、知识点、怎么考、案例积累
- 复制到剪贴板 / 文件下载两种方式

## 待优化 / 已知限制
- 热点抓取使用 corsproxy.io，有额外延迟，首屏尽量 < 3s
- 日期选择用 native date input，样式有限但兼容性最好
- 知识点标签云最多显示 8 个，多了显示 +N