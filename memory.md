# MJC Daily — 设计记录

## 最终架构

- **前端**: `index.html` 单文件，纯前端，访客直接看只读内容
- **API**: `/api/load` (读Redis) `/api/generate` (服务端生成) `/api/news` (保留)
- **存储**: Upstash Redis (免费额度，key = `news:YYYY-MM-DD`)
- **定时**: GitHub Actions cron `0 23 * * *` = 北京时间 07:00
- **密码保护**: 解锁密码 `mjcdaily888`（存 Vercel env EDIT_PASSWORD）
- **API Key**: 存 Vercel env MINIMAX_API_KEY，不暴露在前端

## Upstash Redis 凭证
- URL: `https://divine-glider-125248.upstash.io`
- Token: `gQAAAAAAAelAAAIgcDFiYTA5YjQyZjk3YWQ0Y2YxYTk2MmQ2N2M5NGVmNDAyYw`

## Vercel 环境变量
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `MINIMAX_API_KEY`
- `EDIT_PASSWORD` = `mjcdaily888`

## 热点去重
- 在 `api/generate.js` 的 `deduplicate()` 中实现
- 基于标题字符集合相似度 (Jaccard > 0.6) 判断重复
- 优先保留微博 > 知乎 > 澎湃

## 密码验证流程
1. 前端输入密码 → POST `/api/generate` 带 password
2. 后端比对 `process.env.EDIT_PASSWORD`
3. 验证失败返回 401

## 待完成 / 已知问题
- 生成进度在 GitHub Actions 中无法实时反馈（无 WebSocket）
- GitHub Actions cron 需要手动触发一次验证 workflow 正常
- Vercel 部署后需在 Settings 添加所有 4 个环境变量