/**
 * Surge Monitor 信息面板。
 *
 * 参数顺序：协议 | 端口 | HTTP API Key
 * API: GET /v1/metrics
 */

const rawArgument = String(
  typeof $argument === "string" ? $argument : ""
);
const argumentParts = rawArgument.split("|");
const apiProtocol = String(argumentParts.shift() || "")
  .trim()
  .toLowerCase();
const apiPortText = String(argumentParts.shift() || "").trim();
const apiKey = argumentParts.join("|").trim();
const apiPort = Number(apiPortText);

function isFiniteNumber(value) {
  return isFinite(Number(value));
}

function formatBytes(value) {
  if (!isFiniteNumber(value)) {
    return "—";
  }

  let bytes = Math.max(0, Number(value));
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;

  while (bytes >= 1024 && unitIndex < units.length - 1) {
    bytes /= 1024;
    unitIndex++;
  }

  return bytes.toFixed(2) + " " + units[unitIndex];
}

function formatUptime(value) {
  if (!isFiniteNumber(value)) {
    return "—";
  }

  let seconds = Math.max(0, Math.floor(Number(value)));
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;

  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;

  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  const parts = [];
  if (days > 0) {
    parts.push(days + "天");
  }
  if (hours > 0 || days > 0) {
    parts.push(hours + "小时");
  }
  if (minutes > 0 || hours > 0 || days > 0) {
    parts.push(minutes + "分钟");
  }
  if (parts.length === 0) {
    parts.push(seconds + "秒");
  }

  return parts.join(" ");
}

function parseMetrics(text) {
  const metrics = [];
  const lines = String(text).split(/\r?\n/);
  const metricPattern =
    /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$/;
  const labelPattern =
    /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.charAt(0) === "#") {
      continue;
    }

    const match = line.match(metricPattern);
    if (!match) {
      continue;
    }

    const labels = {};
    const labelText = match[2] || "";
    let labelMatch;

    labelPattern.lastIndex = 0;
    while ((labelMatch = labelPattern.exec(labelText)) !== null) {
      labels[labelMatch[1]] = labelMatch[2]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }

    metrics.push({
      name: match[1],
      labels,
      value: Number(match[3])
    });
  }

  return metrics;
}

function getMetric(metrics, metricName) {
  for (let i = 0; i < metrics.length; i++) {
    if (metrics[i].name === metricName) {
      return metrics[i];
    }
  }
  return null;
}

function sumMetrics(metrics, metricName) {
  let total = 0;
  let found = false;

  for (let i = 0; i < metrics.length; i++) {
    if (
      metrics[i].name === metricName &&
      isFiniteNumber(metrics[i].value)
    ) {
      total += Number(metrics[i].value);
      found = true;
    }
  }

  return found ? total : NaN;
}

function finishPanel(title, content, style, icon, iconColor) {
  const result = {
    title,
    content
  };

  if (style) {
    result.style = style;
  }
  if (icon) {
    result.icon = icon;
  }
  if (iconColor) {
    result["icon-color"] = iconColor;
  }

  $done(result);
}

function configurationError(message) {
  finishPanel(
    "Surge Monitor",
    "模块参数错误\n\n" + message,
    "error",
    "exclamationmark.triangle.fill",
    "#FF3B30"
  );
}

if (apiProtocol !== "http" && apiProtocol !== "https") {
  configurationError("API_PROTOCOL 只能填写 http 或 https");
} else if (
  !/^\d+$/.test(apiPortText) ||
  !Number.isInteger(apiPort) ||
  apiPort < 1 ||
  apiPort > 65535
) {
  configurationError("API_PORT 必须是 1–65535 的整数");
} else if (!apiKey || apiKey.toLowerCase() === "none") {
  configurationError("请在模块参数中填写 API_KEY");
} else {
  const metricsURL =
    apiProtocol + "://127.0.0.1:" + apiPort + "/v1/metrics";

  $httpClient.get(
    {
      url: metricsURL,
      timeout: 8,
      insecure: apiProtocol === "https",
      "auto-cookie": false,
      headers: {
        Accept: "text/plain",
        "X-Key": apiKey
      }
    },
    function (error, response, body) {
      if (error) {
        finishPanel(
          "Surge Monitor",
          "无法获取 Metrics\n\n" + String(error),
          "error",
          "exclamationmark.triangle.fill",
          "#FF3B30"
        );
        return;
      }

      const status = Number(
        response && (response.status || response.statusCode)
      );

      if (status < 200 || status >= 300) {
        finishPanel(
          "Surge Monitor",
          "Metrics 请求失败\n\nHTTP " + (status || "未知"),
          "error",
          "exclamationmark.triangle.fill",
          "#FF3B30"
        );
        return;
      }

      if (!body) {
        finishPanel(
          "Surge Monitor",
          "Metrics 返回为空",
          "error",
          "exclamationmark.triangle.fill",
          "#FF3B30"
        );
        return;
      }

      const metrics = parseMetrics(body);
      const buildInfo = getMetric(metrics, "surge_build_info");
      const uptime = getMetric(metrics, "surge_uptime_seconds");
      const memory = getMetric(metrics, "surge_memory_bytes");

      const version =
        buildInfo && buildInfo.labels.version
          ? buildInfo.labels.version
          : "未知";
      const build =
        buildInfo && buildInfo.labels.build
          ? buildInfo.labels.build
          : "未知";
      const system =
        buildInfo && buildInfo.labels.system
          ? buildInfo.labels.system
          : "未知";
      const download = sumMetrics(
        metrics,
        "surge_interface_in_bytes_total"
      );
      const upload = sumMetrics(
        metrics,
        "surge_interface_out_bytes_total"
      );
      const content = [
        "内存占用：  " + formatBytes(memory ? memory.value : NaN),
        "",
        "运行时间：  " + formatUptime(uptime ? uptime.value : NaN),
        "",
        "↓ " + formatBytes(download) + "     ↑ " + formatBytes(upload),
        "",
        "Surge " + version + " · Build " + build + " · " + system
      ].join("\n");

      finishPanel(
        "Surge Monitor",
        content,
        null,
        "chart.bar.xaxis",
        "#4A90E2"
      );
    }
  );
}
