# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。格式基于
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

- 依赖图谱 Structure View:虚拟滚动文件树 + 知识图谱 + 内联文件预览
- 编译检查仅对代码改动触发,纯文档/配置改动跳过
- VSCode 工作区切换时同步 daemon 工作目录
- 运行时资源自动清理(SSE/定时器/watcher + alive 守卫)
- append-only 会话事件流(JSONL 六类事件 / 10MB 自动轮转 / 审计回放)

## [1.5.103] - 2026-08

### 新增
- 代码智能图谱:daemon `/daemon/code-index/graph` + Windows/POSIX 路径统一
- 可视化任务追踪系统(TaskTracker):DAG 子任务 / 工作流步骤 / 历史任务
- 循环依赖检测(Tarjan SCC)、入口/孤立文件分类、模块聚合图
- 原生 Tool Calling 富结构通道(Claude / Gemini)

### 修复
- 会话续跑、切换线程清理任务状态泄漏
- Markdown 全角缩进列表规范化 + 柔和圆点渲染
- 底部状态行常驻淡入淡出,消除布局跳动

## [1.5.102] - 2026-08

### 变更
- version.json 作为单一版本源,三端版本同步
- daemon-protocol 移入 devDependencies

## [1.5.101] - 2026-08

### 修复
- shell 验证跟踪崩溃(顶层参数)
- 底部执行状态行动态词
- 三端 ask_user 接入 + Windows shell 路由

---

更早的历史版本变更详见各端 git 历史。
