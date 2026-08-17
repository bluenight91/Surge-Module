# Surge 模块

本仓库包含适用于 Surge iOS/macOS 的 Surge Monitor 信息面板、
DNS-QUERY 模块，以及 Surge iOS 专用的 5GPN 蜂窝网络控制模块。

## Surge Monitor

`surge-monitor.sgmodule` 通过本机 Surge HTTP API 的 `/v1/metrics`
接口，在信息面板显示 Surge 版本、Build、系统、运行时间、内存占用及
接口累计流量，支持 Surge iOS 和 Surge Mac。

- Raw URL：[远程模块](https://raw.githubusercontent.com/bluenight91/Surge-Module/refs/heads/main/surge-monitor.sgmodule)
- 一键安装：[在 Surge 中安装](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbluenight91%2FSurge-Module%2Frefs%2Fheads%2Fmain%2Fsurge-monitor.sgmodule)

### 参数

- `API_KEY`：Surge HTTP API 密钥，安装时必须把默认 `none` 替换为
  自己的密钥。
- `API_PORT`：HTTP API 监听端口，默认 `6166`。
- `API_PROTOCOL`：连接模式，仅支持 `http` 或 `https`，须与 Surge
  的 HTTP API TLS 设置一致。

例如，参数 `API_KEY=my-key`、`API_PORT=6166`、`API_PROTOCOL=https`
对应请求：

```text
https://127.0.0.1:6166/v1/metrics
X-Key: my-key
```

请先在 Surge 中启用 HTTP API，并确保监听端口、TLS 模式和模块参数
一致。面板每 10 秒刷新一次；按照 Surge 的面板机制，自动刷新只会在
显示策略选择视图时发生。

API Key 仅通过模块参数传入，并只作为 `X-Key` 请求头发送到本机
`127.0.0.1`。HTTPS 模式仅对该本机连接跳过证书验证。

## DNS-QUERY

`dns-query.sgmodule` 通过 DoH 解析域名，支持 ECS，可选指定
`$httpClient` 策略，并提供信息面板和 `https://dns.query` 统计页。

- Raw URL：[远程模块](https://raw.githubusercontent.com/bluenight91/Surge-Module/refs/heads/main/dns-query.sgmodule)
- 一键安装：[在 Surge 中安装](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbluenight91%2FSurge-Module%2Frefs%2Fheads%2Fmain%2Fdns-query.sgmodule)

安装后可在浏览器打开 `https://dns.query` 查看统计和最近查询。
请先为 `dns.query` 启用 MITM；模块已追加该 hostname。网页里的
`/api/surge-dns` 和测延迟接口依赖本机 Surge HTTP API，未启用时
其余功能仍可用。

### 参数

- `type`：查询类型。`dual`、`A`、`AAAA`、`v4-only`、`v6-only`、
  `prefer-v4`、`prefer-v6`，或逗号分隔的 `A,AAAA`。
- `doh`：DoH URL，多个用逗号分隔。默认 `https://8.8.4.4/dns-query`。
  若使用域名而非 IP，请在 `[Host]` 为该域名加 `server:syslib`，
  避免解析自举。模块已为常见公共 DoH 域名预置该项。
- `ttl`：覆盖 TTL；留空则用上游 TTL。
- `timeout`：单个 DoH 请求超时（秒），默认 `2`。
- `edns`：ECS IP。填写具体 IP，或 `auto`（先读
  `lastNetworkInfoEvent.CN_IP`，否则用定时任务刷新的直连公网 IP）。
- `fallback`：`1` 时失败回退 Surge 默认 DNS，`0` 则返回空结果。
- `log`：`1` 打印脚本日志。
- `policy`：`$httpClient` 策略名；`0` 表示不指定。
- `flush_n` / `flush_ms`：指标落盘阈值（次数 / 毫秒），避免每次
  查询都写 `persistentStore`。
- `ring`：最近查询条数。
- `slow_ms`：超过该耗时的查询必定记入环形缓冲。
- `sample`：成功且不慢的查询记入环形缓冲的比例，`1` 为全记。
- `cronexp`：刷新直连公网 IP 并压缩统计的定时任务。

`[Host]` 中的 `* = script:DNS-QUERY Resolver` 会把未单独映射的
域名交给本模块解析。常见公共 DoH 域名已指向 `server:syslib`，
以免 DoH 自身再走脚本。

### 隐私说明

DoH 请求会把查询域名发给参数指定的上游；启用 ECS 时还会附带
客户端子网。`edns=auto` 时，定时任务会用 `DIRECT` 访问
`https://1.1.1.1/cdn-cgi/trace` 以刷新直连公网 IP。统计只保存在
Surge 本地 `persistentStore`，不会写入本仓库或其他服务。

## 5GPN 蜂窝控制

这组模块根据当前网络和蜂窝出口运营商，自动启停中国联通专用
Payload，并为一个目标域名提供条件 DNS 结果。

### 模块用途

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

### 安装顺序

1. 先安装 `CU Cellular Payload`，填写加密 DNS 参数。保持模块已安装；
   控制器会自动管理它的启用状态。
2. 再安装并启用 `5GPN 蜂窝控制器`，填写目标域名及 DNS 参数。
3. 切换一次 Wi-Fi/蜂窝网络以触发首次检测。请勿重命名
   `CU Cellular Payload`，控制器按该内部名称查找模块。

#### Surge 远程安装

| 模块 | Raw URL | 一键安装 |
| --- | --- | --- |
| CU Cellular Payload | [远程模块](https://raw.githubusercontent.com/bluenight91/Surge-Module/refs/heads/main/cu-cellular-payload.sgmodule) | [在 Surge 中安装](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbluenight91%2FSurge-Module%2Frefs%2Fheads%2Fmain%2Fcu-cellular-payload.sgmodule) |
| 5GPN 蜂窝控制器 | [远程模块](https://raw.githubusercontent.com/bluenight91/Surge-Module/refs/heads/main/5gpn-cellular-controller.sgmodule) | [在 Surge 中安装](surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2Fbluenight91%2FSurge-Module%2Frefs%2Fheads%2Fmain%2F5gpn-cellular-controller.sgmodule) |

如果 GitHub 页面不允许直接打开 `surge://`，请复制对应 Raw URL，在
Surge 的模块页面选择“安装新模块”后粘贴。

### 参数

#### CU Cellular Payload

- `ENCRYPTED_DNS_URL`：中国联通蜂窝网络使用的加密 DNS 完整 URL，
  例如 DoH、DoT 或 DoQ URL。仓库中的 `dns.example` 是保留的示例域名，
  安装时必须替换为自己的值。

#### 5GPN 蜂窝控制器

- `IPINFO_TOKEN`：IPinfo Token，仅在 IPIP 请求失败时使用。不使用
  Token 时保持默认值 `none`，脚本会将其视为空值，回退请求不带 Token。
- `TARGET_DOMAIN`：应用条件 DNS 的目标域名。默认 `example.com` 仅供
  演示，请替换。
- `WIFI_DNS`：Wi-Fi 下为目标域名返回的固定 IP。
- `UNICOM_DNS`：中国联通蜂窝下为目标域名返回的固定 IP。默认
  `192.0.2.1` 属于文档保留地址，仅供演示，请替换。
- `DNS_TTL`：Wi-Fi 和中国联通蜂窝固定 DNS 结果的缓存秒数，须为
  非负整数，默认 `3600`。

`WIFI_DNS` 和 `UNICOM_DNS` 也可填写多个 IP，使用英文逗号分隔。

### 运营商检测与回退

蜂窝网络变化后，控制器会等待出口稳定，然后强制使用 Surge 的
`DIRECT` 策略请求 `https://myip.ipip.net/json`。如果请求失败、响应
无法解析或缺少运营商信息，控制器再使用 `DIRECT` 请求 IPinfo。
IPinfo Token 为空时仍会尝试无 Token 请求。

检测到中国联通后启用 Payload；其他运营商或检测失败时关闭 Payload。
Wi-Fi 下不发起运营商查询并直接关闭 Payload。每次处理结束不设置
cooldown，只使用一个带过期保护的运行锁来避免多个检测任务并发执行。

### 参数替换与 URL 编码

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

### 隐私说明

仓库不包含 Token、私人域名、私人 DNS 地址或其他凭据。所有自定义值
仅保存在用户自己的 Surge 模块参数中。

运营商检测会把当前蜂窝出口 IP 发送给 IPIP；仅在 IPIP 失败时才发送给
IPinfo，若配置了 Token，该 Token 也会随回退请求发送给 IPinfo。请求均
使用 DIRECT。脚本只在 Surge 本地持久化运营商状态和并发锁，不会把参数
写入仓库或其他服务。