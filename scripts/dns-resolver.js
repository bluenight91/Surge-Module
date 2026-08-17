/* generated from lib/packet.js + lib/metrics.js + src/resolver-main.js — do not edit by hand */

/**
 * Minimal DNS wire codec for DoH (RFC 1035 / RFC 6891 / RFC 7871).
 * No Node Buffer dependency — safe for Surge JSC.
 */
var DNSPacket = (function () {
  var TYPE_A = 1;
  var TYPE_AAAA = 28;
  var TYPE_OPT = 41;
  var CLASS_IN = 1;
  var FLAG_RD = 0x0100;
  var OPTION_CLIENT_SUBNET = 8;

  function isIPv4(ip) {
    if (!ip || typeof ip !== "string") return false;
    var parts = ip.split(".");
    if (parts.length !== 4) return false;
    for (var i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return false;
      var n = Number(parts[i]);
      if (n > 255) return false;
    }
    return true;
  }

  function isIPv6(ip) {
    if (!ip || typeof ip !== "string" || ip.indexOf(":") === -1) return false;
    if (ip.split("::").length > 2) return false;
    return /^[0-9a-fA-F:]+$/.test(ip);
  }

  function ipv4Bytes(ip) {
    var parts = ip.split(".");
    return new Uint8Array([
      Number(parts[0]),
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
    ]);
  }

  function ipv6Bytes(ip) {
    var head;
    var tail;
    if (ip.indexOf("::") !== -1) {
      var halves = ip.split("::");
      head = halves[0] ? halves[0].split(":") : [];
      tail = halves[1] ? halves[1].split(":") : [];
    } else {
      head = ip.split(":");
      tail = [];
    }
    head = head.filter(function (p) {
      return p.length > 0;
    });
    tail = tail.filter(function (p) {
      return p.length > 0;
    });
    var missing = 8 - head.length - tail.length;
    if (missing < 0) missing = 0;
    var parts = head.concat(zeros(missing), tail);
    var out = new Uint8Array(16);
    for (var i = 0; i < 8; i++) {
      var n = parseInt(parts[i] || "0", 16);
      if (isNaN(n)) n = 0;
      out[i * 2] = (n >> 8) & 0xff;
      out[i * 2 + 1] = n & 0xff;
    }
    return out;
  }

  function zeros(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push("0");
    return a;
  }

  function writeU16(buf, offset, value) {
    buf[offset] = (value >> 8) & 0xff;
    buf[offset + 1] = value & 0xff;
  }

  function readU16(view, offset) {
    return view.getUint16(offset);
  }

  function encodeDomain(name, buf, offset) {
    if (!name || name === ".") {
      buf[offset++] = 0;
      return offset;
    }
    var cleaned = String(name).replace(/\.$/, "");
    var labels = cleaned.split(".");
    for (var i = 0; i < labels.length; i++) {
      var label = labels[i];
      if (label.length > 63) {
        throw new Error("DNS label too long: " + label);
      }
      buf[offset++] = label.length;
      for (var j = 0; j < label.length; j++) {
        buf[offset++] = label.charCodeAt(j) & 0xff;
      }
    }
    buf[offset++] = 0;
    return offset;
  }

  function typeNumber(type) {
    if (type === "AAAA" || type === 28) return TYPE_AAAA;
    return TYPE_A;
  }

  function encodeQuery(domain, type, edns) {
    var buf = new Uint8Array(512);
    writeU16(buf, 0, 0);
    writeU16(buf, 2, FLAG_RD);
    writeU16(buf, 4, 1);
    writeU16(buf, 6, 0);
    writeU16(buf, 8, 0);
    writeU16(buf, 10, edns ? 1 : 0);
    var o = encodeDomain(domain, buf, 12);
    writeU16(buf, o, typeNumber(type));
    o += 2;
    writeU16(buf, o, CLASS_IN);
    o += 2;

    if (edns) {
      buf[o++] = 0;
      writeU16(buf, o, TYPE_OPT);
      o += 2;
      writeU16(buf, o, 4096);
      o += 2;
      buf[o++] = 0;
      buf[o++] = 0;
      buf[o++] = 0;
      buf[o++] = 0;
      var rdlenAt = o;
      o += 2;
      writeU16(buf, o, OPTION_CLIENT_SUBNET);
      o += 2;
      var optLenAt = o;
      o += 2;
      var v4 = isIPv4(edns);
      writeU16(buf, o, v4 ? 1 : 2);
      o += 2;
      var prefix = v4 ? 24 : 56;
      buf[o++] = prefix;
      buf[o++] = 0;
      var raw = v4 ? ipv4Bytes(edns) : ipv6Bytes(edns);
      var addrBytes = Math.ceil(prefix / 8);
      for (var i = 0; i < addrBytes; i++) buf[o++] = raw[i];
      writeU16(buf, optLenAt, o - optLenAt - 2);
      writeU16(buf, rdlenAt, o - rdlenAt - 2);
    }

    return buf.slice(0, o);
  }

  function readName(view, start, visited) {
    var offset = start;
    var labels = [];
    var jumped = false;
    var returnAt = start;
    var hops = 0;
    visited = visited || {};

    while (hops++ < 20) {
      var len = view.getUint8(offset);
      if (len === 0) {
        offset += 1;
        if (!jumped) returnAt = offset;
        break;
      }
      if ((len & 0xc0) === 0xc0) {
        var ptr = ((len & 0x3f) << 8) | view.getUint8(offset + 1);
        if (!jumped) returnAt = offset + 2;
        if (visited[ptr]) throw new Error("DNS name compression loop");
        visited[ptr] = true;
        offset = ptr;
        jumped = true;
        continue;
      }
      if (len > 63) throw new Error("invalid DNS label length");
      offset += 1;
      var chars = [];
      for (var i = 0; i < len; i++) {
        chars.push(String.fromCharCode(view.getUint8(offset++)));
      }
      labels.push(chars.join(""));
    }

    return { name: labels.join("."), offset: returnAt };
  }

  function toBytes(input) {
    if (!input) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof input === "string") {
      var out = new Uint8Array(input.length);
      for (var i = 0; i < input.length; i++) out[i] = input.charCodeAt(i) & 0xff;
      return out;
    }
    return new Uint8Array(0);
  }

  function decodeResponse(input) {
    var bytes = toBytes(input);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 12) throw new Error("DNS response too short");

    var flags = readU16(view, 2);
    var rcode = flags & 0xf;
    var qd = readU16(view, 4);
    var an = readU16(view, 6);
    var offset = 12;
    var i;

    for (i = 0; i < qd; i++) {
      var q = readName(view, offset);
      offset = q.offset + 4;
    }

    var answers = [];
    for (i = 0; i < an; i++) {
      if (offset + 10 > bytes.length) break;
      var n = readName(view, offset);
      offset = n.offset;
      var type = readU16(view, offset);
      offset += 2;
      offset += 2;
      var ttl = view.getUint32(offset);
      offset += 4;
      var rdlen = readU16(view, offset);
      offset += 2;
      if (offset + rdlen > bytes.length) break;

      if (type === TYPE_A && rdlen === 4) {
        answers.push({
          name: n.name,
          type: "A",
          ttl: ttl,
          data:
            view.getUint8(offset) +
            "." +
            view.getUint8(offset + 1) +
            "." +
            view.getUint8(offset + 2) +
            "." +
            view.getUint8(offset + 3),
        });
      } else if (type === TYPE_AAAA && rdlen === 16) {
        var parts = [];
        for (var j = 0; j < 8; j++) {
          parts.push(readU16(view, offset + j * 2).toString(16));
        }
        answers.push({
          name: n.name,
          type: "AAAA",
          ttl: ttl,
          data: parts.join(":"),
        });
      }
      offset += rdlen;
    }

    return { rcode: rcode, answers: answers };
  }

  var B64 =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function bytesToBase64Url(bytes) {
    var b = toBytes(bytes);
    var out = "";
    var i = 0;
    var len = b.length;
    while (i + 2 < len) {
      out += B64[b[i] >> 2];
      out += B64[((b[i] & 3) << 4) | (b[i + 1] >> 4)];
      out += B64[((b[i + 1] & 15) << 2) | (b[i + 2] >> 6)];
      out += B64[b[i + 2] & 63];
      i += 3;
    }
    if (i < len) {
      out += B64[b[i] >> 2];
      if (i + 1 < len) {
        out += B64[((b[i] & 3) << 4) | (b[i + 1] >> 4)];
        out += B64[(b[i + 1] & 15) << 2];
      } else {
        out += B64[(b[i] & 3) << 4];
      }
    }
    return out.replace(/\+/g, "-").replace(/\//g, "_");
  }

  function parseTraceIp(text) {
    if (!text) return "";
    var m = String(text).match(/(?:^|\n)ip=([0-9a-fA-F:.]+)/);
    return m ? m[1] : "";
  }

  return {
    TYPE_A: TYPE_A,
    TYPE_AAAA: TYPE_AAAA,
    isIPv4: isIPv4,
    isIPv6: isIPv6,
    ipv4Bytes: ipv4Bytes,
    ipv6Bytes: ipv6Bytes,
    encodeQuery: encodeQuery,
    decodeResponse: decodeResponse,
    bytesToBase64Url: bytesToBase64Url,
    toBytes: toBytes,
    parseTraceIp: parseTraceIp,
  };
})();


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
 * Surge type=dns hot-path resolver.
 * Relies on DNSPacket + Metrics being present (concatenated by build.js).
 */
(function () {
  var arg = parseArgument(typeof $argument !== "undefined" ? $argument : "");
  var enableLog = String(arg.log) === "1";
  var fallback = String(arg.fallback) !== "0";
  var timeoutSec = parseInt(arg.timeout || "2", 10);
  if (!(timeoutSec > 0)) timeoutSec = 2;
  var ringLimit = parseInt(arg.ring || "80", 10);
  var flushN = parseInt(arg.flush_n || "8", 10);
  var flushMs = parseInt(arg.flush_ms || "3000", 10);
  var slowMs = parseInt(arg.slow_ms || "200", 10);
  var sample = Number(arg.sample == null ? 1 : arg.sample);
  var policy = normalizePolicy(arg.policy);
  var overrideTtl = arg.ttl === undefined || arg.ttl === "" ? null : parseInt(arg.ttl, 10);
  if (overrideTtl !== null && !(overrideTtl >= 0)) overrideTtl = null;

  function log() {
    if (!enableLog) return;
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(arguments[i]);
    console.log(parts.join(" "));
  }

  function parseArgument(raw) {
    if (!raw) return {};
    try {
      return Object.fromEntries(new URLSearchParams(raw).entries());
    } catch (e) {
      var out = {};
      String(raw)
        .split("&")
        .forEach(function (pair) {
          var idx = pair.indexOf("=");
          if (idx === -1) out[decode(pair)] = "";
          else out[decode(pair.slice(0, idx))] = decode(pair.slice(idx + 1));
        });
      return out;
    }
  }

  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  function normalizePolicy(value) {
    if (value == null) return undefined;
    var v = String(value).trim();
    if (!v || v === "0" || v === "false" || v === "off" || v === "no") return undefined;
    return v;
  }

  function resolveTypes(typeArg) {
    var raw = (typeArg || "dual").trim();
    if (raw === "v4-only" || raw === "A") return { mode: "A", types: ["A"] };
    if (raw === "v6-only" || raw === "AAAA") return { mode: "AAAA", types: ["AAAA"] };
    if (raw === "prefer-v4") return { mode: "prefer-v4", types: ["A"] };
    if (raw === "prefer-v6") return { mode: "prefer-v6", types: ["AAAA"] };
    if (raw === "dual") return { mode: "dual", types: ["A", "AAAA"] };
    var list = raw
      .split(/\s*,\s*/)
      .filter(function (t) {
        return t === "A" || t === "AAAA";
      });
    if (!list.length) list = ["A", "AAAA"];
    return { mode: raw, types: list };
  }

  function parseDoh(value) {
    return String(value || "https://8.8.4.4/dns-query")
      .split(/\s*,\s*/)
      .filter(function (u) {
        return /^https?:\/\//i.test(u);
      });
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

  function loadMetrics() {
    var mem = Metrics.getMem();
    if (mem && mem.stats) return mem;
    return Metrics.setMem(Metrics.load(readStore(Metrics.STORE_KEY)));
  }

  function persistMetrics(state, force) {
    if (!Metrics.shouldFlush(state, { flushN: flushN, flushMs: flushMs, force: force })) {
      return;
    }
    writeStore(Metrics.STORE_KEY, Metrics.serialize(state));
    Metrics.markFlushed(state);
  }

  function resolveEdns() {
    var requested = (arg.edns || "").trim();
    if (requested && requested !== "auto") return requested;
    try {
      var ev = JSON.parse(readStore("lastNetworkInfoEvent") || "null");
      if (ev && ev.CN_IP && DNSPacket.isIPv4(ev.CN_IP)) return ev.CN_IP;
    } catch (e) {}
    var cached = (readStore(Metrics.PUBLIC_IP_KEY) || "").trim();
    if (cached && (DNSPacket.isIPv4(cached) || DNSPacket.isIPv6(cached))) return cached;
    var mem = loadMetrics();
    if (mem.publicIp && (DNSPacket.isIPv4(mem.publicIp) || DNSPacket.isIPv6(mem.publicIp))) {
      return mem.publicIp;
    }
    return "114.114.114.114";
  }

  function httpGet(opt) {
    return new Promise(function (resolve, reject) {
      $httpClient.get(opt, function (error, response, body) {
        try {
          if (error || !response) {
            reject(new Error(error || "empty response"));
            return;
          }
          response.body = body;
          resolve(response);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  function buildDohUrl(base, queryBytes) {
    var encoded = DNSPacket.bytesToBase64Url(queryBytes);
    return base + (base.indexOf("?") === -1 ? "?" : "&") + "dns=" + encoded;
  }

  function queryOne(url, domain, type, edns) {
    var started = Date.now();
    var packet = DNSPacket.encodeQuery(domain, type, edns);
    var req = {
      url: buildDohUrl(url, packet),
      headers: { Accept: "application/dns-message", "User-Agent": "Surge-DNS-QUERY" },
      "binary-mode": true,
      timeout: timeoutSec,
    };
    if (policy) req.policy = policy;
    return httpGet(req).then(function (response) {
      var decoded = DNSPacket.decodeResponse(response.body);
      var answers = decoded.answers.filter(function (a) {
        return a.type === type;
      });
      return {
        url: url,
        type: type,
        answers: answers,
        ms: Date.now() - started,
      };
    });
  }

  function firstSuccess(promises) {
    return new Promise(function (resolve, reject) {
      var pending = promises.length;
      var lastErr = new Error("no upstream");
      if (!pending) {
        reject(lastErr);
        return;
      }
      promises.forEach(function (p) {
        p.then(resolve, function (err) {
          lastErr = err;
          pending -= 1;
          if (pending === 0) reject(lastErr);
        });
      });
    });
  }

  function queryServer(url, domain, types, edns) {
    return Promise.all(
      types.map(function (type) {
        return queryOne(url, domain, type, edns).catch(function (err) {
          return { url: url, type: type, answers: [], error: err, ms: 0 };
        });
      })
    ).then(function (parts) {
      var addresses = [];
      var ttl = 0;
      var ms = 0;
      var errors = [];
      parts.forEach(function (part) {
        if (part.ms > ms) ms = part.ms;
        if (part.error) errors.push(String(part.error.message || part.error));
        (part.answers || []).forEach(function (ans) {
          if (addresses.indexOf(ans.data) === -1) addresses.push(ans.data);
          if (ans.ttl > 0 && (ttl === 0 || ans.ttl < ttl)) ttl = ans.ttl;
        });
      });
      if (!addresses.length) {
        throw new Error(errors.join("; ") || "empty answers");
      }
      return { url: url, addresses: addresses, ttl: ttl || 60, ms: ms };
    });
  }

  function queryAll(domain, types, edns, servers) {
    var jobs = servers.map(function (url) {
      return queryServer(url, domain, types, edns);
    });
    return firstSuccess(jobs);
  }

  function finish(result) {
    try {
      $done(result);
    } catch (e) {
      $done({});
    }
  }

  var domain = typeof $domain !== "undefined" ? $domain : "";
  var typeInfo = resolveTypes(arg.type);
  var servers = parseDoh(arg.doh);
  var started = Date.now();
  var result = { addresses: [], ttl: overrideTtl || 60 };
  var meta = {
    ok: false,
    fallback: false,
    empty: false,
    server: "",
    error: "",
    types: typeInfo.types.join(","),
  };

  (async function () {
    if (!domain) throw new Error("missing $domain");
    if (!servers.length) throw new Error("no DoH servers");
    var edns = resolveEdns();
    meta.edns = edns;
    log("query", domain, typeInfo.types.join(","), "edns", edns, "doh", servers.join(","));

    var resolved;
    try {
      resolved = await queryAll(domain, typeInfo.types, edns, servers);
    } catch (e) {
      if (typeInfo.mode === "prefer-v4") {
        resolved = await queryAll(domain, ["AAAA"], edns, servers);
        typeInfo.types = ["AAAA"];
      } else if (typeInfo.mode === "prefer-v6") {
        resolved = await queryAll(domain, ["A"], edns, servers);
        typeInfo.types = ["A"];
      } else {
        throw e;
      }
    }

    result.addresses = resolved.addresses;
    result.ttl = overrideTtl != null ? overrideTtl : resolved.ttl;
    meta.ok = result.addresses.length > 0;
    meta.empty = !meta.ok;
    meta.server = resolved.url;
    log("ok", domain, result.addresses.join(","), resolved.ms + "ms", resolved.url);
  })()
    .catch(function (err) {
      meta.error = err && err.message ? err.message : String(err);
      log("fail", domain, meta.error);
      if (fallback) {
        meta.fallback = true;
        result = {};
      } else {
        result = { addresses: [], ttl: 60 };
        meta.empty = true;
      }
    })
    .then(function () {
      try {
        var state = loadMetrics();
        Metrics.record(
          state,
          {
            ts: Date.now(),
            domain: domain,
            ms: Date.now() - started,
            ok: meta.ok,
            fallback: meta.fallback,
            empty: meta.empty,
            server: meta.server,
            addresses: result.addresses || [],
            ttl: result.ttl || 0,
            error: meta.error,
            types: meta.types,
            edns: meta.edns,
          },
          { ringLimit: ringLimit, sample: sample, slowMs: slowMs }
        );
        persistMetrics(state, !meta.ok);
      } catch (e) {
        log("metrics", e);
      }
      finish(result);
    });
})();
