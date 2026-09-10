const menuToggle = document.querySelector(".menu-toggle");
const siteNav = document.querySelector(".site-nav");
const languageToggle = document.querySelector("#language-toggle");
const toast = document.querySelector(".copy-toast");

const translations = {
  en: {
    "nav.product": "Product",
    "nav.features": "Capabilities",
    "nav.collaboration": "Collaboration",
    "nav.architecture": "How it works",
    "nav.deploy": "Deploy",
    "nav.contact": "Contact",
    "common.contact": "Contact",
    "brandHome": "Codex Manage home",
    "mainNav": "Main navigation",
    "menuOpen": "Open navigation",
    "menu.open": "Open navigation",
    "hero.kicker": "Controlled collaboration · Child accounts · Web / H5",
    "hero.titleStart": "Give child accounts, ",
    "hero.titleEmphasis": "only the work they are meant to continue.",
    "hero.lede": "Codex Manage is built around controlled collaboration: the owner authorizes existing Codex sessions, while child accounts see only what they are allowed to access and continue work in the original workspace under the default approval policy.",
    "hero.primaryAction": "See child-account collaboration",
    "hero.note": "Access can be revoked at any time. The server enforces every boundary.",
    "hero.visualLabel": "Codex Manage workspace preview",
    "visual.stop": "Stop running",
    "signals.label": "Product highlights",
    "signals.owner": "Owner authorization",
    "signals.child": "Child-account isolation",
    "signals.approval": "Default approvals",
    "signals.revoke": "Instant revocation",
    "product.titleStart": "Not another chat window.",
    "product.titleEmphasis": "A workspace for Codex.",
    "product.lede": "You have already built real engineering context in the terminal. Codex Manage reads native Codex sessions directly, so you can resume a historical task instead of explaining the background again.",
    "product.showcaseLabel": "Codex Manage session workspace illustration",
    "product.captionA.title": "Owners assign. Child accounts continue.",
    "product.captionA.body": "The owner selects and authorizes existing sessions. After signing in, each child account sees only its assigned scope, with history, live output, and continuation in the same workflow.",
    "product.captionB.title": "Pick up on desktop or mobile.",
    "product.captionB.body": "Collapsed H5 lists, mobile details, and approval panels follow the same interaction model, so context stays with you when you leave the desk.",
    "product.deployLink": "Deploy on your own machine",
    "features.titleStart": "See every step,",
    "features.titleEmphasis": "keep every decision in your hands.",
    "features.history.title": "Resume historical sessions",
    "features.history.body": "Read local session records for the active runtime user, browse by recent updates, search, and open native Codex sessions without losing engineering context.",
    "features.stream.title": "See what Codex is doing live",
    "features.stream.body": "Text replies, commands, output, file changes, and process states appear in the session as they happen.",
    "features.control.title": "Approve, do not blindly run",
    "features.control.body": "When an action needs confirmation, Allow, Deny, and Cancel are explicit. The default policy is visible and the recovery path is actionable.",
    "features.model.title": "Switch models per session",
    "features.model.body": "Choose only from models declared by the current app-server. No guessing or silent fallback; the original session ID and history stay intact.",
    "features.workspace.title": "Engineering context follows the session",
    "features.workspace.body": "Working directories, commands, history, and runtime state are organized around each session, so important context is not hidden in another admin page.",
    "features.access.title": "Login protection for local networks",
    "features.access.body": "The management console requires login before sessions are available, making it suitable for development machines, local servers, and private LAN workflows.",
    "collaboration.titleStart": "Give collaboration to child accounts,",
    "collaboration.titleEmphasis": "keep the boundary on the server.",
    "collaboration.lede": "Controlled collaboration lets the owner hand off part of an existing workflow while keeping session, workspace, and approval boundaries clear and visible.",
    "collaboration.owner.label": "Owner account",
    "collaboration.owner.title": "Authorize existing sessions",
    "collaboration.owner.body": "The owner can add or disable local child accounts, assign one or more existing sessions to each account, and revoke access at any time.",
    "collaboration.owner.stepOne": "Choose account",
    "collaboration.owner.stepTwo": "Select sessions",
    "collaboration.owner.stepThree": "Effective now",
    "collaboration.child.label": "Controlled child account",
    "collaboration.child.title": "Continue only authorized work",
    "collaboration.child.body": "After signing in, a child account sees only authorized sessions and continues inside each session's original workspace under the default approval rules.",
    "collaboration.child.permissionOne": "Authorized sessions",
    "collaboration.child.permissionTwo": "Default approvals",
    "collaboration.child.permissionThree": "Fixed workspace",
    "collaboration.boundary.title": "Hiding something in the UI is not a security boundary.",
    "collaboration.boundary.body": "Session lists, details, commands, runtime state, continuation, input, models, approvals, and WebSocket requests are all checked on the server. Unauthorized sessions, workspace escapes, and full-permission requests are rejected.",
    "collaboration.boundary.note": "Collaboration preview · Separate release track",
    "architecture.titleStart": "The browser is the entry point,",
    "architecture.titleEmphasis": "the machine is the execution layer.",
    "architecture.lede": "The core trade-off is simple: bring the control experience to the Web while keeping session data and the real toolchain in your own runtime environment.",
    "architecture.flow.browser.title": "Web / H5 browser",
    "architecture.flow.browser.body": "Sessions, approvals, models, settings",
    "architecture.flow.runtime.body": "Fastify + React · Login protection",
    "architecture.flow.codex.body": "Native sessions · Commands · Project files",
    "architecture.boundary.label": "Data boundary",
    "architecture.boundary.titleStart": "Your sessions",
    "architecture.boundary.titleEnd": "stay on your machine.",
    "architecture.boundary.body": "A cloud relay is not required. The current Web track needs only a Linux host that can run Codex; the website and runtime can be released independently.",
    "architecture.boundary.tagOne": "Local sessions",
    "architecture.boundary.tagTwo": "Local toolchain",
    "architecture.boundary.tagThree": "Auditable deployment",
    "deploy.titleStart": "Choose the runtime,",
    "deploy.titleEmphasis": "then start deployment.",
    "deploy.lede": "The current one-command Runtime installer covers Linux only. Windows and macOS can access a deployed Runtime in the browser; desktop packages and a unified installer still require separate release validation.",
    "deploy.matrixLabel": "Platform deployment support matrix",
    "deploy.server.status": "Available now",
    "deploy.server.body": "Install with the same Linux user that is already logged in to Codex. The service is managed by systemd, making it suitable for a server or always-on development machine.",
    "deploy.command": "sudo bash install-runtime.sh --user &lt;runtime-user&gt; --package &lt;runtime-package&gt;",
    "deploy.server.requirement": "Prerequisites: Node.js, Codex CLI, sudo/systemd",
    "deploy.client.status": "Browser access",
    "deploy.client.body": "Use a browser to access an already deployed Linux Runtime. The current track does not provide a unified native Runtime command for Windows or macOS.",
    "deploy.client.apple": "macOS Apple silicon",
    "deploy.client.requirement": "Desktop packages are a separate release track; use an explicitly validated version",
    "deploy.planned.status": "In progress",
    "deploy.planned.title": "One installer for all three platforms",
    "deploy.planned.body": "Supporting one-command deployment on Windows, macOS, and Linux requires Windows Service, launchd, and systemd integrations, plus signing, upgrades, and rollback flows.",
    "deploy.planned.note": "Not presented as complete yet",
    "deploy.steps.one.title": "Linux: prepare the runtime user",
    "deploy.steps.one.body": "Create a dedicated user and run <code>codex login</code> with that account. Existing sessions, SSH keys, MCP configuration, and project permissions then remain aligned.",
    "deploy.steps.two.title": "Linux: prepare the runtime package",
    "deploy.steps.two.body": "Place the verified Runtime package and installer on the server. The current one-command script requires Bash, sudo, and systemd.",
    "deploy.steps.three.title": "Linux: install and open the console",
    "deploy.steps.three.body": "The installer creates and starts the systemd service. Open the Web/H5 console at the server address, sign in, choose a historical session, and continue the task.",
    "deploy.contactLink": "Deployment question? View contact options",
    "deploy.copy": "Copy",
    "deploy.terminal.comment": "# Use the runtime user that is already logged in to Codex",
    "deploy.terminal.user": "--user &lt;runtime-user&gt; \\",
    "deploy.note.title": "Confirm these three things before deployment",
    "deploy.note.body": "The runtime user has completed Codex login; the package source and checksum are verified; production has a separate access password and restricted access through a firewall or reverse proxy.",
    "deploy.cta": "Deploy Codex Manage",
    "boundary.titleStart": "Available today,",
    "boundary.titleEmphasis": "and still being prepared.",
    "boundary.currentLabel": "Current track",
    "boundary.currentBody": ": Linux Runtime, Web/H5 session management, historical session recovery, live output, approvals, command records, per-session model switching, and login protection.",
    "boundary.nextLabel": "Separate release track",
    "boundary.nextBody": ": Other desktop, cloud, and commercial capabilities still require their own external validation. The website makes accurate commitments about the current track only.",
    "faq.title": "Before deploying, let us answer the key questions.",
    "faq.one.question": "Can the static website run Codex Manage directly?",
    "faq.one.answer": "No. Codex Manage Runtime must run on a Linux host that can access Codex CLI, session directories, and project files. The website is a product and deployment guide; the actual execution layer remains your runtime host.",
    "faq.two.question": "Can Windows and macOS be deployed with one command?",
    "faq.two.answer": "That is not a current promise. Windows and macOS can act as browser clients for a Linux Runtime. Native desktop packages and a unified three-platform installer are a separate release track that still needs installation, signing, upgrade, and real-device validation.",
    "faq.three.question": "Will session content be uploaded to the cloud?",
    "faq.three.answer": "On the current track, sessions are read and Codex runs on your runtime host. The Web version does not require session content to be stored in a cloud database. Review your own network, login password, and reverse-proxy policy before public deployment.",
    "faq.four.question": "I already have Codex sessions. Can I continue them directly?",
    "faq.four.answer": "Yes. Runtime reads the local session records for its runtime user. After signing in, you can browse history, inspect details, and continue through native resume support.",
    "faq.five.question": "Can a child account create sessions or switch workspaces?",
    "faq.five.answer": "No. A child account can only see existing sessions authorized by the owner. It cannot create sessions, switch workspaces, manage users, or change global settings; authorized sessions stay tied to their original workspace.",
    "faq.six.question": "Can a child account keep working after access is revoked?",
    "faq.six.answer": "No. After session access is revoked or the child account is disabled, subsequent list, detail, continuation, input, approval, and live-connection requests are checked again and become invalid.",
    "faq.seven.question": "Why does the website avoid presenting other platforms as ready?",
    "faq.seven.answer": "They belong to separate release tracks and still need signing, cross-platform packages, and production validation. The website makes accurate commitments about the current track first.",
    "cta.titleStart": "Start your next task",
    "cta.titleEmphasis": "from the browser.",
    "cta.noteOne": "Owner authorizes",
    "cta.noteTwo": "Child continues",
    "cta.noteThree": "Browser access",
    "contact.label": "Contact options",
    "contact.telegram": "Open Telegram",
    "contact.email": "Send email",
    "contact.wechat": "Copy WeChat ID"
  }
};

const metaTranslations = {
  en: {
    title: "Codex Manage — Bring Codex sessions to the browser",
    description: "Codex Manage brings local Codex sessions to the browser with history, live output, approvals, model switching, H5 access, and controlled collaboration.",
    ogDescription: "A local-first Codex Web/H5 workspace. Owners authorize existing sessions; child accounts continue only the work they are allowed to access."
  }
};

let currentLanguage = "zh-CN";
const translationNodes = [...document.querySelectorAll("[data-i18n]")];
const defaultMarkup = new Map(translationNodes.map((node) => [node, node.innerHTML]));
const ariaNodes = [...document.querySelectorAll("[data-i18n-aria]")];
const defaultAria = new Map(ariaNodes.map((node) => [node, node.getAttribute("aria-label") || ""]));
const titleNodes = [...document.querySelectorAll("[data-i18n-title]")];
const defaultTitles = new Map(titleNodes.map((node) => [node, node.getAttribute("title") || ""]));
const metaNodes = [...document.querySelectorAll("[data-i18n-meta]")];
const defaultMeta = new Map(metaNodes.map((node) => [node, node.tagName === "TITLE" ? node.textContent : node.getAttribute("content")]));
const copyDefaults = new Map([...document.querySelectorAll("[data-copy]")].map((button) => [button, {
  value: button.getAttribute("data-copy") || "",
  label: button.getAttribute("data-copy-label") || "复制",
  message: button.getAttribute("data-copy-message") || "安装命令已复制"
}]));

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
    const defaults = copyDefaults.get(button);
    const defaultLabel = button.getAttribute("data-copy-label") || defaults?.label || (currentLanguage === "en" ? "Copy" : "复制");
    const successMessage = button.getAttribute("data-copy-message") || defaults?.message || (currentLanguage === "en" ? "Copied" : "已复制");

    try {
      await navigator.clipboard.writeText(value);
      if (button.classList.contains("contact-copy")) {
        button.classList.add("is-copied");
        button.setAttribute("aria-label", currentLanguage === "en" ? "WeChat ID copied" : "微信号已复制");
      } else {
        button.textContent = currentLanguage === "en" ? "Copied" : "已复制";
      }
      showToast(successMessage);
    } catch {
      showToast(currentLanguage === "en" ? "Copy failed. Select the content manually." : "复制失败，请手动选择内容");
    }

    window.setTimeout(() => {
      if (button.classList.contains("contact-copy")) {
        button.classList.remove("is-copied");
        const key = button.getAttribute("data-i18n-aria");
        button.setAttribute("aria-label", key && currentLanguage === "en" ? translate(key) : defaultAria.get(button) || defaultLabel);
      } else {
        button.textContent = button.getAttribute("data-copy-label") || defaultLabel;
      }
    }, 1800);
  });
});

languageToggle?.addEventListener("click", () => {
  applyLanguage(currentLanguage === "en" ? "zh-CN" : "en");
});

function applyLanguage(language) {
  currentLanguage = language;
  const english = language === "en";

  translationNodes.forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key) return;
    node.innerHTML = english && translations.en[key] ? translations.en[key] : defaultMarkup.get(node) || "";
  });

  ariaNodes.forEach((node) => {
    const key = node.getAttribute("data-i18n-aria");
    if (key) node.setAttribute("aria-label", english ? translate(key) : defaultAria.get(node) || "");
  });

  titleNodes.forEach((node) => {
    const key = node.getAttribute("data-i18n-title");
    if (key) node.setAttribute("title", english ? translate(key) : defaultTitles.get(node) || "");
  });

  metaNodes.forEach((node) => {
    const key = node.getAttribute("data-i18n-meta");
    const value = english ? metaTranslations.en[key] : defaultMeta.get(node);
    if (node.tagName === "TITLE") node.textContent = value || "";
    else node.setAttribute("content", value || "");
  });

  document.documentElement.lang = english ? "en" : "zh-CN";
  if (languageToggle) {
    languageToggle.textContent = english ? "中文" : "EN";
    languageToggle.setAttribute("aria-label", english ? "Switch to Chinese" : "切换为英文");
    languageToggle.setAttribute("title", english ? "Switch to Chinese" : "切换为英文");
  }

  document.querySelectorAll("[data-copy]").forEach((button) => {
    const defaults = copyDefaults.get(button);
    if (!defaults) return;
    button.setAttribute("data-copy", english ? button.getAttribute("data-copy-en") || defaults.value : defaults.value);
    button.setAttribute("data-copy-label", english ? button.getAttribute("data-copy-label-en") || "Copy" : defaults.label);
    button.setAttribute("data-copy-message", english ? button.getAttribute("data-copy-message-en") || "Copied" : defaults.message);
  });

  persistLanguage(language);
}

function translate(key) {
  return translations.en[key] || "";
}

function persistLanguage(language) {
  try {
    window.localStorage.setItem("codex-manage-language", language);
  } catch {
    // Private browsing can disable storage; the current page still switches normally.
  }
}

function readLanguage() {
  try {
    return window.localStorage.getItem("codex-manage-language") === "en" ? "en" : "zh-CN";
  } catch {
    return "zh-CN";
  }
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

applyLanguage(readLanguage());
