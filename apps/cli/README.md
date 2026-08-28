# @xuancode/cli

玄码AI — 命令行智能编码助手 CLI（XuanCode AI Agent CLI）

CLI 支持**模型直连**（无需 daemon，适合脚本/CI）与 **daemon connect** 两种模式。

## 从本仓构建运行

```bash
pnpm install
pnpm --filter @xuancode/cli build

# 非交互：管道喂任务
echo "写一个 print hello 的脚本" | node apps/cli/dist/index.js

# 交互对话（Ink TUI）
node apps/cli/dist/index.js

# 多步骤实施计划
node apps/cli/dist/index.js plan "实现一个 todo 应用"
```

默认使用 `mock` provider 即可跑通演示；接入真实模型：

```bash
export DEEPSEEK_API_KEY=your_key        # 自动识别为 deepseek
node apps/cli/dist/index.js -p deepseek # 或显式指定
```

## npm 全局安装

```bash
npm install -g @xuancode/cli
```

## Daemon connect 模式（可选）

npm 版 CLI 为 client-only，不内置 daemon；可通过 `--connect` 连接已有的
daemon（玄码 Desktop 内置 / Docker 镜像）：

```bash
xuancode --connect                 # 默认 http://localhost:3020
xuancode --connect http://localhost:3020
```

## 协议

CLI 与 daemon 之间的 HTTP 线协议定义在 `@xuancode/daemon-protocol`，通过
`X-XC-Api-Version` header 进行版本协商；版本不兼容时会给出明确的升级提示。

## 许可证

Apache-2.0
