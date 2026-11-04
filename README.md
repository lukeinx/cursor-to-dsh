# cursor-to-dsh

[![license](https://img.shields.io/npm/l/cursor-to-dsh)](LICENSE)

> Fork: [AngusFu/cursor-to-dsh](https://github.com/AngusFu/cursor-to-dsh)（上游 [lukeinx/cursor-to-dsh](https://github.com/lukeinx/cursor-to-dsh)）。本 fork 增加：**Settings → Cursor 配置页**（多 API Key / 选用 / 经 credentials 存储）。

> Use Cursor models as the `cursor` LLM provider in DeepSeek Harness (DSH) and DeepSeek Desktop, through the official `@cursor/sdk` and your own Cursor API key. DSH keeps the agent loop, tools and permissions; Cursor is only the model. The docs are in Chinese.

把 Cursor 注册为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH，含 DeepSeek Desktop）的模型提供方 `cursor`。DSH 负责 agent 循环、工具和权限，Cursor 只当模型。

![一次带工具调用的对话：DSH 把工具交给 Cursor，Cursor 调工具时交回 DSH 执行，结果回填到同一个 Cursor run](docs/images/flow.png)

## 特点

- **官方接口**：只用 Cursor 官方 `@cursor/sdk` 和你自己的 API Key，不逆向私有协议、不读 Cursor IDE 登录态；通过 DSH 的 `ctx.llm.registerAdapter` 注册，不改宿主代码。
- **工具归 DSH**：默认关闭 Cursor 内置工具；读写文件、执行命令都由 DSH 执行，沿用沙箱和审批。
- **多 Key UI**：设置 → Cursor 添加 / 保存 / 选用 / 删除；也可用 `/cursor-key-*` 命令。
- **缓存复用**：每个 DSH 会话对应一个 Cursor agent，只发新增内容；工具结果回填到同一个 run 继续。
- **模型与用量**：模型和推理强度来自 Cursor 实时目录，始终 `fast=false`；按 DSH 互不重叠的用量桶上报，不误报超限。
- **图片**：用户消息和工具结果里的图片转给 Cursor。

## 安装

前置：DSH `0.2.0-rc.2` 及以上（DeepSeek Desktop 内置 `0.2.1-rc.2`）。

**CLI 或其他 profile**：`dsh plugin --profile <名称> add cursor-to-dsh`。

**DeepSeek Desktop**：`desktop` profile 由 Desktop 独占，`dsh plugin add` 会报 `managed exclusively by the Electron application`，需要手动改：

1. 完全退出 DeepSeek Harness Desktop。
2. 在 `~/.dsh/profiles/desktop/package.json` 里**追加**两处，已有条目不动：

   ```json
   {
     "dependencies": { "cursor-to-dsh": "github:AngusFu/cursor-to-dsh#v0.3.0" },
     "dsh": { "profile": { "bundles": ["…已有条目…", "cursor-to-dsh"] } }
   }
   ```

3. 用 Desktop 自带的 pnpm 安装，然后启动：

   ```bash
   cd ~/.dsh/profiles/desktop
   node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install
   open -a "DeepSeek Harness"
   ```

升级：改版本号后重复第 3 步。

### 填 API Key（支持多把）— 用配置页，不要手写 yaml

在 [cursor.com/dashboard](https://cursor.com/dashboard) → API Keys → New API Key 创建（个人 key 或 service account key，不支持 Team Admin key）。

**主路径：设置 → Cursor**（本插件自带页面）

1. 打开 DeepSeek Harness / Desktop → **设置 → Cursor**
2. **添加** profile（如 `work` / `personal`）
3. 在对应行粘贴 API Key → **保存 Key**（只写进 DSH credentials，界面永不回显）
4. 点 **选用** 切换当前 Key

也可用斜杠命令（非 Web 表面）：`/cursor-keys`、`/cursor-key-set <id> <key>`（不记入会话日志）、`/cursor-key-use <id>`、`/cursor-key-add`、`/cursor-key-remove`。

> 不要手改 `~/.dsh/.credentials.yaml`。配置页和命令会调用 `credentials.set`；yaml 只是底层存储。

单 profile 查找顺序：credentials → 环境变量 / launch env →（不推荐）明文 `apiKey`。

### 验证

「设置 → 模型」里出现 Cursor，模型选择里有 `cursor` 下的模型即成功。也可以把 `agent-default-model` 设为 `provider: cursor`。

### 让 Agent 代装

把下面这段发给 Claude Code、Cursor、pi 等：

```text
按 https://github.com/AngusFu/cursor-to-dsh 的 README 给我的 DeepSeek Harness Desktop 安装 cursor-to-dsh（github:AngusFu/cursor-to-dsh#v0.3.0），
遵守 README 里给 Agent 的规则；装好后告诉我把 Cursor API Key 填到哪里，key 由我自己填。
```

给 Agent 的规则：

- 改 profile 前先退出 Desktop；只追加条目，不改已有的 `dependencies` 和 `bundles`。
- key 由用户在「设置 → Cursor」填写，Agent 不读取、不打印密钥。
- 改本仓库代码前先读 [AGENTS.md](AGENTS.md)。

## 配置

默认不用配。需要时在 profile 的 `cordis.patch.yml` 覆盖插件这一行（patch 会替换整个 `config`，要写全）：

```yaml
- id: llm-cursor
  name: cursor-to-dsh
  config:
    apiKeyProfiles:
      - id: default
        label: Default
        apiKeyEnv: CURSOR_API_KEY
      - id: work
        label: Work
        apiKeyEnv: CURSOR_API_KEY_WORK
    activeKeyId: default
    apiKeyEnv: CURSOR_API_KEY
    context: min
```

| 配置项 | 默认值 | 环境变量覆盖 | 含义 |
|---|---|---|---|
| `apiKeyProfiles` | 一项 `default` | | 多把 Key 的元数据（密钥在 credentials；请用设置页维护） |
| `activeKeyId` | `default` | | 当前使用的 profile `id`（设置页「选用」） |
| `apiKeyEnv` | `CURSOR_API_KEY` | | 兼容旧版：profiles 为空时的单 key 凭据名 |
| `apiKey` | 无 | | 明文 key，不推荐 |
| `context` | `min` | `DSH_CURSOR_CONTEXT` | 上下文档位：`min`、`max` 或如 `300k`；被拒时自动降档 |
| `cwd` | 会话工作目录 | `DSH_CURSOR_CWD` | Cursor agent 的工作目录 |

其他环境变量：`DSH_CURSOR_DEBUG=1` 输出调试日志到 stderr；`DSH_CURSOR_PREWARM=0` 关闭预热（插件加载后在后台预建一次 agent，省掉 Cursor SDK 首次约 8 秒的初始化）。

## 已知限制

- 文件附件、已卸载（offloaded）或读不出的图片不转给 Cursor，只留占位说明；重放历史时只带最后一条用户消息的图片。
- 工具交接期间不报用量，上下文用量在 run 结束时更新。
- 不支持 `stop`（报 `UNSUPPORTED_OPTION`）；`temperature`、`maxTokens` 被忽略。

## 开发

```bash
npm install && npm run build   # DSH 加载的是 lib/，改源码后要重新 build 并重启 DSH
npm test                       # 假 Cursor agent 的单测
npm run check                  # 类型检查
npm run check:public           # 推 GitHub / 发 npm 前：不含内网链接和本机路径
CURSOR_API_KEY=... node --experimental-strip-types scripts/live.ts [模型 id]   # 真实 Cursor 实测
```

本地源码接入 Desktop：安装第 2 步的依赖写成 `"cursor-to-dsh": "link:<仓库绝对路径>"`。

不动 profile、在真实 DSH 里试跑一次（overlay 里的路径必须是绝对路径）：

```yaml
# /tmp/cursor-overlay.yml
- insert:
    - id: llm-cursor
      name: <仓库绝对路径>/lib/index.js
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: cursor
    model: claude-haiku-5-5
```

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
CURSOR_API_KEY=... DSH_CURSOR_DEBUG=1 "$DSH" --profile headless --patch /tmp/cursor-overlay.yml --json "Read README.md and summarize it in one line"
```

调试日志里工具结果回填那次应显示 `plan=results`，多轮对话的第二轮应显示 `plan=send`。`--patch` 挂载的插件用自己的 `@deepseek-ai/dsh-llm` 副本，错误码会变成 `UNKNOWN`，只用于试跑。

架构和约束见 [AGENTS.md](AGENTS.md)。

## 版权

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 Luke。
