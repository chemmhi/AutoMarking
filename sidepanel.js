(function () {
  const SETTINGS_KEY = "automarking.settings";
  const CRYPTO_KEY_STORAGE = "automarking.cryptoKey";
  const IDB_NAME = "automarking-db";
  const IDB_STORE = "handles";
  const DIRECTORY_HANDLE_KEY = "temp-root-directory";
  const PANEL_STATE_KEY = "automarking.panelState";
  const PAPER_SEQUENCE_KEY = "automarking.paperSequence";
  const DEFAULT_DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";
  const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
  const APP_CONFIG = window.AutoMarkingAppConfig ?? {};
  const DEFAULT_PROXY_ENDPOINT = APP_CONFIG.proxy?.endpoint ?? "";
  const DEFAULT_PROXY_TOKEN = APP_CONFIG.proxy?.token ?? "";
  const ALLOWED_ORIGIN = "https://yue.haofenshu.com/";

  const secretFields = ["ocrToken", "proxyToken", "deepseekApiKey"];
  const nonSecretFields = [
    "ocrEndpoint",
    "proxyEndpoint",
    "deepseekEndpoint",
    "deepseekModel",
    "referenceAnswer",
    "maxScore",
    "paperCount",
    "customPrompt",
    "manualConfirm",
    "deleteTempFiles"
  ];

  const dom = {
    ocrEndpoint: document.getElementById("ocrEndpoint"),
    ocrToken: document.getElementById("ocrToken"),
    proxyEndpoint: document.getElementById("proxyEndpoint"),
    proxyToken: document.getElementById("proxyToken"),
    deepseekEndpoint: document.getElementById("deepseekEndpoint"),
    deepseekModel: document.getElementById("deepseekModel"),
    deepseekApiKey: document.getElementById("deepseekApiKey"),
    referenceAnswer: document.getElementById("referenceAnswer"),
    maxScore: document.getElementById("maxScore"),
    paperCount: document.getElementById("paperCount"),
    customPrompt: document.getElementById("customPrompt"),
    manualConfirm: document.getElementById("manualConfirm"),
    deleteTempFiles: document.getElementById("deleteTempFiles"),
    pickDirectoryButton: document.getElementById("pickDirectoryButton"),
    directoryStatus: document.getElementById("directoryStatus"),
    paperSequenceStatus: document.getElementById("paperSequenceStatus"),
    resetCounterButton: document.getElementById("resetCounterButton"),
    startButton: document.getElementById("startButton"),
    stopButton: document.getElementById("stopButton"),
    clearLogsButton: document.getElementById("clearLogsButton"),
    progressBar: document.getElementById("progressBar"),
    progressMeta: document.getElementById("progressMeta"),
    statusBadge: document.getElementById("statusBadge"),
    logList: document.getElementById("logList"),
    captureCanvas: document.getElementById("captureCanvas")
  };

  const state = {
    running: false,
    stopRequested: false,
    activeTabSupported: false,
    activeTabId: null,
    activeWindowId: null,
    tempRootHandle: null,
    writtenFileNames: [],
    paperSequence: 0,
    abortControllers: new Set(),
    autoSaveTimer: null,
    currentCount: 0,
    totalCount: 0
  };

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function isAllowedUrl(url) {
    return typeof url === "string" && url.startsWith(ALLOWED_ORIGIN);
  }

  async function savePanelState(panelState) {
    await chrome.storage.local.set({
      [PANEL_STATE_KEY]: panelState
    });
  }

  async function loadPanelState() {
    const stored = await chrome.storage.local.get(PANEL_STATE_KEY);
    return stored[PANEL_STATE_KEY] ?? {};
  }

  async function loadPaperSequence() {
    const stored = await chrome.storage.local.get(PAPER_SEQUENCE_KEY);
    const value = Number(stored[PAPER_SEQUENCE_KEY] ?? 0);
    state.paperSequence = Number.isFinite(value) && value >= 0 ? value : 0;
    updatePaperSequenceStatus();
  }

  async function savePaperSequence() {
    await chrome.storage.local.set({
      [PAPER_SEQUENCE_KEY]: state.paperSequence
    });
    updatePaperSequenceStatus();
  }

  function updatePaperSequenceStatus() {
    dom.paperSequenceStatus.textContent = `当前累计编号：${state.paperSequence}`;
  }

  async function consumePaperSequence() {
    state.paperSequence += 1;
    await savePaperSequence();
    return state.paperSequence;
  }

  async function resetPaperSequence() {
    state.paperSequence = 0;
    await savePaperSequence();
    addLog("累计编号已清零。");
  }

  async function initializeCollapsiblePanels() {
    const panelState = await loadPanelState();
    const panels = Array.from(document.querySelectorAll(".collapsible-panel"));

    for (const panel of panels) {
      const panelId = panel.dataset.panelId;
      const toggle = panel.querySelector(".panel-toggle");
      if (!panelId || !(toggle instanceof HTMLButtonElement)) {
        continue;
      }

      const applyCollapsedState = (collapsed) => {
        panel.classList.toggle("is-collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
      };

      applyCollapsedState(Boolean(panelState[panelId]));

      toggle.addEventListener("click", async () => {
        const nextCollapsed = !panel.classList.contains("is-collapsed");
        applyCollapsedState(nextCollapsed);
        panelState[panelId] = nextCollapsed;
        await savePanelState(panelState);
      });
    }
  }

  function toBase64(bytes) {
    let binary = "";
    const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (const byte of array) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function getCryptoKey() {
    const stored = await chrome.storage.local.get(CRYPTO_KEY_STORAGE);
    let rawKey = stored[CRYPTO_KEY_STORAGE];

    if (!rawKey) {
      const random = crypto.getRandomValues(new Uint8Array(32));
      rawKey = toBase64(random);
      await chrome.storage.local.set({ [CRYPTO_KEY_STORAGE]: rawKey });
    }

    return crypto.subtle.importKey(
      "raw",
      fromBase64(rawKey),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptSecret(value) {
    if (!value) {
      return null;
    }

    const key = await getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(value);
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoded
    );

    return {
      iv: toBase64(iv),
      data: toBase64(cipherBuffer)
    };
  }

  async function decryptSecret(payload) {
    if (!payload?.iv || !payload?.data) {
      return "";
    }

    try {
      const key = await getCryptoKey();
      const plainBuffer = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64(payload.iv) },
        key,
        fromBase64(payload.data)
      );
      return new TextDecoder().decode(plainBuffer);
    } catch (_error) {
      return "";
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(IDB_STORE)) {
          database.createObjectStore(IDB_STORE);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("无法打开本地目录句柄存储。"));
    });
  }

  async function withObjectStore(mode, callback) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(IDB_STORE, mode);
      const store = transaction.objectStore(IDB_STORE);
      const result = callback(store);

      transaction.oncomplete = () => {
        database.close();
        resolve(result);
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("本地句柄存储失败。"));
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error ?? new Error("本地句柄存储已中止。"));
      };
    });
  }

  async function saveDirectoryHandle(handle) {
    await withObjectStore("readwrite", (store) => {
      store.put(handle, DIRECTORY_HANDLE_KEY);
    });
  }

  async function loadDirectoryHandle() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(IDB_STORE, "readonly");
      const store = transaction.objectStore(IDB_STORE);
      const request = store.get(DIRECTORY_HANDLE_KEY);

      request.onsuccess = () => {
        resolve(request.result ?? null);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("读取目录句柄失败。"));
      };

      transaction.oncomplete = () => {
        database.close();
      };
      transaction.onabort = () => {
        database.close();
      };
    });
  }

  function addLog(message, level = "info", fullMessage = message) {
    const item = document.createElement("article");
    item.className = "log-item";
    item.title = String(fullMessage ?? "");

    const header = document.createElement("div");
    header.className = "log-item-header";

    const levelNode = document.createElement("span");
    levelNode.className = `log-item-level ${level}`;
    levelNode.textContent = level === "error" ? "ERROR" : "INFO";

    const timeNode = document.createElement("time");
    timeNode.className = "log-item-time";
    timeNode.textContent = new Date().toLocaleTimeString("zh-CN", {
      hour12: false
    });

    const messageNode = document.createElement("p");
    messageNode.className = "log-item-message";
    messageNode.textContent = message;
    messageNode.title = String(fullMessage ?? "");

    header.append(levelNode, timeNode);
    item.append(header, messageNode);
    dom.logList.prepend(item);
  }

  function clearLogs() {
    dom.logList.replaceChildren();
  }

  function setStatus(text, tone = "idle") {
    dom.statusBadge.textContent = text;
    dom.statusBadge.className = `status-badge ${tone}`;
  }

  function updateProgress(current, total) {
    state.currentCount = current;
    state.totalCount = total;
    const safeTotal = total > 0 ? total : 0;
    const percent = safeTotal > 0 ? Math.min(100, (current / safeTotal) * 100) : 0;
    dom.progressBar.style.width = `${percent}%`;
    dom.progressMeta.textContent = `${current} / ${safeTotal}`;
  }

  function updateDirectoryStatus() {
    if (!state.tempRootHandle) {
      dom.directoryStatus.textContent = "尚未选择目录";
      return;
    }

    dom.directoryStatus.textContent = `已选择：${state.tempRootHandle.name}`;
  }

  function summarizeLogText(value, maxLength = 400) {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
  }

  function stripHtmlTags(value) {
    return String(value ?? "")
      .replace(/<img\b[^>]*>/gi, " ")
      .replace(/<\/?(div|span|p|br|strong|em|section|article)[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  function setRunningState(running) {
    state.running = running;
    dom.startButton.disabled = running || !state.activeTabSupported;
    dom.stopButton.disabled = !running;
    dom.pickDirectoryButton.disabled = running || !state.activeTabSupported;
    dom.resetCounterButton.disabled = running || !state.activeTabSupported;
  }

  function createAbortController() {
    const controller = new AbortController();
    state.abortControllers.add(controller);
    controller.signal.addEventListener(
      "abort",
      () => {
        state.abortControllers.delete(controller);
      },
      { once: true }
    );
    return controller;
  }

  function abortActiveOperations() {
    for (const controller of state.abortControllers) {
      controller.abort();
    }
    state.abortControllers.clear();
  }

  function ensureRunning() {
    if (state.stopRequested) {
      throw new Error("阅卷已停止。");
    }
  }

  function normalizeUrl(value, fallback = "") {
    return String(value ?? "").trim() || fallback;
  }

  function readFormValues() {
    return {
      ocrEndpoint: normalizeUrl(dom.ocrEndpoint.value),
      ocrToken: dom.ocrToken.value.trim(),
      proxyEndpoint: normalizeUrl(dom.proxyEndpoint.value, DEFAULT_PROXY_ENDPOINT),
      proxyToken: dom.proxyToken.value.trim() || DEFAULT_PROXY_TOKEN,
      deepseekEndpoint: normalizeUrl(dom.deepseekEndpoint.value, DEFAULT_DEEPSEEK_ENDPOINT),
      deepseekModel: dom.deepseekModel.value.trim() || DEFAULT_DEEPSEEK_MODEL,
      deepseekApiKey: dom.deepseekApiKey.value.trim(),
      referenceAnswer: dom.referenceAnswer.value.trim(),
      maxScore: Number(dom.maxScore.value),
      paperCount: Number(dom.paperCount.value),
      customPrompt: dom.customPrompt.value.trim(),
      manualConfirm: dom.manualConfirm.checked,
      deleteTempFiles: dom.deleteTempFiles.checked
    };
  }

  function validateSettings(settings) {
    if (!settings.ocrEndpoint) {
      throw new Error("请填写 OCR 接口地址。");
    }
    if (!settings.ocrToken) {
      throw new Error("请填写 OCR Token。");
    }
    if (!settings.proxyEndpoint) {
      throw new Error("请填写中间层地址。");
    }
    if (!settings.proxyToken) {
      throw new Error("请填写中间层 Token。");
    }
    if (!settings.deepseekEndpoint) {
      throw new Error("请填写 DeepSeek 接口地址。");
    }
    if (!settings.deepseekApiKey) {
      throw new Error("请填写 DeepSeek API Key。");
    }
    if (!settings.referenceAnswer) {
      throw new Error("请填写标准答案或评分要点。");
    }
    if (!Number.isFinite(settings.maxScore) || settings.maxScore <= 0) {
      throw new Error("满分必须大于 0。");
    }
    if (!Number.isInteger(settings.paperCount) || settings.paperCount <= 0) {
      throw new Error("阅卷份数必须是大于 0 的整数。");
    }
    if (!state.tempRootHandle) {
      throw new Error("请先选择临时文件目录。");
    }
  }

  async function saveSettings(options = {}) {
    const { silent = false } = options;
    const current = readFormValues();
    const payload = {};

    for (const field of nonSecretFields) {
      payload[field] = current[field];
    }

    const secrets = {};
    for (const field of secretFields) {
      secrets[field] = await encryptSecret(current[field]);
    }
    payload.secrets = secrets;

    await chrome.storage.local.set({
      [SETTINGS_KEY]: payload
    });

    if (!silent) {
      addLog("配置已保存到本地。");
    }
  }

  function scheduleAutoSave() {
    if (state.running) {
      return;
    }

    if (state.autoSaveTimer) {
      window.clearTimeout(state.autoSaveTimer);
    }

    state.autoSaveTimer = window.setTimeout(() => {
      state.autoSaveTimer = null;
      saveSettings({ silent: true }).catch((error) => {
        addLog(
          `自动保存配置失败：${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      });
    }, 500);
  }

  function bindAutoSaveEvents() {
    const fields = [
      dom.ocrEndpoint,
      dom.ocrToken,
      dom.proxyEndpoint,
      dom.proxyToken,
      dom.deepseekEndpoint,
      dom.deepseekModel,
      dom.deepseekApiKey,
      dom.referenceAnswer,
      dom.maxScore,
      dom.paperCount,
      dom.customPrompt,
      dom.manualConfirm,
      dom.deleteTempFiles
    ];

    for (const field of fields) {
      if (!field) {
        continue;
      }

      const eventName =
        field instanceof HTMLInputElement &&
        field.type === "checkbox"
          ? "change"
          : "input";
      field.addEventListener(eventName, scheduleAutoSave);
    }
  }

  async function restoreSettings() {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const payload = stored[SETTINGS_KEY];
    if (!payload) {
      dom.proxyEndpoint.value = DEFAULT_PROXY_ENDPOINT;
      dom.proxyToken.value = DEFAULT_PROXY_TOKEN;
      dom.deepseekEndpoint.value = DEFAULT_DEEPSEEK_ENDPOINT;
      dom.deepseekModel.value = DEFAULT_DEEPSEEK_MODEL;
      return;
    }

    for (const field of nonSecretFields) {
      if (typeof payload[field] === "boolean") {
        dom[field].checked = payload[field];
      } else if (payload[field] !== undefined && payload[field] !== null) {
        dom[field].value = String(payload[field]);
      }
    }

    const secrets = payload.secrets ?? {};
    for (const field of secretFields) {
      dom[field].value = await decryptSecret(secrets[field]);
    }

    if (!dom.proxyEndpoint.value && DEFAULT_PROXY_ENDPOINT) {
      dom.proxyEndpoint.value = DEFAULT_PROXY_ENDPOINT;
    }
    if (!dom.proxyToken.value && DEFAULT_PROXY_TOKEN) {
      dom.proxyToken.value = DEFAULT_PROXY_TOKEN;
    }
  }

  async function restoreDirectoryHandle() {
    try {
      const handle = await loadDirectoryHandle();
      if (!handle) {
        return;
      }

      const permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission === "granted" || permission === "prompt") {
        state.tempRootHandle = handle;
        updateDirectoryStatus();
      }
    } catch (error) {
      addLog(
        `恢复目录句柄失败：${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  }

  async function requestDirectoryPermission(handle) {
    const currentPermission = await handle.queryPermission({ mode: "readwrite" });
    if (currentPermission === "granted") {
      return true;
    }

    const nextPermission = await handle.requestPermission({ mode: "readwrite" });
    return nextPermission === "granted";
  }

  async function handlePickDirectory() {
    if (!window.showDirectoryPicker) {
      throw new Error("当前浏览器环境不支持目录选择器。");
    }

    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const granted = await requestDirectoryPermission(handle);
    if (!granted) {
      throw new Error("目录读写权限未授予。");
    }

    state.tempRootHandle = handle;
    await saveDirectoryHandle(handle);
    updateDirectoryStatus();
    addLog(`目录已选择：${handle.name}`);
  }

  function isRestrictedCaptureUrl(url) {
    if (!url) {
      return true;
    }

    return /^(chrome|chrome-extension|devtools|edge|about|brave):/i.test(url);
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    const activeTab = tabs[0];
    if (!activeTab?.id) {
      throw new Error("未找到当前活跃标签页。");
    }
    return activeTab;
  }

  async function refreshActiveTabSupport() {
    try {
      const activeTab = await getActiveTab();
      state.activeTabSupported = isAllowedUrl(activeTab.url);
    } catch (_error) {
      state.activeTabSupported = false;
    }

    setRunningState(state.running);

    if (!state.running) {
      setStatus(
        state.activeTabSupported ? "绌洪棽涓?" : "璇峰垏鎹㈠埌闃呭嵎椤甸潰",
        state.activeTabSupported ? "idle" : "error"
      );
    }
  }

  async function ensureSupportedActiveTab() {
    const activeTab = await getActiveTab();
    if (!isAllowedUrl(activeTab.url)) {
      throw new Error(
        `褰撳墠渚ц竟鏍忎粎鏀寔 ${ALLOWED_ORIGIN}銆傝鍒囨崲鍥炶鍩熷悕涓嬬殑闃呭嵎椤甸潰鍚庡啀缁х画銆?`
      );
    }

    return activeTab;
  }

  async function captureVisibleTab(windowId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "png" },
        (dataUrl) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!dataUrl) {
            reject(new Error("当前窗口截图失败。"));
            return;
          }

          resolve(dataUrl);
        }
      );
    });
  }

  async function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("截图数据加载失败。"));
      image.src = dataUrl;
    });
  }

  async function sendTabMessage(tabId, message) {
    const response = await chrome.tabs.sendMessage(tabId, message);
    if (!response?.ok) {
      throw new Error(response?.error ?? "标签页消息调用失败。");
    }
    return response.result;
  }

  async function ensureTabReady(tabId) {
    try {
      await sendTabMessage(tabId, { type: "PING" });
    } catch (error) {
      throw new Error(
        `无法连接到当前页面。请确认评分页面已打开且不是浏览器受限页面。原始错误：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async function captureSubjectArea(tabId) {
    ensureRunning();
    const context = await sendTabMessage(tabId, { type: "GET_CAPTURE_CONTEXT" });

    try {
      await sendTabMessage(tabId, { type: "PREPARE_CAPTURE_ISOLATION" });
      await wait(200);
      const screenshotDataUrl = await captureVisibleTab(state.activeWindowId);
      const screenshotImage = await loadImageFromDataUrl(screenshotDataUrl);

      const { rect, viewport, signature } = context;
      const imageWidth = screenshotImage.naturalWidth;
      const imageHeight = screenshotImage.naturalHeight;

      if (!imageWidth || !imageHeight) {
        throw new Error("页面截图尚未就绪，无法裁剪。");
      }

      const scaleX = imageWidth / viewport.width;
      const scaleY = imageHeight / viewport.height;

      const sourceX = Math.max(0, Math.round(rect.left * scaleX));
      const sourceY = Math.max(0, Math.round(rect.top * scaleY));
      const sourceWidth = Math.min(
        imageWidth - sourceX,
        Math.max(1, Math.round(rect.width * scaleX))
      );
      const sourceHeight = Math.min(
        imageHeight - sourceY,
        Math.max(1, Math.round(rect.height * scaleY))
      );

      if (sourceWidth <= 0 || sourceHeight <= 0) {
        throw new Error("裁剪区域超出可捕获范围。");
      }

      dom.captureCanvas.width = sourceWidth;
      dom.captureCanvas.height = sourceHeight;
      const ctx = dom.captureCanvas.getContext("2d");
      if (!ctx) {
        throw new Error("无法创建 Canvas 2D 上下文。");
      }

      ctx.clearRect(0, 0, sourceWidth, sourceHeight);
      ctx.drawImage(
        screenshotImage,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
      );

      const blob = await new Promise((resolve, reject) => {
        dom.captureCanvas.toBlob(
          (result) => {
            if (result) {
              resolve(result);
              return;
            }
            reject(new Error("截图导出 PNG 失败。"));
          },
          "image/png",
          1
        );
      });

      return {
        blob,
        signature,
        manualConfirmDoneId: context.manualConfirmDoneId,
        url: context.url
      };
    } finally {
      try {
        await sendTabMessage(tabId, { type: "CLEANUP_CAPTURE_ISOLATION" });
      } catch (_error) {
        // 页面切换期间忽略恢复失败，避免吞掉主错误。
      }
    }
  }

  async function blobToBase64(blob) {
    const buffer = await blob.arrayBuffer();
    return toBase64(buffer);
  }

  async function writeFile(directoryHandle, fileName, blob) {
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async function renameFile(directoryHandle, oldName, newName) {
    if (oldName === newName) {
      return;
    }

    try {
      await directoryHandle.removeEntry(newName);
    } catch (_error) {
      // Ignore missing target file.
    }

    const sourceHandle = await directoryHandle.getFileHandle(oldName);
    const file = await sourceHandle.getFile();
    const targetHandle = await directoryHandle.getFileHandle(newName, { create: true });
    const writable = await targetHandle.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
    await directoryHandle.removeEntry(oldName);
  }

  async function prepareRunDirectory() {
    const granted = await requestDirectoryPermission(state.tempRootHandle);
    if (!granted) {
      throw new Error("临时文件目录没有读写权限。");
    }

    state.writtenFileNames = [];
    addLog(`将直接写入目录：${state.tempRootHandle.name}`);
  }

  async function cleanupRunDirectory(deleteDirectory) {
    if (!state.tempRootHandle) {
      return;
    }

    try {
      if (deleteDirectory) {
        for (const fileName of state.writtenFileNames) {
          try {
            await state.tempRootHandle.removeEntry(fileName);
          } catch (_error) {
            // Ignore missing files.
          }
        }
        addLog(`已删除本次阅卷生成的 ${state.writtenFileNames.length} 个截图文件。`);
      } else {
        addLog(`临时截图已保留在目录：${state.tempRootHandle.name}`);
      }
    } catch (error) {
      addLog(
        `处理临时截图失败：${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }

    state.writtenFileNames = [];
  }

  async function performOcr(settings, blob) {
    ensureRunning();
    const base64Image = await blobToBase64(blob);
    const payload = {
      file: base64Image,
      fileType: 1,
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useChartRecognition: false
    };

    const controller = createAbortController();
    let proxyResult;
    try {
      proxyResult = await window.AutoMarkingProxy.forwardHttpRequest({
        proxyUrl: settings.proxyEndpoint,
        proxyToken: settings.proxyToken,
        url: settings.ocrEndpoint,
        method: "POST",
        headers: {
          "Authorization": `token ${settings.ocrToken}`,
          "Content-Type": "application/json"
        },
        body: payload,
        signal: controller.signal
      });
    } finally {
      state.abortControllers.delete(controller);
    }

    if (Number(proxyResult.upstreamStatus) >= 400) {
      const compactErrorText = String(proxyResult.bodyText ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      throw new Error(
        compactErrorText
          ? `OCR 请求失败：HTTP ${proxyResult.upstreamStatus}，响应：${compactErrorText}`
          : `OCR 请求失败：HTTP ${proxyResult.upstreamStatus}`
      );
    }

    const rawResponseBody = proxyResult.bodyJson?.response_body;
    const data =
      typeof rawResponseBody === "string"
        ? JSON.parse(rawResponseBody)
        : rawResponseBody;
    if (!data || typeof data !== "object") {
      throw new Error("OCR 返回格式异常，无法解析 JSON。");
    }

    if (data.error_msg) {
      throw new Error(`OCR 服务异常：${data.error_msg}`);
    }
    if (!data.result) {
      throw new Error(data.message ?? "OCR 返回中缺少 result 字段。");
    }

    const parsingResults = Array.isArray(data.result.layoutParsingResults)
      ? data.result.layoutParsingResults
      : [];

    const text = parsingResults
      .map((item) => item?.markdown?.text ?? "")
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join("\n\n")
      .trim()
      .replace(/[\{\}\$\_]/g, '');

    const sanitizedText = stripHtmlTags(text);

    if (!sanitizedText) {
      throw new Error("OCR 未识别出任何文本。");
    }

    return sanitizedText;
  }

  function buildScoringPrompt(settings, ocrText) {
    const lines = [
      "你是一名严格且稳定的阅卷老师。",
      `本题满分为 ${settings.maxScore} 分，请只依据标准答案与学生作答进行评分。`,
      "输出必须是 JSON，对象字段固定为 score 和 reason。",
      "score 必须是数字，不要带单位；reason 必须是简短中文，给出得分和扣分理由，控制在 50 字以内。",
      "如果学生答案与标准答案不完全一致，但语义正确且覆盖关键得分点，应酌情给分。",
      "",
      "【标准答案 / 评分要点】",
      settings.referenceAnswer,
      "",
      "【学生作答 OCR 文本】",
      ocrText
    ];

    if (settings.customPrompt) {
      lines.push("", "【补充评分规则】", settings.customPrompt);
    }

    return lines.join("\n");
  }

  function extractJsonObject(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("AI 返回内容中未找到 JSON 对象。");
    }
    return JSON.parse(match[0]);
  }

  function normalizeScore(score, maxScore) {
    const numeric = Number(score);
    if (!Number.isFinite(numeric)) {
      throw new Error("AI 返回的 score 不是有效数字。");
    }

    const clamped = Math.max(0, Math.min(maxScore, numeric));
    if (Number.isInteger(clamped)) {
      return String(clamped);
    }
    return String(Math.round(clamped * 10) / 10);
  }

  async function gradeWithDeepSeek(settings, ocrText) {
    ensureRunning();
    const controller = createAbortController();
    let response;
    try {
      response = await fetch(settings.deepseekEndpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${settings.deepseekApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: settings.deepseekModel || DEFAULT_DEEPSEEK_MODEL,
          temperature: 0.1,
          messages: [
            {
              role: "system",
              content: "你负责给作答打分，并严格返回 JSON。"
            },
            {
              role: "user",
              content: buildScoringPrompt(settings, ocrText)
            }
          ]
        }),
        signal: controller.signal
      });
    } finally {
      state.abortControllers.delete(controller);
    }

    if (!response.ok) {
      throw new Error(`DeepSeek 请求失败：HTTP ${response.status}`);
    }

    const data = await response.json();
    const content =
      data.choices?.[0]?.message?.content ??
      data.choices?.[0]?.text ??
      "";

    if (!content) {
      throw new Error("DeepSeek 未返回可解析内容。");
    }

    const parsed = extractJsonObject(content);
    const rawScore = parsed.score ?? parsed.分数;
    const reason = String(parsed.reason ?? parsed.理由 ?? "AI 已完成评分").trim();

    return {
      score: normalizeScore(rawScore, settings.maxScore),
      reason
    };
  }

  async function waitForNextPaper(tabId, previousSignature, previousUrl) {
    while (true) {
      ensureRunning();
      await wait(1000);

      try {
        const context = await sendTabMessage(tabId, { type: "GET_PAPER_SIGNATURE" });
        if (
          context.signature !== previousSignature ||
          (previousUrl && context.url && context.url !== previousUrl)
        ) {
          await wait(300);
          return;
        }
      } catch (_error) {
        // 页面切换或内容脚本重载时，下一轮继续尝试。
      }
    }
  }

  async function waitForManualSubmitAndNextPaper(
    tabId,
    previousSignature,
    previousUrl,
    armId
  ) {
    while (true) {
      ensureRunning();
      await wait(1000);

      try {
        const context = await sendTabMessage(tabId, { type: "GET_PAPER_SIGNATURE" });
        const manualSubmitDone = Number(context.manualConfirmDoneId) >= Number(armId);
        const pageChanged =
          context.signature !== previousSignature ||
          (previousUrl && context.url && context.url !== previousUrl);

        if (manualSubmitDone && pageChanged) {
          await wait(300);
          return;
        }
      } catch (_error) {
        // 页面切换或内容脚本重载时，下一轮继续尝试。
      }
    }
  }

  async function runGrading(settings) {
    setStatus("准备中", "running");
    updateProgress(0, settings.paperCount);
    state.stopRequested = false;

    try {
      const activeTab = await ensureSupportedActiveTab();
      if (isRestrictedCaptureUrl(activeTab.url)) {
        throw new Error(
          "当前页面是浏览器受限页面，无法截图。请切换到实际阅卷网页（http/https 页面）后再开始。"
        );
      }

      state.activeTabId = activeTab.id;
      state.activeWindowId = activeTab.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
      await ensureTabReady(state.activeTabId);
      await prepareRunDirectory();

      for (let index = 1; index <= settings.paperCount; index += 1) {
        ensureRunning();
        setStatus(`处理中 ${index}/${settings.paperCount}`, "running");
        const serialNumber = await consumePaperSequence();
        addLog(`开始处理累计第 ${serialNumber} 份。`);

        const { blob, signature, url } = await captureSubjectArea(state.activeTabId);
        const tempFileName = `第${serialNumber}份-待评分.png`;
        await writeFile(state.tempRootHandle, tempFileName, blob);
        state.writtenFileNames.push(tempFileName);
        addLog(`第 ${serialNumber} 份截图已保存。`);

        addLog(`第 ${serialNumber} 份 OCR 识别中...`);
        const ocrText = await performOcr(settings, blob);
        addLog(`OCR 完成，第 ${serialNumber} 份识别到 ${ocrText.length} 个字符。`);
        addLog(
          `OCR 识别结果：${summarizeLogText(ocrText)}`,
          "info",
          `OCR 识别结果：${ocrText}`
        );

        addLog(`第 ${serialNumber} 份 AI 评分中...`);
        const grading = await gradeWithDeepSeek(settings, ocrText);
        addLog(`AI 评分完成：${grading.score} 分。`);
        addLog(
          `评分理由：${summarizeLogText(grading.reason, 200)}`,
          "info",
          `评分理由：${grading.reason}`
        );

        await sendTabMessage(state.activeTabId, {
          type: "SET_SCORE",
          score: grading.score,
          reason: grading.reason
        });

        const finalFileName = `第${serialNumber}份-${grading.score}分.png`;
        await renameFile(state.tempRootHandle, tempFileName, finalFileName);
        state.writtenFileNames = state.writtenFileNames.map((name) =>
          name === tempFileName ? finalFileName : name
        );
        addLog(`截图已重命名为：${finalFileName}`);

        updateProgress(index, settings.paperCount);

        if (settings.manualConfirm) {
          const armResult = await sendTabMessage(state.activeTabId, {
            type: "ARM_MANUAL_CONFIRM"
          });

          if (index < settings.paperCount) {
            addLog("已回填分数，等待人工点击提交并跳转到下一份试卷。");
            setStatus("等待人工确认", "running");
            await waitForManualSubmitAndNextPaper(
              state.activeTabId,
              signature,
              url,
              armResult.armId
            );
            addLog("检测到人工提交已完成，已进入下一份试卷。");
            continue;
          }

          addLog("已回填最后一份分数，等待人工点击提交完成本次阅卷。");
          setStatus("等待人工确认", "running");
          await waitForManualSubmitAndNextPaper(
            state.activeTabId,
            signature,
            url,
            armResult.armId
          );
          addLog("检测到人工提交已完成，本次阅卷结束。");
          break;
        }

        addLog(`正在提交第 ${index} 份...`);
        await sendTabMessage(state.activeTabId, { type: "CLICK_SUBMIT" });

        if (index < settings.paperCount) {
          addLog("等待下一份试卷加载...");
          await waitForNextPaper(state.activeTabId, signature, url);
        }
      }

      setStatus("阅卷完成", "idle");
      return {
        completed: settings.paperCount,
        finishedNaturally: true
      };
    } finally {
      state.activeTabId = null;
      state.activeWindowId = null;
    }
  }

  async function handleStart() {
    if (state.running) {
      return;
    }

    const settings = readFormValues();
    let shouldDeleteTempFiles = false;
    let stoppedByUser = false;

    try {
      validateSettings(settings);
      setRunningState(true);
      addLog("正在准备页面截图...");
      await saveSettings({ silent: true });

      const result = await runGrading(settings);
      shouldDeleteTempFiles = result.finishedNaturally && settings.deleteTempFiles;
      if (settings.deleteTempFiles && !result.finishedNaturally) {
        addLog("本次流程未自然结束，截图文件将保留，避免人工复核时丢失结果。");
      }
    } catch (error) {
      stoppedByUser =
        state.stopRequested ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.message === "阅卷已停止。");

      if (stoppedByUser) {
        setStatus("已停止", "idle");
        addLog("阅卷已停止。");
      } else {
        setStatus("运行失败", "error");
        addLog(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      }
    } finally {
      if (state.writtenFileNames.length > 0) {
        if (settings.deleteTempFiles && !shouldDeleteTempFiles && !stoppedByUser) {
          addLog("由于流程异常中断，截图文件已保留，便于排查问题。");
        }
        await cleanupRunDirectory(shouldDeleteTempFiles);
      }

      setRunningState(false);
      abortActiveOperations();
      state.stopRequested = false;
      state.writtenFileNames = [];
    }
  }

  function handleStop() {
    if (!state.running) {
      return;
    }

    state.stopRequested = true;
    abortActiveOperations();
    setStatus("正在停止", "error");
    addLog("收到停止请求，将在当前步骤结束后中断。", "error");
  }

  async function bootstrap() {
    setStatus("空闲中", "idle");
    updateProgress(0, 0);
    updateDirectoryStatus();
    updatePaperSequenceStatus();

    if (DEFAULT_PROXY_ENDPOINT) {
      dom.proxyEndpoint.value = DEFAULT_PROXY_ENDPOINT;
    }
    if (DEFAULT_PROXY_TOKEN) {
      dom.proxyToken.value = DEFAULT_PROXY_TOKEN;
    }

    await initializeCollapsiblePanels();
    await restoreSettings();
    await restoreDirectoryHandle();
    await loadPaperSequence();
    await refreshActiveTabSupport();

    dom.pickDirectoryButton.addEventListener("click", () => {
      handlePickDirectory().catch((error) => {
        addLog(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      });
    });

    dom.resetCounterButton.addEventListener("click", () => {
      if (state.running) {
        return;
      }

      if (!window.confirm("确认将累计编号清零，并从第1份重新开始吗？")) {
        return;
      }

      resetPaperSequence().catch((error) => {
        addLog(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      });
    });

    dom.startButton.addEventListener("click", () => {
      handleStart().catch((error) => {
        addLog(
          error instanceof Error ? error.message : String(error),
          "error"
        );
      });
    });

    dom.stopButton.addEventListener("click", handleStop);
    dom.clearLogsButton.addEventListener("click", clearLogs);
    bindAutoSaveEvents();

    chrome.tabs.onActivated.addListener(() => {
      void refreshActiveTabSupport();
    });

    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (tab.active && (changeInfo.url || changeInfo.status === "complete")) {
        void refreshActiveTabSupport();
      }
    });
  }

  void bootstrap();
})();
