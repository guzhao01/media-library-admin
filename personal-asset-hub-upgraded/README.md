# 个人素材库 Personal Asset Hub（双仓库升级版）

这是 Cloudflare Worker + GitHub Contents API 的个人素材管理后台。管理代码放在 `media-library-admin`，公开素材和私人素材分别存放在两个独立 GitHub 仓库。

## 仓库规划

- `media-library-admin`：本项目代码与部署说明，不存素材。
- `media-library-assets`：**Public**，存放允许公开访问的素材；可复制 `raw.githubusercontent.com` 直链。
- `media-library-private`：**Private**，存放私人角色卡和收藏；仅能通过已登录的 Worker 下载，不会生成公开直链。

> 公开仓库中的文件任何人都可能访问。不要把私人文件上传到公开仓库。

## 功能

- 管理员密码登录，HttpOnly / Secure / SameSite Cookie 会话（12 小时）。
- 上传时选择公开或私人仓库，支持多文件逐个上传。
- 分类、搜索、预览图片、下载原文件、删除、重命名和移动分类。
- 上传与移动时计算 SHA-256，并在写入后重新下载校验；移动失败时保留源文件。
- 私人文件下载经过 Worker 身份验证，不返回 GitHub 私有仓库直链。
- 文件按原始字节传输，不主动压缩、缩放、转码或重新编码图片/GIF/PNG。
- 预留后续统一存储适配器迁移到 Cloudflare R2 / S3 的方向；当前版本仍使用 GitHub 存储。

## 重要限制

1. 当前单文件限制为 **8 MiB**，这是为了避免 Worker 内存、GitHub API Base64 内容接口和请求体限制带来的不稳定。超出会明确报错，不会偷偷压缩文件。
2. GitHub Contents API 更适合小型个人素材库，不是无限容量网盘。频繁修改/删除会留下 Git 历史记录；删除当前文件不等于从 Git 历史彻底清除。
3. 私人素材预览由 Worker 代理下载，较大的图片会占用 Worker 内存与请求时间。
4. SHA-256 当前在上传/移动时计算并即时校验；本版本未建立独立的持久化哈希数据库。
5. GitHub raw 公开链接依赖 GitHub 服务与网络环境，不承诺永久可用。
6. SVG 等主动执行内容不建议作为可信网页直接打开；下载后按需使用。

## 部署前准备

确认 GitHub 已有以下仓库：

- `guzhao1/media-library-admin`（建议 Private，放代码）
- `guzhao1/media-library-assets`（Public）
- `guzhao1/media-library-private`（Private）

Fine-grained Personal Access Token：

- Repository access：仅选择 `media-library-assets` 和 `media-library-private`
- Repository permissions：`Contents: Read and write`、`Metadata: Read-only`
- 不需要把 Token 发给任何人，也不要写进代码、README 或 GitHub 仓库。

## Cloudflare Worker 配置

在 Cloudflare Dashboard → Workers & Pages → `personal-asset-hub` → Settings → Variables and Secrets 添加：

**普通变量（Text）**
- `GITHUB_OWNER` = `guzhao1`
- `PUBLIC_REPO` = `media-library-assets`
- `PRIVATE_REPO` = `media-library-private`
- `GITHUB_BRANCH` = `main`

**机密（Secret）**
- `GITHUB_TOKEN` = 你的 Fine-grained Token
- `ADMIN_PASSWORD` = 你自己设置的高强度后台密码
- `SESSION_SECRET` = 一段随机且足够长的独立密钥（建议至少 32 字符，不要与管理员密码相同）

不要把 Secret 放进 `wrangler.toml`。如果使用 Wrangler CLI，可用 `npx wrangler secret put GITHUB_TOKEN` 等命令逐项录入。

## 部署方式（网页控制台）

1. 打开 Cloudflare → Workers & Pages → `personal-asset-hub`。
2. 进入 Edit code / Quick edit。
3. 用本项目 `src/index.js` 完整替换编辑器内容。
4. 保存并 Deploy。
5. 在 Settings → Variables and Secrets 中确认上述变量和 Secret 已配置。
6. 打开 Worker 域名，使用 `ADMIN_PASSWORD` 登录。

## 部署方式（Wrangler CLI，可选）

安装 Node.js 后，在项目目录执行：

```bash
npm install
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler deploy
```

普通变量已写在 `wrangler.toml`，如用户名或仓库名不同请先修改。

## 安全与使用提醒

- 绝不在聊天、截图、前端代码或公开仓库中粘贴 Token。
- 后台密码不要与 GitHub 密码相同。
- 建议只在可信设备上登录；退出后会清除会话 Cookie。
- 上传私人素材前，确认上传位置显示“私人素材库”。
- GitHub 仓库的 Private 状态与 Token 仓库授权应定期复核。

## 目录

```text
personal-asset-hub/
├── README.md
├── package.json
├── wrangler.toml
└── src/
    └── index.js
```
