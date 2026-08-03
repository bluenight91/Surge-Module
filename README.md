# 5GPN Surge iOS 模块

这组模块根据当前网络和蜂窝出口运营商，自动启停中国联通专用
Payload，并为一个目标域名提供条件 DNS 结果。

## 模块用途

- `cu-cellular-payload.sgmodule`：中国联通蜂窝网络专用 Payload，
  为蜂窝流量设置 DIRECT 规则和参数指定的加密 DNS。
- `5gpn-cellular-controller.sgmodule`：监听网络变化。Wi-Fi 下关闭
  Payload；蜂窝网络下检测出口运营商，仅在中国联通网络启用
  Payload，并在状态切换后清理 Surge DNS 缓存。

控制器同时为参数指定的目标域名注册 DNS 脚本：

- Wi-Fi：返回 `WIFI_DNS`。
- 中国联通蜂窝：返回 `UNICOM_DNS`。
- 其他蜂窝网络、检测失败或参数为空：交回 Surge 进行正常 DNS
  查询。

## 安装顺序

1. 先安装 `CU Cellular Payload`，填写加密 DNS 参数。保持模块已安装；
   控制器会自动管理它的启用状态。
2. 再安装并启用 `5GPN 蜂窝控制器`，填写目标域名及 DNS 参数。
3. 切换一次 Wi-Fi/蜂窝网络以触发首次检测。请勿重命名
   `CU Cellular Payload`，控制器按该内部名称查找模块。

### Surge 远程安装

| 模块 | Raw URL | 一键安装 |
| --- | --- | --- |
| CU Cellular Payload | [远程模块](https://raw.githubusercontent.com/bluenight91/Surge-Module/main/cu-cellular-payload.sgmodule) | [在 Surge 中安装](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbluenight91%2FSurge-Module%2Fmain%2Fcu-cellular-payload.sgmodule) |
| 5GPN 蜂窝控制器 | [远程模块](https://raw.githubusercontent.com/bluenight91/Surge-Module/main/5gpn-cellular-controller.sgmodule) | [在 Surge 中安装](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbluenight91%2FSurge-Module%2Fmain%2F5gpn-cellular-controller.sgmodule) |

如果 GitHub 页面不允许直接打开 `surge://`，请复制对应 Raw URL，在
Surge 的模块页面选择“安装新模块”后粘贴。

## 参数

### CU Cellular Payload

- `ENCRYPTED_DNS_URL`：中国联通蜂窝网络使用的加密 DNS 完整 URL，
  例如 DoH、DoT 或 DoQ URL。仓库中的 `dns.example` 是保留的示例域名，
  安装时必须替换为自己的值。

### 5GPN 蜂窝控制器

- `IPINFO_TOKEN`：IPinfo Token，仅在 IPIP 请求失败时使用；可以留空，
  留空时回退请求不带 Token。
- `TARGET_DOMAIN`：应用条件 DNS 的目标域名。默认 `example.com` 仅供
  演示，请替换。
- `WIFI_DNS`：Wi-Fi 下为目标域名返回的固定 IP。
- `UNICOM_DNS`：中国联通蜂窝下为目标域名返回的固定 IP。默认
  `192.0.2.1` 属于文档保留地址，仅供演示，请替换。
- `DNS_TTL`：Wi-Fi 和中国联通蜂窝固定 DNS 结果的缓存秒数，须为
  非负整数，默认 `3600`。

`WIFI_DNS` 和 `UNICOM_DNS` 也可填写多个 IP，使用英文逗号分隔。

## 运营商检测与回退

蜂窝网络变化后，控制器会等待出口稳定，然后强制使用 Surge 的
`DIRECT` 策略请求 `https://myip.ipip.net/json`。如果请求失败、响应
无法解析或缺少运营商信息，控制器再使用 `DIRECT` 请求 IPinfo。
IPinfo Token 为空时仍会尝试无 Token 请求。

检测到中国联通后启用 Payload；其他运营商或检测失败时关闭 Payload。
Wi-Fi 下不发起运营商查询并直接关闭 Payload。每次处理结束不设置
cooldown，只使用一个带过期保护的运行锁来避免多个检测任务并发执行。

## 参数替换与 URL 编码

模块使用 Surge iOS 的 `#!arguments` 和 `{{{参数名}}}` 进行替换：

- Token 通过脚本 `argument` 传给 `carrier-controller.js`。
- 两个固定 DNS 结果及 `DNS_TTL` 通过脚本 `argument` 传给
  `carrier-dns.js`。
- 目标域名直接替换 `[Host]` 条目。
- 加密 DNS URL 直接替换 `[SSID Setting]`；这里需要填写原始完整 URL，
  不要手动进行百分号编码。

上方一键安装链接只对 `url=` 后的 Raw URL 编码一次。脚本自身在向
IPinfo 发送 Token 时使用 `encodeURIComponent`，避免 Token 破坏查询
字符串。

## 隐私说明

仓库不包含 Token、私人域名、私人 DNS 地址或其他凭据。所有自定义值
仅保存在用户自己的 Surge 模块参数中。

运营商检测会把当前蜂窝出口 IP 发送给 IPIP；仅在 IPIP 失败时才发送给
IPinfo，若配置了 Token，该 Token 也会随回退请求发送给 IPinfo。请求均
使用 DIRECT。脚本只在 Surge 本地持久化运营商状态和并发锁，不会把参数
写入仓库或其他服务。