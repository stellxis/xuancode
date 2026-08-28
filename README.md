# 玄码 Code Desk · XuanCode

**一切皆五行 · 国风科技智能编码中枢 — AI Code Agent Harness**

> 太极生两仪,两仪生四象,四象生五行。玄码以五行架构为纲,以 TAOR 循环为轴,
> 打造全球领先的 AI Agent Harness 系统。

[![License](https://img.shields.io/badge/License-Apache--2.0_OR_Commercial-blue)](LICENSE)

---

## 项目定位

玄码 (XuanCode) 是对标 Claude Code,codex等主流工具的自研 AI 编码智能体,但目标并非复刻,而是**以中华文明的计算哲学为根基,构建顶级 Agent Harness 系统**。

2026 年 Agent 系统的本质——**模型能力趋同,工程架构才是护城河**。玄码融合全球各领先开发工具架构精髓,以「太极五行」为设计哲学,打造一款在架构设计上全球领先的国风科技 Code Desk。

未来，以太极阴阳五行八卦为道基，固本培元，万剑（插件）归元，打造全球第一代硅基古智慧人架构。当前已经初步具备**自追踪，自改进，自评估，自微调，自升级**五自（行业标准）运行系统，以及拟人类学习-记忆-成长特征。

### 核心设计哲学:一切皆五行，自善生命编码系统

```
        太极 (Agent Loop)
    ┌─────────────────────┐
    │  Think → Act → Observe → Repeat  │
    └─────────────────────┘
    阴阳平衡:推理(阴)与执行(阳)的动态切换
```

| 五行 | 组件 | 核心职责 |
|------|------|---------|
| **金** | Agent Orchestrator | TAOR 循环、消息路由、状态管理 |
| **木** | Tool System | 多工具注册、渐进式曝光、并发执行 |
| **水** | Context & Memory | 四级压缩管道、六层记忆架构+ |
| **火** | Permission & Security | 五档信任光谱、纵深防御体系 |
| **土** | Sub-Agent & Hooks | 多 Agent 协同、27+ 事件钩子 |

---

## 快速开始

本仓开放 **14 个核心引擎包 + `apps/cli`**：types / utils / tools / context /
telemetry / model-adapter / permission / orchestrator / code-intelligence /
daemon-protocol / database / distiller / session / subagent。

### 用 CLI 直接跑起来

```bash
# 安装依赖 (pnpm 9+ / Node.js 20+)
pnpm install

# 构建 CLI 单文件 bundle
pnpm --filter @xuancode/cli build

# 非交互模式：管道喂任务，立即执行
echo "帮我在当前目录写一个 print hello 的脚本" | node apps/cli/dist/index.js

# 交互对话模式（终端里直接输入，进入 Ink TUI）
node apps/cli/dist/index.js

# 多步骤实施计划
node apps/cli/dist/index.js plan "实现一个本地 todo 应用"

# 查看所有选项
node apps/cli/dist/index.js --help
```

CLI 默认使用 `mock` provider 演示（无外部依赖即可跑通）。接入真实模型：

```bash
# DeepSeek
export DEEPSEEK_API_KEY=你的_key

# 或 通义千问
export QWEN_API_KEY=你的_key

# 显式指定供应商
node apps/cli/dist/index.js -p deepseek
```

> `apps/cli` 为 **client-only** 形态：不内置 daemon，模型直连调用；`xuancode daemon`
> 子命令在 npm 版下优雅降级（提示需配合 Desktop / Docker 的 daemon）。connect 模式见
> [apps/cli/README.md](apps/cli/README.md)。

### 核心引擎测试

```bash
pnpm test    # vitest 464 用例
pnpm build   # tsc --noEmit 类型检查
pnpm lint    # biome 全量格式化 + lint
```

---

## 架构特点

- **TAOR Loop**:Think-Act-Observe-Repeat 核心循环
- **多步骤工作流 (Workflow)**:任务自动拆解为 plan → step_1..N → complete 状态链路,
  7 种 SSE 事件实时推送步骤进度,CLI/VSCode/桌面端统一 step card 渲染
- **Harness Engineering**:98.4% 是确定性基础设施,仅 ~1.6% 是 AI 决策逻辑
- **纵深防御**:工具预过滤 → 模式过滤 → 拒绝规则 → 分类器 → Hook → 沙箱 → 用户确认
- **四级压缩**:懒惰降级策略,逐级提升压缩成本
- **渐进式工具曝光**:核心工具始终加载,其余按需搜索
- **DAG 拓扑调度**:大任务自动拆解为 DAG(有向无环图),LLM + 启发式双引擎分解,
  按拓扑层级并行执行无依赖子任务,失败自动回退标准模式
- **文件级写排他锁**:LockManager 全局单例,agent 写入前自动检查锁,超时自动释放
- **冲突检测 + 自动合并**:写前快照→执行后对比→git merge-file 三路合并
- **模式自适应**:standard(单 Agent)/ smart(主+子 Agent)/ local(多子 Agent)自动推荐
- **可视化任务追踪系统**:右侧栏任务页一体化追踪 DAG 子任务 / 工作流步骤 / 历史任务,
  前端解析 P0/Phase/Step 步骤文本,实时状态标签 + 子任务过滤
- **轻量拓扑高阶图谱**:daemon `/daemon/code-index/graph` 输出文件/目录节点 + import 边
  (Windows/POSIX 路径统一),前端三栏联动:虚拟滚动文件树 + 知识图谱 + 内联文件预览;
  图分析层提供 Tarjan SCC 循环依赖检测、入口/孤立文件分类、模块聚合图、N 跳 BFS 邻居展开
- **运行时资源自动清理**:SSE 订阅 / 轮询定时器 / 事件监听 / 文件 watcher 在组件卸载、
  任务结束、切换线程时统一自动回收,并带 alive 守卫标志防止异步泄漏
- **append-only 会话事件流**:SessionStore 以 JSONL 逐行追加记录六类事件,
  10MB 自动轮转,只读回放(重建消息 / 审计轨迹 / 会话摘要)

---

## 与 Claude Code 的差异化优势

| 维度 | Claude Code | 玄码 (XuanCode) |
|------|-------------|----------------|
| 架构哲学 | 西方实用主义 | **太极五行阴阳平衡** |
| 子 Agent | 6 种固定类型 | **5 行定制 + 扩展** |
| 上下文压缩 | 4 级线性 | **4 级 + 太极动态平衡** |
| 权限系统 | 5 档 (无命名) | **观/问/信/任/达** |
| 终端 UI | 功能优先 | **国风美学 + 功能并重** |
| 记忆系统 | 文件索引 | **文件索引 + 自动蒸馏** |
| 插件生态 | MCP + Skills | **五行元素分类 + MCP 兼容** |
| 任务追踪 | 纯文本滚动输出 | **可视化追踪系统: DAG 拓扑分解 + 实时步骤状态 + 历史回放** |
| 代码洞察 | 无原生依赖图谱 | **轻量拓扑高阶图谱: 依赖图 + 循环依赖检测 + 入口/孤立识别** |
| 会话存储 | 轮转压缩文本 | **append-only 事件流: JSONL 逐事件落盘 + 审计回放 + 自动轮转** |
| 副作用管理 | 依赖手动清理 | **运行时资源自动清理: 订阅/定时器/watcher 自动回收 + alive 守卫** |

---

## 路线图

| 阶段 | 状态 | 内容 |
|------|------|------|
| 核心引擎 | ✅ 已开源 | TAOR 循环 + 工具系统 + 权限安全 + 上下文工程 + 模型适配 + **CLI (`apps/cli`)** |
| 高级能力 | 🔜 计划 | DAG 调度 + 文件锁 + 子 Agent + 会话/记忆 + 代码智能图谱 |
| 生态三端 | 🔜 计划 | Desktop + VSCode + 插件注册表 + 插件市场 |
| 商业闭环 | 🔜 计划 | Open Core: 企业版 = 私有部署 + 云能力 + 商业支持 |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | TypeScript (Node.js 20+) |
| 包管理 | pnpm workspaces |
| 测试 | Vitest |
| 格式化 | Biome |
| 模型 | DeepSeek / Qwen / Claude / 8+ 模型支持 |

---

## 许可

玄码采用双许可:

- **Apache License 2.0** — 默认开源许可,见 [LICENSE](LICENSE)
- **商业许可** — 托管/云服务 (SaaS)、闭源商业产品嵌入等场景需商业授权,见 [LICENSE-COMMERCIAL](LICENSE-COMMERCIAL.md)

---

## 贡献与安全

- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [行为准则](CODE_OF_CONDUCT.md)
