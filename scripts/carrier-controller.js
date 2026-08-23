/**
 * Surge iOS 蜂窝运营商控制器。
 *
 * 蜂窝网络下优先通过 DIRECT 查询 IPIP，失败时回退 IPinfo。
 * 响应网络变化、引擎启动和配置重载事件。
 * 运行结束后不设置冷却期，持久化锁仅用于避免并发检测。
 */

const ipinfoTokenArgument = String(
  typeof $argument === "string" ? $argument : ""
).trim();

const CONFIG = {
  // 必须与 Payload 模块的 #!name 完全一致。
  payloadModule: "CU Cellular Payload",
  ipinfoToken:
    ipinfoTokenArgument.toLowerCase() === "none"
      ? ""
      : ipinfoTokenArgument,
  detectionDelay: 2500,
  stateKey: "cu-cellular-carrier-state",
  runningKey: "cu-cellular-controller-running",
  lockLifetime: 60000,
  unicomASNs: [
    4808,
    4837,
    9929,
    10099,
    17621,
    17622,
    17623,
    17816,
    140979
  ]
};

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function callSurgeAPI(method, path, body = null) {
  return new Promise((resolve, reject) => {
    try {
      $httpAPI(method, path, body, result => {
        if (
          method.toUpperCase() === "GET" &&
          (result === null || result === undefined)
        ) {
          reject(new Error(`${method} ${path} 没有返回数据`));
          return;
        }

        resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function directRequest(url, timeout = 12) {
  return new Promise((resolve, reject) => {
    $httpClient.get(
      {
        url,
        policy: "DIRECT",
        timeout,
        "auto-cookie": false,
        "auto-redirect": true,
        headers: {
          Accept: "application/json,text/plain,*/*",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": "Surge-iOS-Carrier-Controller"
        }
      },
      (error, response, body) => {
        if (error) {
          reject(new Error(`DIRECT 请求失败：${error}`));
          return;
        }

        const status = Number(
          response && (response.status || response.statusCode)
        );

        if (status < 200 || status >= 300) {
          reject(new Error(`DIRECT 请求 HTTP ${status || "未知"}`));
          return;
        }

        resolve(String(body || ""));
      }
    );
  });
}

function parseJSON(body, service) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${service} 响应不是有效 JSON：${body.slice(0, 120)}`);
  }
}

async function queryIPIP() {
  console.log("[运营商检测] 正在通过 DIRECT 查询 IPIP");

  const body = await directRequest(
    `https://myip.ipip.net/json?t=${Date.now()}`
  );
  const result = parseJSON(body, "IPIP");
  const rawLocation = result && result.data && result.data.location;
  let location = "";

  if (Array.isArray(rawLocation)) {
    for (const value of rawLocation) {
      const part = String(value || "").trim();

      if (part) {
        location += `${location ? " " : ""}${part}`;
      }
    }
  }

  const ip = String(
    (result && result.data && result.data.ip) || ""
  ).trim();
  const carrier = Array.isArray(rawLocation)
    ? String(rawLocation[4] || "").trim()
    : "";

  if (!ip) {
    throw new Error("IPIP 没有返回出口 IP");
  }

  if (!carrier) {
    throw new Error(
      `IPIP 没有返回运营商：${location || "空"}`
    );
  }

  console.log(
    `[运营商检测] IPIP：IP=${ip}，位置=${location}，运营商=${carrier}`
  );

  return {
    ip,
    carrier,
    org: carrier,
    source: "ipip"
  };
}

async function queryIPinfo() {
  const parameters = [`t=${Date.now()}`];

  if (CONFIG.ipinfoToken) {
    parameters.push(`token=${encodeURIComponent(CONFIG.ipinfoToken)}`);
  }

  console.log("[运营商检测] 正在通过 DIRECT 查询 IPinfo");

  const body = await directRequest(
    `https://ipinfo.io/json?${parameters.join("&")}`
  );
  const result = parseJSON(body, "IPinfo");

  if (result && result.error) {
    throw new Error(`IPinfo 错误：${JSON.stringify(result.error)}`);
  }

  if (!result || !result.ip) {
    throw new Error("IPinfo 没有返回出口 IP");
  }

  console.log(
    `[运营商检测] IPinfo：IP=${result.ip}，ORG=${result.org || "未知"}`
  );

  // 只保留后续运营商判断和通知需要的字段，尽快释放完整响应对象。
  return {
    ip: result.ip,
    org: result.org,
    carrier: result.carrier,
    asn: result.asn,
    source: "ipinfo"
  };
}

async function queryCarrierInfo() {
  try {
    return await queryIPIP();
  } catch (error) {
    console.log(
      `[运营商检测] IPIP 查询失败，回退 IPinfo：${error}`
    );
    return queryIPinfo();
  }
}

function getASN(info) {
  if (Number(info && info.asn)) {
    return Number(info.asn);
  }

  const matched = String((info && info.org) || "").match(/\bAS(\d+)\b/i);
  return matched ? Number(matched[1]) : 0;
}

function isChinaUnicom(info) {
  const asn = getASN(info);
  const carrier = info && info.carrier;
  const org = info && info.org;
  const text = carrier
    ? org
      ? `${carrier} ${org}`
      : String(carrier)
    : org
      ? String(org)
      : "";
  const matched =
    CONFIG.unicomASNs.includes(asn) ||
    /china\s*unicom|china169|cncgroup|联通/i.test(text);

  console.log(
    `[运营商检测] 来源=${info.source || "未知"}，ASN=${
      asn || "未知"
    }，运营商=${text || "未知"}，联通匹配=${matched}`
  );

  return matched;
}

async function getPayloadEnabled() {
  const modules = await callSurgeAPI("GET", "v1/modules");

  if (
    !modules ||
    !Array.isArray(modules.available) ||
    !Array.isArray(modules.enabled)
  ) {
    throw new Error("Surge 返回的模块数据格式不正确");
  }

  if (!modules.available.includes(CONFIG.payloadModule)) {
    throw new Error(`未找到模块“${CONFIG.payloadModule}”`);
  }

  return modules.enabled.includes(CONFIG.payloadModule);
}

async function setPayloadEnabled(enabled) {
  const currentlyEnabled = await getPayloadEnabled();

  if (currentlyEnabled === enabled) {
    console.log(
      `[运营商检测] Payload 已经${enabled ? "启用" : "关闭"}`
    );
    return false;
  }

  await callSurgeAPI("POST", "v1/modules", {
    [CONFIG.payloadModule]: enabled
  });
  console.log(`[运营商检测] Payload 已${enabled ? "启用" : "关闭"}`);

  return true;
}

async function flushDNS() {
  try {
    await callSurgeAPI("POST", "v1/dns/flush");
    console.log("[运营商检测] DNS 缓存已清理");
  } catch (error) {
    console.log(`[运营商检测] DNS 清理失败：${error}`);
  }
}

function saveState(state) {
  $persistentStore.write(state, CONFIG.stateKey);
}

function shouldForceDNSRefresh(triggerName) {
  // 未知入口保持原有的保守刷新行为；仅同状态 network-changed 可安全跳过。
  return triggerName !== "network-changed";
}

async function commitState(state, previousState, moduleChanged, triggerName) {
  const stateChanged = previousState !== state;

  if (stateChanged) {
    saveState(state);
  }

  if (
    stateChanged ||
    moduleChanged ||
    shouldForceDNSRefresh(triggerName)
  ) {
    await flushDNS();
  } else {
    console.log("[运营商检测] 状态未改变，跳过 DNS 缓存清理");
  }

  return stateChanged;
}

async function applyState(
  enabled,
  state,
  info = null,
  triggerName = "unknown"
) {
  const previousState = $persistentStore.read(CONFIG.stateKey);
  const moduleChanged = await setPayloadEnabled(enabled);
  const stateChanged = await commitState(
    state,
    previousState,
    moduleChanged,
    triggerName
  );

  if (!stateChanged && !moduleChanged) {
    console.log("[运营商检测] 状态未改变，不发送重复通知");
    return;
  }

  const detail = state === "wifi"
    ? `SSID：${($network.wifi && $network.wifi.ssid) || "未知"}`
    : `${(info && info.source) || "未知来源"} · ${
        (info && info.ip) || "未知 IP"
      } · ${(info && (info.carrier || info.org)) || "未知运营商"}`;
  const subtitle = enabled
    ? "中国联通：Payload 已启用"
    : state === "wifi"
      ? "Wi-Fi：Payload 已关闭"
      : "非中国联通：Payload 已关闭";

  $notification.post("Surge 蜂窝运营商检测", subtitle, detail);
}

async function failClosed(error, triggerName = "unknown") {
  console.log(`[运营商检测] 检测失败：${error}`);

  const previousState = $persistentStore.read(CONFIG.stateKey);
  let moduleChanged = false;

  try {
    moduleChanged = await setPayloadEnabled(false);
  } catch (moduleError) {
    console.log(`[运营商检测] 关闭 Payload 失败：${moduleError}`);
  }

  const stateChanged = await commitState(
    "detection-failed",
    previousState,
    moduleChanged,
    triggerName
  );

  if (stateChanged || moduleChanged) {
    $notification.post(
      "Surge 运营商检测失败",
      "已关闭联通蜂窝功能",
      String(error)
    );
  }
}

function acquireLock() {
  const now = Date.now();
  const runningAt = Number(
    $persistentStore.read(CONFIG.runningKey) || 0
  );

  if (runningAt && now - runningAt < CONFIG.lockLifetime) {
    console.log("[运营商检测] 已有任务正在执行，本次跳过");
    return false;
  }

  $persistentStore.write(String(now), CONFIG.runningKey);
  return true;
}

function releaseLock() {
  $persistentStore.write("0", CONFIG.runningKey);
}

function getTriggerName() {
  if (
    typeof $event === "object" &&
    $event &&
    typeof $event.name === "string"
  ) {
    return $event.name;
  }

  return "unknown";
}

async function main() {
  if (!acquireLock()) {
    return;
  }

  const triggerName = getTriggerName();

  try {
    console.log(`[运营商检测] 触发事件=${triggerName}`);

    const initialSSID = $network.wifi && $network.wifi.ssid;

    if (initialSSID) {
      console.log(`[运营商检测] 当前为 Wi-Fi：${initialSSID}`);
      await applyState(false, "wifi", null, triggerName);
      return;
    }

    console.log("[运营商检测] 当前为蜂窝网络，等待出口稳定");
    await sleep(CONFIG.detectionDelay);

    const currentSSID = $network.wifi && $network.wifi.ssid;

    if (currentSSID) {
      console.log(`[运营商检测] 等待期间连接 Wi-Fi：${currentSSID}`);
      await applyState(false, "wifi", null, triggerName);
      return;
    }

    const info = await queryCarrierInfo();
    const unicom = isChinaUnicom(info);

    await applyState(
      unicom,
      unicom ? "unicom" : "other-cellular",
      info,
      triggerName
    );
  } catch (error) {
    await failClosed(error, triggerName);
  } finally {
    releaseLock();
  }
}

main()
  .catch(error => {
    console.log(`[运营商检测] 未处理错误：${error}`);
  })
  .finally(() => {
    $done();
  });
