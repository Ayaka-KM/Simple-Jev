# Simple-Jev

简单的调用 Jev。

一个不用命令行就能调用决策模型的网页，支持 [Jev](https://openrouter.ai/docs/guides/community/jev) 和 [GPT-6 Luna Decisions](https://openrouter.ai/docs/guides/community/multimodal-decisions)（能看图片）。填入 Base URL 和 API Key，选模型和题型、写问题和选项，点「发起调用」，结果以带动画的概率条显示。

决策模型不生成文字，只在你给定的选项之间分配概率。两个模型的详细区别见网页右上角的「模型对比」（`/compare.html`）。

## 功能

- **三种题型**
  - **是 / 否**（`noul`）：返回“是”的概率，左右两段颜色从两端向中间长出来，比如「是 96% / 否 4%」。
  - **单选**（`choice`）：2–8 个选项，每个选项一种颜色，显示模型选了哪个、每个选项的概率和置信度。
  - **打分**（`score`）：2–10 个从低到高的档位，刻度尺上的标记滑到得分位置，下面列出每一档的概率。
- **动画**：调用前所有数字都是 0%，结果返回后，色条和数字一起从 0 涨到最终值。再次调用时先缩回 0，再涨到新结果。
- **示例**：打开时表单是空的，输入框里的灰色文字只是示例，直接输入即可，不用先删除。想直接试用，可以点「试试示例」一键填入（薛定谔的猫、工单分类、紧急程度、评论情感等）。
- **清空**：示例后面的「清空」按钮会清空问题、背景内容、图片和所有选项（Base URL、Key 和模型不变），清空后几秒内可以点「撤销」恢复。
- **模型**：下拉框列出 OpenRouter 上的全部决策模型：Jev 1.13、Jev Latest、GPT-6 Luna Decisions 排在最前，其余按「支持图片」和「只支持文字」分组。列表在打开页面时从 OpenRouter 公开的模型目录读取，并缓存在浏览器里，所以新上架的模型会自动出现。下拉框下面一行显示所选模型能否看图片、上下文长度、价格和模型页链接。不在列表里的名称（比如带 `:nitro` 的变体）可以选「自定义模型名称」手动填写。有的模型只接受部分题型（比如 Respan 的模型只接受是/否题），选错题型时会直接提示该换成哪种。
- **图片**（只限支持图片的模型，比如 GPT-6 Luna Decisions）：在「背景内容」下面点「添加图片」、把图片拖进来或直接粘贴，每次最多 8 张。每张图都会在浏览器里重新画成最长边不超过 1024 像素的 JPEG 再发送：透明部分填成白色，照片的 EXIF 信息（比如拍摄地点）不会发出去。用 GPT-6 Luna Decisions 时还可以选择图片精度：「自动」每张最多约 1000 token，「低」先缩到 512 像素以内、每张最多约 260 token（具体多少取决于图片的长宽比）；其他图片模型不理会这个设置，所以不显示。图片只放在内存里，不会保存。哪个模型支持图片、每次最多几张，以 OpenRouter 模型目录和文档为准（GPT-6 Luna Decisions 本页最多发 8 张，Clef 系列每次最多 4 张，其他图片模型按 4 张算）。选只支持文字的模型（如 Jev）时图片区域会禁用，已添加的图片也不会发送，因为这类模型收到图片不会报错，只会乱猜。粘贴到输入框时，如果剪贴板里同时有文字（比如从表格复制的单元格），粘贴的是文字。
- **模型对比**：右上角「模型对比」打开 GPT-6 Luna Decisions 和 Jev 的详细对比文档（数据截至 2026-10-09）。
- **深色模式**：跟随系统，也可以手动切换。手机上也能用。
- **原始数据**：可以展开查看请求 JSON、响应 JSON 和等价的 curl 命令（命令里不含 Key）。

## 隐私

- 网页在浏览器里**直接**请求你填写的 Base URL，Key 不经过本站服务器。本站只提供静态文件。
- 表单内容保存在浏览器的 localStorage 里，方便下次打开。Key 只有在勾选「记住 Key」时才会保存。图片从不保存。
- 打开页面时，如果 Base URL 是 OpenRouter，页面会读取 OpenRouter 公开的决策模型目录（不带 Key），用来列出模型、判断哪些支持图片；读到的列表缓存在浏览器里，「清除缓存」会一并删除。
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
  index.html      调用工具页面
  compare.html    GPT-6 Luna Decisions 与 Jev 的详细对比文档
  styles.css      样式（浅色 / 深色两套配色）
  compare.css     对比文档页面的样式
  _headers        Cloudflare 静态资源的响应头
  favicon.svg
  js/
    core.js       纯逻辑：拼请求（含图片）、解析响应、处理错误（无 DOM，可在 Node 里测试）
    viz.js        概率条、刻度尺和动画
    app.js        表单、图片和页面交互
    compare.js    对比文档页面的脚本
    theme.js      页面加载前应用主题，避免闪烁
    theme-toggle.js  两个页面共用的主题切换按钮
test/
  core.test.js    core.js 的单元测试（node --test）
wrangler.jsonc    Cloudflare Workers 配置
```

## Jev 接口速查

- 地址：`POST {Base URL}/alpha/decisions`。默认 Base URL 是 `https://openrouter.ai/api`；填 `https://openrouter.ai/api/v1` 也行，页面会自动去掉 `/v1`。
- 请求头：`Authorization: Bearer <API Key>`
- 请求体：`model`、`state`（要判断的内容）、`questions`（题目）。`state` 留空时，页面会用问题本身代替。
- 带图片时 `state` 是数组：第一项是文字（或 JSON），后面每张图一个 `{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,..."}}`。图片必须是 base64 data URL（PNG / JPEG / WebP），放在数组最外层。GPT-6 Luna Decisions 每次最多 128 张图、200 道题。

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

计费只按输入 token 算，输出免费，一次纯文字调用通常不到 $0.0001；用 GPT-6 Luna Decisions 看图时，每张图另加最多约 $0.0001。
