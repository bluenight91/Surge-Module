const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("controller and Payload module names remain aligned", () => {
  const controller = read("scripts/carrier-controller.js");
  const payload = read("cu-cellular-payload.sgmodule");

  assert.match(controller, /payloadModule:\s*"CU Cellular Payload"/);
  assert.match(payload, /^#!name=CU Cellular Payload$/m);
});

test("controller keeps all event and conditional DNS entry points", () => {
  const module = read("5gpn-cellular-controller.sgmodule");
  const scriptLines = module
    .split("\n")
    .filter(line => line.includes("type="));
  const eventLines = scriptLines.filter(line => line.includes("type=event"));
  const dnsLine = scriptLines.find(line => line.includes("type=dns"));

  assert.match(module, /event-name=network-changed/);
  assert.match(module, /event-name=engine-started/);
  assert.match(module, /event-name=profile-reloaded/);
  assert.match(module, /type=dns,[^\n]*carrier-dns\.js/);
  assert.match(module, /^\{\{\{TARGET_DOMAIN\}\}\} = script:运营商条件DNS$/m);
  assert.equal(eventLines.length, 3);
  assert.ok(eventLines.every(line => line.includes("engine=webview")));
  assert.match(dnsLine, /engine=jsc$/);
});

test("Payload keeps cellular DIRECT and encrypted DNS semantics", () => {
  const payload = read("cu-cellular-payload.sgmodule");

  assert.match(
    payload,
    /^AND,\(\(SUBNET,TYPE:CELLULAR\),\(NOT,\(\(RULE-SET,\{\{\{DIRECT_EXCLUDE_URL\}\}\}\)\)\)\),DIRECT$/m
  );
  assert.match(
    payload,
    /^TYPE:CELLULAR encrypted-dns-server=\{\{\{ENCRYPTED_DNS_URL\}\}\}$/m
  );
});
