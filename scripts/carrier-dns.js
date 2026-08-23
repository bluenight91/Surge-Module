/**
 * 按当前网络和控制器记录的运营商状态返回 DNS 结果。
 */

function parseAddresses(value) {
  const source = String(value || "");
  const addresses = [];
  let start = 0;

  while (start <= source.length) {
    const separator = source.indexOf(",", start);
    const address = source
      .slice(start, separator === -1 ? source.length : separator)
      .trim();

    if (address) {
      addresses.push(address);
    }

    if (separator === -1) {
      break;
    }

    start = separator + 1;
  }

  return addresses;
}

function getArgumentPart(value, index) {
  let start = 0;

  for (let current = 0; current <= index; current += 1) {
    const separator = value.indexOf("|", start);

    if (current === index) {
      return separator === -1
        ? value.slice(start)
        : value.slice(start, separator);
    }

    if (separator === -1) {
      return "";
    }

    start = separator + 1;
  }

  return "";
}

function parseTTL(value) {
  const rawTTL = String(value || "").trim();
  const parsedTTL = Number(rawTTL);

  return rawTTL &&
    Number.isInteger(parsedTTL) &&
    parsedTTL >= 0 &&
    parsedTTL <= 2147483647
    ? parsedTTL
    : 3600;
}

function resolveFixedDNS(rawArgument, addressIndex) {
  const addresses = parseAddresses(
    getArgumentPart(rawArgument, addressIndex)
  );

  if (addresses.length === 0) {
    return null;
  }

  return {
    addresses,
    ttl: parseTTL(getArgumentPart(rawArgument, 2))
  };
}

function resolveDNS() {
  const rawArgument = String(
    typeof $argument === "string" ? $argument : ""
  );
  const ssid = $network.wifi && $network.wifi.ssid;

  if (ssid) {
    const wifiResult = resolveFixedDNS(rawArgument, 0);

    if (wifiResult) {
      return wifiResult;
    }
  }

  const carrierState = $persistentStore.read(
    "cu-cellular-carrier-state"
  );

  if (carrierState !== "unicom") {
    // 其他蜂窝网络或检测失败时交回 Surge 正常 DNS。
    return {};
  }

  // 保留旧行为：Wi-Fi 地址为空时仍允许联通状态回退到联通地址。
  return resolveFixedDNS(rawArgument, 1) || {};
}

$done(resolveDNS());
