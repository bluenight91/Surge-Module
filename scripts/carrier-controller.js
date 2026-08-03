/**
 * Surge iOS 蜂窝运营商控制器。
 *
 * 蜂窝网络下优先通过 DIRECT 查询 IPIP，失败时回退 IPinfo。
 * 运行结束后不设置冷却期，持久化锁仅用于避免并发检测。
 */

const CONFIG = {
  // 必须与 Payload 模块的 #!name 完全一致。
  payloadModule: "CU Cellular Payload",
  ipinfoToken: String(
    typeof $argument === "string" ? $argument : ""
  ).trim(),
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
  const location = Array.isArray(rawLocation)
    ? rawLocation.map(value => String(value || "").trim()).filter(Boolean)
    : [];
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
      `IPIP 没有返回运营商：${location.join(" ") || "空"}`
    );
  }

  console.log(
    `[运营商检测] IPIP：IP=${ip}，位置=${location.join(" ")}，运营商=${carrier}`
  );

  return {
    ip,
    carrier,
    org: carrier,
    location,
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

  result.source = "ipinfo";
  console.log(
    `[运营商检测] IPinfo：IP=${result.ip}，ORG=${result.org || "未知"}`
  );

  return result;
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
  const text = [info && info.carrier, info && info.org]
    .filter(Boolean)
    .join(" ");
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

async function getModules() {
  const modules = await callSurgeAPI("GET", "v1/modules");

  if (
    !modules ||
    !Array.isArray(modules.available) ||
    !Array.isArray(modules.enabled)
  ) {
    throw new Error("Surge 返回的模块数据格式不正确");
  }

  return modules;
}

async function setPayloadEnabled(enabled) {
  const modules = await getModules();

  if (!modules.available.includes(CONFIG.payloadModule)) {
    throw new Error(`未找到模块“${CONFIG.payloadModule}”`);
  }

  const currentlyEnabled = modules.enabled.includes(CONFIG.payloadModule);

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

async function applyState(enabled, state, info = null) {
  const previousState = $persistentStore.read(CONFIG.stateKey);
  const moduleChanged = await setPayloadEnabled(enabled);

  saveState(state);
  // 状态及模块切换完成后清理旧解析结果。
  await flushDNS();

  if (previousState === state && !moduleChanged) {
    console.log("[运营商检测] 状态未改变，不发送重复通知");
    return;
  }

  const detail =
    state === "wifi"
      ? `SSID：${($network.wifi && $network.wifi.ssid) || "未知"}`
      : [
          (info && info.source) || "未知来源",
          (info && info.ip) || "未知 IP",
          (info && (info.carrier || info.org)) || "未知运营商"
        ].join(" · ");
  const subtitle = enabled
    ? "中国联通：Payload 已启用"
    : state === "wifi"
      ? "Wi-Fi：Payload 已关闭"
      : "非中国联通：Payload 已关闭";

  $notification.post("Surge 蜂窝运营商检测", subtitle, detail);
}

async function failClosed(error) {
  console.log(`[运营商检测] 检测失败：${error}`);

  const previousState = $persistentStore.read(CONFIG.stateKey);
  let moduleChanged = false;

  try {
    moduleChanged = await setPayloadEnabled(false);
  } catch (moduleError) {
    console.log(`[运营商检测] 关闭 Payload 失败：${moduleError}`);
  }

  saveState("detection-failed");
  await flushDNS();

  if (previousState !== "detection-failed" || moduleChanged) {
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

async function main() {
  if (!acquireLock()) {
    return;
  }

  try {
    const initialSSID = $network.wifi && $network.wifi.ssid;

    if (initialSSID) {
      console.log(`[运营商检测] 当前为 Wi-Fi：${initialSSID}`);
      await applyState(false, "wifi");
      return;
    }

    console.log("[运营商检测] 当前为蜂窝网络，等待出口稳定");
    await sleep(CONFIG.detectionDelay);

    const currentSSID = $network.wifi && $network.wifi.ssid;

    if (currentSSID) {
      console.log(`[运营商检测] 等待期间连接 Wi-Fi：${currentSSID}`);
      await applyState(false, "wifi");
      return;
    }

    const info = await queryCarrierInfo();
    const unicom = isChinaUnicom(info);

    await applyState(
      unicom,
      unicom ? "unicom" : "other-cellular",
      info
    );
  } catch (error) {
    await failClosed(error);
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
