# execbro 鸿蒙支持实施计划（Phase 0-3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复设备绑定校验缺陷（P0）并让 execbro 的设备层获得完整的 HarmonyOS（hdc）支持，Phase 0-3 在同一分支统一实现、统一发布。

**Architecture:** 方案 C —— `"harmony"` 进入平台联合类型；hdc 能力按 `android.ts` 函数风格落在独立 `src/core/harmony.ts`；接线只发生在四个收口点（verifyAction 截图、screenSpaceDevice 尺度、nativeLogs 分派、deviceDiscovery+deviceResolver）与各工具平台分支处。不做全量 DeviceBackend 接口重构。

**Tech Stack:** TypeScript (ESM, Node >=20.9)、@modelcontextprotocol/sdk、fast-xml-parser（dumpLayout 预留，本期不用）、jest 单测（绝不驱动真机）。

**Spec:** `docs/specs/2026-09-02-harmonyos-support-design.md`（随计划一起阅读）

## Global Constraints

- 自动化测试只做单元测试，**绝不驱动真机/模拟器**（CLAUDE.md 硬规则）；测试命令 `NODE_OPTIONS='--experimental-vm-modules' npx jest --testPathPatterns='unit/<name>'`。
- 命令构造必须是纯函数（参数拼装、键位表、输出解析器）以便 fixture 测试。
- 鸿蒙 hdc 命令细节以真机验证为准：所有 shell 命令经 adapter 函数隔离，验证失败只改一处。
- 降级必须明说，不伪造成功；native 工具在"app 未绑定受管设备"时必须报错而非回落。
- 每个任务完成即 commit（分支 `feature/harmonyos-support`）；构建 `npm run build` 必须通过。
- 新工具需同步 `docs/tools.md`、`get_usage_guide`（`src/core/guides.ts`）与 `tools.json`（postbuild 自动生成）。
- 遥测：新工具调用沿用现有 telemetry 注册方式，平台标签加 `"harmony"`。

---

### Task 1: Phase 0 — resolver 绑定校验与匹配收紧

**Files:**
- Modify: `src/core/deviceResolver.ts`
- Test: `src/__tests__/unit/deviceResolverBinding.test.ts`（新建）

**Interfaces:**
- Produces: `DeviceTarget.nativeBinding: "adb" | "simctl" | "hdc" | "none"`；新错误码 `NATIVE_BACKEND_UNAVAILABLE`；`formatResolverError` 不变。

- [ ] 步骤 1：写失败测试。表驱动：registry 命中 unbound app（adbSerial/simulatorUdid 均空）→ `NATIVE_BACKEND_UNAVAILABLE`；registry 命中绑定 app → nativeBinding 正确；等值匹配优先于子串；唯一子串命中返回 note 警告。
- [ ] 步骤 2：跑测试确认失败。
- [ ] 步骤 3：实现。registry 步骤（deviceResolver.ts:194-240）中，对唯一命中的 app 计算 `nativeBinding`（simulatorUdid→"simctl"，adbSerial→"adb"，均空→"none"）；先做 normalize 等值匹配，子串命中时 note 附 warning；`resolveDeviceTargetInner` 对 `nativeBinding==="none"` 的解析结果在返回前改为 `err("NATIVE_BACKEND_UNAVAILABLE", ...)`（错误文案列出该 app 可用的 CDP 工具类别）。stale-retry 集合不含新错误码。
- [ ] 步骤 4：跑通新测试 + 既有 `deviceResolver.test.ts`、`deviceResolution.test.ts`、`deviceResolverStaleRetry.test.ts` 回归。
- [ ] 步骤 5：commit `fix(resolver): refuse native backends for apps not bound to adb/simctl devices`。

### Task 2: Phase 0 — 工具层包装器与 tap 两段一致性 guard

**Files:**
- Modify: `src/tools/_deviceArg.ts`（`resolveAndroidDeviceId`/`resolveIosUdid` 透传新错误）
- Modify: `src/pro/tap.ts`（native 段前一致性校验）
- Test: `src/__tests__/unit/deviceResolverBinding.test.ts` 补充、`src/__tests__/unit/tapAndroidSerial.test.ts` 回归

**Interfaces:**
- Consumes: Task 1 的 `NATIVE_BACKEND_UNAVAILABLE`。
- Produces: tap 在 fiber 定位 app 与 native 目标不一致时返回 `{ success:false, error }`。

- [ ] 步骤 1：`resolveAndroidDeviceId`/`resolveIosUdid` 已经对 `!resolved.ok` 走 formatResolverError，验证新错误码文案可读即可（补 1 个单测断言错误文案含 "NATIVE_BACKEND_UNAVAILABLE" 或人读文案）。
- [ ] 步骤 2：tap.ts native 段前 guard：当 `resolved.target.source === "registry"` 且目标 nativeBinding 与定位所用 app 的绑定不一致（app 有绑定而 target 没有标识，或标识不同）→ 返回 formatTapFailure，suggestion 说明设备不匹配。用 stub resolver 的单测锁定。
- [ ] 步骤 3：跑 tap 相关单测（tap.test、tapAndroidSerial、tapDuration、tapLongPressReport）。
- [ ] 步骤 4：commit `fix(tap): refuse native touch when fiber locate and native target disagree`。

### Task 3: Phase 1 — 类型扩展

**Files:**
- Modify: `src/core/types.ts`、`src/core/deviceResolver.ts`（DeviceTarget）、`src/core/deviceDiscovery.ts`（ListAllDevicesResult.harmony）

**Interfaces:**
- Produces: `platform: "ios" | "android" | "harmony"` 全线生效；`ConnectedApp.harmonyTargetKey?: string`；`HarmonyTargetRow { key,name,state,kind,rnConnected? }`；`DeviceTarget.harmonyTargetKey?: string`。

- [ ] 步骤 1：改类型并 `npx tsc --noEmit src/index.ts` 找出所有因联合扩展而收窄失败的分支；逐一处理（本任务只处理编译错误：行为分支留待后续任务，编译期不允许的分支用显式归组或收窄处理，不得 `as any`）。
- [ ] 步骤 2：`npm test --testPathPatterns='unit/deviceResolver'` 等核心回归通过。
- [ ] 步骤 3：commit `feat(types): introduce harmony platform across device model`。

### Task 4: Phase 1 — `src/core/harmony.ts` hdc 后端（命令构造 + 执行）

**Files:**
- Create: `src/core/harmony.ts`
- Test: `src/__tests__/unit/harmonyCommands.test.ts`（命令构造纯函数）、`src/__tests__/unit/harmonyParse.test.ts`（输出解析 fixture）

**Interfaces:**
- Produces（后续任务依赖的签名，与 android.ts 风格对齐）:
  - `isHdcAvailable(): Promise<boolean>`（缓存，`resetHdcAvailabilityCache()`）
  - `listHarmonyTargets(): Promise<{ key: string; name: string; state: "connected"|"disconnected"; kind: "emulator"|"real" }[]>`
  - `buildHdcArgs(targetKey?: string): string[]`（等价 buildDeviceArgs：`["-t", key]` 或 `[]`）
  - `harmonyScreenshot(outputPath?: string, targetKey?: string): Promise<HdcResult>`（snapshot_display → file recv → 远端清理；HdcResult 形如 AdbResult）
  - `harmonyTap(x, y, targetKey?)` / `harmonyLongPress(x, y, durationMs, targetKey?)` / `harmonySwipe(x1,y1,x2,y2,speed?,targetKey?)`
  - `harmonyKeyEvent(key: HarmonyKey, targetKey?)`；`HARMONY_KEY_EVENTS` 常量表（Back/Home/Enter/DEL/Esc…映射 `uitest uiInput keyEvent` 键名，真机验证点）
  - `harmonyInputText(x, y, text, targetKey?)`；`escapeHarmonyShellText(text)` 转义纯函数
  - `harmonyLaunchApp(bundleName, abilityName?, targetKey?)` / `harmonyTerminateApp(bundleName, targetKey?)` / `parseBmDumpList(stdout): string[]`
  - `harmonyGetScreenSize(targetKey?): Promise<{ width: number; height: number } | null>`（优先 hidumper，兜底 snapshot 尺寸回推；null=未知）

- [ ] 步骤 1：先写命令构造测试：`buildHdcArgs()`/`buildHdcArgs("127.0.0.1:5555")`、HARMONY_KEY_EVENTS 映射、escapeHarmonyShellText（引号/反斜杠/`$`）、各 build*Command 纯函数的 argv 快照。
- [ ] 步骤 2：跑测试确认失败；实现命令构造层。
- [ ] 步骤 3：写解析 fixture 测试：`hdc list targets -v` 样本输出 → targets 数组；`bm dump -a` 样本 → 包名数组；snapshot/hidumper 尺寸样本。
- [ ] 步骤 4：实现执行层（exec 模式对齐 android.ts 的 execFileAsync + 超时 + isHdcAvailable 缓存），跑通全部新测试。
- [ ] 步骤 5：`npm run build`；commit `feat(harmony): hdc backend command layer`。

### Task 5: Phase 1 — 平台检测与连接期标注

**Files:**
- Modify: `src/core/appDetection.ts`（DETECTION_EXPRESSION 增读 `PlatformConstants.os` 原始值）
- Modify: `src/core/connection.ts`（probe 结果 platform:"harmony" 升级写法，复刻 1381 行 iOS 模式）
- Test: `src/__tests__/unit/appDetectionHarmony.test.ts`（parseDetectionResult 对 os:"harmony" 的映射）

**Interfaces:**
- Consumes: Task 3 类型。Produces: `AppDetectionResult.appPlatform === "harmony"` 时 `connectedApp.platform = "harmony"`。

- [ ] 步骤 1：DETECTION_EXPRESSION 返回 `r.os = c.os`（原始值）；parseDetectionResult 接受 `os` 值（"harmony"/"openharmony"/含 ohos 候选）→ `appPlatform:"harmony"`；单测锁定。
- [ ] 步骤 2：connection.ts 在 probe 成功回调里（appDetection.ts:106-110 已回写 appDetection）同步改写 `connectedApp.platform`；harmony 时补一次 hdc 关联（复用 listHarmonyTargets 唯一 target 时回填 harmonyTargetKey，多 target 不猜）。
- [ ] 步骤 3：回归 connection 相关单测；commit `feat(detect): detect harmony via PlatformConstants.os and link hdc target`。

### Task 6: Phase 1 — 设备发现与 resolver/list_devices 接线

**Files:**
- Modify: `src/core/deviceDiscovery.ts`（discoverHarmony 并入）
- Modify: `src/core/deviceResolver.ts`（步骤2 hdc key 精确匹配；步骤4 harmony 名称匹配；步骤5 默认候选）
- Modify: `src/tools/deviceTools.ts`（list_devices 渲染 harmony 段）
- Create: `src/tools/_deviceArg.ts` 增 `resolveHarmonyTargetKey(hint?)`
- Test: `src/__tests__/unit/deviceDiscovery.test.ts` 扩展、`src/__tests__/unit/harmonyDiscovery.test.ts`

**Interfaces:**
- Consumes: Task 4 `listHarmonyTargets`、Task 3 `HarmonyTargetRow`。
- Produces: `listAllDevices()` 返回含 `harmony.targets`；`device=` 可用 hdc key 或名称寻址鸿蒙设备。

- [ ] 步骤 1：deviceDiscovery 扩展测试（stub listHarmonyTargets → 缓存/合并/summary 含 harmony）。
- [ ] 步骤 2：实现 discoverHarmony（hdc 不可用时 `{available:false}`，不拖慢 Promise.all）。
- [ ] 步骤 3：resolver 接线 + 单测（hdc key 唯一命中；名称匹配；默认候选并入；hdc 不可用零影响）。
- [ ] 步骤 4：list_devices 渲染 + RN 注册表关联（deviceName 等值优先）。
- [ ] 步骤 5：回归 deviceDiscovery/deviceResolver 套件；commit `feat(discovery): merge hdc targets into device inventory and resolver`。

### Task 7: Phase 2 — harmony_screenshot + verifyAction/screenSpaceDevice 收口

**Files:**
- Modify: `src/tools/screenshotTools.ts`（新工具 harmony_screenshot；ocr_screenshot platform 枚举 +3）
- Modify: `src/pro/verifyAction.ts:120-145`（captureScreenshot 增 harmony 分支）
- Modify: `src/core/screenSpaceDevice.ts`（resolveDeliveredScaleFactor/resolveScreenSpaceMetrics 增 harmony 三元组）
- Test: `src/__tests__/unit/verifyAction.test.ts` 扩展、`src/__tests__/unit/screenSpace.test.ts` 扩展

**Interfaces:**
- Consumes: Task 4 `harmonyScreenshot`/`harmonyGetScreenSize`。
- Produces: `captureScreenshot(platform: "ios"|"android"|"harmony", udid?, deviceId?, hdcKey?)`；harmony 的 scale 兜底为 snapshot 实际像素（deviceScale 未知时按 1 处理并如实标注）。

- [ ] 步骤 1：verifyAction 扩展单测（platform:"harmony" → harmonyScreenshot 被调）。
- [ ] 步骤 2：实现三处收口；harmony_screenshot 工具注册（复用 android_screenshot 的输出渲染/ImageBuffer 逻辑，含降采样）。
- [ ] 步骤 3：ocr_screenshot 枚举扩展 + DPR 推断走 harmony 分支。
- [ ] 步骤 4：跑相关单测 + build；commit `feat(harmony): screenshot tooling and capture choke-points`。

### Task 8: Phase 2 — tap 鸿蒙 native 段与 OCR 策略

**Files:**
- Modify: `src/pro/tap.ts`（OCR 策略、coordinate 策略、native 段的 harmony 分支；策略选择表）
- Test: `src/__tests__/unit/tap.test.ts` 风格新增 `harmonyTap.test.ts`（stub harmony 后端断言被调与坐标换算）

**Interfaces:**
- Consumes: Task 4/7。Produces: tap 在 harmony 上 fiber→native(hdc click/longClick)、OCR、坐标三策略可用；accessibility 策略在 harmony 跳过并如实说明。

- [ ] 步骤 1：单测先行：harmony app + fiber 定位 → native 段调用 harmonyTap（物理像素 = delivered 像素 × resolveDeliveredScaleFactor）；accessibility 跳过记录在 attempted。
- [ ] 步骤 2：实现 tap.ts harmony 分支（对齐现有 ios/android 分支结构；坐标换算复用 convertScreenshotToTapCoords 的 harmony 像素路径）。
- [ ] 步骤 3：回归 tap 套件；commit `feat(tap): harmony native and OCR strategies`。

### Task 9: Phase 2 — swipe / input_text 鸿蒙分支

**Files:**
- Modify: `src/tools/interactionTools.ts`（swipe、input_text 的 harmony 分支）
- Modify: `src/core/textEntry.ts`（typeHid harmony 路由 → harmonyInputText）
- Test: `src/__tests__/unit/swipeDirection.test.ts` 扩展、`src/__tests__/unit/textEntry.test.ts` 扩展

**Interfaces:**
- Consumes: Task 4。Produces: swipe 走 `uiInput swipe`（scroll-probe 不可得时如实说明）；input_text React 层不变，native 层走 uiInput inputText，keyboard-raise harmony 降级（见 Task 12）。

- [ ] 步骤 1：swipe harmony 分支单测（方向换算、系统条 inset 不可得时不 clamp 且说明）。
- [ ] 步骤 2：实现；input_text 的 typeHid 路由从二元改三元。
- [ ] 步骤 3：回归；commit `feat(interaction): harmony swipe and native text entry`。

### Task 10: Phase 2 — harmony_* 管理工具

**Files:**
- Modify: `src/tools/deviceTools.ts`（harmony_launch_app、harmony_list_packages、harmony_key_event、harmony_terminate_app）
- Test: `src/__tests__/unit/harmonyTools.test.ts`（stub 后端断言参数透传与输出渲染）

**Interfaces:**
- Consumes: Task 4/6（resolveHarmonyTargetKey）。
- [ ] 步骤 1：工具注册 + 单测（对齐 android_launch_app/android_list_packages/android_key_event 的 schema 与响应渲染）。
- [ ] 步骤 2：实现；`docs/tools.md` 与 guides.ts 补条目。
- [ ] 步骤 3：build + `npm run tools:json`；commit `feat(harmony): management tools`。

### Task 11: Phase 2 — hilog 原生日志

**Files:**
- Create: `src/core/logSourceHarmony.ts`
- Modify: `src/core/nativeLogs.ts`（resolveLogTargets 增 harmony targets；fetchForTarget 增 harmony 分派）
- Test: `src/__tests__/unit/logSourceHarmony.test.ts`（fixture：hilog 样本行 → 事件组）

**Interfaces:**
- Consumes: Task 6 inventory。Produces: `get_logs(source="native")` 覆盖鸿蒙。
- [ ] 步骤 1：解析 fixture 测试；步骤 2：实现（hilog 时间窗 + 域/进程过滤，输出对齐 logSourceAndroid 的事件组结构）；步骤 3：nativeLogs 分派 + 单测；commit `feat(logs): harmony native log source via hilog`。

### Task 12: Phase 3 — Keyboard 诚实降级

**Files:**
- Modify: `src/core/keyboardMetrics.ts`（错误结构化：`reason:"module-registry-unreachable"`）
- Modify: `src/tools/interactionTools.ts`（input_text 响应：React 成功 + 原生键盘不可知；dismiss_keyboard 不返回假成功）
- Test: `src/__tests__/unit/keyboardMetrics.test.ts`、`screenStateKeyboard.test.ts` 扩展
- [ ] 步骤 1-3：单测 → 实现 → commit `fix(keyboard): honest degradation when module registry unreachable`。

### Task 13: Phase 3 — appId 命名兜底

**Files:**
- Modify: `src/core/connection.ts`（get_apps 渲染处）或 appDetection 命名兜底函数
- Test: `src/__tests__/unit/appDetectionHarmony.test.ts` 扩展
- [ ] 步骤 1：`undefinedAppName@` 前缀检测单测；步骤 2：兜底链（deviceName → bundle URL 标识 → 保留原值并注明）；commit `fix(apps): fallback naming for harmony apps without a reported app name`。

### Task 14: 收尾 — 文档、指南、回归

**Files:**
- Modify: `README.md`、`docs/tools.md`、`docs/setup.md`（hdc 前置条件）、`src/core/guides.ts`
- [ ] 步骤 1：全套单测 + stub adb/xcrun/hdc 零接触检查；`npm run build` + `npm run tools:json`。
- [ ] 步骤 2：文档更新（61→65+ 工具矩阵、鸿蒙支持说明、真机验证清单引用 spec §6）。
- [ ] 步骤 3：commit `docs: harmonyos support`。

## 真机验证清单（agent 经 mcp__execbro-dev__* 执行，见 spec §6）

V1: PlatformConstants.os 实际值；`hdc list targets -v`/snapshot_display/bm dump 实际输出与解析器比对。
V2: click/longClick/swipe/keyEvent/inputText 实际生效；tap 前后 diff 与坐标对齐；hilog 过滤。
V3: debug 构建 source 符号化；undefinedAppName 兜底链。
多设备对照：鸿蒙模拟器 + Android 模拟器同机，验证 Phase 0 报错文案与零串扰。
