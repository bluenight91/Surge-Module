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
  state = "wifi",
  payloadEnabled = false,
  responses = []
} = {}) {
  const store = new Map();
  const storeReads = [];
  const storeWrites = [];
  const apiCalls = [];
  const requests = [];
  const notifications = [];
  const logs = [];
  let doneCount = 0;
  let currentPayloadEnabled = payloadEnabled;
  const responseQueue = responses.slice();

  if (state !== undefined) {
    store.set("cu-cellular-carrier-state", state);
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
    setTimeout(callback) {
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
