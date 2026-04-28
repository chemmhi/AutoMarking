(function () {
  function tryParseJson(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function normalizeProxyPayload(rawText, fallbackStatus) {
    const parsed = tryParseJson(rawText);
    if (!parsed || typeof parsed !== "object") {
      return {
        upstreamStatus: fallbackStatus,
        bodyText: rawText,
        bodyJson: tryParseJson(rawText),
        raw: parsed
      };
    }

    const wrappedStatus =
      Number(parsed.status) ||
      Number(parsed.statusCode) ||
      Number(parsed.code) ||
      fallbackStatus;

    const wrappedBody = parsed.body ?? parsed.data ?? parsed.response ?? parsed.result ?? parsed;
    if (typeof wrappedBody === "string") {
      return {
        upstreamStatus: wrappedStatus,
        bodyText: wrappedBody,
        bodyJson: tryParseJson(wrappedBody),
        raw: parsed
      };
    }

    if (wrappedBody && typeof wrappedBody === "object") {
      return {
        upstreamStatus: wrappedStatus,
        bodyText: JSON.stringify(wrappedBody),
        bodyJson: wrappedBody,
        raw: parsed
      };
    }

    return {
      upstreamStatus: wrappedStatus,
      bodyText: rawText,
      bodyJson: parsed,
      raw: parsed
    };
  }

  async function forwardHttpRequest(options) {
    const response = await fetch(options.proxyUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${options.proxyToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: options.url,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        body: options.body ?? null
      }),
      signal: options.signal
    });

    const responseText = await response.text();
    if (!response.ok) {
      const compactText = responseText.replace(/\s+/g, " ").trim().slice(0, 240);
      throw new Error(
        compactText
          ? `中间层请求失败：HTTP ${response.status}，响应：${compactText}`
          : `中间层请求失败：HTTP ${response.status}`
      );
    }

    return normalizeProxyPayload(responseText, response.status);
  }

  window.AutoMarkingProxy = {
    forwardHttpRequest
  };
})();
