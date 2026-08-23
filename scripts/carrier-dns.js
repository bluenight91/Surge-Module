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

function resolveDNS() {
  const rawArgument = String(
    typeof $argument === "string" ? $argument : ""
  );
  const ssid = $network.wifi && $network.wifi.ssid;
  let addressArgument;

  if (ssid) {
    addressArgument = getArgumentPart(rawArgument, 0);
  } else {
    const carrierState = $persistentStore.read(
      "cu-cellular-carrier-state"
    );

    if (carrierState !== "unicom") {
      // 其他蜂窝网络或检测失败时交回 Surge 正常 DNS。
      return {};
    }

    addressArgument = getArgumentPart(rawArgument, 1);
  }

  const addresses = parseAddresses(addressArgument);

  if (addresses.length === 0) {
    // 当前网络对应参数为空时交回 Surge 正常 DNS。
    return {};
  }

  return {
    addresses,
    ttl: parseTTL(getArgumentPart(rawArgument, 2))
  };
}

$done(resolveDNS());
