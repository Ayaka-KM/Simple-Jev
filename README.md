# Simple-Jev

简单的调用 Jev。

一个不用命令行就能调用 [Jev](https://openrouter.ai/docs/guides/community/jev) 决策模型的网页。填入 Base URL 和 API Key，选题型、写问题和选项，点「发起调用」，结果以带动画的概率条显示。

Jev 是 TypeSafe 的决策模型：它不生成文字，只在你给定的选项之间分配概率。

## 功能

- **三种题型**
  - **是 / 否**（`noul`）：返回“是”的概率，左右两段颜色从两端向中间长出来，比如「是 96% / 否 4%」。
  - **单选**（`choice`）：2–8 个选项，每个选项一种颜色，显示 Jev 选了哪个、每个选项的概率和置信度。
  - **打分**（`score`）：2–10 个从低到高的档位，刻度尺上的标记滑到得分位置，下面列出每一档的概率。
- **动画**：调用前所有数字都是 0%，结果返回后，色条和数字一起从 0 涨到最终值。再次调用时先缩回 0，再涨到新结果。
- **示例**：打开时表单是空的，输入框里的灰色文字只是示例，直接输入即可，不用先删除。想直接试用，可以点「试试示例」一键填入（薛定谔的猫、工单分类、紧急程度、评论情感等）。
- **清空**：示例后面的「清空」按钮会清空问题、背景内容和所有选项（Base URL、Key 和模型不变），清空后几秒内可以点「撤销」恢复。
- **深色模式**：跟随系统，也可以手动切换。手机上也能用。
- **原始数据**：可以展开查看请求 JSON、响应 JSON 和等价的 curl 命令（命令里不含 Key）。

## 隐私

- 网页在浏览器里**直接**请求你填写的 Base URL，Key 不经过本站服务器。本站只提供静态文件。
- 表单内容保存在浏览器的 localStorage 里，方便下次打开。Key 只有在勾选「记住 Key」时才会保存。
- 「发起调用」右边的「清除缓存」会删除本页保存在浏览器里的所有内容（表单、记住的 Key、主题设置），并刷新页面，和第一次打开时一样。

## 部署到 Cloudflare Workers

这是一个只有静态文件的 Worker，配置在 `wrangler.jsonc`，网页文件在 `public/`，不需要构建步骤。

在 Cloudflare 控制台 **Workers & Pages → 创建 → 导入 Git 仓库**，选择这个仓库：

| 设置 | 值 |
|---|---|
| Worker 名称 | `simple-jev`（要和 `wrangler.jsonc` 里的 `name` 一致；想用别的名字就两边一起改） |
| 构建命令 | 留空 |
| 部署命令 | `npx wrangler deploy`（默认值） |

之后每次 push，Cloudflare 都会自动重新部署。

`public/_headers` 设置了安全响应头（CSP 等）。其中 `connect-src` 允许任意 `https:` 地址，这样用户填的 Base URL 都能调用。

## 本地开发

需要 Node.js 22 及以上版本（wrangler 4 的要求；仓库里的 `.node-version` 让 Cloudflare 构建也用 Node 22）。

```bash
npm install
npm run dev     # 启动本地服务 http://localhost:8787
npm test        # 运行单元测试
npm run deploy  # 手动部署（需要先 npx wrangler login）
```

## 项目结构

```
public/
  index.html      页面结构
  styles.css      样式（浅色 / 深色两套配色）
  _headers        Cloudflare 静态资源的响应头
  favicon.svg
  js/
    core.js       纯逻辑：拼请求、解析响应、处理错误（无 DOM，可在 Node 里测试）
    viz.js        概率条、刻度尺和动画
    app.js        表单和页面交互
    theme.js      页面加载前应用主题，避免闪烁
test/
  core.test.js    core.js 的单元测试（node --test）
wrangler.jsonc    Cloudflare Workers 配置
```

## Jev 接口速查

- 地址：`POST {Base URL}/alpha/decisions`。默认 Base URL 是 `https://openrouter.ai/api`；填 `https://openrouter.ai/api/v1` 也行，页面会自动去掉 `/v1`。
- 请求头：`Authorization: Bearer <API Key>`
- 请求体：`model`、`state`（要判断的内容）、`questions`（题目）。`state` 留空时，页面会用问题本身代替。

```json
{
  "model": "typesafe/jev-1.13",
  "state": "薛定谔的猫是活的还是死的？",
  "questions": {
    "decision": {
      "type": "choice",
      "instructions": "薛定谔的猫是活的还是死的？",
      "criteria": { "活": "猫是活的", "死": "猫是死的" }
    }
  }
}
```

- 返回：`answers.decision` 里，`choice` 是选中的选项，`probabilities` 是各选项概率，`confidence` 是置信度；是/否题返回 `noul`；打分题返回 `score`（从 0 开始计数）。`usage.cost` 是这次的费用（美元）。

计费只按输入 token 算，输出免费，一次调用通常不到 $0.0001。
