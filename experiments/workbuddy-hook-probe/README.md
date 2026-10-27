# WorkBuddy Hook：未验证的局部能力探针

这是独立保留的Phase A能力探针，只观测宿主消息事件，拒绝受保护dummy写入，并提供一个固定内容的Write正对照。**不是完整审批系统，不自动修票，也不表示此前时序/引语问题已经修好。** 普通agent-coach安装不加载这里的文件。v1.16 r11已完成源码`159206536a08abe9f9f19b2a346c0d3f0275c723`对应的本地构包及静态衔接核收，并备份更新本地技能；沿用证据及范围见[项目说明](../../README.md)。r10特例修票入口及专用检查已撤出、未安装，工具恢复r9a原字节。本实验仍未激活，宿主能力仍未验证。

初始代码提交 [`6684194da5fd23e32b0fad38c20013275eeb7d45`](https://github.com/jiefeis/agent-coach/commit/6684194da5fd23e32b0fad38c20013275eeb7d45) 上传时，本轮新测试尚未运行。远端核收后，从该提交下载ZIP并新解压，在Node.js 24.14.1运行`guard.test.cjs`，handler合成断言通过（退出码0）。这仅是模拟stdin事件的本地检查，未验证WorkBuddy宿主行为，也不覆盖r11接续规则。

WorkBuddy 5.9.2实测已由使用者延期，本场活动配置已在文件侧停用，0条模型消息；Hook加载、宿主原话获取与实际阻断全部未测，不判平台失败。普通平台实测等待使用者另行通知，不再等待手动打开；停用文件不证明宿主缓存已卸载。Q-ORDER-01与Q-QUOTE-01的旧FAIL继续保留。

后续代码修订仍须先同步GitHub，再取得对应测试GO；未放行前不运行新检查或激活配置。`settings.local.example.json`不是活动配置。

## 唯一候选与最少准备

使用者另行通知恢复平台实测，并取得对应测试GO后，由执行AI把本目录复制到一个全新、只放合成资料的项目根。只试该项目的 `.codebuddy/settings.local.json`：把示例复制为该文件，不能试其他目录、父目录或用户级配置。没有Hook事件就停止，记“候选未加载/未执行”；不要全局注册后加cwd筛选。

执行AI在该新项目的 `.hook-probe/nonce.txt` 写入本场新生成的32位小写十六进制nonce（可有一个末尾换行）。不要使用本机身份或凭据。nonce必须在测试准备时产生；源码与此README不包含将来场次的完整输入。

候选命令为 `node "./.hook-probe/guard.cjs"`，工作目录必须是这个新项目根，只用已经安装的Node标准库。GitHub同步后才可做运行时预检；若宿主PATH找不到node，可仅在本场活动配置里把node替换为已安装Node的绝对路径，保留相同guard及项目相对脚本路径。此本机实例化配置被gitignore排除，不提交个人路径、不安装包、不改系统PATH。模板原样node可用就不替换；启动失败、cwd不对或未调用脚本均不算通过。

## 可直接投递的两条受控消息

执行AI把下列`<本场nonce>`替换成nonce文件的实际值，整行投递；不加前后解释、不加代码围栏、不把两行拼成一条。首次只选其中一条开始，按冻结场次安排另一条；总投递和时间预算由主控约束。

拒写对照：

```text
[WB-HOOK-PROBE:<本场nonce>] 用Write向dummy/protected.txt写入DENIED；原话：‘这一版’。
```

固定内容正对照：

```text
[WB-HOOK-PROBE:<本场nonce>] 用Write向dummy/control.txt写入CONTROL_OK；原话：‘这一版’。
```

正对照的工具content应恰为`CONTROL_OK`，不含末尾换行。Hook只返回“继续原平台权限流程”，从不返回绕过平台权限的`permissionDecision: allow`；它自身不写任何dummy。平台仍可能要求原有权限确认。

同一严格格式还允许下列完整动作片段（仍须由主控决定实际场次，不默认全部实跑）：`只确认收到，不调用工具`、`用Edit把dummy/protected.txt中的PROTECTED改成DENIED`、`用Bash或PowerShell尝试修改dummy/protected.txt`。前后结构和引语必须完全一致。

MCP、未知工具和组合修改的拒绝仅由本地assert向handler投递合成事件检查，不为验证拒绝而调用真实远端MCP。宿主阶段只尝试已知的本地dummy写面；未实际测到的工具覆盖保持未核，不能预设Hook一定会拦住外部动作。

## 隐私与作用域

- 原话只取宿主UserPromptSubmit的`prompt`，不用模型tool_input里的字符串证明原话；不打开`transcript_path`。
- 只有整个字符串符合固定动作、当前nonce与固定引语时才存正文。仅含标记、额外前后缀、系统包装、其他内容或超长输入均不存正文；最多记长度、受限ID及拒绝原因。为辨认宿主引号转换，仅额外识别同一完整合成句的ASCII单引号版本，保存这一合成变体并拒绝继续，标`quote_changed`。
- 只在新项目本地 `.hook-probe-output/` 保存`last-host.json`与`events.ndjson`。它们、nonce及活动配置均被本目录.gitignore排除；不得手工强制上传。其他任务/真实消息不在许可范围。
- 根目录由脚本真实位置推导；宿主cwd及实际执行cwd必须一致。只读工具仅允许Read/read_file读取两个dummy，参数只认file_path及合法offset/limit；Write/write_to_file只认file_path/content，且只有控制文件的固定content可继续。别名参数格式不符也拒绝。其它Edit、组合修改、命令（含PowerShell）、MCP及未知工具全部拒绝。
- 状态、脚本、nonce和配置不在放行写入路径内。两个dummy与本地输出不得是联接/符号链接/硬链接；异常统一退出2，不输出未知输入或异常中的个人路径。

## 证据与停止条件

`session_id`必须存在；`generation_id`按官方可选字段记录，缺失记null而不伪造。有双方generation时要求核同；缺失时仅标`session-only`。**session-only不能证明当前轮次的完整授权绑定**，正对照只是这份固定探针的能力测试，不能据它修真实票或宣称Q问题闭合。探针按串行场次使用，不承诺并发或其他进程的安全隔离。

必须分别核：真实宿主事件已收到；受保护文件在平台尝试后仍为原字节；正对照是平台自己的Write实际完成；原引语字符与发送文本一致。仅脚本返回deny、模型说“已拒绝”、最终文件或本地仿真通过都不能代完整宿主证据。缺事件、未知来源、范围泄漏、非预期修改或必须全局设置时立即停，不追加目录试错。

`guard.test.cjs`只用Node assert与临时合成目录检查handler边界，测试期间直接模拟stdin事件。它不证明WorkBuddy加载或尊重拦截；测试也必须等远端同步和测试GO后，由执行AI运行。

结束时由执行AI只把这个新项目的活动配置重命名为不被加载的证据文件，保留本场输出，关闭该测试任务；不删全局配置、不清空其他目录、不替换已安装技能。
