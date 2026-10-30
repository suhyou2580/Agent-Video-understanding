# 视频理解插件（video-understanding）

把 **GIF / 本地视频 / B 站视频** 变成**带时间戳、可追问、可核验**的帧证据与事件时间线，
挂到 QQ Agent（SnowLuma + qq-bridge + DSH）现有的 MCP 工具面上。

- **不引第二套运行时**：纯 Node + 系统 ffmpeg，零 Python 依赖。
- **不买视觉 API**：帧以图片内容块交给当前会话的模型（DeepSeek 原生支持图片输入）。
- **不伪造能力**：拿不到媒体就返回 `ACCESS_FAILED` / `METADATA_ONLY`，绝不假装看过。

环境勘察与可行性数据见 [../DSH_视频理解_资源盘点与可行性核查.md](../DSH_视频理解_资源盘点与可行性核查.md)。

---

## 1. 它是怎么"理解"视频的

```
用户给 GIF / 文件 / B站链接
        │
   ┌────▼─────┐   ffprobe：时长/分辨率/轨道；GIF 逐帧时间轴
   │  探测    │   → access_status（USER_FILE_READY / VIDEO_READY / …）
   └────┬─────┘
        │
   ┌────▼─────┐   ffmpeg 内置 scene 检测（不装 PySceneDetect）
   │  采样    │   概览：均匀 + 首尾 + 镜头切换；精读：围绕指定时间窗
   └────┬─────┘   成本闸门：超图片 token 预算就**减帧**，不超发
        │
   ┌────▼─────┐   GIF 按**帧序号**取（帧延迟不均时按时间 seek 会取错）
   │  抽帧    │   视频按 -ss 取（走 http range，不整段下载）
   └────┬─────┘
        │  图片内容块 + 时间戳清单 → 模型自己看
   ┌────▼─────┐
   │ 模型分析 │   （不开额外 API 调用；就是当前会话的模型）
   └────┬─────┘
        │
   ┌────▼─────┐   紧凑事件（一条 25~50 token）：只有时间范围 + 变化描述
   │ 事件落库 │   证据帧由服务端按时间范围**派生**，模型不用输出 frame_id
   └────┬─────┘   SQLite 第二层：media_tasks / media_frames / media_events / media_raw_outputs
        │
   ┌────▼─────┐   只把标了 w:1 的写成**一条**摘要；推断不写入
   │ 长期记忆 │   → 复用锚点记忆插件的结构化写入接口（第三层）
   └──────────┘
```

**三层储存**：① 临时分析（帧图 + 原始模型输出，按保留期删）→ ② 视频事件（长期、可按
视频ID/时间/类型查）→ ③ 锚点记忆（只收值得记的）。详见 §3.2。

**"理解"的工程定义**（按意见稿 §6）：不只是"每张图各说一句"，而要尽量保留
事件顺序、时间范围、画面变化与证据引用；稀疏采样确认不了的，必须标为不确定。

---

## 2. 安装与接入

### 2.1 前置

| 项 | 要求 | 本机实测 |
|---|---|---|
| Node.js | ≥ 22.5（`node:sqlite`） | v24.22.0 ✅ |
| FFmpeg + ffprobe | 在 PATH，或配置 `ffmpegPath`/`ffprobePath` | ffmpeg 9.0.2-full ✅ |
| Python | **不需要** | — |
| 网络 | 本地文件/GIF 完全离线；B 站需外网 | B 站 200/184ms ✅ |

### 2.2 三步

```powershell
cd '<你的安装目录>\video-understanding'

# ① 数据库（首次会自动创建；也可手动）
node -e "const {createVideoService}=await import('./src/service.js');const s=createVideoService();console.log(s.health());s.close()"

# ② 挂到既有 snowluma-host MCP server（纯追加，自动备份 + 语法检查 + 可一键回滚）
node scripts/integrate-bridge.mjs --apply

# ③ 真实验证（stdio 握手 + 真抽一帧）
node scripts/verify-mcp.mjs --selftest

# 重启桥接，让 QQ 会话拿到新工具
D:\qq-bridge\restart.bat
```

**为什么挂 MCP**：QQ 会话有执行期工具白名单，只放行
`mcp__snowluma__ / mcp__snowluma-host__ / mcp__web-search-safe__ / mcp__phone__`。
挂到 `snowluma-host` 上得到 `mcp__snowluma-host__video_*`，正好在白名单内，
且**不改动任何 QQ agent 机制**（唤醒、分条、提示词、白名单全都不动）。

### 2.3 回滚

```powershell
node scripts/integrate-bridge.mjs --remove   # 撤掉工具（数据库与临时文件保留）
```

---

## 3. 工具清单

| 工具 | 花钱？ | 作用 |
|---|---|---|
| `video_probe` | 否 | 探测来源/时长/分辨率/轨道/`access_status` |
| `video_bilibili` | 否 | B 站元数据 + 能力状态 + 字幕清单（可选抓字幕时间轴） |
| `video_frames` | **是**（图片 token） | 抽帧并**把图片给模型看**；`task_id` 可复用已抽帧 |
| `video_save_events` | 否 | 保存**紧凑格式**的变化时间线（一条 20~50 token） |
| `video_query_events` | 否 | 按**视频 ID / 时间范围 / 数据类型**回查事件，不重新抽帧 |
| `video_timeline` | 否 | 回读完整时间线与帧清单 |
| `video_remember` | 否 | 写入长期记忆（**只写标了 `w:1` 的事件**） |
| `video_stats` | 否 | 成本与失败率统计（帧数/图片 token/缓存命中/失败率） |
| `video_doctor` | 否 | 自检：ffmpeg 版本、库健康、配置上限 |

典型用法（模型侧）：

```jsonc
// 先看能不能拿到
{ "tool": "video_bilibili", "arguments": { "target": "BV1GJ411x7h7" } }
// 概览：6 帧，约 1152 token
{ "tool": "video_frames", "arguments": { "source_bilibili": "BV1GJ411x7h7", "count": 6 } }
// 追问某一段 → 局部加密
{ "tool": "video_frames", "arguments": { "source_bilibili": "BV...", "mode": "focus", "start_ms": 62000, "end_ms": 70000, "count": 4 } }
// 落时间线（紧凑格式，一条 25~47 token；w:1 表示值得长期记住）
{ "tool": "video_save_events", "arguments": { "task_id": "V_xxx", "events": [
  { "t": [0, 480],      "e": "平趴不动",     "k": "st", "m": 0 },
  { "t": [1480, 2000],  "e": "支起上身抬头", "k": "mv", "m": 1, "a": "cat", "w": 1 },
  { "t": [3480, 3520],  "e": "回趴",         "k": "mv", "m": 0 }
] } }
// 之后按视频/时间/类型回查（不花 token）
{ "tool": "video_query_events", "arguments": { "task_id": "V_xxx", "from_ms": 1000, "to_ms": 2100, "kind": "motion" } }
// 只把值得记的写进长期记忆
{ "tool": "video_remember", "arguments": { "task_id": "V_xxx" } }
```

---

## 3.1 事件格式：为什么是这几个字段（实测 token）

视觉模型的输出也是要付费的，所以事件 schema 按 token 精算过。同一张 112×124 动图实测：

| schema | token | 结论 |
|---|---:|---|
| `{"t":[1480,2000],"e":"猫支起上身抬头"}` | **25** | 下限：只有时间范围 + 变化描述 |
| `+ "k":"mv"`（数据类型） | 33 | |
| `+ "m":1`（连续性） | 39 | |
| `+ "a":"cat"`（角色） | **47** | 五字段仍 ≤50 |
| `+ "c":0.8`（置信度） | 55 | **超预算** |
| `+ "w":1`（值得记忆） | 61 | 超预算 |
| 再加完整 `evidence_frame_ids` | 70~78 | 超预算 |

**结论：20~50 token 装不下"全部字段"，所以设计成"必填 2 个 + 可选按需出现"：**

- 必填 `t`（时间范围）+ `e`（描述**变化**，不是描述每个画面）；
- 可选 `k` 数据类型 / `m` 连续性 / `a` 角色 / `c` 置信度 / `w` 值得记忆 / `x` 推断；
- **证据帧不要求模型输出**：服务端按时间范围从已知帧时间轴**派生**（省 ~24 token/条），
  仍然保证每个事件可追溯到帧；
- `c` 只在真拿不准时写（写不下就算了，别为了凑字段挤掉描述）；
- 整条时间线超过 400 token 会**拒收**并提示合并；单条超过 50 token 只告警。

> 一句话给模型：**描述"变了什么"，不是"每一帧长什么样"**。同一段动作用一条
> `平趴→支起抬头→回趴` 比三条逐帧描述省 60 token 且信息更准。

---

## 3.2 三层储存（临时分析 / 视频事件 / 锚点记忆）

| 层 | 表 / 位置 | 内容 | 保留策略 | 检索方式 |
|---|---|---|---|---|
| **① 临时分析** | `media_frames` + `data/tmp/<task>/` + `media_raw_outputs` | 抽出的帧图、**原始模型输出**（成功与被拒都留）、被拒原因、调试信息 | `tempRetentionMinutes`（默认 120 分钟），`pruneTemp()` 清理；**按保留策略删除** | 按 `task_id` |
| **② 视频事件** | `media_events`（每条事件独立一行） | `start_ms/end_ms/description/kind/continuity/actor/confidence/worth_memory/tokens/evidence_frame_ids` | **长期保留**（用户不要求遗忘就一直留） | **视频 ID + 时间范围 + 数据类型**（`video_query_events`） |
| **③ 锚点记忆** | 锚点记忆插件（另一个库） | 只有**标了 `w:1`** 的事件才会汇总成**一条**摘要记忆，含来源与视频任务 ID | 由记忆插件的删除/衰减策略管理 | 记忆召回；再用 `video_query_events` 按 ID 回查细节 |

**为什么不把整条时间线写进长期记忆**：一个视频 20 条事件写进记忆，会挤占其他所有话题的召回预算；
所以只把"对将来有交互价值"的（`w:1`）写成一条摘要。没有 `w:1` 时 `video_remember` 会拒绝并提示
（用户明确要求记住时传 `force:true`）。

**原始输出为什么要单独存**：模型给出的东西一旦被校验拒绝，最需要知道的就是"它到底说了什么"。
`media_raw_outputs` 原样保存 `submit / submit_compact / rejected`，但它属于第一层，会随保留策略消失——
不会污染长期数据。

---

## 4. 成本模型（设计核心 + 实测账单）

**不调用任何视觉 API。** 帧作为图片内容块进入当前会话的模型，因此：

- 没有第二次模型调用、没有重复的系统提示词开销；
- 主要成本就是**图片 token**，而图片 token 由分辨率唯一决定。

### 4.1 计费规律（读 `dsh-llm-deepseek` 源码得到的公式）

`PATCH=14 / DOWNSAMPLE=3 / MAX=1024 / MIN_PIXELS=544²`

| 分辨率 | token/帧 | 说明 |
|---|---:|---|
| ≤544×544（如 480×270、640×360） | **192** | 提供方会放大到下限，**缩得更小不省钱** |
| 725×408（≈29.6 万像素，16:9） | 192 | 概览模式的**目标尺寸**：踩地板且不被放大糊掉 |
| 852×480 | 266 | B 站未登录上限 |
| 1280×720 | 578 | |
| 1920×1080 | 1024 | `quality=detail` 才用（看清文字） |

默认策略：概览 6 帧 ≈ **1152~1188 token**；`maxImageTokens=4000`，超了**自动减帧**；
1080p 只在 `quality=detail` 时用；同媒体同参数命中缓存不重复抽帧；每任务帧数硬上限 16。

### 4.2 一次分析的实测成本

单价取自 `qq-bridge/src/model-prices.js`（`deepseek-flash` 空闲档，元/百万 token）：
**未命中 1.0 / 命中 0.02 / 输出 4.0**，工作日 9–12、14–18 高峰 ×2。

以一张 112×124 的 QQ 动图（88 帧 / 3.52 秒）为例，token 全部实测：

| 帧数 | 图片 | 工具返回文字 | 模型输出 | 合计 |
|---:|---:|---:|---:|---:|
| 1 | 198 | 213 | 120 | **0.951 厘** |
| 2 | 396 | 272 | 120 | 1.208 厘 |
| 4 | 792 | 328 | 200 | 1.980 厘 |
| **6（默认）** | 1188 | 384 | 200 | **2.432 厘** |

一厘 = 0.001 元。**看一个动图约 2.4 厘 = 0.24 分。**

### 4.3 不同来源/画质（6 帧 / 3 帧）

| 来源 | 6 帧 | 3 帧 |
|---|---:|---:|
| QQ 动图 112×124（198/帧） | 2.43 厘 | 1.59 厘 |
| 概览 725×408（192/帧，地板） | 2.40 厘 | 1.58 厘 |
| B站未登录 852×480（266/帧） | 2.84 厘 | 1.80 厘 |
| 720p（578/帧） | 4.71 厘 | 2.73 厘 |
| 1080p 精读（1024/帧） | **7.39 厘** | 4.07 厘 |

即使最贵的 1080p 精读一次也只有 **0.74 分**。

### 4.4 上下文与缓存的重复计费（容易忽略）

图片进了上下文就不会消失，之后每轮都要再付一次输入费：

| 该会话后续轮数 | 未命中价 | 命中价 |
|---:|---:|---:|
| 1 | 1.57 厘 | 0.03 厘 |
| 5 | 7.86 厘 | 0.16 厘 |
| 10 | 1.57 分 | 0.31 厘 |
| 20 | 3.14 分 | 0.63 厘 |

**命中缓存便宜 50 倍**，所以"看完就总结成文字、结束这个会话"比"留着图继续聊"省得多。

### 4.5 工具定义的固定开销

9 个工具定义共 **2529 token**（本轮从 2977 压下来，-15%），每一轮请求都在提示词里
（稳定前缀，正常走缓存）：

| 工具 | token | 备注 |
|---|---:|---|
| video_frames | 593 | 参数多（source/mode/count/quality…），省不掉 |
| video_save_events | 363 | 字段规则写在 `events` 参数上，不占工具描述 |
| video_query_events | 338 | enum 放 schema，描述只留一句话 |
| video_remember | 315 | |
| video_bilibili | 300 | |
| video_probe | 293 | |
| video_stats / video_timeline / video_doctor | 132 / 111 / 84 | 几乎不占 |

原则：**参数规则写在参数上、描述只说行为、同一事实只说一次**。

| 轮数 | 命中 | 未命中 |
|---:|---:|---:|
| 1 | 0.05 厘 | 2.5 厘 |
| 100 | 5.1 厘 | 0.25 元 |
| 1000 | **5 分** | 2.53 元 |

所以改工具描述要按"每轮 × 轮数"算，不是一次性开销。

### 4.6 月成本估算

| 频率 | 用量 | 月成本 |
|---|---:|---:|
| 5 张/天 | 150 张 | **0.36 元** |
| 20 张/天 | 600 张 | **1.46 元** |
| 50 张/天 | 1500 张 | 3.65 元 |

### 4.7 与"不用插件"的对比（别被倍数吓到）

| | 单张成本 |
|---|---:|
| 只看 1 帧就回复（`qq_get_message_images`） | 0.62 厘 |
| 看 6 帧 + 存事件 | 2.43 厘 |
| **差额** | **+1.81 厘（3.9 倍）** |
| 参考：一次普通文字唤醒（推算） | 4.82 厘 |

**3.9 倍是"用不用视频工具"的差，不是版本间的差。** 绝对值是每张多 1.8 厘，
换来的是"能看出动作"——只看单帧会把"趴→支起→回趴"看成"一直趴着"。
看一个动图 ≈ 一次普通文字唤醒的 50%。

### 4.8 计量边界（哪些是实测、哪些不是）

| 项 | 性质 |
|---|---|
| 图片 token / 工具返回文字 / 事件 token / 工具定义 token | **实测**（插件自带的 char+bigram 估算器，非官方分词器） |
| 单价 | **查自 `model-prices.js`**，非本文臆造 |
| **模型输出 token（120/200）** | **估算**：插件看不到模型实际输出，按"3 条事件 + 一两句回复"估 |
| 后续轮数、缓存命中率 | **未知**，所以给"命中/未命中"两端区间 |
| 唤醒提示 4500 token | **推算**（按 `wakeMaxChars=6000`） |

结论：**分析本身便宜到可忽略（每张 2~3 厘），真正的成本变量是"图在上下文里留多久 × 缓存命中率"。**

---

## 5. 诚实的边界（请先读）

1. **B 站不是官方 API。** `open.bilibili.com` 不提供任意公开视频的媒体流/字幕下载；
   本适配器用的是**网页播放器自身的公开接口**，返回里会明说这一点。
   不绕过登录/付费/DRM/风控；带签名的 `wbi/playurl`（会 412 风控）**不碰**。
   拿不到就 `ACCESS_RESTRICTED` / `METADATA_ONLY`。
2. **`METADATA_ONLY` 只能谈标题与简介**，工具会显式警告模型不要描述画面。
3. **采样必然漏事件。** 返回里带"相邻采样点最大间隔"和"共 N 帧只看 M 帧"；
   短于间隔的动作可能没被拍到，模型必须说明限制而不是推测成事实。
4. **一次分析 ≠ 看完全片。** `coverage.covers_full_duration` 只表示**采样点覆盖面**，
   不代表逐帧检查。
5. **ffmpeg 会自己发网络请求**，前置 URL 校验管不到它内部的重定向。
   本插件做了：协议白名单（本地只 `file`、远程只 http 系）、DNS 解析后内网/环回/保留地址拦截、
   `-rw_timeout`、时长与文件大小上限。**残余风险**：ffmpeg 建连时会再解析 DNS，
   理论上存在 DNS rebinding 窗口；彻底消除需要本机中继代理，本版**未实现**。
6. **DSH 原生工具未做。** 本插件通过 MCP 提供能力（QQ 会话走这条路已足够）；
   若要给 DSH Web 会话注册原生工具，需要 `@deepseek-ai/schemastery` 可解析，当前未接。
7. **无音频转录。** 需要 ASR；本机 Python 3.15 缺 `onnxruntime` wheel（见可行性报告 §5）。
   B 站字幕可用时优先读字幕（`video_bilibili` + `fetch_subtitle=true`）。
8. **成本记账缺"模型/提示词版本"。** 插件不调用模型，因此**观测不到**当前会话用的是哪个
   模型、哪版提示词、输入/输出 token 与重试次数（这些只有宿主知道）。
   `analysis_runs` 只记插件自己能观测的：帧数、图片 token、插件版本、缓存命中/部分失败。
   这是已知缺口，不要把 `video_stats` 当成完整账单。
9. **没跑过的不说通过。** 见 §7 的实测清单；`tests/live` 需要外网，单独手动跑。

### 与意见稿的两处**有意偏差**（不是遗漏）

| 意见稿要求 | 本实现 | 原因 |
|---|---|---|
| §6 通过统一的 `VisionProvider` / `MultimodalProvider` 接口调用模型 | **插件不调用模型**：帧作为图片内容块交给当前会话的模型，由它自己分析 | 这是省成本的核心：不产生第二次模型调用、不重复系统提示词；DeepSeek 原生支持图片输入，没必要再包一层 provider |
| §4.2 帧记录含 `scene_id`（镜头分段归属） | **未实现**，只有 `selection_reason` | 本版只把镜头切换点当作**采样候选**，不做镜头分段编号。编一个永远为 null 的字段比不写更糟；需要时用 `sampling.sceneThreshold` 的切换时间自行分段 |

---

## 5.5 开发中踩到并已修掉的坑（都是实测暴露的）

| 坑 | 现象 | 修复 |
|---|---|---|
| ffmpeg 的 GIF 编码器重采样 | 手工造"4 帧、延迟 1000/300/700/200ms"的素材，被 ffmpeg 编成 **56 帧 @25fps**，帧延迟全丢 | 测试素材改为**纯 Node 手写 GIF89a 字节**；并明确"分析前不得用 ffmpeg 转码 GIF" |
| `-vsync` 已移除 | ffmpeg 9 直接报 `Unrecognized option 'vsync'` | 改用 `-fps_mode passthrough` |
| 锚点查询全表扫描（记忆插件） | 1 万节点 63ms | 强制从锚点表驱动，0.30ms |
| 末帧 seek 到正好等于时长 | `-ss 3.000` 于 3.000s 视频取不到帧 → "末帧必取"静默失效 | 时间戳夹紧到 `duration - guard`，guard 随 fps/时长自适应（下界 50ms，且绝不吃掉 >10% 时长） |
| 去重把**不同帧**合并 | 100ms/20ms 延迟的 GIF 被当成"同一时刻"，4 帧静默变 2 帧、3 帧变 1 帧 | 有逐帧时间轴时**禁用时间去重**（每个点都是精确某帧）；只有视频才用 150ms |
| 场景切换点突破帧数上限 | `count=4` 却抽了 5~7 帧，成本不可预测 | 场景点**替换**均匀点而不是追加；先按时间戳合并（同一时刻不同理由只占一个名额） |
| `drawbox` 的 `x` 表达式不逐帧求值 | 想造"方块移动"的连续动作素材，结果造出静止画面 | 测试改用 `testsrc2`（实测首末帧差异 58.5%） |
| `workDir` 为绝对路径时 `path.join` 拼错 | 临时目录变成 `...\tmp\C:\...\tmp\V_x` | 统一走 `resolveWorkDir()` 归一化 |

---

## 6. 配置

`config.json`（可选，默认见 `src/config.js`）：

```jsonc
{
  "ffmpegPath": "",              // 留空用 PATH
  "tempRetentionMinutes": 120,   // 第一层（帧图 + 原始模型输出）保留多久；事件不受影响
  "limits": {
    "maxFrames": 16,             // 单次抽帧硬上限
    "defaultFrames": 6,
    "maxDurationSec": 1800,
    "maxBytes": 524288000,
    "frameMaxWidth": 0,          // 0=不限（概览靠像素地板省 token）
    "jpegQuality": 4
  },
  "sampling": {
    "sceneDetect": true,
    "sceneThreshold": 0.3,
    "sceneDetectMaxDurationSec": 600   // 超长视频跳过场景检测，防扫全片
  },
  "cost": {
    "maxImageTokens": 4000       // 超预算自动减帧
  }
}
```

**想更省 token 就调 `defaultFrames`**：6→3 一张动图从 2.43 厘降到 1.59 厘，
代价是采样间隔从 480ms 拉到 1.2s，更短的动作可能漏（见 §4.3）。

环境变量：`VIDEO_UNDERSTANDING_LOG_LEVEL` / `VIDEO_UNDERSTANDING_LOG_FILE` /
`ANCHOR_MEMORY_DIR`（记忆插件位置）/ `QQ_BRIDGE_DIR`、`VIDEO_UNDERSTANDING_DIR`（接入脚本用）。

---

## 7. 自检与测试

```powershell
node scripts/doctor.mjs --bilibili BV1GJ411x7h7   # 环境 + 真实 B 站连通
node --test                                       # 93 个单元/集成测试
node tests/live/bilibili.live.mjs                 # 真实外网联调（需手动）
node scripts/verify-mcp.mjs --selftest            # 走真实 MCP 协议验证工具
```

### 已实测覆盖的验收项

| 意见稿验收项 | 对应用例 | 结果 |
|---|---|---|
| 不得只分析第一帧 | `不只看第一帧：采样点覆盖到末帧` | ✅ 末帧必须在采样里 |
| 帧顺序与帧延迟正确 | `探测非均匀延迟 GIF` / `端到端` | ✅ pts 0/1000/1300/2000，末帧 200ms 不被前帧覆盖 |
| 透明度 / 帧合成 / 循环 | `gif-compositing.test.mjs` | ✅ 透明帧与前帧合成（不是黑屏）、无限循环只分析一轮、20ms 帧不合并 |
| 有音轨/无音轨/损坏/超限 | `video-pipeline.test.mjs` | ✅ |
| 同一镜头内连续动作 | `continuous-action.test.mjs` | ✅ 0 切换点但首末帧差异明显；精读帧两两不同 |
| 事件有起止时间或标不确定 | `events.test.mjs` | ✅ 时间越界/倒序/负值全拒 |
| 区分观察与推断 | `events.test.mjs` + `memory-bridge.test.mjs` | ✅ 推断不写入记忆 |
| 不能把镜头切分当语义事件 | `continuous-action.test.mjs` | ✅ 事件表在抽帧后仍为空，事件只能由模型提交 |
| **紧凑事件落在 50 token 内** | `event-format.test.mjs` | ✅ 25/33/39/47；加 `c` 才 55，故做成可选字段 |
| **证据帧由服务端派生** | `three-layer-storage.test.mjs` | ✅ 模型不给 frame_id，落库后仍有证据 |
| **三层储存各管各的** | `three-layer-storage.test.mjs` | ✅ 清理第一层不影响第二层；无 `w:1` 不写第三层 |
| **按视频ID/时间/类型可查** | `three-layer-storage.test.mjs` | ✅ 三种过滤 + 交集语义 |
| B 站不冒充官方 API / 状态如实 | `bilibili.live.mjs` | ✅ 返回里明说"网页播放器公开接口" |
| 降级路径 | `video-probe` 的 METADATA_ONLY / ACCESS_FAILED 用例 | ✅ |

---

## 8. 目录结构

```
video-understanding/
├── package.json / config.example.json
├── migrations/
│   ├── 001_init.sql                  任务/帧/事件/成本 四张表
│   └── 002_three_layer_storage.sql   原始输出表 + 事件字段/索引
├── src/
│   ├── config.js      上限与校验（非法值直接报错）
│   ├── media.js       ffmpeg/ffprobe 封装：argv 数组、超时、协议白名单、请求头白名单
│   ├── probe.js       归一化探测 + GIF 逐帧时间轴 + access_status
│   ├── sampling.js    采样计划、scene 检测、token 估算、成本闸门、时间戳夹紧
│   ├── frames.js      抽帧（GIF 按帧号 / 视频按 seek）
│   ├── event-format.js  紧凑事件 schema、token 预算、证据帧派生
│   ├── events.js      旧格式事件校验（兼容保留）
│   ├── store.js       SQLite 持久化 + 缓存键 + 三层查询 + 成本统计
│   ├── service.js     门面：analyze / saveEvents / queryEvents / timeline / stats / pruneTemp
│   ├── adapters/bilibili.js   B 站适配器（能力状态机 + 明确非官方）
│   ├── memory-bridge.js       第三层：与锚点记忆插件的单向对接（只写 w:1）
│   ├── net-guard.js   URL 安全闸门（协议/内网/DNS）
│   ├── mcp-tools.js   9 个 MCP 工具
│   └── log.js         分级日志（不含媒体内容与凭据）
├── scripts/  integrate-bridge / verify-mcp / doctor
└── tests/    unit / integration / live / fixtures
```
