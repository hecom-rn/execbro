# 鸿蒙支持真机验证报告（V1-V3）

> 2026-09-02 · 环境：HarmonyOS 模拟器（NEXT，hdc target `127.0.0.1:5557`）+ Android `emulator-5554`
> 同机在线；RN 0.77.1 / RNOH，app `cn.hecom.cloud.har`（harmony 侧）与 `cn.hecom.crm.plus.ent`
> （android 侧）；验证经 execbro-dev HTTP server（localhost:8600，运行 feature/harmonyos-support 分支）。

## 结论

**V1、V2 全部通过（含 4 处真机回修）；V3 中 debug 构建 source 符号化与 input_text native
路径待补测**（分别需要应用侧 debug 构建与含输入框的流程）。多设备对照回归通过：P0 缺陷
（跨设备误触/假成功）已封死，Android 侧全程零串扰。

## V1 平台检测与设备层 — 通过（1 处回修）

| 项 | 结果 |
|---|---|
| platform 标注 | ✅ `get_apps` 显示 `harmony`（回修后，见缺陷 1） |
| appId 命名兜底 | ✅ "app name not reported by the app — using device name" |
| list_devices | ✅ "HarmonyOS devices (hdc)" 段 + `[RN connected on port 8082]` 关联 |
| snapshot_display/file recv | ✅ 截图 1320×2120 真实返回 |
| `hdc list targets`/`bm dump -a` 解析 | ✅ 解析器与实际输出吻合 |
| hidumper 屏幕尺寸 | ⚠️ 实际格式 `activeMode: 1320x2120`（冒号后有空格）；快照回推兜底生效，正则待放宽（已列入待办） |
| PlatformConstants.os | ❌ **RNOH 0.77 上不可达**：`nativeModuleProxy.PlatformConstants` 为空对象、`__turboModuleProxy`/`require('react-native')` 均不可用 → 缺陷 1 |

**缺陷 1（已修，commit 031f9e8）**：JS 侧探测在 RNOH 上拿不到 os 值，platform 恒为 android。
回修：`detectRnohTarget()`——扫描各 hdc target 的 hilog RNOH 标记，唯一命中者即目标，
`detectionSource` 走 hdc 关联。真机验证通过。

## V2 原生工具面 — 通过（2 处回修）

| 工具 | 结果 |
|---|---|
| harmony_screenshot | ✅ 真实鸿蒙画面，device pixels |
| get_screen_state | ✅ fiber 树/路由可读；键盘行如实显示 unknown |
| tap(testID) fiber+native | ✅（回修后）tabbarMine 切页真实生效；convertedTo 为 dumpLayout 推导的设备像素 |
| tap(text, strategy=ocr) | ✅ "设置"点击真实打开设置页 |
| tap 坐标 | ✅（截图像素直传） |
| swipe | ✅ "No Error"，页面横幅轮播位置变化证明手势真实送达 |
| harmony_key_event BACK | ✅ 设置页返回我的页 |
| harmony_list_packages | ✅ `cn.hecom.cloud.har`（filter 生效） |
| get_logs(source=native) | ✅（回修后）hilog 事件进入鸿蒙 buffer |
| input_text | ⏳ React 层已由 9/1 报告验证；native 路径（`uiInput text`）本轮流程中无输入框，待补测 |

**缺陷 2（已修，031f9e8，最高危）**：tap 的 fiber+native 在 harmony 下落入 android 分支——
`androidGetDensity(undefined)` 读 Android 默认设备的密度、`androidTap(undefined)` **把触控发到
emulator-5554** 并对鸿蒙返回 success。与 9/1 报告同级的事故，被新检测链路重新激活。
回修：harmony 分支改用 `uitest dumpLayout` 树解析（RN testID 以 `key` 出现、bounds 为设备像素）
定位元素中心后经 hdc 点击；镜像上无密度 API，dp→px 猜测路径彻底移除。

**缺陷 3（已修，72c7503 后续）**：native logs 为 0——identity.appId 是 `undefinedAppName@`
blob，pidof 解析不出 pid，归属管线全部丢弃。回修：`resolveHarmonyBundleName()` 从 dumpLayout
的 `bundleName` 属性取真实包名再解析 pid。真机验证 hilog 事件正常进入。

## V3 — 部分完成

| 项 | 结果 |
|---|---|
| appId 兜底链 | ✅ 见 V1 |
| Keyboard 降级 | ✅ get_screen_state 显示 "Keyboard: unknown (…)"；dismiss_keyboard 待复测 |
| source 符号化 | ⏳ 需应用侧出 debug 构建（DevEco），release 维持静默降级 |

## 多设备对照回归 — 通过（1 处回修）

- `android_screenshot({deviceId:"emulator"})` → **拒绝执行**，无截图落盘、无 adb 触碰 ✅
  （缺陷 4 已修：错误文案误称 "resolved to an iOS device"，改为实际平台名，4aa11d5）
- `tap({testID:"tabbarMine", device:"emulator"})` → 只作用于鸿蒙，Android 侧零反应 ✅
- `android_screenshot()`（无参，文档化默认行为）→ 照常工作（1344×2992）✅
- 全程 Android CRM app 无误触/弹窗/退出 ✅

## 补充轮（2026-09-02 下午）：未适配项补齐 — 通过（2 处真机回修）

| 项 | 结果 |
|---|---|
| tap accessibility 策略 | ✅ 接入 dumpLayout 树（testID 为 key、设备像素 bounds、包含关系收敛 + 歧义守卫）；真机 `tap({testID:"tabbarMenu"})` method=accessibility 真实切页 |
| input_text native 路径 | ✅ 真机验证：中文+数字写入搜索框（含 IME 提交延迟轮询）；发现 `uiInput text` 为**追加**语义（改尾部匹配）；发现容器节点带窗口级 focused 标记与内部 key（字段启发式收紧为仅输入类型节点）；最终 "Typed and verified …: doneZZ9" |
| get_bundle_errors 兜底 | ✅ harmony 分派已接（与 ocr_screenshot 同构）。注意：兜底门控 `metroRunning && !hasConnectedApps` 在 Metro 仍广播僵尸 target 时不可达（三平台共有的既有行为），本轮未触发到该分支 |
| parseScreenSize 空格 | ✅ 正则放宽 `activeMode: WxH` |

## 第三轮（2026-09-02）：pinch 调研定论 + dismiss_keyboard 复测

**pinch — 定论：鸿蒙不支持，如实报错（commit 6ae91d9）**
- `uitest uiInput` 子命令集无多指（click/doubleClick/longClick/swipe/drag/fling/dircFling/
  inputText/text/keyEvent）。
- `/system/bin/uinput` 二进制含 pinch 事件路径（`-p <dx> <dy> <scalePercent>`、
  ActionPinchEvent、ABS_MT_SLOT、"up to three finger"），但**真机实测全部静默无效**：
  `-p` 各参数变体（120/140/200/250、带时长）exit 0 且像素级零变化（图库发票大图、
  详情页表格、桌面三处判定面）；两指分进程 down/move/up 交错也无法合成单手势
  （每个 uinput 进程是独立虚拟设备）。hilog MMI 域无事件痕迹。
- 结论：模拟器上 uinput pinch 不生效；可行路径是 UiDriver(ArkXTest) 测试基座（另行立项）。
  工具层 harmony 报错文案已写明该调研结论。
- 顺带修复：accessibility 匹配升级为分级评分——RNOH 会在 dumpLayout key 上加后缀
  （fiber testID `tabbarMenuPage_Item_X` 实际为 `..._X_业务对象`），且只允许 dump key
  包含 testID 的单向包含（反向会让 `tabbarMenu` 误配任何更长查询）。真机复测报表项
  点击成功。

**dismiss_keyboard — 复测通过（行为正确，无代码改动）**
- 搜索框聚焦（inputMethodPanel 在场）→ dismiss_keyboard → 响应如实说明
  "Keyboard visibility could NOT be verified (Keyboard module unreachable)"，无假成功；
- dumpLayout 地面真值：键盘实际已被关闭（inputMethodPanel 消失）——React blur 在
  鸿蒙上真实生效，保守文案与正确行为并存。

## 剩余待办（P3）

1. debug 构建 source 符号化复测（需应用侧配合出 debug 包）。
2. Phase 4 调研项：hdc install、deep link（aa start 带 URI）、模拟器管理；
   pinch 若要支持需 UiDriver(ArkXTest) 基座（见第三轮定论）。
