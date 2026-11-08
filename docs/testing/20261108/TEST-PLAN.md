# dsh-chat-sessions：独立验收执行手册（2026-11-08）

本手册用于另一会话的 DeepSeek V4.1 Flash 独立验收。目标是发现实际缺陷、补齐证据并输出可复现报告。允许在独立运行目录编写测试夹具，不修改候选程序，不操作用户日常 desktop profile，不发布版本。

配套：[执行 prompt](./AGENT-PROMPT.md)。产品合同：[生命周期设计](../../lifecycle/01-DESIGN.md)、[原验收规范](../../lifecycle/02-ACCEPTANCE.md)。本手册细化执行方式，原 R01–R18 合同继续有效；旧开发 prompt 的开发/提交步骤不属于本次验收任务。

## 1. 固定候选，先看清这一轮测什么

- 仓库：<https://github.com/ZSQBFan/dsh-chat-sessions>，目标分支 `main`，包版本仍 `0.1.1`，Unreleased 尚未发版。
- 本轮程序基线：`0847a70`（接手时取 manifest 中的完整 `runtimeCommit`）。其后可有变更记录/测试文档提交，准确候选以交接方提供的 `handoff.json` 中 `candidateCommit`、`candidateTree`、`packageSha256` 为准。
- 不能用同名 `0.1.1.tgz` 或当前桌面「已安装」作为身份凭据。旧版 Release 0.1.1 与本次 main 的程序不同。
- manifest 在仓库外，避免文档记录自身提交 SHA 的循环。运行开始保存一份原始 manifest；候选变更时开新 RUN，不拼接前后两版结果。
- 交接前历史基线：默认检查 81、默认测试 146；原生服务断言 28、旧数据交接断言 18。它们是上一轮实测参考，独立 agent 必须重跑并引用自己的日志。默认测试数不包含独立 GUI 验收。
- 当前已知宿主缺少原子条件 delete/attach/create。尤其「用户恰好在复读后、创建前登记同路径工作区」窗口，插件 mutex 不等于宿主 CAS。保留 `BLOCKED_HOST_CAPABILITY`，不得写成已解决。

### 1.1 每个结果采用相同状态

| 状态 | 条件 |
|---|---|
| PASS | 实际执行，断言与该项层级匹配，有可定位证据 |
| FAIL | 预期与实际不符，有最小复现及前后状态 |
| BLOCKED_HOST_CAPABILITY | 已核实宿主缺少该项所需能力，有宿主版本和接口证据 |
| BLOCKED_ENV | 环境/登录/模型服务/原生模块等条件不足，记录精确错误与已尝试办法 |
| NOT_RUN | 尚未执行，不能用旧截图、源码阅读、skip 代替 |
| N/A | 合同允许该平台不适用，给具体原因；核心项不借 N/A 绕过 |

证据层级：L0 静态；L1 受控 host/store、真实临时文件系统；L2 真 DSH、真 registry/plugin manager；L3 浏览器真实交互与模型/工具回合。高层测试不自动覆盖所有低层故障点，VM 渲染不算 L3。

整体结论：有产品 FAIL → `FAIL`；无 FAIL 但核心有 BLOCKED/NOT_RUN → `BLOCKED`；所有核心均满足才 `PASS`。另记进度 `COMPLETE/PARTIAL`。一次套件通过不得将整组未跑用例补成 PASS。

## 2. 工作目录、候选副本和运行记录

在用户指定的工作区之外另建唯一 `RUN_ROOT`；可放其项目验收目录中，但不能置于用户 `.dsh/chats`、真实 `.dsh/storages` 或候选源码中。下例的路径由执行者填入已确认的绝对路径：

```bash
export REPO_URL=https://github.com/ZSQBFan/dsh-chat-sessions.git
export RUN_ROOT=/absolute/path/flash-uat-YYYYMMDD-HHMMSS
export CANDIDATE_SHA=FULL_SHA_FROM_HANDOFF_JSON
mkdir -p "$RUN_ROOT/logs" "$RUN_ROOT/evidence" "$RUN_ROOT/artifacts"
git clone "$REPO_URL" "$RUN_ROOT/source"
git -C "$RUN_ROOT/source" checkout --detach "$CANDIDATE_SHA"
git -C "$RUN_ROOT/source" rev-parse HEAD
git -C "$RUN_ROOT/source" rev-parse 'HEAD^{tree}'
git -C "$RUN_ROOT/source" status --porcelain
```

直接从现有本地仓库创建 detached worktree 也可，先确认候选 SHA 可达、目录不存在。所有命令显式使用 cwd；不要照抄旧运行目录覆盖证据。保存 `commands.jsonl`，每条记录 `time,cwd,argv或完整command,envNames,start/end,exitCode,stdoutPath,stderrPath`。环境变量只记录非秘密配置；token/password/API key 不进入报告、终端回显和 Git。

推荐目录：

```text
RUN_ROOT/
  handoff.json                 # 原始交接清单
  source/                      # 固定 SHA 的候选副本
  artifacts/                   # 原始候选 tgz + 校验结果
  logs/                        # 每个命令独立日志
  homes/<case-id>/              # 每个破坏性用例独立 DSH_HOME
  fixtures/                    # 受控测试文件和故障注入夹具
  evidence/<case-id>/           # before/after、截图、视频、JSON
  commands.jsonl
  cases.json                   # 所有用例逐项结果
  REPORT.md
  REPRODUCTION.md
  findings.json
```

候选 source 保持干净；测试扩展放 `fixtures/`，导入候选模块或从候选 harness 复制并保存 diff。禁止改候选源码后继续把结果归于原 SHA。允许 wrapper 注入 fs 错误/暂停点，报告必须标 L1 和注入位置；真实崩溃项仍须 L2 独立完成。

### 2.1 固定包与源码关系

1. 校验交付 tgz 的 SHA256，保留原包只读副本。
2. `npm pack --dry-run --json` 记录实际文件集合。重新打包仅做源码对应验证，不能用新包覆盖交付包。
3. 用 Python `tarfile` 读取包：拒绝绝对路径或 `..` 越界项；去除 `package/` 前缀，对每个常规文件按字节比较候选 `git show SHA:path`。记录缺失/额外/不同内容，不能只比 `index.js`。
4. 原生安装参数 `LC_PLUGIN_DIR` 必须指原始 tgz 的绝对路径。安装后核对实际入口文件哈希；默认工作树安装不证明最终 tgz。
5. 记录宿主版本、OS/架构、Node/Electron/npm、profile、入口和实际加载路径。Node 22 为当前 CI 基线，真实宿主曾验证 DSH 0.2.2-rc.1；不要把 engines 范围当作全版本实测。

## 3. 先跑已有测试，再补独立案例

在 `RUN_ROOT/source` 中顺序执行，逐条保存真实退出码。通过后不要无理由重复全套。

```bash
npm ci
npm run check
npm test
npm run test:lifecycle
npm pack --dry-run --json
```

- `test:lifecycle` 是默认测试的子集，用于定位；它没有额外证明真实宿主。
- `test:native` 使用宿主客户端 bundle 的函数 + VM，是契约测试。设置 `DSH_NATIVE_WORKSPACE_CLIENT` 指向能被当前 Node 读取的原生 client.js 后运行。macOS `app.asar/...` 通常不是系统文件目录，普通 Node 的 readFile 可能报 ENOTDIR；可用 Electron 的 Node 模式读取到 RUN_ROOT 分析副本，记录原包和提取文件 SHA，不安装替代宿主或修改 app.asar。
- `test:lifecycle:native` 与 `test:lifecycle:e2e` 都调用真宿主服务 harness；e2e 不开浏览器，原脚本仅检查 sentinel 和 nested，不替代完整文件树检查。

### 3.1 macOS 真宿主示例

先读 `check-lifecycle-native.mjs` 与 `test-support/native-lifecycle-harness.mjs`，确认版本接口和 profile 作用域。`LC_PATCH` 是原 harness 叠加的配置文件；创建它后再启动。

```yaml
# RUN_ROOT/isolation.yml；DSH 0.2.2-rc.1 已验证的 patch 数组格式
- id: workspace-controller
  config:
    documentsDirectory: /absolute/path/THIS_RUN/documents
- id: desktop-product-telemetry
  disabled: true
- id: plugin-manager
  config:
    pnpmCommand: /absolute/path/to/pnpm
```

先将 documentsDirectory 替换为本 RUN 下的绝对路径，pnpmCommand 替换为已验证存在的可执行文件；不要保留占位值启动。其它宿主版本先核对 schema，若不符只修本 RUN overlay 并保留错误，不改候选代码。

```bash
export LC_DSH_APP='/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
export LC_DSH_MODULES='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/'
export LC_PLUGIN_DIR=/absolute/path/to/frozen-candidate.tgz
export LC_PATCH="$RUN_ROOT/isolation.yml"
export LC_NATIVE_HOME="$RUN_ROOT/homes/native"
export LC_NATIVE_PORT=62541
export LC_FROM_DEFAULT=1
export LC_NATIVE_REMOVE=1
npm run test:lifecycle:native
# e2e 必须新 HOME、新空闲端口，不能复用首次安装后的状态：
export LC_NATIVE_HOME="$RUN_ROOT/homes/service-e2e"
export LC_NATIVE_PORT=62542
npm run test:lifecycle:e2e
```

启动前检查端口占用和 paths；绝不终止未知 PID。只关闭当前 RUN 启动且拥有的实例。`LC_NATIVE_ALLOW_SKIP=1` 不用于验收。必要时为进程设置合理超时，超时标 FAIL/BLOCKED 并保留输出，不记通过。原生结果应保留 `@@NATIVE@@` payload 与 `native-lifecycle.jsonl`，区分 Node 顶层 1 个 test 与内部断言总数。

### 3.2 GUI 和模型前置

用本 RUN 的独立 profile/HOME 启动可访问 GUI，保留 URL、PID、profile 与候选身份。浏览器复用 agent default 空间，不连接用户 desktop 数据实例。登录/CAPTCHA 由用户在对应窗口完成；等待期间继续无依赖测试，超时记录具体阻塞，不改用伪造响应宣称模型回合完成。需要模型凭据时使用该隔离实例的正式登录或用户提供的受限配置；不复制用户密钥库。

## 4. 每个生命周期检查点都拍同一套状态

检查点至少包含：安装前、READY、新建后、停用前、停用后、启用后、恢复后、普通重启后、bundle 卸载后、重装后。

- **原生归属全集**：从真实 registry/原生 API 获取全部 Workspace ID/path/sessionIds/title，独立计算某 Session 被哪些工作区认领。停用后插件 route 消失正常，不能继续依赖 `/chat-sessions/status` 判断成功。
- **Session 全集**：ID、header.cwd、origin/subagent 标记、日志物理路径、size、SHA256；只读 header 不算历史全文校验。非运行会话日志前后逐字节相同；主动聊天的日志仅允许该会话自然追加，分别保存消息前、消息后基线。压缩日志有重写则解码比较既有事件前缀并说明，不能忽略任意变化。
- **任务文件树**：对测试 root 递归 `lstat`，保存相对路径、类型、mode、文件 size/SHA256、空目录、软链接 raw target；不跟随链接，dangling link 也记录。任务目录 dev/ino 另存以检查替换；不以 mtime 单独判内容变化，不要求正常写入后的 mtime 不变。
- **用户状态**：pin/archive 全集、当前会话、未发送草稿文本及光标、折叠/树形/搜索/悬停状态。草稿只存在前端，不能用服务日志为空推断它不存在。
- **账本**：只读保存当前 scope 的 ledger/marker/history/lock 及 scope 计算依据；history 故障案例保留 prepared/committed 顺序。测试自己的状态可完整保存，秘密字段脱敏。
- **文件入口**：标题软链、`.archive`、`.links.json` 与真实目录分别核对；解除 Workspace 登记不等于删除文件或自动移动入口。

做一个统一快照 helper，输出排序稳定的 JSON 和差异报告。初始测试 room 内放：`keep.txt`、中文与空格名、二进制、嵌套目录、显式空目录、相对 link、dangling link。每个案例写独特 nonce，防止误用旧数据。

## 5. 核心用例逐项执行

所有案例都必须进入 cases.json；一项多分支只跑一半记 PARTIAL 到 actual，状态不填 PASS。优先 P0/P1；P2 仍要求有结论。下列缩写 B/A 分别指本节第4节定义的操作前/后快照。

### A. 候选、能力和已有套件

**A01 · P0 · L0/L1 · 候选不可漂移**
步骤：比对 manifest 的 commit/tree/tgz SHA；候选源码 status 干净；保存安装入口 hashes。断言：每项一致；有差异即停用该候选结果，建立新 RUN。证据：identity.json、tar-diff.json、git-status.txt。

**A02 · P0 · L1 · 干净依赖与默认套件**
步骤：新副本 npm ci→check→test，记录依赖锁文件哈希；不使用 desktop node_modules。断言：退出0、无 skip/取消/未捕获异常；实际计数说明与146基线的差异。证据：3份日志及测试摘要。

**A03 · P1 · L1/L2 · 原生客户端契约**
步骤：提取/定位该版本原生 client bundle 后跑 test:native；记录函数是否存在。断言：成功只计契约层；因宿主符号变动失败记录为兼容性问题，不能改测试放宽后记原套PASS。证据：bundle SHA、日志。

**A04 · P0 · L2 · 原生服务包安装链**
步骤：用最终 tgz 在新 HOME 跑 lifecycle:native（含 REMOVE），另新 HOME 跑 service-e2e。断言：28断言参考值与实际核对、无失败；保存每项 name/pass；不把它们标 GUI。证据：payload、入口哈希、独立前后状态。

**A05 · P0 · L2 · 宿主交接钩子能力**
步骤：分别单插件 disable、bundle disable、remove bundle，观察异步 disposer 是否等待、依赖是否仍可用、错误是否可见；另做无 HMR 环境。断言：真实能力逐项描述；restart-required 不计即时交接PASS。证据：事件时间线、manager返回值、宿主版本。

**A06 · P0 · L2 · 宿主条件操作门槛**
步骤：审查真实registry接口，暂停插件确认之后，在原生API插入用户同cwd登记/改成员，再释放。断言：若没有跨原生操作的条件提交能力，记 BLOCKED_HOST_CAPABILITY；不能用插件自有mutex或一次无竞争成功当证明。证据：确切竞态点、两个原生快照、API限制。

### B. 新建、空白、文件和侧栏

**B01 · P0 · L3 · 不选项目即可聊天**
步骤：新profile点击独立对话，发送带nonce消息，要求bash输出pwd并写本room keep.txt。断言：原生会话能发起模型/工具回合，cwd为新room目录，文件可读；不是仅能点击进入。证据：短视频、消息/工具事件、header与文件。

**B02 · P1 · L2/L3 · 空白复用及并发**
步骤：连续点击新建10次并并发发10个 {reuseBlank:true} 请求，再对非空白会话新建。断言：同一空白复用请求合并，无重复空壳；非空白不被覆盖；Session/room数量可解释。证据：请求/响应ID、registry/ledger差异。

**B03 · P0 · L3 · 未发送草稿超过90秒**
步骤：输入独特草稿不发送，等至少120秒并跨2轮维护；切换/回来，再停用与启用。断言：不自动归档、不跳回工作区选择，草稿可核对；若宿主自身卸载前端导致丢草稿需如实FAIL或明确宿主证据。证据：带时间视频、草稿和archive全集。

**B04 · P1 · L2/L3 · 共享目录普通派生**
步骤：同Workspace新建普通派生Session，另建一个独立room。断言：前两者共享cwd，第三者不同；标题改名不移动实际目录；共享room一次交接所有合格普通成员。证据：3份header、room成员与文件树。

**B05 · P1 · L1/L3 · 菜单原生ID与兼容ID**
步骤：L1用真实组件分别传workspaceId/id摘要；L3打开选择器，含当前managed及旧承载项。断言：承载文件夹不逐条出现，只一个独立对话动作；普通workspace保留。证据：渲染行ID和菜单完整截图。

**B06 · P1 · L1/L3 · 旧登记434+大量同名菜单**
步骤：隔离registry造435个有明确本root receipt路径的历史项，其中1managed；另造3普通项；打开菜单。断言：一个独立动作、3普通项、0 receipt文件夹；过滤只改变展示，registry仍435条，不能暗删。证据：前后registry hash、菜单枚举/视频。

**B07 · P1 · L1/L3 · 过滤边界**
步骤：加入普通同名「独立对话」、其它root下session路径、`.sessions-extra`、相似路径与无path项。断言：这些普通项仍可选；picker分类不把它们加入managed，归档投影不扩张所有权。证据：参数、行ID、managed集合。

**B08 · P1 · L3 · 置顶、普通排序与共享兄弟**
步骤：准备活动时间不同的3会话，只置顶共享room中的一个，更新另一会话活动。断言：仅对应Session置顶，未置顶兄弟不随room整体抬升；菜单/标题/排序一致。证据：pin全集、排序前后视频。

**B09 · P1 · L3 · 归档空白与恢复**
步骤：原生归档非当前空白会话，切到仅归档/显示全部列表，刷新后单项恢复。断言：能发现、恢复、打开；日志/header及任务文件不被伪造，隐藏空白过滤仍符合原生规则。证据：3种过滤截图、archive差异。

**B10 · P1 · L1/L3 · 子代理不阻止标题归档**
步骤：owner已归档，同cwd仅未归档子代理；触发维护。再加普通未归档兄弟做对照。断言：仅子代理时旧标题入口归档；存在普通可见兄弟时保留活动入口；子代理不加入managed。证据：header来源、链接 raw target、ledger。

**B11 · P1 · L3 · 侧栏动效与输入锚点**
步骤：置顶/取消、活动排序、折叠/展开、tree/list切换、搜索、hover与键盘导航；录制实际位移。断言：无残影/跳回/重复行、hover不锚到旧位置、点击命中对应Session；reduced-motion下不强行动画。证据：视频与DOM行ID。

**B12 · P1 · L2 · 保留所有任务目录**
步骤：空白/非空白、已归档/未归档四类目录，包含空目录；普通启动、维护多轮和启用。断言：不自动GC、目录dev/ino与文件内容保留；不把有历史引用空目录当孤儿删掉。证据：完整B/A manifest。

### C. 停用、重启、卸载与恢复

**C01 · P0 · L2/L3 · 单插件停用**
步骤：2room、共享普通成员、pin/archive各一项，原生插件页停用。断言：仅自有登记消失，普通workspace不变；会话无原生claim；Session/cwd/日志/任务树/pin/archive保留。证据：manager结果、原生归属B/A、GUI未分组。

**C02 · P0 · L3 · 未分组继续模型与bash**
步骤：C01后打开有历史会话，发送新nonce消息，bash检查pwd并写after.txt。断言：真实模型回合和工具执行成功，仍原cwd，旧文件不变；日志仅自然追加。证据：视频、模型/工具事件与文件哈希。

**C03 · P1 · L3 · 空白脱管输入区**
步骤：未发消息的空白会话停用，分别打开hero和原会话。断言：直接记录composer状态及继续路径；若禁用且无原生续聊能力，R18该分支不能PASS。证据：页面截图、原生归属与route。

**C04 · P0 · L2/L3 · 重新启用**
步骤：C01后不做用户归属变动直接enable。断言：恢复同Session/cwd/room成员，只WorkspaceID可因显式交接改变；无重复空壳、pin/archive不批量重置。证据：ledger阶段、原生快照、UI。

**C05 · P0 · L2 · bundle停用**
步骤：在独立home重复C01/C04但由bundle入口触发。断言：实际bundle作用范围明确，不只点单插件；异步交接完成后返回。证据：native manager方法/返回、B/A。

**C06 · P0 · L2/L3 · 真卸载后重装**
步骤：removeBundle候选，确认依赖来源消失和UI撤下；同tgz重装。断言：卸载不删日志/任务；账本在安装目录外且仍在；重装只恢复合格成员。证据：安装依赖/实际模块路径、registry和全树。

**C07 · P0 · L2/L3 · 普通进程重启保号**
步骤：同轮保存所有managed Workspace IDs，正常关闭本RUN宿主，原HOME启动同版本同包。断言：IDs逐个相同；不要拿另一轮启用后的ID作重启前基线。证据：同一run前后JSON、PID/boot事件。

**C08 · P1 · L2 · 实际HMR及无关刷新**
步骤：在允许HMR的隔离实例触发确实产生reload的宿主操作，再做无关配置变化。断言：不是空reconcile调用；managed IDs与成员稳定，没被当PLUGIN_DISABLE解绑。证据：真实reload事件、B/A。环境不支持即BLOCKED_ENV。

**C09 · P1 · L2 · 无HMR/离线删包**
步骤：宿主运行时无HMR触发停用，另正常停机后在一次性home移走安装包再启动。断言：restart-required/离线无hook如实报告，不凭包文件消失声称已交接；任务原样。证据：manager状态、启动日志。

**C10 · P1 · L2 · 快速反向操作与新建并发**
步骤：new请求进入后并发disable→enable，另轮disable→remove，循环10次。断言：冻结后无晚建/晚写，最终状态符合最后明确用户意图；无重复登记、永久frozen或挂起。证据：操作顺序/时间、generation、每轮对象计数。

**C11 · P1 · L2/L3 · 运行中Agent交接**
步骤：隔离会话运行有进度且可终止的10秒工具，开始后disable，结束后enable。断言：不丢既有事件、不改cwd、不串到其它任务；是否等待、继续或中止按真实宿主行为记录。证据：工具进度和交接时间线，不终止测试实例外进程。

### D. 用户所有权与旧数据迁移

**D01 · P0 · L2 · 用户同cwd登记优先**
步骤：托管room停用；用户通过原生registry为原cwd建普通Workspace，再enable。断言：插件不把Session塞入用户登记，不改title，room RELEASED/USER_CLAIMED；文件不变。证据：用户Workspace前后逐字段JSON。

**D02 · P0 · L2 · 用户收编部分成员**
步骤：共享room停用后，将一个成员认领到用户工作区，另一个保持未分组。断言：只恢复剩余合格成员；released成员不出现在managedSessionIds且后续sweep不夺回。证据：所有Workspace claim全集、PARTIAL/RELEASED资格。

**D03 · P0 · L1/L2 · 子代理与外来成员**
步骤：同cwd普通derived、origin subagent、parent/delegation标记、cwd不同成员分别加入；交接前最后一次确认时再加入普通成员。断言：子代理excluded；合格新增普通成员先落账再交接；真正外来成员保守冲突，不按同名或路径形状乱收。证据：header与最后确认快照/账本。

**D04 · P0 · L2 · 首次旧数据自动迁移**
步骤：全新scope，安装候选前由真实sessionController和registry造旧room、日志、标题链接；stat.header不带type。然后装候选。断言：合法version/id/cwd归一化，三证据一致房间入账；子代理不纳管；不能用现成已迁移HOME。证据：安装前原始header、首启ledger与adopted计数。

**D05 · P0 · L2 · completed后显式补接管**
步骤：D04完成后再造late旧room；POST /chat-sessions/lifecycle/recover-legacy，body为 {"workspaceIds":["确切late ID"]}；停用/启用。断言：只指定合格房间入账、普通成员交接恢复、原目录不动；不清全migration标记。证据：请求/响应、lastRecovery、B/A。

**D06 · P0 · L1/L2 · 补接管资格与幂等**
步骤：重复D05；分别请求RELEASED/CONFLICT房间、普通其它路径Workspace、伪造同名但无header的目录。断言：不重新夺回/盲目认领，无重复room；无无关原生变化。证据：ledger及registry逐字段diff。

**D07 · P1 · L1/L2 · 补接管输入/写失败**
步骤：body缺字段、空数组、超过100ID、非字符串、未知ID；对有效请求在账本update注入ENOSPC。断言：坏请求400；有效但写失败blocked/DEGRADED（HTTP按实际handler409）；不改原生登记和任务文件，不伪报adopted。证据：完整请求与脱敏响应、文件diff。

**D08 · P0 · L1/L2 · 迁移复读保护**
步骤：审计后、写账本前分别改成员、换目录dev/ino、删owner、换cwd/claim；另scope放同路径证据。断言：冲突不认领；所有权多证据重新核对；其它profile/root不污染当前。证据：暂停点、B/A、理由码。

**D09 · P1 · L1/L2 · root软链与目录替换**
步骤：配置root经祖先symlink、未来创建的缺失尾部；同真实目录两种拼写。停用后将房间目录移到fixture并建新inode同路径目录。断言：前者scope一致，后者身份变更保守冲突，不在新目录上恢复原任务。证据：canonical paths/dev/ino/scope。

### E. 账本、history与失败必须收口

**E01 · P0 · L1/L2 · beginCreate持久化失败**
步骤：原生对象创建前注入ENOSPC/EACCES各一次。断言：HTTP503/LIFECYCLE_LEDGER_UNAVAILABLE、DEGRADED，native Workspace/Session新增0、后续维护停写。证据：write暂停/错误、HTTP和集合diff。

**E02 · P0 · L1/L2 · finishCreate失败后对账**
步骤：原生对象已建、finishCreate写失败；清故障重启，再disable。断言：原请求不假200；PENDING能按原生证据ADOPTED后交接，无无账本空壳；子代理不因对账混入。证据：意图阶段、原生IDs、重启与停用快照。

**E03 · P0 · L1 · restore两次关键写故障**
步骤：分别在RESTORING意图落盘前、创建后实际WorkspaceID记录、最终终态写时注入错误；准备两个待恢复房间。断言：第一点无原生创建；后两点阻断READY、记住已建ID；首房间失败后第二房间不继续写；随后disable能清理RESTORING登记。证据：create/attach调用计数与ledger。

**E04 · P0 · L1/L2 · history提交选择**
步骤：同generation不同revision、同revision不同generation，插入有效committed记录后重新open；准备prepared-only、半截JSON、坏JSON行。断言：按revision再generation选正确已提交记录；prepared不当已提交，坏行不覆盖有效ledger。证据：原始history与最终状态。

**E05 · P0 · L1 · history身份校验**
步骤：分别造外层scope不同、state.identity不同但伪造scopeId、schema99、envelope revision不同、坏state。断言：先验证再恢复；有效ledger不被坏history覆盖，记录原因；匹配记录仍可恢复。证据：每项前后ledger hash。

**E06 · P0 · L1/L2 · 活owner过期锁与死owner恢复**
步骤：真实A进程持锁，在fence→rename边界SIGSTOP超过lease；B请求写入；恢复A；另轮kill A后B接管。断言：A活着时B不能偷锁、无旧覆盖新；死owner场景可保守恢复；EPERM/未知存活不得当死。证据：PID/token/lease/revision时间线、最终commit。

**E07 · P0 · L1/L2 · 启动reconcile和rollback并发**
步骤：在恢复取得锁/重读/写前暂停，再让另进程尝试新提交；对失锁补偿也分别测。断言：恢复本身受锁与fresh ledger保护，无锁外rename覆盖较新revision；不能只测原normal update。证据：两个进程输出和完整history。

**E08 · P0 · L1 · fsync及history三阶段故障**
步骤：prepared append/fsync、ledger rename、committed append/fsync、目录fsync分别注入EIO/ENOSPC。断言：prepared失败主账本不换；rename后故障标持久化不确定/DEGRADED，不返回成功；不支持fsync与真实I/O故障区分。证据：故障位置、错误code、disk/cache状态及重开结果。

**E09 · P0 · L1/L2 · 恢复锁忙及恢复写失败**
步骤：有效history比ledger新，另活进程持锁；另轮恢复rename/fsync失败。断言：recoveryState blocked、update拒写、coordinator DEGRADED；不以旧ledger继续READY。故障解除重新open后可恢复。证据：store/coordinator状态、原生调用0计数。

**E10 · P0 · L1/L2 · 丢账本与损坏隔离**
步骤：先初始化marker，再将ledger移至fixture保留；另轮损坏JSON/schema/identity；再启动并跑legacy audit。断言：区别首次安装和已用丢失；不生成空新账本，不重迁移；用户文件/原生登记不动。证据：marker、diagnostics、原文件hash。

**E11 · P0 · L1/L2 · drain晚任务与降级维护**
步骤：暂停/link、定时sweep、unarchive各在第一次异步边界，开始disable，再释放；另造DEGRADED触发维护。断言：任务被track并drain或按generation失效；交接完成后不再新建link/改标题/改归档；冻结后新请求不越闸。证据：严格时间线与链接/archive diff。

**E12 · P1 · L1/L2 · scope隔离与兼容**
步骤：两个profile/两个root/祖先symlink各创建状态；升级旧账本缺marker；未知schema新版本。断言：当前scope不接别人状态，旧可兼容者补marker，未知schema只读；没发生双writer。证据：各scope摘要与原生对象归属。

### F. 真实崩溃、规模与最终检查

**F01 · P0 · L2 · SIGKILL：创建意图后**
步骤：通过外部观察/可证明的暂停点，确认PENDING已fsync且Session尚未建，杀本RUN宿主；同HOME重启。断言：未建对象的意图被正确处理，不盲建重复会话，不删除已有目录。证据：kill PID、落盘意图、重启ledger/registry。

**F02 · P0 · L2 · SIGKILL：原生创建后**
步骤：Workspace/Session已落盘而finishCreate前强杀；重启→对账→disable。断言：单room单owner，ID/cwd不变，最后无残留登记。证据：原生持久化与PENDING各自快照。

**F03 · P0 · L2 · SIGKILL：DETACHING中**
步骤：分别在删登记前与删后终态前强杀，至少各一次；重启按最终启用意图收敛。断言：不重复解绑、不多建登记、不把用户收编夺回，目录/日志完整。证据：last durable phase和恢复时间线。

**F04 · P0 · L2 · SIGKILL：RESTORING中**
步骤：分别在create后attach前、部分attach后终态前强杀；重启、再disable。断言：复用已持久化实际workspaceId，只补缺失成员，无空壳；不把合成异常对象当正常成功。证据：每个checkpoint与完整B/A。

**F05 · P1 · L2 · 10轮启停/卸载循环**
步骤：同测试数据10轮disable→enable，另重装循环；每轮记录归属、文件、pin/archive、状态。断言：无数量增长、泄漏、重复链接或卡frozen；不能只保存第10轮。证据：每轮结构化JSON和汇总表。

**F06 · P1 · L2/L3 · 50room/100Session规模**
步骤：造50个room每room2普通Session，另子代理/归档/置顶分布；记录创建、status、交接、恢复和菜单耗时，操作一次完整周期。断言：成员无错漏、普通用户workspace不动、UI可操作；先报告实际性能不凭空设通过阈值，超时/阻塞有证据。证据：计数、分布、时间、视频。

**F07 · P1 · L2 · 新旧日志/文件完整性总核对**
步骤：汇总所有无主动写入阶段的B/A，对所有文件/目录/symlink及完整日志做diff。断言：没有未解释差异；只写keep.txt对比不足；普通workspace和非测试数据也无副作用。证据：每次diff与差异白名单理由。

**F08 · P1 · L0/L2 · 收尾复核与只清自己的实例**
步骤：候选git仍干净；记录最终SHA/tree/tgz；核对该RUN拥有的PID/端口/临时profile，正常关宿主，保留报告和最小夹具。断言：无误杀日常DSH、未push/tag/发布、未动用户聊天目录；不在线覆盖旧备份registry。证据：final-identity、cleanup记录。

## 6. 各案例证据怎么写，防止Flash遗漏

每完成一项立即更新 cases.json，推荐字段：

```json
{
  "id": "D05", "priority": "P0", "level": "L2", "status": "PASS",
  "candidateCommit": "完整SHA", "hostVersion": "实际版本",
  "fixture": "homes/D05", "steps": ["实际执行步骤"],
  "expected": "只补接管指定room", "actual": "adopted=1，重复请求未增room",
  "commands": ["commands.jsonl对应记录ID"],
  "evidence": ["evidence/D05/request.json", "evidence/D05/after.json"],
  "issue": null, "durationMs": 0
}
```

实际值必须来自本次执行。证据应链接本RUN相对路径，截图标明时间/URL/当前Session，不用含token的URL作为文件名。每个FAIL给：影响、优先级、前置状态、最短复现、期望/实际、代码路径/行号、机器输出；不要直接修产品后重复测试掩掉失败。

建议分批：A→B05/B07/D04/D05/C01/C04→完整B/C/D→E→F。每批最多5–8项；完成即落盘进度，避免长上下文混淆。遇同问题连续3次调整测试夹具仍失败，停下该路径，保存三次错误和最小样本，继续独立用例。相同产品问题无需反复全套；新故障须区分环境、夹具、产品、宿主能力，分类不确定时明确写待定位。

## 7. 报告与交接门槛

必须交付：

1. `REPORT.md`：候选身份、环境、整体结论、PASS/FAIL/BLOCKED/NOT_RUN计数、P0/P1/P2发现、完整用例表、R01–R18及原59项验收的映射、证据缺口、性能、限制、未改候选声明。
2. `REPRODUCTION.md`：每个FAIL的精确完整命令/操作、最小夹具、路径参数、需要的宿主能力；不省略成 `...`。
3. `cases.json`：本手册全部用例逐项状态；`findings.json`：结构化缺陷，没有也写空数组；`commands.jsonl` 和 `identity.json`。
4. 原始脱敏日志、关键状态、完整manifest差异、实际GUI视频/截图、候选包SHA。包不重复上传秘密数据，报告不包含凭据。
5. 对原合同59项单独给状态映射；一次A04服务级成功可映射已有断言，不能填完所有LC/OW/RC/RG。

结果例子：默认146/146、真原生28/28、GUI因未登录未跑、宿主CAS缺失 → 总结必须是 BLOCKED/PARTIAL，并分别写缺口。若发现恢复终态仍READY等产品错误 → FAIL/PARTIAL。旧用户环境已经清理过大量登记；禁止为证明这轮修复而重做用户真实数据清理。

最终回复应简洁：候选完整SHA与包SHA；整体结论；最重要发现；本次实际执行的层级和计数；核心未跑/阻塞；报告及最小复现的可点击路径。只把文件写完不算测试完成，也不以“可以继续测试”代替已授权的独立测试。
