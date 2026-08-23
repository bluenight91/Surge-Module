const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "carrier-dns.js"),
  "utf8"
);

function runDNS({
  argument = "127.0.0.1|192.0.2.1|3600",
  ssid = null,
  state = "other-cellular"
} = {}) {
  const storeReads = [];
  let doneValue;
  let doneCount = 0;

  vm.runInNewContext(
    script,
    {
      $argument: argument,
      $network: { wifi: { ssid } },
      $persistentStore: {
        read(key) {
          storeReads.push(key);
          return state;
        }
      },
      $done(value) {
        doneCount += 1;
        doneValue = value;
      }
    },
    { filename: "carrier-dns.js" }
  );

  return {
    doneCount,
    result: JSON.parse(JSON.stringify(doneValue)),
    storeReads
  };
}

test("Wi-Fi returns only Wi-Fi addresses without reading carrier state", () => {
  const execution = runDNS({
    argument: " 127.0.0.1, 127.0.0.2 ||600",
    ssid: "Test Wi-Fi",
    state: "unicom"
  });

  assert.deepEqual(execution.result, {
    addresses: ["127.0.0.1", "127.0.0.2"],
    ttl: 600
  });
  assert.deepEqual(execution.storeReads, []);
  assert.equal(execution.doneCount, 1);
});

test("Unicom cellular returns only Unicom addresses", () => {
  const execution = runDNS({
    argument: "127.0.0.1| 192.0.2.1, 192.0.2.2 |1800",
    state: "unicom"
  });

  assert.deepEqual(execution.result, {
    addresses: ["192.0.2.1", "192.0.2.2"],
    ttl: 1800
  });
  assert.deepEqual(execution.storeReads, [
    "cu-cellular-carrier-state"
  ]);
});

test("other cellular state falls back without parsing fixed addresses", () => {
  const execution = runDNS({
    argument: "127.0.0.1|192.0.2.1|not-a-number",
    state: "other-cellular"
  });

  assert.deepEqual(execution.result, {});
  assert.deepEqual(execution.storeReads, [
    "cu-cellular-carrier-state"
  ]);
});

test("empty selected address list falls back to normal DNS", () => {
  assert.deepEqual(
    runDNS({
      argument: "127.0.0.1| , |3600",
      state: "unicom"
    }).result,
    {}
  );
});

test("invalid TTL keeps the existing 3600-second default", () => {
  assert.equal(
    runDNS({
      argument: "127.0.0.1|192.0.2.1|-1",
      state: "unicom"
    }).result.ttl,
    3600
  );
  assert.equal(
    runDNS({
      argument: "127.0.0.1|192.0.2.1|2147483648",
      state: "unicom"
    }).result.ttl,
    3600
  );
});

test("TTL boundary values and extra argument fields preserve split semantics", () => {
  assert.equal(
    runDNS({
      argument: "127.0.0.1|192.0.2.1|0|ignored",
      state: "unicom"
    }).result.ttl,
    0
  );
  assert.equal(
    runDNS({
      argument: "127.0.0.1|192.0.2.1|2147483647",
      state: "unicom"
    }).result.ttl,
    2147483647
  );
});
