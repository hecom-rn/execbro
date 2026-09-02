# execbro 鸿蒙（HarmonyOS）支持设计方案

> 2026-09-02 · 状态：**待审批**（本稿为设计提案，未包含任何实现）
>
> 依据：《execbro 鸿蒙兼容性检验报告》（2026-09-01，真实 HarmonyOS NEXT 模拟器全量 61 工具实测）
> 及对 `src/` 现有代码的逐点核对（文中引用均带 file:line，于 v2.9.5 核实）。

---

## 1. 结论先行

实测已证明 execbro 的 **CDP 层（约 36 个工具）在鸿蒙上零改动可用**，缺的是三件事：

1. **P0 安全缺陷（与鸿蒙无关但被鸿蒙暴露）**：`device` 参数子串匹配可命中"未绑定任何受管设备"的
   app，native 工具静默回落到 adb 默认设备，造成"假成功 + 操纵错误设备"。必须先行修复。
2. **平台模型只有 ios/android 两值**：鸿蒙 app 被硬编码标记为 android，在工具面不可见、不可寻址。
3. **无 hdc 后端**：截图/触控/按键/包管理/原生日志全部没有鸿蒙通道。

本方案按 Phase 0（安全修复）→ Phase 1（平台模型 + hdc 后端 + 设备发现）→ Phase 2（原生工具面）
→ Phase 3（CDP 层小修）→ Phase 4（增强调研）推进。Phase 0 独立成立，可先行发布。

## 2. 现状架构分析

### 2.1 分层现状

```
MCP 工具层   src/tools/*.ts        参数 schema、resolver 包装、输出渲染
tap 引擎     src/pro/*.ts          tap 策略编排（fiber → accessibility → OCR → 坐标）
CDP 层       src/core/connection.ts、jsExecute、network*、screenState…   ← 平台无关
原生层       src/core/android.ts（adb，1953 行）/ ios.ts（simctl/idb/axe，2244 行）
设备发现     src/core/deviceDiscovery.ts（simctl + adb，30s 缓存）
设备解析     src/core/deviceResolver.ts（device 参数 → DeviceTarget）
```

关键事实：**原生层没有抽象接口**，是两套"函数对"直接被 import。20 余处 `platform ===` 行为分支
（tap 策略、verifyAction 截图、screenSpaceDevice 尺度、nativeLogs 管道、keyboardRaise 等）构成事实
上的分派表。`deviceResolver.ts:13` 的 `platform: "ios" | "android"` 联合类型是所有分支的根。

### 2.2 连接期平台判定（鸿蒙被标成 android 的位置）

- `connection.ts:1288`：连接建立时 `platform: "android"` **硬编码**。
- `connection.ts:1372-1391`：随后按 deviceName 反查——`findSimulatorByName` 命中则升级 "ios"，
  `resolveAdbSerialForDeviceName` 命中则确认 "android"。
- 鸿蒙 app 的 deviceName "emulator" 两者都不命中 → 永远是 `platform: "android"` 且
  `adbSerial/simulatorUdid` 均为 null。appDetection 探针（`appDetection.ts:17-28`）读了
  PlatformConstants 但**没读 `os` 原始字段**，因此从未发现 harmony。

> 注：RNOH（react-native-harmony）的 `Platform.OS` 返回 `'harmony'`，其底层
> `PlatformConstants.os` 即为可探测的原始值——这是 JS 侧平台检测的可靠抓手（待真机确认）。

### 2.3 高危缺陷根因链（实测报告 §3 的代码落点）

```
device="emulator"
  → deviceResolver.ts:198-227 步骤3：RN 注册表子串匹配，唯一命中鸿蒙 app
  → 返回 { platform:"android", androidSerial: undefined }        ← app 实际未绑定任何设备
  → _deviceArg.ts:31-44 resolveAndroidDeviceId 返回 { ok:true, serial:undefined }
  → android.ts:317 buildDeviceArgs(undefined) 产出 []（不带 -s）
  → adb 选中它自己的默认设备 emulator-5554（同机恰好挂着的一台 Android 模拟器）
  → 截图/触控落在错误设备；tap 的 fiber 段（CDP，目标正确）+ native 段（adb，目标错误）
    两段来自不同设备，却返回 success:true（tap.ts:2152-2172 拿到错误设备后照常执行）
```

同类"serial 为 undefined 即静默回落 adb 默认设备"的调用点共 8 类（含
`inputArtifact.ts:53` 这个从不传 serial 的真实泄漏点、`androidPinch.ts:53` 与
`interactionTools.ts:1148` 的 `getDefaultAndroidDevice()` 兜底），完整清单见勘察记录
（Phase 0 将逐一核对）。

### 2.4 兼容性矩阵（实测，61 工具）

| 分组 | 数量 | 结论 |
|---|---|---|
| CDP 层（连接/布局/检查/日志/状态/Bundle/网络/导航） | 36 | 零改动可用 |
| 部分可用（input_text、inspect_at_point、tap、dismiss_keyboard） | 4 | 各有一个非鸿蒙专属缺口（见 §7.3） |
| native 后端（截图/触控/按键/包管理） | 8 | 全部无效且**误伤其他设备** |
| 环境限制（ios_*、redux_* 等） | 13 | 与鸿蒙无关，不在本方案范围 |

## 3. 目标与非目标

**目标**
1. 修复设备绑定校验缺陷（P0，先于一切鸿蒙工作发布）。
2. `platform` 模型引入 `"harmony"`；鸿蒙设备在 `list_devices` / `get_apps` 可见、可用 `device=` 寻址。
3. 新增 hdc 后端，鸿蒙获得与 Android 对等的 native 能力：截图、触控（tap/swipe/长按/按键）、
   包管理、启动、原生日志（hilog）、OCR。
4. 三个 CDP 小修：appId 命名兜底、Keyboard 降级提示、platform 标注。

**非目标（本方案明确不做）**
- 不重构 `android.ts` / `ios.ts` 为统一接口大改（见 §4 方案取舍）。
- 不做 pinch 多指注入（先调研，无解则显式报不支持——与 iOS pinch 现状一致）。
- 不处理 HarmonyOS 的 app 构建/部署（hdc 安装 hap 属未来扩展，接口预留但不实现）。
- redux_*/ios_* 等与鸿蒙无关的工具不动。

## 4. 方案取舍

**方案 A：全量抽象 `DeviceBackend` 接口**，三平台各给一份实现，替换全部 `platform ===` 分派。
- 优点：结构最干净，第四平台（如实验室自定义设备）成本最低。
- 缺点：iOS（simctl/idb/axe 三驱动、点坐标）与 Android（adb、像素坐标）函数形状差异大，强凑
  接口是一次 2000+ 行的双文件重构，波及 tap 引擎与全部工具层，回归风险与鸿蒙目标无关。
- 结论：**过度设计，YAGNI**。

**方案 B：仅在工具层逐点加 `platform === "harmony"` if 分支**，不动模型。
- 优点：改动最少。
- 缺点：鸿蒙设备在 resolver/discovery 不可寻址，`device=` 无效，多设备场景必然出错；20 处分支
  变 30 处，散落更广。
- 结论：**不解决寻址问题，否决**。

**方案 C（推荐）：类型联合扩展 + 单一 choke-point 接线 + 独立 `harmony.ts`**
- `"harmony"` 进入平台联合类型；hdc 能力按 `android.ts` 的函数风格落在独立的
  `src/core/harmony.ts`；接线只发生在勘察确认的 4 个单一收口点
  （`verifyAction.ts:136` 截图、`screenSpaceDevice.ts:53-116` 尺度、`nativeLogs.ts:260` 日志分派、
  `deviceDiscovery.ts`+`deviceResolver.ts` 发现与寻址）+ 各工具层的平台分支处。
- 与仓库现状最贴合（android/ios 本就是两套平行函数对），改动面可控、可分阶段验证；
  未来若需要，方案 A 的接口抽取可在 choke-point 已收口的基础上再做，成本不变。
- 结论：**采纳**。

## 5. 详细设计

### 5.1 Phase 0 —— 设备绑定校验（P0 安全修复，独立发布）

**原则：native 工具执行前，必须证明目标设备就是 app 所在设备；证明不了就明确报错，绝不回落。**

1. **DeviceTarget 增加 `nativeBinding` 字段**
   `deviceResolver.ts` 在 registry 命中（步骤 3）与默认选择（步骤 5）两处，依据被命中 app 的
   `adbSerial` / `simulatorUdid`（Phase 1 后加 `harmonyTargetKey`）计算：
   `"adb" | "simctl" | "hdc" | "none"`。`"name-match"` / `"udid"` / `"adb-serial"` 来源天然非 none。
2. **resolver 对 unbound app 的 native 解析直接失败**
   新错误码 `NATIVE_BACKEND_UNAVAILABLE`：当 device 提示词解析到一个
   `nativeBinding === "none"` 的 app 时，`resolveAndroidDeviceId` / `resolveIosUdid`
   （`_deviceArg.ts`）与 tap/swipe 的 native 段返回错误，文案说明
   "该 app 仅经 Metro 连接，未绑定 adb/simctl 设备，native 工具不可用（可用的 CDP 工具：…）"。
   无 `device` 参数的既有"Omit for first"默认行为保持不变（文档化行为，非本次缺陷）。
3. **tap 两段一致性 guard**
   `pro/tap.ts` 在 fiber 段定位成功、进入 native 段前校验：定位所用 app 的绑定标识
   （adbSerial/simulatorUdid）与 resolver 解析出的目标一致；不一致（正是实测踩中的
   "fiber 在鸿蒙、native 在 Android"状态）→ 拒绝执行，返回明确错误。
4. **匹配规则收紧**：registry 步骤先做 normalize 后**等值**匹配；子串匹配保留，但命中时在
   解析结果附 warning（`source:"registry-substring"`），多命中仍报 MULTIPLE_DEVICES_MATCH。
5. **回归保护**：表驱动单测覆盖（unbound app × 各工具包装器）；对照 CLAUDE.md 的 stub-adb 惯例
   跑全套单测证明零设备接触。

### 5.2 Phase 1 —— 平台模型 + hdc 后端 + 设备发现/寻址

**类型扩展**（一处改动，处处受益）：
- `types.ts`：`ConnectedApp.platform`、`AppDetectionResult.appPlatform`、
  `EnsureConnectionDeviceInfo.platform` → `"ios" | "android" | "harmony"`；
  `ConnectedApp` 增加 `harmonyTargetKey?: string`。
- `deviceResolver.ts`：`DeviceTarget.platform` 同步扩展，增加 `harmonyTargetKey?`。
- `deviceDiscovery.ts`：`ListAllDevicesResult` 增加
  `harmony: { available: boolean; error?: string; targets: HarmonyTargetRow[] }`，
  `HarmonyTargetRow = { key, name, state: "connected"|"disconnected", kind: "emulator"|"real", rnConnected? }`。

**平台检测（connection.ts 连接期，同现有 iOS 升级模式）**：
- `appDetection.ts` 的 DETECTION_EXPRESSION 增加返回 `PlatformConstants.os` 原始值（以及
  `systemName`/`osType` 中的 harmony/ohos 候选标记）。RNOH 下预期 `os === "harmony"`（真机验证点 V1）。
- 命中标记 → `connectedApp.platform = "harmony"`（复刻 `connection.ts:1381` 的 iOS 升级写法）。
- 兜底关联：标记未命中但 `adbSerial/simulatorUdid` 均空 + hdc inventory 存在 target 时，
  以 deviceName 归一化匹配（等值优先，唯一子串打 warning）关联 hdc target，标注 harmony-suspected
  （实现为 platform:"harmony" + `detectionSource:"hdc-correlation"`，遥测区分）。
- 多 hdc target 时关联可能含糊：宁可保持现状（platform 仍为 android、`nativeBinding:"none"`）
  也不猜——Phase 0 已保证这种状态下 native 工具报错而非误伤。

**hdc 后端 `src/core/harmony.ts`**（函数风格、可用性缓存、超时模式对齐 `android.ts`）：

| 能力 | 命令（实现时按真机验证，见报告 §4.1 注） |
|---|---|
| 可用性探测 | `hdc list targets`（缓存同 `isAdbAvailable`） |
| 设备清单 | `hdc list targets -v`（解析 key、kind、state） |
| 截图 | `hdc -t <key> shell snapshot_display -f /data/local/tmp/execbro_<ts>.jpeg` + `hdc file recv` + 远端清理；写 ImageBuffer |
| 点击/长按 | `uitest uiInput click x y` / `longClick x y`（**物理像素**，与 delivered-pixel 坐标系需一次换算，见下） |
| 滑动 | `uitest uiInput swipe x1 y1 x2 y2 speed`（drag/fling 备选） |
| 按键 | `uitest uiInput keyEvent Back|Home|…`（键位表常量对齐 `ANDROID_KEY_EVENTS` 风格） |
| 文本输入 | `uitest uiInput inputText x y "text"`（焦点在场时 `uiInput text`；引号/反斜杠转义函数 + 单测） |
| 列包 | `bm dump -a`（解析 JSON/文本输出为包名列表） |
| 启动/强停 | `aa start -b <bundle> -a <ability>` / `aa force-stop <bundle>` |
| 屏幕尺寸/密度 | 优先窗口管理 hidumper，兜底用 snapshot 实际像素回推；真机验证点 V2 |
| 原生日志 | `hdc shell hilog`（时间窗 + 进程过滤，对齐 `logSourceAndroid.ts` 的 epoch 分组输出） |

**发现与寻址接线**：
- `deviceDiscovery.ts` 增加 `discoverHarmony()`，并入 `listAllDevices()` 缓存与失效逻辑。
- `list_devices`（`deviceTools.ts`）渲染 harmony 段 + RN 注册表关联 + summary。
- `deviceResolver.ts`：步骤 2 增 hdc key 精确匹配；步骤 4 增 harmony target 名称匹配；
  步骤 5 默认设备候选并入 harmony targets；`_deviceArg.ts` 增加 `resolveHarmonyTargetKey` 包装。

### 5.3 Phase 2 —— 鸿蒙原生工具面

**新工具**（沿用 android_*/ios_* 命名惯例与参数习惯）：
- `harmony_screenshot`（含 ImageBuffer、OCR 所需元数据）
- `harmony_key_event`（Back/Home 等键位表）
- `harmony_launch_app` / `harmony_list_packages`
- （`harmony_terminate_app` 视 `aa force-stop` 验证结果决定是否暴露）

**跨平台工具的 harmony 分支**：
- `tap`：fiber 定位（CDP，已天然可用）→ native 段走 hdc click/longClick；OCR 策略接
  `harmonyScreenshot` 后自动可用；accessibility 策略 Phase 2 先跳过（Phase 4 用
  `uitest dumpLayout` XML 补齐，解析器可仿 `androidGetUITree` 的 fast-xml-parser 用法）。
  验证截图/前后 diff 复用 `verifyAction` 的 harmony 分支。
- `swipe`：`uiInput swipe`；scroll-probe 依赖的 foreground-package/system-bar 探测在鸿蒙降级——
  探测不可得时按项目惯例如实说明（"无法验证滚动面"），不伪造 `meaningful`。
- `input_text`：React 层写值已可用（实测通过）；native 路径接 `uiInput inputText`；
  keyboard-raise 在鸿蒙明确降级（见 §5.4）。
- `ocr_screenshot`：platform 枚举加 `"harmony"`，DPR 推断用 Phase 1 的尺度信息。
- `pinch`：工具层 guard 从"Android-only"改为列出支持矩阵，鸿蒙在 Phase 4 调研前明确报不支持。

### 5.4 Phase 3 —— CDP 层小修

1. **appId 命名兜底**：`undefinedAppName@` 前缀（Metro inspector 对未报名 app 的生成值）在
   `get_apps` 显示层兜底：依次尝试 deviceName、Metro bundle URL 中的 app 标识、
   `execute_in_app` 读取 `AppRegistry`/manifest 名；取不到则显示 deviceName 并注明。
   （仅显示与注册表标签，不改 appKey 语义。）
2. **Keyboard 诚实降级**：`keyboardMetrics.ts:27` 的失败在 harmony（或任意
   module-registry 不可达环境）下改为结构化降级——`input_text` 返回"React 写值成功、原生键盘
   状态不可知"；`dismiss_keyboard` 不再返回成功（实测的假成功问题）；`get_screen_state`
   键盘状态行显示 "unknown"。
3. **`inspect_at_point` source 符号化**：不新增代码路径。先在鸿蒙 debug 构建（非 release）复测
   `no-debug-stack` 是否消失；release 维持现状（字段静默缺省），在 `get_usage_guide` 注明。

### 5.5 Phase 4 —— 调研与增强（另行立项，不在首个实现计划内）

- `uitest` 多指注入能力 → pinch（无解则永久显式报不支持）。
- `uitest dumpLayout` → tap accessibility 策略、`find_components` 的原生树互补。
- `hdc fport` 自动化（当前用户手工 fport，可在 scan_metro 提示中检测"端口通但无 adb/simctl 绑定
  的 harmony app"并给出 fport 建议）。
- `hdc install` hap 安装。

## 6. 测试与验证策略（遵循仓库硬规则）

- **自动化只做单元测试，绝不驱动真机**：resolver 绑定 guard 表驱动用例；`harmony.ts` 命令构造
  纯函数（参数拼装、键位表、输出解析器）用 fixture 测试（bm dump / hilog / dumpLayout 样本入库）；
  用 stub `adb`/`xcrun`/`hdc` 跑全套单测证明零设备接触。
- **真机验证由 agent 经 `mcp__execbro-dev__*` 交互完成**，每个 Phase 附验证清单，直接对照
  兼容性报告的工具矩阵复核：
  - V1（Phase 1）：DETECTION_EXPRESSION 读到的 `PlatformConstants.os` 实际值；
    `hdc list targets -v` 输出格式；snapshot_display 落盘与 recv 链路。
  - V2（Phase 2）：click/longClick/swipe/keyEvent/inputText 实际生效；坐标换算与截图像素对齐
    （tap 前后 diff 验证）；bm/aa 输出解析；hilog 时间窗过滤。
  - V3（Phase 3）：debug 构建下 source 符号化是否恢复；undefinedAppName 兜底链。
- **多设备对照回归**：鸿蒙模拟器 + Android 模拟器同机（正是报告的误伤场景）跑 Phase 0 后的
  `android_screenshot / tap`，确认错误信息正确、零串扰。

## 7. 风险与开放问题

1. **hdc/uitest 命令细节需真机确认**（报告已注明"实现时需验证"）：Phase 1 的 V1 清单就是为此
   设计的，命令层以 adapter 函数隔离，验证失败只改一处。
2. **RNOH 版本差异**：被测 app 为 RN 0.77.1 new-arch；`PlatformConstants.os` 的实际取值、
   release 构建是否携带 debug 堆栈，均以真机验证为准。
3. **多 hdc target 关联含糊**：宁可"不标注"，Phase 0 的绑定校验保证这种状态下不会误伤。
4. **`platform` 联合扩展的波及面**：所有 `platform === "android"` 行为分支在 harmony 下会走
   "都不命中"路径——逐一核对（勘察已列出清单），原则与 §5.3 相同：**降级要明说，不伪造成功**。
5. **spec 存放位置**：本仓库 CLAUDE.md 规定 spec 应写入 `~/rn-devtools/docs/`，该 monorepo 目录
   在本机不存在；本稿暂存仓库 `docs/specs/`，审批后可按你的意见迁移。

## 8. 实施顺序与交付物

| Phase | 内容 | 交付物 |
|---|---|---|
| 0 | 设备绑定校验 + 匹配收紧 | resolver/_deviceArg/tap guard + 单测；独立 commit 可先行发布 |
| 1 | 类型扩展、平台检测、`harmony.ts`（发现/截图/触控/键/包/日志）、resolver/list_devices 接线 | V1 真机验证记录 |
| 2 | harmony_* 工具 + 跨平台工具 harmony 分支 + verifyAction/scale/日志收口接线 | V2 真机验证记录 |
| 3 | appId 兜底、Keyboard 降级、source 复测 | V3 验证记录 |
| 4 | pinch/dumpLayout/fport 调研报告（另行立项） | 调研结论 |

## 9. 参考资料

- RNOH 仓库与平台支持（`Platform.OS === 'harmony'`）：[RNOH/rnoh (Gitee)](https://gitee.com/rnoh/rnoh)、
  [Software Mansion × Huawei 合作公告](https://swmansion.com/blog/huawei-x-software-mansion-bringing-react-native-support-to-harmonyos-next-82e02bd75549/)
- hdc/uitest 命令集：[awesome-hdc](https://github.com/codematrixer/awesome-hdc)、
  [OpenHarmony ArkXTest（uitest uiInput/dumpLayout 官方说明）](https://gitee.com/openharmony/testfwk_arkxtest/blob/master/README_zh.md)、
  [OpenHarmony hdc 官方文档](https://gitee.com/openharmony/docs/blob/master/en/application-dev/dfx/hdc.md)
