const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "carrier-controller.js"),
  "utf8"
);

async function runController({
  eventName = "network-changed",
  ssid = "Test Wi-Fi",
  state,
  payloadEnabled = false,
  responses = [],
  store: suppliedStore = null,
  now = 1000000,
  onSleep = null
} = {}) {
  const store = suppliedStore || new Map();
  const storeReads = [];
  const storeWrites = [];
  const apiCalls = [];
  const requests = [];
  const notifications = [];
  const logs = [];
  let doneCount = 0;
  let currentPayloadEnabled = payloadEnabled;
  let currentNow = now;
  const responseQueue = responses.slice();

  if (state !== undefined) {
    store.set("cu-cellular-carrier-state", state);
  } else if (!suppliedStore) {
    store.set("cu-cellular-carrier-state", "wifi");
  }

  const context = {
    $argument: "none",
    $event: { name: eventName },
    $network: { wifi: { ssid } },
    $persistentStore: {
      read(key) {
        storeReads.push(key);
        return store.get(key);
      },
      write(value, key) {
        storeWrites.push({ key, value });
        store.set(key, value);
        return true;
      }
    },
    $httpAPI(method, apiPath, body, callback) {
      apiCalls.push({ method, path: apiPath, body });

      if (method === "GET" && apiPath === "v1/modules") {
        callback({
          available: ["CU Cellular Payload", "Other Module"],
          enabled: currentPayloadEnabled
            ? ["CU Cellular Payload"]
            : []
        });
        return;
      }

      if (method === "POST" && apiPath === "v1/modules") {
        currentPayloadEnabled = Boolean(body["CU Cellular Payload"]);
      }

      callback({});
    },
    $httpClient: {
      get(options, callback) {
        requests.push(options);
        const response = responseQueue.shift();

        if (!response || response.error) {
          callback(
            response ? response.error : "missing mock response",
            null,
            null
          );
          return;
        }

        callback(
          null,
          { status: response.status || 200 },
          typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body)
        );
      }
    },
    $notification: {
      post(...args) {
        notifications.push(args);
      }
    },
    $done() {
      doneCount += 1;
    },
    console: {
      log(message) {
        logs.push(message);
      }
    },
    Date: {
      now() {
        return currentNow;
      }
    },
    setTimeout(callback, milliseconds = 0) {
      currentNow += Number(milliseconds) || 0;

      if (onSleep) {
        onSleep({ milliseconds, store });
      }

      callback();
      return 0;
    }
  };

  await vm.runInNewContext(script, context, {
    filename: "carrier-controller.js"
  });

  return {
    apiCalls,
    doneCount,
    logs,
    notifications,
    now: currentNow,
    payloadEnabled: currentPayloadEnabled,
    requests,
    store,
    storeReads,
    storeWrites
  };
}

function callsTo(result, method, apiPath) {
  return result.apiCalls.filter(
    call => call.method === method && call.path === apiPath
  );
}

function stateWrites(result) {
  return result.storeWrites.filter(
    write => write.key === "cu-cellular-carrier-state"
  );
}

test("same-state Wi-Fi network change skips redundant writes and DNS flush", async () => {
  const result = await runController();

  assert.equal(callsTo(result, "GET", "v1/modules").length, 1);
  assert.equal(callsTo(result, "POST", "v1/modules").length, 0);
  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 0);
  assert.equal(stateWrites(result).length, 0);
  assert.equal(result.notifications.length, 0);
  assert.equal(result.doneCount, 1);
});

test("profile reload still refreshes DNS when state is unchanged", async () => {
  const result = await runController({ eventName: "profile-reloaded" });

  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(stateWrites(result).length, 0);
  assert.equal(result.notifications.length, 0);
});

test("locked profile reload waits and performs its required DNS refresh", async () => {
  const store = new Map([
    ["cu-cellular-carrier-state", "wifi"],
    ["cu-cellular-controller-running", "1000000"]
  ]);
  let released = false;
  const result = await runController({
    eventName: "profile-reloaded",
    state: undefined,
    store,
    now: 1000100,
    onSleep({ store: sharedStore }) {
      if (!released) {
        released = true;
        sharedStore.set("cu-cellular-controller-running", "0");
      }
    }
  });

  assert.equal(callsTo(result, "GET", "v1/modules").length, 0);
  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(
    store.get("cu-cellular-controller-pending-reload"),
    "0"
  );
  assert.ok(
    result.logs.some(log => log.includes("配置重载已排队"))
  );
});

test("active task consumes a queued reload before releasing its lock", async () => {
  const store = new Map([
    ["cu-cellular-carrier-state", "wifi"],
    ["cu-cellular-controller-pending-reload", "1"]
  ]);
  const result = await runController({
    state: undefined,
    store
  });

  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(
    store.get("cu-cellular-controller-pending-reload"),
    "0"
  );
  assert.ok(
    result.logs.some(log => log.includes("正在处理排队的配置重载"))
  );
});

test("queued reload does not duplicate a DNS refresh already completed", async () => {
  const store = new Map([
    ["cu-cellular-carrier-state", "unicom"],
    ["cu-cellular-controller-pending-reload", "1"]
  ]);
  const result = await runController({
    state: undefined,
    store,
    payloadEnabled: true
  });

  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(
    store.get("cu-cellular-controller-pending-reload"),
    "0"
  );
  assert.ok(
    result.logs.some(log => log.includes("已由当前任务刷新 DNS"))
  );
});

test("Wi-Fi transition disables Payload, stores state, and flushes DNS", async () => {
  const result = await runController({
    state: "unicom",
    payloadEnabled: true
  });

  assert.equal(result.payloadEnabled, false);
  assert.equal(callsTo(result, "POST", "v1/modules").length, 1);
  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.deepEqual(stateWrites(result), [
    { key: "cu-cellular-carrier-state", value: "wifi" }
  ]);
  assert.equal(result.notifications.length, 1);
});

test("IPIP Unicom response enables Payload with compact carrier data", async () => {
  const result = await runController({
    ssid: null,
    state: "other-cellular",
    responses: [
      {
        body: {
          data: {
            ip: "198.51.100.10",
            location: ["中国", "北京", "", "", "中国联通"]
          }
        }
      }
    ]
  });

  assert.equal(result.requests.length, 1);
  assert.equal(result.payloadEnabled, true);
  assert.equal(result.store.get("cu-cellular-carrier-state"), "unicom");
  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(result.notifications.length, 1);
});

test("Payload feedback event skips delay, carrier lookup, and module API", async () => {
  const first = await runController({
    ssid: null,
    state: "other-cellular",
    responses: [
      {
        body: {
          data: {
            ip: "198.51.100.12",
            location: ["中国", "广东", "", "", "中国联通"]
          }
        }
      }
    ]
  });
  const marker = first.store.get("cu-cellular-controller-feedback");

  assert.match(marker, /\|unicom$/);

  const duplicate = await runController({
    ssid: null,
    state: undefined,
    payloadEnabled: true,
    store: first.store,
    now: first.now + 500
  });

  assert.equal(duplicate.requests.length, 0);
  assert.equal(duplicate.apiCalls.length, 0);
  assert.equal(duplicate.now, first.now + 500);
  assert.equal(
    duplicate.store.get("cu-cellular-controller-feedback"),
    "0"
  );
  assert.ok(
    duplicate.logs.some(log => log.includes("已忽略 Payload 切换"))
  );
});

test("suppressed feedback event still completes a pending reload refresh", async () => {
  const store = new Map([
    ["cu-cellular-carrier-state", "unicom"],
    ["cu-cellular-controller-feedback", "1000000|unicom"],
    ["cu-cellular-controller-pending-reload", "1"]
  ]);
  const result = await runController({
    ssid: null,
    state: undefined,
    payloadEnabled: true,
    store,
    now: 1000500
  });

  assert.equal(result.requests.length, 0);
  assert.equal(callsTo(result, "GET", "v1/modules").length, 0);
  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(
    store.get("cu-cellular-controller-pending-reload"),
    "0"
  );
});

test("feedback marker never suppresses a real Wi-Fi/cellular type change", async () => {
  const store = new Map([
    ["cu-cellular-carrier-state", "unicom"],
    ["cu-cellular-controller-feedback", "1000000|unicom"]
  ]);
  const result = await runController({
    ssid: "Test Wi-Fi",
    state: undefined,
    payloadEnabled: true,
    store,
    now: 1000500
  });

  assert.equal(result.payloadEnabled, false);
  assert.equal(callsTo(result, "GET", "v1/modules").length, 1);
  assert.equal(callsTo(result, "POST", "v1/modules").length, 1);
  assert.equal(store.get("cu-cellular-carrier-state"), "wifi");
});

test("same carrier state repairs externally disabled Payload and flushes DNS", async () => {
  const result = await runController({
    ssid: null,
    state: "unicom",
    payloadEnabled: false,
    responses: [
      {
        body: {
          data: {
            ip: "198.51.100.11",
            location: ["中国", "上海", "", "", "中国联通"]
          }
        }
      }
    ]
  });

  assert.equal(result.payloadEnabled, true);
  assert.equal(stateWrites(result).length, 0);
  assert.equal(callsTo(result, "POST", "v1/modules").length, 1);
  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(result.notifications.length, 1);
});

test("IPIP and IPinfo failures retain fail-closed behavior", async () => {
  const result = await runController({
    ssid: null,
    state: "unicom",
    payloadEnabled: true,
    responses: [
      { error: "IPIP unavailable" },
      { error: "IPinfo unavailable" }
    ]
  });

  assert.equal(result.requests.length, 2);
  assert.equal(result.payloadEnabled, false);
  assert.equal(
    result.store.get("cu-cellular-carrier-state"),
    "detection-failed"
  );
  assert.equal(callsTo(result, "POST", "v1/dns/flush").length, 1);
  assert.equal(result.notifications.length, 1);
});
