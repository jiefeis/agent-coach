# Agent 搭建教练

**v1.13 试用版，仍以 `agent-coach` 技能使用。**

[下载完整技能包](https://raw.githubusercontent.com/jiefeis/agent-coach/main/releases/v1.13/agent-coach-v1.13-20261112.zip) · [SHA-256 校验清单](https://raw.githubusercontent.com/jiefeis/agent-coach/main/releases/v1.13/SHA256SUMS.txt)

## v1.13 升级亮点

在完整保留「五站空间骨架」与 `coach-check.mjs` 全部静态断言的前提下，大幅砍掉站内重复问答，并强化了后期的文件定位能力：

1. **站内提速（砍掉假摩擦）**：第 1 站合并立项三问；取消强制转 CSV 限制，支持 `.xlsx` / `.pptx` / `.docx` 原件直接入库；第 2 站新增“半成品 SOP 去噪清洗”并改为一屏带默认推荐项的确认清单；第 3 站以 `run-flow.md` 为单表驱动，反例允许自动构造；第 4 站由 AI 预填预期校验值。
2. **第 4 站双档位**：默认**教学档**（逐票出【文件定位卡】并核对一次）；教练或熟手可在核对本批票号、版本和预期值后说 **`按快跑档推进`**，让 `AI照规矩` 纯脚本票自检全绿后自动连跑，仅在报错、主观判断、人工核对或高危步停下。
3. **四重文件定位锁（防黑盒）**：物理保持一步一脚本一中间文件；每步必出【文件定位卡】；`README.md` 内置《按症状查文件速查表》；生成项目的 `AGENTS.md` 内置 **`帮我查哪步错了`** 自诊口令。

## 安装与使用

1. 在 WorkBuddy 的技能管理中选择“添加技能 → 上传技能”，上传下载的原 ZIP，不用重新打包。
2. 打开自己的项目文件夹，使用新版 **Agent** 模式（旧版对应“做一做 / Craft”），在技能选择器中选 `agent-coach`。
3. 常用指令：
   - 新建项目：`调用 agent-coach，带我开始新项目。`
   - 体检项目：`调用 agent-coach，体检当前项目，先不修复。`
   - 已有修改：`同步改动`

本仓库采用 [MIT License](LICENSE)。
