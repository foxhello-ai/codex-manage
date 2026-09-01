// Configure one private destination before publishing the site.
// Keep both values empty when feedback should stay local and be downloaded/copied manually.
const FEEDBACK_EMAIL = "";
const FEEDBACK_ENDPOINT = "";

const menuToggle = document.querySelector(".menu-toggle");
const siteNav = document.querySelector(".site-nav");
const toast = document.querySelector(".copy-toast");
const feedbackForm = document.querySelector("#feedback-form");
const feedbackStatus = document.querySelector("#feedback-status");
const supportStatus = document.querySelector("#support-status");
const feedbackSubmitButton = feedbackForm?.querySelector('button[type="submit"]');

if (feedbackSubmitButton) {
  feedbackSubmitButton.innerHTML = FEEDBACK_ENDPOINT ? "提交反馈 <span>→</span>" : FEEDBACK_EMAIL ? "打开客服邮件 <span>→</span>" : "生成反馈单 <span>→</span>";
}

menuToggle?.addEventListener("click", () => {
  const open = siteNav?.classList.toggle("open") ?? false;
  menuToggle.setAttribute("aria-expanded", String(open));
});

siteNav?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    siteNav.classList.remove("open");
    menuToggle?.setAttribute("aria-expanded", "false");
  });
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy");
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "已复制";
      showToast("安装命令已复制");
    } catch {
      showToast("复制失败，请手动选择命令");
    }

    window.setTimeout(() => {
      button.textContent = "复制";
    }, 1800);
  });
});

document.querySelector("[data-copy-feedback]")?.addEventListener("click", async () => {
  if (!feedbackForm) return;
  const copied = await copyText(buildFeedbackText(new FormData(feedbackForm)));
  setFeedbackStatus(copied ? "反馈内容已复制，可以交给客服处理。" : "复制失败，请手动选择反馈内容。", copied ? "success" : "error");
  setSupportStatus(copied ? "反馈单已复制，可以直接交给客服。" : "复制失败，请使用下载反馈单。", copied ? "success" : "error");
});

document.querySelector("[data-contact-focus]")?.addEventListener("click", focusFeedbackForm);

document.querySelectorAll("[data-contact-focus-link]").forEach((link) => {
  link.addEventListener("click", () => {
    window.setTimeout(focusFeedbackForm, 250);
  });
});

document.querySelectorAll("[data-download-feedback]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!feedbackForm) return;
    downloadFeedback(buildFeedbackText(new FormData(feedbackForm)));
    setSupportStatus("反馈单已下载，可以作为附件或文本交给客服。", "success");
  });
});

feedbackForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(feedbackForm);
  const feedback = buildFeedbackText(data);

  if (FEEDBACK_ENDPOINT) {
    setFeedbackStatus("正在提交反馈…");
    try {
      const response = await fetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: data.get("type"),
          title: data.get("title"),
          detail: data.get("detail"),
          contact: data.get("contact")
        })
      });
      if (!response.ok) throw new Error("feedback request failed");
      setFeedbackStatus("反馈已提交，感谢你帮助我们改进。", "success");
      setSupportStatus("反馈已进入客服接收渠道。", "success");
      feedbackForm.reset();
    } catch {
      downloadFeedback(feedback);
      const copied = await copyText(feedback);
      setFeedbackStatus(copied ? "在线提交失败，反馈单已下载并复制。" : "在线提交失败，反馈单已下载。", "error");
      setSupportStatus("在线提交失败，请将已下载的反馈单交给客服。", "error");
    }
    return;
  }

  if (FEEDBACK_EMAIL) {
    const subject = encodeURIComponent(`[Codex Manage] ${data.get("type")}: ${data.get("title")}`);
    const body = encodeURIComponent(feedback);
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
    setFeedbackStatus("已打开客服邮件，请确认后发送。", "success");
    setSupportStatus("客服邮件已准备好，请在邮件客户端完成发送。", "success");
    return;
  }

  downloadFeedback(feedback);
  const copied = await copyText(feedback);
  setFeedbackStatus(copied ? "反馈单已下载并复制，请交给客服。" : "反馈单已下载，请交给客服。", copied ? "success" : "error");
  setSupportStatus("反馈单已生成，可以下载、复制后交给客服。", "success");
});

function focusFeedbackForm() {
  if (!feedbackForm) return;
  feedbackForm.scrollIntoView({ behavior: "smooth", block: "start" });
  window.setTimeout(() => feedbackForm.querySelector('[name="title"]')?.focus(), 350);
  setSupportStatus("已定位到问题单，请填写后生成反馈单。", "success");
}

function downloadFeedback(value) {
  const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = url;
  link.download = `codex-manage-feedback-${timestamp}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildFeedbackText(data) {
  return [
    `反馈类型：${data.get("type") || "未填写"}`,
    `问题标题：${data.get("title") || "未填写"}`,
    `联系方式：${data.get("contact") || "未填写"}`,
    "",
    "问题描述：",
    data.get("detail") || "未填写"
  ].join("\n");
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  }
}

function setFeedbackStatus(message, tone = "") {
  if (!feedbackStatus) return;
  feedbackStatus.textContent = message;
  feedbackStatus.dataset.tone = tone;
}

function setSupportStatus(message, tone = "") {
  if (!supportStatus) return;
  supportStatus.textContent = message;
  supportStatus.dataset.tone = tone;
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

const year = document.querySelector("#year");
if (year) year.textContent = String(new Date().getFullYear());
