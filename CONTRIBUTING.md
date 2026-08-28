# 贡献指南 (Contributing)

感谢你对玄码 (XuanCode) 的兴趣。欢迎任何形式的贡献:bug 报告、功能建议、
文档改进、代码提交。

## 环境搭建

```bash
pnpm install          # 安装依赖(pnpm 9+)
pnpm test             # 运行单元测试
pnpm lint             # 代码检查
```

## 开发流程

1. Fork 本仓库并克隆到本地
2. 创建特性分支:`git checkout -b feat/your-feature`
3. 提交改动,遵循项目的提交信息风格(中文、概括改动要点)
4. 推送到你的 fork 并发起 Pull Request

## 提交规范

- 保持改动聚焦:一个 PR 解决一个问题
- 新功能附带测试;修复附带能复现问题的测试
- 提交前确保 `pnpm lint` 与 `pnpm test` 全部通过

## 行为准则

请阅读并遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可

本项目采用双许可 **Apache-2.0 OR Commercial**。除非你明确另行声明,否则
你自愿提交到本项目的内容将按 **Apache License 2.0** 授权。详见 [LICENSE](LICENSE)。
