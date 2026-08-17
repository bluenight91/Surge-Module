/* generated from lib/metrics.js + src/cron-main.js — do not edit by hand */

/**
 * Compact DNS metrics with a ring buffer.
 * Designed so the DNS hot path can skip most $persistentStore writes.
 */
var Metrics = (function () {
  var STORE_KEY = "dns-query-metrics";
  var PUBLIC_IP_KEY = "dns-query-public-ip";
  var MEM_KEY = "__DNS_QUERY_MEM__";

  function emptyState() {
    return {
      v: 1,
      startedAt: Date.now(),
      lastFlush: 0,
      dirty: 0,
      stats: {
        total: 0,
        ok: 0,
        fail: 0,
        fallback: 0,
        empty: 0,
        sumMs: 0,
        maxMs: 0,
        minMs: 0,
        byServer: {},
      },
      ring: [],
      lastEdns: "",
      publicIp: "",
    };
  }

  function load(raw) {
    if (!raw) return emptyState();
    try {
      var parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!parsed || parsed.v !== 1 || !parsed.stats) return emptyState();
      if (!parsed.ring) parsed.ring = [];
      if (!parsed.stats.byServer) parsed.stats.byServer = {};
      parsed.dirty = parsed.dirty || 0;
      return parsed;
    } catch (e) {
      return emptyState();
    }
  }

  function serialize(state) {
    return JSON.stringify({
      v: 1,
      startedAt: state.startedAt,
      lastFlush: state.lastFlush,
      dirty: 0,
      stats: state.stats,
      ring: state.ring,
      lastEdns: state.lastEdns || "",
      publicIp: state.publicIp || "",
    });
  }

  function record(state, entry, opts) {
    opts = opts || {};
    var ringLimit = opts.ringLimit || 80;
    var sample = opts.sample == null ? 1 : Number(opts.sample);
    var slowMs = opts.slowMs || 200;
    var stats = state.stats;
    var ms = Number(entry.ms) || 0;

    stats.total += 1;
    stats.sumMs += ms;
    if (ms > stats.maxMs) stats.maxMs = ms;
    if (stats.minMs === 0 || (ms > 0 && ms < stats.minMs)) stats.minMs = ms;

    if (entry.ok) stats.ok += 1;
    else stats.fail += 1;
    if (entry.fallback) stats.fallback += 1;
    if (entry.empty) stats.empty += 1;

    if (entry.server) {
      var row = stats.byServer[entry.server];
      if (!row) {
        row = { n: 0, ok: 0, sumMs: 0 };
        stats.byServer[entry.server] = row;
      }
      row.n += 1;
      row.sumMs += ms;
      if (entry.ok) row.ok += 1;
    }

    if (entry.edns) state.lastEdns = entry.edns;

    var take =
      sample >= 1 ||
      !entry.ok ||
      ms >= slowMs ||
      Math.random() < sample;

    if (take) {
      state.ring.push({
        ts: entry.ts || Date.now(),
        domain: entry.domain || "",
        ms: ms,
        ok: !!entry.ok,
        fallback: !!entry.fallback,
        empty: !!entry.empty,
        server: entry.server || "",
        addresses: (entry.addresses || []).slice(0, 8),
        ttl: entry.ttl || 0,
        error: entry.error ? String(entry.error).slice(0, 160) : "",
        types: entry.types || "",
      });
      if (state.ring.length > ringLimit) {
        state.ring.splice(0, state.ring.length - ringLimit);
      }
    }

    state.dirty = (state.dirty || 0) + 1;
    return state;
  }

  function shouldFlush(state, opts) {
    opts = opts || {};
    var flushN = opts.flushN || 8;
    var flushMs = opts.flushMs || 3000;
    var force = !!opts.force;
    if (force) return true;
    if (!state.dirty) return false;
    if (state.dirty >= flushN) return true;
    if (!state.lastFlush) return true;
    return Date.now() - state.lastFlush >= flushMs;
  }

  function markFlushed(state) {
    state.dirty = 0;
    state.lastFlush = Date.now();
    return state;
  }

  function avgMs(stats) {
    if (!stats || !stats.total) return 0;
    return Math.round(stats.sumMs / stats.total);
  }

  function getMem() {
    var root = typeof globalThis !== "undefined" ? globalThis : this;
    return root[MEM_KEY];
  }

  function setMem(state) {
    var root = typeof globalThis !== "undefined" ? globalThis : this;
    root[MEM_KEY] = state;
    return state;
  }

  return {
    STORE_KEY: STORE_KEY,
    PUBLIC_IP_KEY: PUBLIC_IP_KEY,
    MEM_KEY: MEM_KEY,
    emptyState: emptyState,
    load: load,
    serialize: serialize,
    record: record,
    shouldFlush: shouldFlush,
    markFlushed: markFlushed,
    avgMs: avgMs,
    getMem: getMem,
    setMem: setMem,
  };
})();


/**
 * Cron: compact metrics on disk and refresh the direct public IP used by edns=auto.
 * Relies on Metrics being present (concatenated by build.js).
 */
(function () {
  var arg = {};
  if (typeof $argument !== "undefined" && $argument) {
    try {
      arg = Object.fromEntries(new URLSearchParams($argument).entries());
    } catch (e) {
      arg = {};
    }
  }

  function readStore(key) {
    try {
      return $persistentStore.read(key);
    } catch (e) {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      return $persistentStore.write(value, key);
    } catch (e) {
      return false;
    }
  }

  function httpGet(opt) {
    return new Promise(function (resolve, reject) {
      $httpClient.get(opt, function (error, response, body) {
        if (error || !response) {
          reject(new Error(error || "empty response"));
          return;
        }
        resolve(body);
      });
    });
  }

  function refreshPublicIp() {
    var edns = String(arg.edns || "");
    if (edns && edns !== "auto") {
      return Promise.resolve(edns);
    }
    return httpGet({
      url: "https://1.1.1.1/cdn-cgi/trace",
      policy: "DIRECT",
      timeout: 5,
    }).then(function (body) {
      var ip = parseTraceIp(body);
      if (!ip) throw new Error("no ip in trace");
      writeStore(Metrics.PUBLIC_IP_KEY, ip);
      return ip;
    });
  }

  function parseTraceIp(text) {
    if (!text) return "";
    var m = String(text).match(/(?:^|\n)ip=([0-9a-fA-F:.]+)/);
    return m ? m[1] : "";
  }

  (async function () {
    var state = Metrics.load(readStore(Metrics.STORE_KEY));
    var ringLimit = parseInt(arg.ring || "80", 10);
    if (state.ring && state.ring.length > ringLimit) {
      state.ring = state.ring.slice(state.ring.length - ringLimit);
    }
    try {
      var ip = await refreshPublicIp();
      state.publicIp = ip;
      if (typeof console !== "undefined") console.log("[dns-query] public ip", ip);
    } catch (e) {
      if (typeof console !== "undefined") console.log("[dns-query] public ip skipped", e);
    }
    writeStore(Metrics.STORE_KEY, Metrics.serialize(state));
    $done();
  })().catch(function () {
    $done();
  });
})();
