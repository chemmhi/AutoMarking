(function () {
  const SUBJECT_SELECTOR = "#subjectmark_content_svg";
  const SCORE_SELECTOR = ".score-input";
  const SUBMIT_SELECTOR = ".submit-button";
  const MANUAL_CONFIRM_ARM_KEY = "automarking.manualConfirmArmId";
  const MANUAL_CONFIRM_DONE_KEY = "automarking.manualConfirmDoneId";
  const ISOLATION_STYLE_ID = "automarking-capture-isolation-style";
  const ISOLATION_ROOT_ATTR = "data-automarking-isolating";
  const ISOLATION_OVERLAY_ID = "automarking-capture-isolation-overlay";

  let manualConfirmArmId = Number(sessionStorage.getItem(MANUAL_CONFIRM_ARM_KEY) ?? "0");
  if (!Number.isFinite(manualConfirmArmId)) {
    manualConfirmArmId = 0;
  }

  let manualConfirmDoneId = Number(sessionStorage.getItem(MANUAL_CONFIRM_DONE_KEY) ?? "0");
  if (!Number.isFinite(manualConfirmDoneId)) {
    manualConfirmDoneId = 0;
  }

  let isolationOverlay = null;

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function pickVisibleElement(selector) {
    const elements = Array.from(document.querySelectorAll(selector));
    return elements.find(isVisible) ?? elements[0] ?? null;
  }

  function getSubjectElement() {
    const element = document.querySelector(SUBJECT_SELECTOR);
    if (!element) {
      throw new Error(`未找到作答区域：${SUBJECT_SELECTOR}`);
    }
    return element;
  }

  function getScoreElement() {
    const element = pickVisibleElement(SCORE_SELECTOR);
    if (!element) {
      throw new Error(`未找到分数输入框：${SCORE_SELECTOR}`);
    }
    return element;
  }

  function getSubmitElement() {
    const element = pickVisibleElement(SUBMIT_SELECTOR);
    if (!element) {
      throw new Error(`未找到提交按钮：${SUBMIT_SELECTOR}`);
    }
    return element;
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  function ensureIsolationStyle() {
    let styleElement = document.getElementById(ISOLATION_STYLE_ID);
    if (styleElement) {
      return styleElement;
    }

    styleElement = document.createElement("style");
    styleElement.id = ISOLATION_STYLE_ID;
    styleElement.textContent = `
      html[${ISOLATION_ROOT_ATTR}="1"] body * {
        visibility: hidden !important;
      }

      html[${ISOLATION_ROOT_ATTR}="1"] body *::before,
      html[${ISOLATION_ROOT_ATTR}="1"] body *::after {
        visibility: hidden !important;
      }

      html[${ISOLATION_ROOT_ATTR}="1"] body #${ISOLATION_OVERLAY_ID},
      html[${ISOLATION_ROOT_ATTR}="1"] body #${ISOLATION_OVERLAY_ID} *,
      html[${ISOLATION_ROOT_ATTR}="1"] body #${ISOLATION_OVERLAY_ID} *::before,
      html[${ISOLATION_ROOT_ATTR}="1"] body #${ISOLATION_OVERLAY_ID} *::after {
        visibility: visible !important;
      }
    `;
    document.documentElement.appendChild(styleElement);
    return styleElement;
  }

  function getIsolationBackdropColor() {
    const candidates = [document.body, document.documentElement];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const color = window.getComputedStyle(candidate).backgroundColor;
      if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
        return color;
      }
    }

    return "#ffffff";
  }

  function removeIsolationOverlay() {
    isolationOverlay?.remove();
    isolationOverlay = null;
  }

  async function prepareCaptureIsolation() {
    const subjectElement = getSubjectElement();
    const rect = subjectElement.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      throw new Error("浣滅瓟鍖哄煙灏哄寮傚父锛屾棤娉曟埅鍥俱€?");
    }

    ensureIsolationStyle();
    removeIsolationOverlay();

    const overlay = document.createElement("div");
    overlay.id = ISOLATION_OVERLAY_ID;
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483647";
    overlay.style.pointerEvents = "none";
    overlay.style.overflow = "hidden";
    overlay.style.background = getIsolationBackdropColor();

    const stage = document.createElement("div");
    stage.style.position = "fixed";
    stage.style.left = `${rect.left}px`;
    stage.style.top = `${rect.top}px`;
    stage.style.width = `${rect.width}px`;
    stage.style.height = `${rect.height}px`;
    stage.style.overflow = "hidden";

    const clone = subjectElement.cloneNode(true);
    if (clone instanceof Element) {
      clone.style.setProperty("display", "block", "important");
      clone.style.setProperty("width", `${rect.width}px`, "important");
      clone.style.setProperty("height", `${rect.height}px`, "important");
      clone.style.setProperty("margin", "0", "important");
      clone.style.setProperty("transform", "none", "important");
      clone.style.setProperty("max-width", "none", "important");
      clone.style.setProperty("max-height", "none", "important");
      clone.style.setProperty("pointer-events", "none", "important");
    }

    stage.appendChild(clone);
    overlay.appendChild(stage);
    (document.body ?? document.documentElement).appendChild(overlay);
    isolationOverlay = overlay;

    document.documentElement.setAttribute(ISOLATION_ROOT_ATTR, "1");
    await nextFrame();
    await nextFrame();
    await wait(60);
    return { ok: true };
  }

  async function cleanupCaptureIsolation() {
    removeIsolationOverlay();
    document.documentElement.removeAttribute(ISOLATION_ROOT_ATTR);
    await nextFrame();
    return { ok: true };
  }

  function armManualConfirm() {
    manualConfirmArmId += 1;
    sessionStorage.setItem(MANUAL_CONFIRM_ARM_KEY, String(manualConfirmArmId));
    return manualConfirmArmId;
  }

  function markManualConfirmDoneIfArmed() {
    if (manualConfirmArmId <= manualConfirmDoneId) {
      return;
    }

    manualConfirmDoneId = manualConfirmArmId;
    sessionStorage.setItem(MANUAL_CONFIRM_DONE_KEY, String(manualConfirmDoneId));
  }

  function getImageHrefSignature(subjectElement) {
    const imageHrefs = Array.from(subjectElement.querySelectorAll("image"))
      .map((image) => {
        const href =
          image.getAttribute("href") ??
          image.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
          image.href?.baseVal ??
          "";
        return href.trim();
      })
      .filter(Boolean);

    if (imageHrefs.length > 0) {
      return JSON.stringify(imageHrefs);
    }

    const text = (subjectElement.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    const htmlLength = subjectElement.innerHTML.length;
    const childCount = subjectElement.childElementCount;
    const rect = subjectElement.getBoundingClientRect();

    return JSON.stringify({
      childCount,
      htmlLength,
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text
    });
  }

  function setElementValue(element, value) {
    const normalized = String(value ?? "");
    if (element instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      );
      descriptor?.set?.call(element, normalized);
    } else if (element instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      );
      descriptor?.set?.call(element, normalized);
    } else if (element.isContentEditable) {
      element.textContent = normalized;
    } else {
      throw new Error("分数输入框不是可写控件。");
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  async function getCaptureContext() {
    const subjectElement = getSubjectElement();
    subjectElement.scrollIntoView({
      behavior: "auto",
      block: "center",
      inline: "nearest"
    });

    await wait(150);
    await nextFrame();
    await nextFrame();

    const rect = subjectElement.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      throw new Error("作答区域尺寸异常，无法截图。");
    }

    return {
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      signature: getImageHrefSignature(subjectElement),
      manualConfirmDoneId,
      url: window.location.href,
      title: document.title
    };
  }

  async function getPaperSignature() {
    const subjectElement = getSubjectElement();
    return {
      signature: getImageHrefSignature(subjectElement),
      manualConfirmDoneId,
      url: window.location.href
    };
  }

  async function setScore(payload) {
    const scoreElement = getScoreElement();
    setElementValue(scoreElement, payload.score);

    if (payload.reason) {
      scoreElement.dataset.aiScoreReason = payload.reason;
      scoreElement.title = payload.reason;
    }

    scoreElement.focus();
    return { ok: true };
  }

  async function clickSubmit() {
    const submitElement = getSubmitElement();
    submitElement.scrollIntoView({
      behavior: "auto",
      block: "center",
      inline: "nearest"
    });

    await nextFrame();
    submitElement.click();
    return { ok: true };
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest(SUBMIT_SELECTOR)) {
        markManualConfirmDoneIfArmed();
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case "PING":
          return { ok: true, href: window.location.href };
        case "GET_CAPTURE_CONTEXT":
          return await getCaptureContext();
        case "GET_PAPER_SIGNATURE":
          return await getPaperSignature();
        case "PREPARE_CAPTURE_ISOLATION":
          return await prepareCaptureIsolation();
        case "CLEANUP_CAPTURE_ISOLATION":
          return await cleanupCaptureIsolation();
        case "ARM_MANUAL_CONFIRM":
          return { armId: armManualConfirm() };
        case "SET_SCORE":
          return await setScore(message);
        case "CLICK_SUBMIT":
          return await clickSubmit();
        default:
          throw new Error(`未知消息类型：${message?.type ?? "undefined"}`);
      }
    })()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );

    return true;
  });
})();
