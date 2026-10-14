# Agent 搭建教练

**v1.12 试用版，仍以 `agent-coach` 技能使用。**

[下载完整技能包](https://raw.githubusercontent.com/jiefeis/agent-coach/main/releases/v1.12/agent-coach-v1.12-20261009.zip) · [SHA-256 校验清单](https://raw.githubusercontent.com/jiefeis/agent-coach/main/releases/v1.12/SHA256SUMS.txt)

## 安装与使用

1. 在 WorkBuddy 的技能管理中选择“添加技能 → 上传技能”，上传下载的原 ZIP，不用重新打包。
2. 打开自己的项目文件夹，使用新版 **Agent** 模式；旧版对应“做一做 / Craft”。在技能选择器中选 `agent-coach`。
3. 输入一句：

> 调用 agent-coach，体检当前项目，先不修复。

看完报告，想修哪项再说“修复 P01”，按教练提示确认范围。权限弹窗出现时，先核对项目和报告路径，再按需授权。

新项目可说“调用 agent-coach，带我开始新项目。”；已有批准的改动需要对齐文件时说“同步改动”。项目文件放在自己的工作目录，技能文件夹只放技能。

## 这一版

支持在当前项目体检、按问题编号授权修复、复诊后返回原任务；保留新做 / SOP 的五站引导和“同步改动”。当前面向 Windows，需可用 Node.js 22 或 24（WorkBuddy 自带运行环境）。

只想体验第1站，可下载[首站包](https://raw.githubusercontent.com/jiefeis/agent-coach/main/releases/v1.12/agent-coach-v1.12-20261009-stage1.zip)；完整体检与修复请用完整包。两个下载文件均为已验收原 ZIP。

## 试用范围

已完成 Node.js 22 / 24 各185项机器回归，以及完整包、首站包的 L0 检查。

模型体检仍可能漏项或提出额外任务建议，请核对报告证据后再批准修复；WorkBuddy/豆包本版本完整实测及 L3 真人验收未完成。机器通过不代表所有模型和平台场景通过。

本仓库采用 [MIT License](LICENSE)。
