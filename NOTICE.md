# 来源与第三方组件说明

## 派生代码

| 文件 | 来源 | 说明 |
|---|---|---|
| `public/peer-stream.js` | [inveta/peer-stream](https://github.com/inveta/peer-stream) 的浏览器 SDK（`peer-stream.js`） | 在原 SDK 基础上修改：TURN/ICE 配置合并、强制中继、QoS 上报、无操作释放、播放配置等。上游仓库未声明开源许可证，对外分发前请自行确认授权 |

信令协议与 UE 像素流插件（Unreal Engine Pixel Streaming）保持兼容。

## 第三方组件

| 组件 | 位置 | 许可证 |
|---|---|---|
| [Preact](https://github.com/preactjs/preact) | `admin/vendor/preact-htm.js`（打包内置） | MIT，见 `admin/vendor/LICENSE-preact.txt` |
| [htm](https://github.com/developit/htm) | `admin/vendor/preact-htm.js`（打包内置） | Apache-2.0，见 `admin/vendor/LICENSE-htm.txt` |
| [ws](https://github.com/websockets/ws) | npm 依赖 | MIT |
| [esbuild](https://github.com/evanw/esbuild) | 打包 exe 时的开发依赖 | MIT |

## 本项目许可

`package.json` 中为 `UNLICENSED`（未授予他人使用许可）。如需开源，请由版权方选择许可证并添加 `LICENSE` 文件。
