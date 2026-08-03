/**
 * 按当前网络和控制器记录的运营商状态返回 DNS 结果。
 */

function parseAddresses(value) {
  return String(value || "")
    .split(",")
    .map(address => address.trim())
    .filter(Boolean);
}

const rawArgument = String(
  typeof $argument === "string" ? $argument : ""
);
const argumentParts = rawArgument.split("|");
const wifiAddresses = parseAddresses(
  argumentParts[0]
);
const unicomAddresses = parseAddresses(
  argumentParts[1]
);
const parsedTTL = Number(argumentParts[2]);
const ttl =
  Number.isFinite(parsedTTL) && parsedTTL >= 0
    ? Math.floor(parsedTTL)
    : 3600;
const ssid = $network.wifi && $network.wifi.ssid;
const carrierState = $persistentStore.read(
  "cu-cellular-carrier-state"
);

if (ssid && wifiAddresses.length > 0) {
  $done({
    addresses: wifiAddresses,
    ttl
  });
} else if (carrierState === "unicom" && unicomAddresses.length > 0) {
  $done({
    addresses: unicomAddresses,
    ttl
  });
} else {
  // 其他蜂窝网络、检测失败或参数为空时回退 Surge 正常 DNS。
  $done({});
}
