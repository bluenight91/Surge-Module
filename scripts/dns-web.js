/* generated from lib/metrics.js + src/web-main.js — do not edit by hand */

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
 * Surge type=http-request backend for https://dns.query
 * Relies on Metrics being present (concatenated by build.js).
 */
(function () {
  var arg = parseArgument(typeof $argument !== "undefined" ? $argument : "");

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
          if (idx === -1) out[pair] = "";
          else out[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
        });
      return out;
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

  function loadState() {
    var mem = Metrics.getMem && Metrics.getMem();
    if (mem && mem.stats) return mem;
    return Metrics.load(readStore(Metrics.STORE_KEY));
  }

  function json(status, data, extraHeaders) {
    var headers = {
      "Content-Type": "application/json;charset=UTF-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    };
    if (extraHeaders) {
      Object.keys(extraHeaders).forEach(function (k) {
        headers[k] = extraHeaders[k];
      });
    }
    done({
      status: status,
      headers: headers,
      body: JSON.stringify(data),
    });
  }

  function html(status, body) {
    done({
      status: status,
      headers: {
        "Content-Type": "text/html;charset=UTF-8",
        "Cache-Control": "no-store",
      },
      body: body,
    });
  }

  function done(response) {
    $done({ response: response });
  }

  function parseUrl(url) {
    var path = "/";
    var query = {};
    try {
      var u = new URL(url);
      path = u.pathname || "/";
      u.searchParams.forEach(function (v, k) {
        query[k] = v;
      });
    } catch (e) {
      var m = String(url).match(/https?:\/\/[^/]+(\/[^?]*)?(\?.*)?/);
      path = (m && m[1]) || "/";
      var qs = (m && m[2] && m[2].slice(1)) || "";
      qs.split("&").forEach(function (pair) {
        if (!pair) return;
        var idx = pair.indexOf("=");
        query[idx === -1 ? pair : pair.slice(0, idx)] =
          idx === -1 ? "" : decodeURIComponent(pair.slice(idx + 1));
      });
    }
    return { path: path, query: query };
  }

  function httpAPI(method, path, body) {
    return new Promise(function (resolve, reject) {
      if (typeof $httpAPI !== "function") {
        reject(new Error("Surge HTTP API is not available"));
        return;
      }
      $httpAPI(method, path, body || null, function (result) {
        resolve(result);
      });
    });
  }

  function publicConfig() {
    return {
      type: arg.type || "dual",
      doh: arg.doh || "",
      ttl: arg.ttl || "",
      timeout: arg.timeout || "2",
      edns: arg.edns || "",
      fallback: arg.fallback || "1",
      policy: arg.policy || "0",
      flush_n: arg.flush_n || "8",
      flush_ms: arg.flush_ms || "3000",
      ring: arg.ring || "80",
      slow_ms: arg.slow_ms || "200",
      sample: arg.sample || "1",
    };
  }

  function statsPayload(state) {
    var stats = state.stats || Metrics.emptyState().stats;
    return {
      startedAt: state.startedAt,
      lastFlush: state.lastFlush,
      lastEdns: state.lastEdns || "",
      publicIp: state.publicIp || readStore(Metrics.PUBLIC_IP_KEY) || "",
      avgMs: Metrics.avgMs(stats),
      stats: stats,
      config: publicConfig(),
    };
  }

  var PAGE = [
    "<!doctype html>",
    "<html lang='zh-CN'>",
    "<head>",
    "<meta charset='utf-8'/>",
    "<meta name='viewport' content='width=device-width,initial-scale=1'/>",
    "<title>DNS-QUERY</title>",
    "<style>",
    ":root{--bg:#0f1419;--card:#1a2330;--line:#2c3a4d;--text:#e7eef7;--muted:#8aa0b8;--ok:#3dd68c;--bad:#ff6b6b;--acc:#5ac8fa}",
    "*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--text)}",
    "header{padding:20px 24px 8px}h1{margin:0;font-size:22px}p.sub{color:var(--muted);margin:6px 0 0}",
    "main{padding:12px 24px 40px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}",
    ".card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}",
    ".k{color:var(--muted);font-size:12px}.v{font-size:22px;font-weight:650;margin-top:4px}",
    "table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}",
    "th{color:var(--muted);font-weight:600;font-size:12px}code,td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
    "button{background:#243246;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:0 8px 8px 0;cursor:pointer}",
    "button:hover{border-color:var(--acc)}.ok{color:var(--ok)}.bad{color:var(--bad)}pre{white-space:pre-wrap;word-break:break-all;color:var(--muted)}",
    "</style></head><body>",
    "<header><h1>DNS-QUERY</h1><p class='sub'>DoH 查询统计与最近记录</p></header>",
    "<main>",
    "<section class='grid' id='cards'></section>",
    "<p><button id='reload'>刷新</button><button id='delay'>测 DNS 延迟</button><button id='reset'>清空统计</button></p>",
    "<section class='card'><div class='k'>模块参数</div><pre id='config'></pre></section>",
    "<section class='card' style='margin-top:12px'><div class='k'>最近查询</div><div style='overflow:auto'><table><thead><tr><th>时间</th><th>域名</th><th>耗时</th><th>结果</th><th>上游</th><th>地址</th></tr></thead><tbody id='rows'></tbody></table></div></section>",
    "<section class='card' style='margin-top:12px'><div class='k'>Surge DNS Cache (/v1/dns)</div><pre id='cache'>加载中…</pre></section>",
    "</main>",
    "<script>",
    "function el(id){return document.getElementById(id);}",
    "function fmt(ts){return ts?new Date(ts).toLocaleString():'-';}",
    "async function get(path){var r=await fetch(path);if(!r.ok) throw new Error(path+' '+r.status);return r.json();}",
    "function cards(s){var st=s.stats||{};var items=[['总查询',st.total||0],['成功',st.ok||0],['失败',st.fail||0],['回退',st.fallback||0],['平均 ms',s.avgMs||0],['最慢 ms',st.maxMs||0],['EDNS',s.lastEdns||'-'],['公网 IP',s.publicIp||'-']];el('cards').innerHTML=items.map(function(kv){return '<article class=card><div class=k>'+kv[0]+'</div><div class=v>'+kv[1]+'</div></article>';}).join('');}",
    "function rows(list){var html=(list||[]).slice().reverse().map(function(x){return '<tr><td>'+fmt(x.ts)+'</td><td class=mono>'+(x.domain||'')+'</td><td>'+x.ms+'ms</td><td class=\"'+(x.ok?'ok':'bad')+'\">'+(x.ok?'OK':(x.fallback?'fallback':'fail'))+'</td><td class=mono>'+(x.server||'')+'</td><td class=mono>'+(x.addresses||[]).join('<br>')+(x.error?'<br>'+x.error:'')+'</td></tr>';}).join('');el('rows').innerHTML=html||'<tr><td colspan=6>暂无记录</td></tr>';}",
    "async function load(){var s=await get('/api/stats');var q=await get('/api/queries');cards(s);el('config').textContent=JSON.stringify(s.config,null,2);rows(q.ring||[]);try{var d=await get('/api/surge-dns');el('cache').textContent=JSON.stringify(d,null,2);}catch(e){el('cache').textContent='无法读取 Surge HTTP API: '+e.message;}}",
    "el('reload').onclick=load;el('reset').onclick=async function(){await fetch('/api/reset',{method:'POST'});load();};el('delay').onclick=async function(){try{alert(JSON.stringify(await get('/api/dns-delay')));}catch(e){alert(e.message);}};load();",
    "</script></body></html>",
  ].join("");

  var req = typeof $request !== "undefined" ? $request : {};
  var url = req.url || "";
  var method = String(req.method || "GET").toUpperCase();
  var parsed = parseUrl(url);
  var path = parsed.path.replace(/\/+$/, "") || "/";

  if (method === "OPTIONS") {
    json(200, { ok: true });
    return;
  }

  if (path === "/" || path === "/index.html") {
    html(200, PAGE);
    return;
  }

  if (path === "/api/health") {
    json(200, { ok: true, name: "dns-query" });
    return;
  }

  if (path === "/api/stats" && method === "GET") {
    json(200, statsPayload(loadState()));
    return;
  }

  if (path === "/api/queries" && method === "GET") {
    json(200, { ring: loadState().ring || [] });
    return;
  }

  if (path === "/api/config" && method === "GET") {
    json(200, publicConfig());
    return;
  }

  if (path === "/api/reset" && method === "POST") {
    var blank = Metrics.emptyState();
    writeStore(Metrics.STORE_KEY, Metrics.serialize(blank));
    if (Metrics.setMem) Metrics.setMem(blank);
    json(200, { ok: true });
    return;
  }

  if (path === "/api/surge-dns" && method === "GET") {
    httpAPI("GET", "/v1/dns", null)
      .then(function (data) {
        json(200, data || { error: "empty HTTP API response" });
      })
      .catch(function (err) {
        json(200, {
          error: String(err && err.message ? err.message : err),
          hint: "Enable Surge HTTP API if you want the native DNS cache here.",
        });
      });
    return;
  }

  if (path === "/api/dns-delay" && method === "GET") {
    httpAPI("POST", "/v1/test/dns_delay", {})
      .then(function (data) {
        json(200, data || {});
      })
      .catch(function (err) {
        json(500, { error: String(err && err.message ? err.message : err) });
      });
    return;
  }

  json(404, { error: "not found", path: path });
})();
