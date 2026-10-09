# 第三方代码与许可

本项目是 `dsh-workbuddy-console`（作者 dhdbvcg）与 `dsh-connect-trae`
（作者 dingminhua）的合并版：两个桌面 App 的模型各作为一个独立 provider
接入 DeepSeek Harness，并在设置里共用一张四标签页管理页。

合并方式是**原样并入、不改上游代码**，因此两份上游的版权声明都必须保留。

## 1. dsh-workbuddy-xdpool

- **来源**：https://github.com/XDTrees/dsh-workbuddy-xdpool
- **作者**：XDTrees
- **许可**：MIT（`Copyright (c) 2026 XDTrees`）
- **位置**：`vendor/xdpool/`
- **并入版本**：见 `vendor/xdpool/README.md`

保留内容：

- `vendor/xdpool/LICENSE-ORIGINAL` —— 原作者的 MIT 声明，**请勿删除**
- `vendor/xdpool/lib/*` —— 运行时代码，便于与上游对照升级

其中 `vendor/xdpool/lib/dsml-bridge.mjs` 是本项目的**新增文件**（不是上游文件），
用于修复 WorkBuddy 网关的文本重复与工具调用漏成文本两个问题；
`vendor/xdpool/lib/index.js` 有一处本地修复（`legacyContext()`，工具定义传递）。

## 2. dsh-connect-trae

- **来源**：https://github.com/dingminhua/dsh-connect-trae
- **作者**：dingminhua（LaoDing）
- **许可**：MIT（`Copyright (c) 2026 LaoDing`）
- **位置**：`lib/trae.js`（宿主半边）、`vendor/trae/client.js`（浏览器半边）

这两个文件是对上游 `lib/index.js` 与 `lib/client.js` 的**逐字节拷贝，未做修改**。
另有 `icons/` 下的图标同样来自该上游项目。

### 为什么合并

两个插件各自注册 provider、各自有一张设置卡片，配置入口分散；
合并后仍是两个独立 provider（`workbuddy-xdpool` / `trae` 等），
但只需安装一个包、一处管理页。

## 3. 其它说明

- 本仓库的 `LICENSE` 是本项目自身的 MIT（`Copyright (c) 2026 dhdbvcg`），
  **不覆盖**上面两份第三方代码原有的许可。
- 上游代码不因并入本仓库而改变其版权归属；两处 MIT 声明必须随分发携带。
