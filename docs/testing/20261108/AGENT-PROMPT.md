# 可直接交给 DeepSeek V4.1 Flash 的独立验收 prompt

将本文件全文连同交接清单 `handoff.json` 交给新会话。若收到附有「本机执行上下文」的版本，以其中完整 SHA、候选包路径和输出目录作为已固定参数。仅阅读本文件不是验收完成。

---

你负责独立测试 `dsh-chat-sessions`，不是继续开发。持续执行下面已授权的验收，发现问题保留复现；不要只列计划或复述上轮报告。你可以编写测试脚本、创建独立 DSH 实例、安装候选包、在该隔离实例启停/卸载重装和注入故障。不要修改候选产品、提交/推送代码或操作用户日常 desktop profile。

## 一、先读、先固定身份

1. 查看本会话可用技能和工具，加载任务匹配的浏览器、调试、记忆/验收技能。OpenViking 记录只作历史背景；本轮使用真实源码、运行数据和原始日志判断。不要只靠技能摘要行事。
2. 读取交接 `handoff.json`，记录完整 candidateCommit、candidateTree、runtimeCommit、packagePath、packageSha256。程序基线为 `0847a704ba50933a7b8fa49bf13d05f1282ce482`；完整测试候选可能包含后续文档提交，必须按 manifest 固定，不能浮动跟随 main。
3. 新建唯一 RUN_ROOT，把候选 checkout 到独立 detached worktree/clone，保存原始 manifest。候选工作树始终干净；所有新增夹具、证据、报告放 RUN_ROOT。
4. 按顺序全文阅读：
   - `docs/testing/20261108/TEST-PLAN.md`（当前测试手册，逐项用例）；
   - `CHANGELOG.md` 的 Unreleased；
   - `docs/lifecycle/01-DESIGN.md` 与 `02-ACCEPTANCE.md`（R01–R18/原59项合同）；
   - `docs/lifecycle/05-REVIEW-FIXES.md`（修复背景，不当作测试结果）；
   - `package.json`、`check-lifecycle-native.mjs`、`check-lifecycle-e2e.mjs`、`test-support/native-lifecycle-harness.mjs`；
   - 需要定位时读取 `index.js`、`client.js`、`lifecycle/{store,coordinator,host-adapter,legacy,model}.js` 和对应测试。
5. 原 `docs/lifecycle/03-AGENT-PROMPT.md` 是开发交接背景，不执行其中开发、Git提交步骤。本轮测试范围由本 prompt 和 TEST-PLAN 确定。

## 二、独立执行，不把旧证据变成本轮PASS

- 第一批：候选/包逐文件校验、npm ci、npm run check、npm test、npm run test:lifecycle、npm pack --dry-run --json。预期历史基线81检查/146默认测试，但以实际日志为准；数量不符要解释。
- 第二批：最终tgz在全新DSH_HOME、明确profile、独立documentsDirectory和空闲端口上跑真宿主安装/停用/启用/remove。LC_PLUGIN_DIR指tgz绝对路径，LC_FROM_DEFAULT=1；每个首次安装测试使用新的HOME。TEST-PLAN有实际环境变量与overlay数组格式。
- 第三批：先测此次最直接回归 B05–B07（原生workspaceId、历史承载项、菜单边界）、D04–D08（旧header、首次迁移、completed后指定补接管、幂等/用户保护/写失败）。再完成所有B/C/D用例及真实GUI、模型与bash续聊。
- 第四批：E01–E12注入失败、锁/history、drain与scope；分清 L1 受控夹具和 L2 真实进程。
- 第五批：F01–F08真实SIGKILL业务恢复、10轮、50room/100Session、完整文件与日志核对、收尾。
- 按批保存进度，不等全部完成才写报告。无需我逐步确认；仅对真正缺失的外部条件记录阻塞，继续做不依赖该条件的测试。

## 三、必须记住的事实和边界

1. 单个room可有多个普通Session共享cwd；派生普通会话与子代理不同。子代理header/元数据要核实，不能仅凭UUID或“未归档”猜普通活跃成员。
2. 菜单隐藏承载项仅为展示，不扩大账本所有权；普通同名、其它root、相似路径的工作区仍显示。旧历史登记不能为了测试在用户真实环境再批量清理。
3. 停用/卸载只解除自有Workspace登记。Session ID/cwd/历史/目录/内容/软链及pin/archive要独立核对；显式交接后Workspace ID可变，普通重启/HMR应同轮保号。
4. 旧版误记migration.completed后，使用确切workspaceIds的维护入口恢复；不要清空migration、手改用户ledger或registry来伪造修复。请求格式和失败码按当前源码验证。
5. `test:lifecycle:e2e` 是服务级，无浏览器；`test:native` 是原生客户端函数VM契约。二者不证明真实GUI、输入区或模型工具回合。
6. 默认native harness主要检查sentinel。你要增加完整递归lstat/文件SHA256/空目录/软链raw target及全Session日志对比；不要只检查keep.txt或header。
7. 同路径create、conditional delete/attach的宿主原子性缺口仍可能 BLOCKED_HOST_CAPABILITY；插件mutex/多次复读不构成宿主CAS，不得通过改名/按钮/每次退出解绑绕过原合同。
8. 真强杀只针对当前RUN明确拥有的PID；先证实位于目标业务阶段再kill。SIGSTOP/恢复或mock写失败不等于真实SIGKILL恢复样本。
9. 出现凭据、登录token时不回显、不写报告；只保存脱敏日志。GUI登录/验证码由用户在隔离实例对应窗口完成；等待时继续独立测试，未完成标BLOCKED_ENV。
10. 禁止 git reset/clean/stash、force push、发布tag/Release/npm/市场、删除用户聊天、递归扫描个人目录、复制真实密钥库、在线用旧备份覆盖全部workspace/ledger。

## 四、记录和故障处理

用例表至少包含手册全部ID，逐项写 status、priority、level、expected、actual、fixture、commands、evidence、candidateCommit。只用 PASS/FAIL/BLOCKED_HOST_CAPABILITY/BLOCKED_ENV/NOT_RUN/N/A，不用skip包装PASS。

- 产品失败：保留最小可复现，不修产品，继续独立用例。
- 夹具/环境失败：先看原始错误，最多三次针对性调整；每次写清原因。三次仍未解决暂停该路径并报告，不无限循环安装、重跑全套或扩大对用户环境的修改。
- 固定一版候选完成一轮；若有外部新提交，先结束当前报告，再开新RUN。不要边测边拉最新main。
- 每一阶段检查点记录原生归属全集、Session→cwd/日志、完整任务树、pin/archive、账本阶段；插件停用后不能仅靠插件status，因为路由可能撤销。
- 所有脚本实际执行参数与cwd可复现；命令不能写成省略号；新增脚本不嵌入本机秘密。

示例：默认146项过、真宿主28项过、GUI未登录、CAS缺失，整体应 BLOCKED/PARTIAL；若发现history覆盖或终态失败仍READY，则 FAIL/PARTIAL。不要把整个LC/OW/RC/RG组批量填PASS。

## 五、交付、停止点与最终回复

在 RUN_ROOT 写并读回确认：

- `REPORT.md`：身份/环境/总体结论、逐项统计、完整用例表、P0/P1/P2缺陷、R01–R18与原59项映射、限制和未跑项；
- `REPRODUCTION.md`：每个失败的最短完整步骤、命令、独立夹具、实际/期望及证据路径；
- `cases.json`、`findings.json`（无发现写空数组）、`commands.jsonl`、`identity.json`；
- 候选逐文件比对、脱敏原始日志、前后JSON/manifest、实际GUI录屏与截图。

报告必须指向本轮真实证据。若任务用到OpenViking，按当前用户项目存放约定保存报告并读回，不反复写同一busy资源；保存失败不覆盖本地完整产物。

只有候选验收或明确阻塞报告完成后停止。最终回复给完整SHA/包SHA、整体状态、实际层级和计数、最重要缺陷/核心阻塞、报告与复现可点击路径。不要提交、修复、推送或正式发版，等主agent审阅结果。
