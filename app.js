(() => {
  const config = window.KYAMI_CONFIG || {};
  const apiBaseUrl = String(config.apiBaseUrl || "").trim().replace(/\/$/, "");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("promptInput");
  const sendBtn = document.getElementById("sendBtn");
  const charCount = document.getElementById("charCount");
  const messagesEl = document.getElementById("messages");
  const welcome = document.getElementById("welcome");
  const mainPanel = document.querySelector(".main-panel");
  const toast = document.getElementById("toast");
  const historyList = document.getElementById("historyList");
  const sidebar = document.getElementById("sidebar");
  const connectionLabel = document.getElementById("connectionLabel");
  const modelSelect = document.getElementById("modelSelect");
  const MAX_HISTORY = 30;
  let conversations = safeRead("kyami-conversations", []);
  let currentId = null;
  let busy = false;
  let backendReady = false;
  let toastTimer;

  function safeRead(key, fallback) {
    try { const parsed = JSON.parse(localStorage.getItem(key)); return Array.isArray(parsed) ? parsed : fallback; }
    catch { return fallback; }
  }
  function persist() { try { localStorage.setItem("kyami-conversations", JSON.stringify(conversations.slice(0, MAX_HISTORY))); } catch {} }
  function id() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function current() { return conversations.find(c => c.id === currentId); }
  function showToast(text) {
    toast.textContent = text; toast.classList.add("show"); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
  }
  function backendConfigured() { return Boolean(apiBaseUrl); }
  function setConnection(ready, label) {
    backendReady = ready;
    connectionLabel.textContent = label;
    const dot = document.querySelector(".sidebar-foot .status-dot");
    dot.classList.toggle("connected", ready);
  }
  async function loadModels() {
    if (!backendConfigured()) {
      modelSelect.innerHTML = '<option value="">Set up Ollama Cloud backend</option>';
      modelSelect.disabled = true;
      setConnection(false, "Cloud backend URL needed");
      return;
    }
    try {
      const response = await fetch(`${apiBaseUrl}/api/models`, { method: "GET" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Cannot connect to Ollama Cloud backend.");
      const models = Array.isArray(data.models) ? data.models : [];
      modelSelect.replaceChildren();
      if (!models.length) {
        const option = document.createElement("option");
        option.value = ""; option.textContent = "No Gemma Cloud models available";
        modelSelect.append(option); modelSelect.disabled = true;
        setConnection(false, "No Gemma Cloud models available");
        return;
      }
      const saved = (() => { try { return localStorage.getItem("kyami-model") || ""; } catch { return ""; } })();
      const preferred = models.includes(saved) ? saved : (models.includes("gemma3:4b") ? "gemma3:4b" : models[0]);
      for (const name of models) {
        const option = document.createElement("option");
        option.value = name; option.textContent = name;
        modelSelect.append(option);
      }
      modelSelect.value = preferred;
      modelSelect.disabled = false;
      setConnection(true, `Ollama Cloud · ${models.length} Gemma model${models.length === 1 ? "" : "s"}`);
    } catch (error) {
      modelSelect.innerHTML = '<option value="">Cloud backend unavailable</option>';
      modelSelect.disabled = true;
      setConnection(false, "Check cloud backend settings");
    }
  }
  function renderHistory() {
    historyList.replaceChildren();
    const recent = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
    if (!recent.length) { const empty = document.createElement("div"); empty.className = "history-empty"; empty.textContent = "Your conversations will appear here"; historyList.append(empty); return; }
    for (const conversation of recent) {
      const btn = document.createElement("button"); btn.className = "history-item"; btn.textContent = conversation.title || "New chat"; btn.title = btn.textContent;
      btn.addEventListener("click", () => loadConversation(conversation.id)); historyList.append(btn);
    }
  }
  function createConversation() {
    currentId = id();
    conversations.unshift({ id: currentId, title: "New chat", updatedAt: Date.now(), messages: [] });
    persist(); renderHistory(); renderMessages(); sidebar.classList.remove("open"); input.focus();
  }
  function loadConversation(conversationId) { currentId = conversationId; renderMessages(); sidebar.classList.remove("open"); }
  function renderMessages() {
    messagesEl.replaceChildren();
    const c = current();
    const list = c ? c.messages : [];
    for (const msg of list) appendMessage(msg.role, msg.text, false);
    const has = list.length > 0;
    mainPanel.classList.toggle("has-messages", has);
    welcome.style.display = has ? "none" : "";
    requestAnimationFrame(() => { document.querySelector(".conversation").scrollTop = document.querySelector(".conversation").scrollHeight; });
    renderHistory();
  }
  function appendMessage(role, text, scroll = true, error = false) {
    const article = document.createElement("article"); article.className = `message ${role}${error ? " error" : ""}`;
    const avatar = document.createElement("div"); avatar.className = "avatar"; avatar.textContent = role === "user" ? "●" : "✦";
    const wrap = document.createElement("div"); wrap.className = "message-content";
    const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.textContent = text;
    wrap.append(bubble); article.append(avatar, wrap); messagesEl.append(article);
    mainPanel.classList.add("has-messages"); welcome.style.display = "none";
    if (scroll) requestAnimationFrame(() => { const conv = document.querySelector(".conversation"); conv.scrollTop = conv.scrollHeight; });
    return article;
  }
  function addTyping() {
    const article = appendMessage("assistant", "", true);
    article.querySelector(".bubble").innerHTML = '<span class="typing" aria-label="KYAMI is thinking"><span></span><span></span><span></span></span>';
    return article;
  }
  function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; charCount.textContent = `${input.value.length} / 8000`; }
  async function sendMessage(rawText) {
    const text = String(rawText || "").trim();
    if (!text || busy) return;
    if (!backendConfigured() || !backendReady || !modelSelect.value) {
      showToast("KYAMI Cloud is not connected yet. Check the Render backend URL and Ollama Cloud setup.");
      return;
    }
    if (!current()) createConversation();
    const c = current();
    c.messages.push({ role: "user", text });
    if (c.title === "New chat") c.title = text.length > 34 ? text.slice(0, 34).trim() + "…" : text;
    c.updatedAt = Date.now(); persist(); renderMessages();
    input.value = ""; autosize(); busy = true; sendBtn.disabled = true;
    const typing = addTyping();
    try {
      const history = c.messages.slice(-20).map(m => ({ role: m.role, text: m.text }));
      const response = await fetch(`${apiBaseUrl}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, model: modelSelect.value })
      });
      const data = await response.json().catch(() => ({}));
      typing.remove();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
      const reply = typeof data.reply === "string" ? data.reply.trim() : "";
      if (!reply) throw new Error("KYAMI received an empty response. Please try again.");
      c.messages.push({ role: "assistant", text: reply }); c.updatedAt = Date.now(); persist();
      appendMessage("assistant", reply); renderHistory();
    } catch (error) {
      typing.remove();
      const message = error && error.message ? error.message : "Something went wrong. Please try again.";
      appendMessage("assistant", message, true, true);
      showToast(message.length > 130 ? "Couldn't reach KYAMI. Check your backend and try again." : message);
    } finally {
      busy = false; sendBtn.disabled = false; input.focus();
    }
  }
  form.addEventListener("submit", e => { e.preventDefault(); sendMessage(input.value); });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  document.querySelectorAll(".suggestion").forEach(button => button.addEventListener("click", () => sendMessage(button.dataset.prompt)));
  modelSelect.addEventListener("change", () => {
    try { localStorage.setItem("kyami-model", modelSelect.value); } catch {}
    const model = modelSelect.value;
    if (model) showToast(`Selected ${model}`);
  });
  document.getElementById("newChatBtn").addEventListener("click", createConversation);
  document.getElementById("homeBtn").addEventListener("click", () => { if (!current() || current().messages.length) createConversation(); else renderMessages(); });
  document.getElementById("historyBtn").addEventListener("click", () => { if (!conversations.length) showToast("Your recent chats will appear here after you start chatting."); else { const latest = [...conversations].sort((a,b)=>b.updatedAt-a.updatedAt)[0]; loadConversation(latest.id); } });
  document.getElementById("mobileMenuBtn").addEventListener("click", () => sidebar.classList.toggle("open"));
  document.getElementById("themeBtn").addEventListener("click", () => {
    document.body.classList.toggle("light-theme");
    try { localStorage.setItem("kyami-light-theme", document.body.classList.contains("light-theme") ? "1" : "0"); } catch {}
  });
  try { if (localStorage.getItem("kyami-light-theme") === "1") document.body.classList.add("light-theme"); } catch {}
  document.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); createConversation(); } if (e.key === "Escape") sidebar.classList.remove("open"); });
  setConnection(false, "Checking Ollama Cloud…");
  loadModels();
  renderHistory();
  if (!conversations.length) createConversation(); else loadConversation(conversations[0].id);
  autosize();
})();
