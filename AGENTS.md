# AGENTS.md

## Cursor Cloud specific instructions

This repo is a set of **Surge iOS** modules, not a buildable/runnable server or web app:

- `*.sgmodule` — Surge iOS configuration modules (declarative).
- `scripts/carrier-controller.js`, `scripts/carrier-dns.js` — JavaScript that runs inside
  Surge's on-device JSC engine. They depend on Surge-only globals such as `$httpClient`,
  `$httpAPI`, `$persistentStore`, `$notification`, `$network`, `$argument`, and `$done`,
  which do **not** exist in Node.js. There is intentionally no `package.json`, dependency
  manifest, build step, or test framework.

Because the runtime is iOS-only, the scripts cannot be executed as-is on this Linux VM.
Practical development on the VM is limited to editing files and validating them:

- Lint / build equivalent: `node --check scripts/carrier-controller.js` and
  `node --check scripts/carrier-dns.js` (syntax validation). `node` (v22) is preinstalled.
- To exercise the actual logic end-to-end, run the scripts inside a stub that provides the
  Surge globals (e.g. via Node's `vm` module) — inject fakes for `$httpClient`/`$httpAPI`
  (return canned IPIP/IPinfo JSON and a fake `v1/modules` state), `$persistentStore`
  (in-memory), `$network.wifi.ssid`, `$argument`, and `$done`. This is how the "does the
  carrier detection actually toggle the payload / does the DNS script return the right
  addresses" checks are done without a device. Keep such harnesses out of the repo (they
  are test scaffolding, not part of the published modules).
- Real end-to-end verification happens by installing the modules in the Surge iOS app
  (see `README.md` for install order and the `#!arguments` parameters).

There are no dependencies to install, so the startup update script is effectively a no-op.
