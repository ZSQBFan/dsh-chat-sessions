# 开发 agent 执行 prompt

下面正文可整体复制给开发 agent；无需依赖前一段聊天。文档包版本：LC-20261107 / 1.0。

---

你负责在新建的 Git 分支上实现 dsh-chat-sessions 的生命周期交接，并完成真实验收。先阅读本会话实际 skill／MCP 目录，加载与代码理解、调试、测试、浏览器验收、OpenViking 和提示词等本次工作直接匹配的技能；委派子 agent 时把这一要求一并写入任务。不要凭技能名称猜其内容。日常实现选择自主推进，不把已有明确需求重新交回用户选择。

## 一、目标

插件启用时维持原有独立对话体验。用户通过原生管理器显式停用或卸载时，解除插件自有 Workspace 登记，使旧 Session 进入原生未分组；原 Session ID、历史、cwd、任务目录、文件、已有标题软链接、归档与置顶状态保持。重新安装或启用时，只对仍未分组、目录身份匹配且所有权明确的旧插件会话重新注册／关联工作区。用户在停用期间已另行收编的对象保留其新安排。

普通进程重启、普通 HMR、无关配置刷新保留原 Workspace ID；不采用“每次退出都解绑”的默认折中。共享 cwd 按房间处理。旧目录包括已归档空目录均保留，取消该范围内原来的自动目录 GC。原生未分组旧会话必须真实可继续聊天并在原 cwd 使用工具，单纯出现在列表不算完成。

## 二、必读文件与基线

请先读完这三份文档，再制定执行计划：

1. `/Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-lifecycle-spec-20261107/01-DESIGN.md`
2. `/Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-lifecycle-spec-20261107/02-ACCEPTANCE.md`
3. 本 prompt。

代码仓库：`/Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-dev`。
已核对历史基线：版本 0.1.1，main，HEAD `06d39d1a88e5833897d48606a1d3c2eff8dee0fe`，当时干净。重新读取你实际接手的分支／HEAD／改动；不得 reset 到历史 SHA。

继续阅读仓库及其上级生效的 AGENTS 指令、package.json、index.js、client.js、links.js、gc.js、README 中英文、配置文档、现有测试与打包配置。本文不要求把整个宿主源码全扫一遍。

宿主只读证据副本：
`/Users/qbfanzs/.dsh/chats/.sessions/session-d99228ff-4e4d-4fc4-bfcc-cc288e8e11f9/lifecycle-host-evidence/`。
设计文档已列出实际模块和行号。若副本已不在，从你实际目标宿主重取等价证据，并记录其版本；不修改已安装应用包。

可选历史参考：

- `viking://user/zsqbfan/resources/dsh-chat-sessions/notes/LIFECYCLE-UNGROUPED-DESIGN-20261107.md`
- `viking://user/zsqbfan/resources/dsh-chat-sessions/research/竞品同类插件-20261106.md`

以上 URI 通过 OpenViking read 读取，不当成本地文件。旧的 2026-11-04 活跃工作区保留方案已由本次设计替代。dsh-chat 的数据投影／请求 journal 可借鉴，但它自己的卸载不会自动删除全部登记，不能拿它的行为当成本次功能已成立的证明。

## 三、首先创建 Git 分支，然后在分支上开发

先执行只读检查，记录输出：

```sh
git -C /Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-dev status --short --branch
git -C /Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-dev rev-parse HEAD
git -C /Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-dev branch --show-current
git -C /Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-dev branch --list 'feat/lifecycle-ungrouped-handoff*'
```

确认目标名称未占用后，从当前已确认基线新建：

```sh
git -C /Users/qbfanzs/DSH_Common_Workplace/dsh-chat-sessions-dev switch -c feat/lifecycle-ungrouped-handoff
```

若重名，选择从未使用的新名称如 `feat/lifecycle-ungrouped-handoff-02`，不复用或重置旧分支。如果原工作树有用户改动，不丢弃、不自动 stash；必要时从当前已提交基线创建独立 worktree 和新分支，记录哪些用户未提交变更未纳入。无法分离且影响语义时明确列出冲突，继续可独立工作。

在产生第一笔源码修改前，核验当前确实是新分支。可将两份规范复制到新分支的 `docs/lifecycle/` 便于追踪，保留相互链接；未来实现有明确收敛时同步它们，保留需求不变量和变更理由。

本任务授权你在这个新分支创建本地 Git 提交，按可审查单元提交代码、测试和文档。每次显式暂存本任务文件；不使用不加区分的 git add -A；不提交用户原有改动、真实会话、fixture 数据、凭证或大体积录像。没有配置作者身份时不擅改全局配置，报告具体问题。

不推送、不合并、不打 tag、不正式发布，也不为了任务重置／清理用户工作树。保留新分支与完整提交 SHA 交付用户。

## 四、待办与执行顺序

### 阶段 0：创建可追踪计划和隔离环境

使用任务清单，记录 baseSHA、branch、工作目录、宿主版本和测试身份。所有停用／卸载、目录变更、崩溃注入只能在本任务的隔离 DSH 数据根、profile、端口和合成夹具中进行。先读实际宿主帮助确认启动／安装方法，不虚构 CLI 参数，不改生产 profile。

证据和候选包存到仓库之外的任务专用目录，记录绝对路径；不得把实际会话目录当 artifacts 清理区。

### 阶段 1：先做 G0 真实能力探针

按验收 G0-01–07 编写并执行最小探针，输出 `HOST-CAPABILITY.md`。重点：

- 原生 plugin disable、bundle disable、bundle remove 是否触发并等待异步业务交接。
- 如何可靠区分显式停用／卸载与普通退出／重载。changed 事后事件、通用 dispose、包缺失猜测不能冒充已证明的前置 hook。
- 清理失败在真实管理器中如何表现；失败是否仍继续卸载。
- 原生未分组旧 Session 是否有可用输入区、模型回合和原 cwd 工具。
- 原生并发收编／新增成员与删除、attach 之间有没有可靠条件保护。插件 mutex 只能管插件，不能锁住原生 UI。
- 无 HMR 路径的实际生效时点。

如果公开插件接口确实缺核心能力，记录 `BLOCKED_HOST_CAPABILITY` 与精确版本、调用链、复现和最小宿主能力提案。不修改 DSH 本体，不 monkey patch 宿主管理器，也不把“手动先交接”或“每次退出都解绑”当成需求完成。继续实现并验证可以独立完成的 store／状态机／恢复／保护部分，最终状态保持 PARTIAL／BLOCKED。

### 阶段 2：先定义状态与可验证的失败结果

沿用现有 ESM JavaScript 风格和 Node 内置模块。实现独立的 scope 账本、原子持久化、单 writer 锁、管理资格判断、迁移与协调器；模块可轻量拆分，不做无关重构。

对高影响行为先落能失败的有意义测试，再实现：退出写前意图、崩溃中断、同 cwd 用户登记、外来成员、部分 attach、坏账本、不误回收任务目录。不要为每个私有函数写机械镜像测试。

账本放在安装包和任务 cwd 外，身份以稳定 profile＋canonical root 为依据，不能用端口或进程启动时间代替 scope。格式与恢复语义遵循设计第 6–8、13 节。第一次升级的多证据迁移和迁移后账本丢失必须能区分；证据不足则保守冲突，不盲扫认领。

### 阶段 3：接入创建、交接、恢复和前端

新建过程先落 creation intent，再创建原生对象、flush/stat 并确认管理状态。重复请求、空白复用、启动恢复和 sweep 共用生命周期闸门与 generation。原有 ensureSessionWorkspace 不得绕开资格判断重建目录／登记。

停用：freeze 新写入口→drain 已接收插件任务→持久 DETACHING→原生条件校验→删除自有整房间登记→复读原生状态→持久 DETACHED／错误摘要。没有可靠原子条件时如实报告边界。

启用：锁和账本→先对账→检查仍未分组、路径和身份、同路径用户登记→持久 RESTORING→注册现存目录→逐个条件 attach→落结果→再开放日常维护。新启用目标已明确时，中断的 DETACHING 如仍有正确自有登记直接保留，不为了补完旧意图先删再建。

用户收编者 RELEASED；外来成员／目录异常 CONFLICT；部分成员恢复单列 PARTIAL。别把同路径 create 返回已有用户登记当本插件创建；别在恢复缺失目录时 mkdir。

取消本范围所有自动任务目录 GC，交接／恢复不改已有标题入口。前端消费明确托管集合，避免只按路径形状压平用户工作区。原生归档、置顶、菜单、排序、共享房间、动效与退出清理按回归规范保留。

### 阶段 4：候选包、真实验收和修复

新增并实现生命周期测试命令，纳入默认测试；按验收规范执行 G0、L1、L2、L3，使用原生快照和独立文件 manifest 检查，而非仅信插件 status。

新增模块进入 package files；从仓库外生成候选 tgz，记录 SHA256 并安装到隔离 profile，核对已安装构建。修复缺陷后重新提交、重打包，报告中的最终结果要对应最终 SHA 与包，保留失败证据。

文档至少更新 README 中英文、配置说明、CHANGELOG 的实际适用部分：目录保留、停用与重装、兼容宿主、scope、恢复冲突、离线路径限制、GC 行为变化。版本号和 engines 不随意扩大，不发正式版。

## 五、红线

- 不修改生产会话、Session 日志、原生存储 JSON 或应用包；不靠手工改归属制造通过。
- 不删除任何测试 Session 记录或 session-* 目录；任务完成只归档测试 Session。合成负向目录条件按验收规范保留在测试区。
- 不移动、改名、回收或覆写已有用户任务目录；交接不触发标题／.archive 移动。
- 不清空草稿、不自动发消息、不种假 turn/start、不批量 unarchive。
- 不按 root 前缀、标题或单份 .links.json 认定所有权；不接管普通工作区、子代理或用户停用期间的新安排。
- 不把 mock dispose、脚本存在、native skip、jsdom 通过或一次成功重试算完整原生验收。
- 不为了“自动卸载”偷偷改为每次普通重启重建全部工作区。
- 不把失败吞掉或将核心缺口写成轻微已知问题；已归档／空白列表过滤与真实丢数据要区分。
- 不额外做远端同步、框架重写、品牌改名、发布、生产更新或无关 GUI 优化。

## 六、复验命令

在新分支／独立 worktree 的实际仓库根目录执行，并保存命令、退出码、skip 详情：

```sh
npm run check
npm test
npm run test:native
npm pack --dry-run --json
```

新增脚本并真实执行（这些名字在历史基线尚不存在）：

```sh
npm run test:lifecycle
npm run test:lifecycle:native
npm run test:lifecycle:e2e
```

如采用等价名称，同步规范和报告并给出完整复验方式。native/e2e 必须检查目标是专用隔离实例，提供准确环境变量、fixture 初始化和实际启动／安装命令。每次查看测试正文，退出码 0 但 skip 不代表目标通过。

最终检查：

```sh
git status --short --branch
git diff --check
git log --oneline --decorate -10
git rev-parse HEAD
```

这些命令在实际开发仓库执行。打包验证须检查新模块是否全部收录、报告与候选 SHA 一致。若最终报告等文档提交不改变包内容，可记录被测构建提交与最终文档提交的关系；发生源码／打包清单变化必须重新生成候选包并复验受影响部分，不能拿旧 tgz 冒充最终源码。

## 七、交付物与最终汇报格式

交付：新分支名称、baseSHA、所有本地提交与最终完整 SHA；核心 diff 说明；实际支持矩阵和 `HOST-CAPABILITY.md`；设计／实现差异；验收 `REPORT.md`、`TRACEABILITY.md`、证据索引；候选 tgz 路径和 SHA256；完整复验命令；隔离环境和测试会话残留清单。

最终回答先写 COMPLETE／PARTIAL／BLOCKED 及具体用户行为，再写：

1. 新分支、基线与最终提交；已做本地提交，无远端发布动作。
2. 实现范围和关键设计取舍。
3. 实际执行与未执行测试，PASS/FAIL/BLOCKED/NOT_RUN/N/A 分列。
4. Session、归属、日志、任务目录、置顶／归档／草稿完整性结果。
5. 证据、候选包、复验命令的可点击路径。
6. 剩余缺口的具体宿主版本／接口／复现，下一步；不将整体受阻表述为“已全部完成”。

重要进展与最终产物按当前 OpenViking 协作规则保存至已有 dsh-chat-sessions 项目目录，读取确认；不保存密钥和无关用户文件。使用了哪些项目记录、产物存在哪，在最终回答末尾一句说明。完成时保留新分支和文件供用户审阅，不自行合并或部署。
