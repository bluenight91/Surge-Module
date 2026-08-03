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
const separator = rawArgument.indexOf("|");
const wifiAddresses = parseAddresses(
  separator >= 0 ? rawArgument.slice(0, separator) : rawArgument
);
const unicomAddresses = parseAddresses(
  separator >= 0 ? rawArgument.slice(separator + 1) : ""
);
const ssid = $network.wifi && $network.wifi.ssid;
const carrierState = $persistentStore.read(
  "cu-cellular-carrier-state"
);

if (ssid && wifiAddresses.length > 0) {
  $done({
    addresses: wifiAddresses,
    ttl: 3600
  });
} else if (carrierState === "unicom" && unicomAddresses.length > 0) {
  $done({
    addresses: unicomAddresses,
    ttl: 3600
  });
} else {
  // 其他蜂窝网络、检测失败或参数为空时回退 Surge 正常 DNS。
  $done({});
}
