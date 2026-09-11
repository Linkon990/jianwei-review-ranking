"use strict";

(() => {
  const $ = selector => document.querySelector(selector);
  const viewport = $("#review-viewport");
  const reviews = $("#reviews");
  const contentDialog = $("#content-dialog");
  const themeToggle = $("#theme-toggle");
  const phoneTime = $(".phone-time");
  const browserRuntime = document.body.dataset.runtime === "browser";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const strategyNames = { uniform: "均匀权重", slide: "随滑动位置加权", center_lower: "中下区域加权" };
  const filterNames = { all: "全部评论", positive: "正面体验", neutral: "中性评价", negative: "使用限制" };
  const names = ["小张", "阿杰", "周女士", "momo", "小陈", "橙子", "刘同学", "晴天", "小吴", "静静", "李先生", "远行"];
  const MAX_PENDING = 600;
  const screens = ["product", "reviews", "summary"];
  const resultNames = { purchase: "支付未退款", abandon: "未购买", refund: "购买后退款" };
  let state = null, ownedId = null, screen = "product", intent = "product";
  let busy = false, armed = false, renderReady = false, errorPaused = false;
  let departed = false, drawerOpen = false, contentOpen = false, focused = document.hasFocus();
  let origin = performance.now(), lastSample = performance.now(), scrolled = false;
  let currentFilter = "all", currentSort = "recommended", activeStrategy = "center_lower";
  let active = new Map(), pending = [], sending = null;
  let seconds = 0, submitted = 0, lastVisible = 0, retryAction = null;
  let generation = 0;
  let rowHeight = 0, displayedReceipt = null, dialogOpener = null;
  let transitioning = false, currentMotion = null;
  let settling = false;
  let resetting = false, pendingStopRound = null;
  const requestControllers = new Set();
  let phoneClockTimer = null;

  function stopPhoneClock() {
    clearTimeout(phoneClockTimer);
    phoneClockTimer = null;
  }
  function updatePhoneClock() {
    stopPhoneClock();
    if (!phoneTime || departed || document.hidden) return;
    const localTime = new Date();
    phoneTime.textContent = `${localTime.getHours()}:${String(localTime.getMinutes()).padStart(2, "0")}`;
    // Align each update to the next minute, including after a suspended tab resumes.
    phoneClockTimer = setTimeout(updatePhoneClock, 60000 - localTime.getSeconds() * 1000 - localTime.getMilliseconds() + 20);
  }

  class ObsoleteOperation extends Error {}
  const isCurrent = token => token === generation && !departed;
  function guard(token) { if (!isCurrent(token)) throw new ObsoleteOperation("页面已离开，忽略旧操作。"); }
  function invalidateOperations() {
    generation++;
    cancelMotion();
    for (const controller of requestControllers) controller.abort();
    requestControllers.clear();
    sending = null;
  }

  const nowMs = () => Math.max(0, Math.round(performance.now() - origin));
  const isActive = () => Boolean(ownedId && state?.episode?.episode_id === ownedId && state.episode.phase === "active" && !state.episode.closed);
  const roundComplete = (data = state) => data?.round?.status === "completed";
  const hasRoundProgress = () => Boolean(state && (state.round?.strategy || state.round?.completed || state.counts?.episodes || ownedId || intent === "reviews"));
  const canRecord = () => Boolean(armed && renderReady && !transitioning && screen === "reviews" && location.hash === "#reviews" && intent === "reviews" && isActive() && !busy && !errorPaused && !departed && !document.hidden && focused && !contentOpen);

  function node(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }
  function notice(message, error = false, retry = null, label = "重试") {
    $("#notice-text").textContent = message;
    $("#notice").classList.toggle("error", error);
    $("#notice").setAttribute("role", error ? "alert" : "status");
    $("#notice").hidden = false;
    retryAction = retry;
    $("#retry-action").hidden = !retry;
    $("#retry-action").textContent = label;
    $("#dismiss-notice").hidden = error;
  }
  function clearNotice() {
    errorPaused = false;
    retryAction = null;
    $("#notice").hidden = true;
  }
  function fail(message, retry, label = "重试") {
    armed = false;
    errorPaused = true;
    finishAll();
    notice(message, true, retry, label);
    sync();
  }
  async function api(path, body, { keepalive = false, token = generation, detached = false } = {}) {
    if (!detached) guard(token);
    if (browserRuntime) {
      if (!window.ReviewDemoEngine) throw new Error("演示组件加载失败，请刷新页面重试。");
      const payload = body === undefined ? null : { ...body, round_id: body.round_id ?? (detached ? undefined : state?.round?.id) };
      const data = await window.ReviewDemoEngine.request(path, payload);
      if (!detached) guard(token);
      return data;
    }
    const controller = new AbortController();
    if (!detached) requestControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const options = { signal: controller.signal, keepalive };
      if (body !== undefined) Object.assign(options, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, round_id: body.round_id ?? (detached ? undefined : state?.round?.id) }) });
      const response = await fetch(path, options);
      if (!detached) guard(token);
      let data;
      try { data = await response.json(); } catch { throw new Error(`服务返回了无法读取的数据（${response.status}）。`); }
      if (!detached) guard(token);
      if (!response.ok) throw new Error(data.error || data.message || `请求失败（${response.status}）。`);
      return data;
    } catch (error) {
      if (!detached && !isCurrent(token)) throw new ObsoleteOperation("忽略旧页面请求。");
      if (error.name === "AbortError") throw new Error("连接超过 8 秒未响应，请检查本地服务后重试。");
      throw error;
    } finally { clearTimeout(timeout); requestControllers.delete(controller); }
  }
  function acceptState(data, token = generation) {
    guard(token);
    if (!data || !Array.isArray(data.comments) || !data.ranking) throw new Error("演示状态不完整，请刷新页面重试。");
    state = data;
    $("#product-review-count").textContent = String(data.comments.length);
    renderViewer();
    renderLastResult();
    renderRound();
    if (screen === "reviews") renderScores();
  }
  function renderViewer() {
    const viewer = state.viewer || {};
    const theme = ["forest", "ocean", "sunset", "violet"].includes(viewer.theme) ? viewer.theme : "forest";
    document.body.dataset.theme = theme;
    $("#viewer-avatar").textContent = String(viewer.avatar || "访").slice(0, 2);
    $("#viewer-name").textContent = viewer.nickname || "当前访客";
    $("#viewer-ordinal").textContent = `第 ${viewer.ordinal || 1} / ${state.round?.limit || 6} 位访客`;
    updateThemeMeta();
  }
  function updateThemeMeta() {
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (!themeMeta) return;
    const dark = document.body.dataset.colorMode === "dark";
    const theme = document.body.dataset.theme || "forest";
    const lightColors = { forest: "#245849", ocean: "#205f96", sunset: "#a75630", violet: "#79549f" };
    const darkColors = { forest: "#202521", ocean: "#20252a", sunset: "#29221f", violet: "#27232b" };
    themeMeta.setAttribute("content", (dark ? darkColors : lightColors)[theme] || (dark ? darkColors.forest : lightColors.forest));
  }
  function setColorMode(mode, persist = true) {
    const next = mode === "dark" ? "dark" : "light";
    document.body.dataset.colorMode = next;
    const dark = next === "dark";
    if (themeToggle) {
      themeToggle.setAttribute("aria-pressed", String(dark));
      themeToggle.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到深色模式");
      themeToggle.title = dark ? "切换到浅色模式" : "切换到深色模式";
      const icon = themeToggle.querySelector(".theme-toggle-icon");
      const label = themeToggle.querySelector(".theme-toggle-label");
      if (icon) icon.textContent = dark ? "☀" : "☾";
      if (label) label.textContent = dark ? "浅色" : "深色";
    }
    updateThemeMeta();
    if (persist) {
      try { localStorage.setItem("review-ranking-color-mode", next); } catch { /* storage may be blocked */ }
    }
  }
  function restoreColorMode() {
    let saved = "light";
    try { saved = localStorage.getItem("review-ranking-color-mode") || "light"; } catch { /* storage may be blocked */ }
    setColorMode(saved, false);
  }
  function renderLastResult() {
    const receipt = state.last_result;
    const panel = $("#last-result"), body = $("#last-result-body");
    panel.hidden = !receipt || roundComplete();
    if (!receipt) return;
    if (displayedReceipt !== receipt.episode_id) { panel.open = false; displayedReceipt = receipt.episode_id; }
    const contributions = receipt.contributions || {};
    const ids = Object.keys(contributions).filter(id => Number(contributions[id]) > 0);
    $("#last-result-title").textContent = ids.length ? "已沿用上一位的评分更新" : "上一位已完成体验";
    body.replaceChildren();
    const resultNames = { purchase: "已支付", abandon: "未购买", refund: "购买后退款" };
    body.append(node("p", "", `${receipt.from_viewer?.nickname || "上一位访客"}选择了“${resultNames[receipt.outcome] || receipt.outcome}”。${ids.length ? "阅读贡献已计入共享评分，下一次进入评论时应用更新。" : "本轮没有有效曝光，评论评分未更新。"}当前由${state.viewer?.nickname || "下一位访客"}继续体验。`));
    if (ids.length) {
      const table = node("table", "result-table"), head = node("thead"), header = node("tr");
      ["评论", "阅读贡献", "评分变化"].forEach(label => header.append(node("th", "", label)));
      head.append(header); table.append(head);
      const rows = node("tbody");
      ids.sort((a, b) => contributions[b] - contributions[a]).slice(0, 12).forEach(id => {
        const change = receipt.score_changes?.[id];
        const row = node("tr");
        row.append(node("td", "", id), node("td", "", `${(100 * Number(contributions[id])).toFixed(1)}%`), node("td", "", change ? `${Number(change.before).toFixed(3)} → ${Number(change.after).toFixed(3)}` : "未变化"));
        rows.append(row);
      });
      table.append(rows); body.append(table);
      body.append(node("p", "", "这些数值反映弱关联，并不证明因果效果，也不保证某条评论在一次支付后置顶。"));
    }
  }
  function renderRound() {
    const round = state.round;
    const done = roundComplete(), limit = round?.limit || 6, completed = round?.completed || 0;
    $("#round-progress-label").textContent = `第 ${round?.ordinal || 1} 轮 · 已完成 ${completed} / ${limit}`;
    $("#round-strategy-label").textContent = done ? "本轮已完成" : round?.strategy ? `${strategyNames[round.strategy]} · 本轮固定` : "进入评论前，可选择本轮策略";
    $("#round-step-list").replaceChildren();
    for (let i = 1; i <= limit; i++) {
      const result = round?.results?.[i - 1];
      const status = i <= completed ? "complete" : !done && i === completed + 1 ? "current" : "pending";
      const step = node("li", "round-step"); step.dataset.status = status;
      step.setAttribute("aria-label", `第 ${i} 位：${result ? resultNames[result.outcome] : status === "current" ? "当前访客" : "等待体验"}`);
      if (status === "current") step.setAttribute("aria-current", "step");
      step.append(node("span", "step-avatar", status === "complete" ? "✓" : String(i)), node("span", "step-name", result?.from_viewer?.nickname || (status === "current" ? state.viewer.nickname : `访客 ${i}`)));
      $("#round-step-list").append(step);
    }
    if (round?.strategy) {
      activeStrategy = round.strategy;
      document.querySelectorAll("input[name=strategy]").forEach(input => { input.checked = input.value === round.strategy; });
      $("#selected-strategy-label").replaceChildren(document.createTextNode(`${strategyNames[activeStrategy]} `), node("b", "", "⌄"));
    }
    $("#live-research").hidden = done;
    $("#round-report").hidden = !done;
    if (done) renderRoundSummary();
  }
  function renderRoundSummary() {
    const round = state.round, summary = round.summary || {}, counts = round.outcome_counts || {};
    $("#summary-title").textContent = "本轮已完成";
    $("#summary-subtitle").textContent = `第 ${round.ordinal} 轮 · ${round.completed} 位访客 · ${strategyNames[round.strategy] || "评论阅读"}`;
    $("#summary-outcomes").replaceChildren();
    for (const outcome of ["purchase", "abandon", "refund"]) {
      const stat = node("div", "summary-stat"); stat.dataset.outcome = outcome;
      stat.append(node("strong", "", String(counts[outcome] || 0)), node("span", "", resultNames[outcome]));
      $("#summary-outcomes").append(stat);
    }
    const withContribution = Number(summary.with_contribution || 0);
    $("#summary-highlights").replaceChildren(
      node("p", "summary-observation", `${withContribution} / ${round.completed} 位访客留下有效阅读贡献`),
      node("p", "summary-observation", `支付后未退款 ${summary.net_purchase?.count ?? counts.purchase ?? 0} / ${round.completed} 人`)
    );
    $("#round-report-results").replaceChildren();
    for (const result of round.results || []) {
      const person = node("div", "report-person"), copy = node("div", "report-name"), outcome = node("span", "report-outcome", resultNames[result.outcome]);
      outcome.dataset.outcome = result.outcome;
      copy.append(node("strong", "", `${result.from_viewer.ordinal}. ${result.from_viewer.nickname}`), node("small", "", result.has_contribution ? "有阅读贡献" : "无有效阅读贡献"));
      person.append(node("span", "report-avatar", result.from_viewer.avatar), copy, outcome);
      $("#round-report-results").append(person);
    }
    const changes = summary.strategy_summaries?.[round.strategy]?.score_changes || {};
    const changed = Object.entries(changes).filter(([, change]) => Math.abs(Number(change.delta)) > 1e-10).sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta)).slice(0, 5);
    $("#round-report-scores").replaceChildren();
    for (const [id, change] of changed) {
      const comment = state.comments.find(item => item.comment_id === id);
      const row = node("div", "report-score"), label = node("div", "report-score-copy"), values = node("div", "report-score-values");
      label.append(node("strong", "", `${id} · ${comment?.topic || "使用体验"}`), node("span", "", comment?.text || id));
      values.append(node("span", "", `${Number(change.before).toFixed(3)} → ${Number(change.after).toFixed(3)}`), node("strong", change.delta >= 0 ? "positive-change" : "negative-change", `${change.delta >= 0 ? "+" : ""}${Number(change.delta).toFixed(4)}`));
      row.append(label, values); $("#round-report-scores").append(row);
    }
    if (!changed.length) $("#round-report-scores").append(node("p", "report-empty", "本轮评分未发生变化。没有有效阅读贡献的结果不会训练评论分数。"));
    $("#round-report-note").textContent = `结果计数覆盖全部 ${round.completed} 位；其中 ${summary.without_contribution || 0} 位没有有效阅读贡献。以上为合成体验记录与关联分变化，不代表评论导致购买，也不能用 6 人验证真实效果。新一轮将恢复初始评分。`;
  }
  function sync() {
    // A route can remain eligible for sampling while its viewport is outside
    // the browser window (for example when the external research panel is
    // scrolled into view on a narrow screen). Reflect the actual readable
    // state in the indicator instead of showing "前台采集中" with zero rows.
    const live = canRecord() && lastVisible > 0;
    const settled = Boolean(ownedId && state?.episode?.phase === "settled");
    $("#enter-reviews").disabled = !state || busy || transitioning || Boolean(ownedId) || Boolean(pendingStopRound) || roundComplete();
    $("#enter-reviews").querySelector("span").textContent = pendingStopRound ? "正在结束本轮…" : busy && screen === "product" ? "正在准备评论…" : "查看全部评论";
    $("#back-product").disabled = settling || Boolean(pendingStopRound) || intent === "product";
    $("#stop-reading").disabled = resetting || !(pendingStopRound || hasRoundProgress());
    $("#restart-round").disabled = busy || transitioning || Boolean(pendingStopRound) || !roundComplete();
    $("#retry-action").disabled = busy;
    document.querySelectorAll("input[name=strategy]").forEach(input => { input.disabled = busy || Boolean(pendingStopRound) || screen !== "product" || Boolean(state?.round?.strategy); });
    const viewDisabled = busy || screen !== "reviews" || errorPaused || !(isActive() || settled);
    document.querySelectorAll("[data-filter]").forEach(button => { button.disabled = viewDisabled; });
    $("#sort").disabled = viewDisabled;
    document.querySelectorAll("[data-outcome]").forEach(button => { button.disabled = busy || !isActive() || errorPaused || screen !== "reviews" || !armed; });
    const status = settled ? "已结算 · 停止采集" : errorPaused ? "记录已暂停" : busy ? "正在处理" : live ? "前台采集中" : isActive() ? "采集已暂停" : "尚未开始";
    $("#reading-status").textContent = status;
    $("#recording-indicator").classList.toggle("live", live);
    $("#recording-indicator span").textContent = status;
    $("#episode-status").textContent = settled ? "本轮已结算" : isActive() ? "本轮阅读中" : "等待进入评论";
    $("#visible-count").textContent = live ? String(lastVisible) : "0";
    $("#read-seconds").replaceChildren(document.createTextNode(seconds.toFixed(1)), node("span", "", "s"));
    $("#event-count").textContent = String(submitted);
    $("#queue-status").textContent = `本地待提交 ${pending.length} 段`;
    $("#decision-title").textContent = settled ? "正在完成本次体验" : "本次购买结果";
    $("#decision-description").textContent = state?.viewer?.ordinal === (state?.round?.limit || 6) ? "选择结果后查看本轮总结。" : "选择结果后切换下一位访客。";
  }
  function showScreen(next) {
    cancelMotion();
    screen = next;
    renderReady = false;
    document.body.dataset.screen = next;
    screens.forEach(name => { $(`#${name}-screen`).hidden = name !== next; });
    window.scrollTo(0, 0);
    if (next !== "reviews") {
      reviews.replaceChildren(); // No readable review DOM on the product route.
      closeDrawer(false);
      closeContentDialog(false);
    }
    sync();
  }
  const waitForLayout = () => new Promise(resolve => {
    // Background tabs can suspend rAF. Foreground checks still gate activation.
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(done, 160);
    requestAnimationFrame(() => requestAnimationFrame(done));
  });
  function finishMotion(motion) {
    if (currentMotion !== motion) return;
    for (const animation of motion.animations) animation.cancel();
    clearTimeout(motion.timer);
    for (const element of screens.map(name => $(`#${name}-screen`))) {
      element.style.opacity = "";
      element.style.zIndex = "";
      element.inert = false;
      element.hidden = element !== motion.incoming;
    }
    if (motion.next !== "reviews") reviews.replaceChildren();
    currentMotion = null; transitioning = false;
    document.body.classList.remove("is-transitioning");
    delete document.body.dataset.motion;
    motion.resolve();
  }
  function cancelMotion() { if (currentMotion) finishMotion(currentMotion); }
  async function transitionScreen(next, { token = generation, kind = "navigate", prepare = () => {} } = {}) {
    guard(token);
    cancelMotion();
    const previous = screen;
    const outgoing = $(`#${previous}-screen`), incoming = $(`#${next}-screen`);
    const motion = { token, next, incoming, animations: [], timer: null, resolve: null };
    const completed = new Promise(resolve => { motion.resolve = resolve; });
    currentMotion = motion; transitioning = true; armed = false; renderReady = false; finishAll();
    document.body.classList.add("is-transitioning");
    document.body.dataset.motion = kind;
    screen = next; document.body.dataset.screen = next;
    outgoing.inert = true; incoming.inert = true;
    incoming.hidden = false;
    incoming.style.opacity = "0";
    incoming.style.zIndex = "2";
    try {
      prepare();
      if (next === "product") incoming.scrollTop = 0;
      // A focused entry near the bottom of the product may scroll the outer
      // mobile page. Restore the complete client before measuring/animating.
      window.scrollTo(0, 0);
      sync();
      await waitForLayout();
      guard(token);
      if (currentMotion !== motion) return;
      if (next === "reviews") updateRowGeometry();
      if (previous === next || reducedMotion.matches || document.hidden || !focused || typeof incoming.animate !== "function") {
        finishMotion(motion);
      } else {
        const forward = next === "reviews", handoff = ["handoff", "complete", "restart"].includes(kind);
        const duration = handoff ? 380 : 340;
        const start = handoff ? "translateY(24px)" : `translateX(${forward ? 42 : -28}px)`;
        const end = handoff ? "translateY(-16px)" : `translateX(${forward ? -22 : 32}px)`;
        const options = { duration, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" };
        try {
          for (const [element, frames] of [
            [outgoing, [{ opacity: 1, transform: "translate(0)" }, { opacity: 0, transform: end }]],
            [incoming, [{ opacity: 0, transform: start }, { opacity: 1, transform: "translate(0)" }]]
          ]) {
            const animation = element.animate(frames, options);
            motion.animations.push(animation);
            void animation.finished.catch(() => {});
          }
          incoming.style.opacity = "";
          // Animation completion, cancellation and timeout all converge once;
          // stale callbacks cannot release a newer motion's lock.
          void Promise.allSettled(motion.animations.map(animation => animation.finished)).then(() => finishMotion(motion));
          motion.timer = setTimeout(() => finishMotion(motion), duration + 200);
        } catch {
          // A missing/broken animation engine must not strand a prepared page
          // before its route and normal foreground activation are established.
          finishMotion(motion);
        }
      }
      await completed;
      guard(token);
    } finally {
      if (currentMotion === motion) finishMotion(motion);
    }
  }
  function resetEpisode() {
    armed = false; renderReady = false; errorPaused = false;
    active.clear(); pending = []; seconds = 0; submitted = 0; lastVisible = 0;
    currentFilter = "all"; currentSort = "recommended"; scrolled = false;
    updateViewControls();
    $("#view-mode-note").textContent = "当前：初始推荐排序 · 全部评论。手动调整后的列表不适用初始首位概率。";
  }
  function updateViewControls() {
    $("#sort").value = currentSort;
    document.querySelectorAll("[data-filter]").forEach(button => {
      const selected = button.dataset.filter === currentFilter;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }
  function orderedComments() {
    const byId = new Map(state.comments.map(comment => [comment.comment_id, comment]));
    let list = (state.ranking.order || []).map(id => byId.get(id)).filter(Boolean);
    if (currentSort === "recent") list.sort((a, b) => Number(b.created_order || 0) - Number(a.created_order || 0));
    return list.filter(comment => currentFilter === "all" || comment.sentiment === currentFilter);
  }
  function renderComments() {
    if (screen !== "reviews") return;
    reviews.replaceChildren();
    const list = orderedComments();
    $("#review-count").textContent = String(list.length);
    list.forEach(comment => {
      const index = Math.max(0, state.comments.findIndex(item => item.comment_id === comment.comment_id));
      const name = names[index % names.length] + (index >= names.length ? ` ${Math.floor(index / names.length) + 1}` : "");
      const article = node("article", "review-card");
      article.dataset.commentId = comment.comment_id;
      article.setAttribute("aria-label", `${name}的评论`);
      const opener = node("button", "review-open");
      opener.type = "button";
      opener.setAttribute("aria-label", `展开${name}的完整评论`);
      opener.setAttribute("aria-haspopup", "dialog");
      opener.addEventListener("click", () => openReview(comment, name, opener));
      const top = node("div", "review-topline");
      const avatar = node("span", "avatar", name.slice(0, 1));
      avatar.setAttribute("aria-hidden", "true");
      top.append(node("span", "review-author", name), node("span", "topic-badge", comment.topic || "使用感受"));
      const copy = node("div", "row-copy");
      const summary = comment.text.length > 158 ? `${comment.text.slice(0, 155)}…` : comment.text;
      copy.append(top, node("p", "review-text", summary));
      const arrow = node("span", "open-arrow", "›");
      arrow.setAttribute("aria-hidden", "true");
      opener.append(avatar, copy, arrow);
      article.append(opener);
      reviews.append(article);
    });
    if (!list.length) reviews.append(node("div", "empty-state", "这个筛选下暂时没有评论。试试其他评价类型。"));
    $("#feed-caption").textContent = currentFilter === "all" ? "点击评论，展开全文" : `正在查看${filterNames[currentFilter]}`;
    viewport.scrollTop = 0;
    updateRowGeometry();
    renderWeightRuler();
    updateProgress();
  }
  function updateRowGeometry() {
    if (departed || screen !== "reviews") return;
    const height = viewport.getBoundingClientRect().height;
    if (!(height > 0)) return;
    const nextHeight = height / 8;
    if (Math.abs(nextHeight - rowHeight) > .01) {
      finishAll();
      const index = rowHeight > 0 ? Math.round(viewport.scrollTop / rowHeight) : 0;
      rowHeight = nextHeight;
      viewport.style.setProperty("--row-height", `${rowHeight}px`);
      viewport.dataset.summaryLines = rowHeight >= 64 ? "2" : "1";
      viewport.scrollTop = index * rowHeight;
    }
    updateProgress();
  }
  function updateSignaturePosition() {
    const signature = document.querySelector(".page-signature");
    const phone = $("#phone-shell");
    const panel = $("#research-panel");
    if (!signature || !phone || !panel) return;
    const phoneRect = phone.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const left = Math.min(phoneRect.left, panelRect.left);
    const right = Math.max(phoneRect.right, panelRect.right);
    if (!(right > left)) return;
    document.documentElement.style.setProperty("--content-center", `${(left + right) / 2}px`);
  }
  function positionWeight(strategy, centerY, initialScreen) {
    const y = Math.max(0, Math.min(1, centerY));
    if (initialScreen || strategy === "uniform") return 1;
    if (strategy === "slide") return Math.min(8, Math.max(1, 8 * y + .5)) / 8;
    const weights = [1, 3, 5, 7, 8, 8, 7, 5];
    const z = Math.min(7, Math.max(0, 8 * y - .5));
    const left = Math.floor(z);
    return (weights[left] + (weights[Math.min(7, left + 1)] - weights[left]) * (z - left)) / 8;
  }
  function renderWeightRuler() {
    const ruler = $("#weight-ruler");
    ruler.replaceChildren();
    for (let i = 0; i < 8; i++) {
      const weight = positionWeight(activeStrategy, (i + .5) / 8, !scrolled);
      const slot = node("div", "weight-slot");
      slot.style.setProperty("--weight-opacity", String(weight * .16));
      const display = String(Math.round(weight * 8 * 100) / 100);
      slot.setAttribute("aria-label", `第 ${i + 1} 行，位置权重 ${display}`);
      slot.append(node("strong", "", display));
      ruler.append(slot);
    }
  }
  function updateProgress() {
    if (screen !== "reviews") return;
    const count = reviews.querySelectorAll(".review-card").length;
    const first = count ? Math.floor((viewport.scrollTop + .25) / Math.max(1, rowHeight)) + 1 : 0;
    $("#scroll-progress").textContent = `${first}–${Math.min(first + 7, count)} / ${count}`;
    $("#previous-page").disabled = !count || viewport.scrollTop < 1;
    $("#next-page").disabled = !count || viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1;
  }
  function movePage(direction) {
    if (busy || drawerOpen || contentOpen || screen !== "reviews") return;
    const index = Math.round(viewport.scrollTop / Math.max(1, rowHeight));
    viewport.scrollTo({ top: Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, (index + direction * 8) * rowHeight)), behavior: "auto" });
  }
  function renderScores() {
    $("#score-list").replaceChildren();
    const ids = (state.ranking.order || []).slice(0, 8);
    for (const id of ids) {
      const score = Math.max(0, Math.min(1, Number(state.scores?.[id]) || 0));
      const row = node("div", "score-row");
      const comment = state.comments.find(item => item.comment_id === id);
      const stat = state.stats?.[id] || {};
      row.title = `${comment?.text.slice(0, 65) || id}\n正向贡献 ${Number(stat.positive || 0).toFixed(3)}；负向贡献 ${Number(stat.negative || 0).toFixed(3)}`;
      const track = node("div", "score-track"), bar = node("div", "score-bar");
      bar.style.width = `${score * 100}%`; track.append(bar);
      row.append(node("span", "", id), track, node("span", "score-value", score.toFixed(3)));
      $("#score-list").append(row);
    }
    $("#policy-action").textContent = `初始首位：${state.ranking.action || "—"}`;
    const probability = Number(state.ranking.logging_probability);
    $("#policy-probability").textContent = `初始首位策略概率：${Number.isFinite(probability) ? probability.toFixed(4) : "—"}`;
  }
  function renderHeatmap() {
    $("#active-strategy").textContent = strategyNames[activeStrategy];
    $("#position-heatmap").replaceChildren();
    const middleWeights = [1, 3, 5, 7, 8, 8, 7, 5];
    for (let i = 0; i < 8; i++) {
      const weight = activeStrategy === "slide" ? (i + 1) / 8 : activeStrategy === "center_lower" ? middleWeights[i] / 8 : 1;
      const row = node("div", "heat-row");
      row.style.opacity = String(.18 + .67 * weight);
      row.title = `第 ${i + 1} 行中心，权重 ${weight.toFixed(3)}`;
      $("#position-heatmap").append(row);
    }
  }
  function finishSegment(id) {
    const segment = active.get(id);
    if (!segment) return;
    active.delete(id);
    if (segment.last_ms - segment.start_ms < 1000) return;
    if (pending.length >= MAX_PENDING) {
      armed = false; errorPaused = true;
      notice("本地缓存已达上限，记录已暂停；超出部分未保存。请恢复服务后重试提交。", true, retryCapture, "重试提交");
      return;
    }
    pending.push({ comment_id: id, start_ms: segment.start_ms, end_ms: segment.last_ms, visible_fraction: segment.visible_sum / segment.samples, center_y: segment.center_sum / segment.samples, initial_screen: segment.initial_screen });
  }
  function finishAll() { for (const id of Array.from(active.keys())) finishSegment(id); lastVisible = 0; }
  function stopCapture() { armed = false; finishAll(); sync(); }
  function sample() {
    const timestamp = performance.now(), elapsed = timestamp - lastSample, time = nowMs();
    lastSample = timestamp;
    if (!canRecord()) { finishAll(); sync(); return; }
    if (elapsed > 750) finishAll();
    const box = viewport.getBoundingClientRect();
    const top = Math.max(0, box.top), bottom = Math.min(window.innerHeight, box.bottom);
    const height = Math.max(0, bottom - top), nominalHeight = Math.min(box.height, window.innerHeight);
    const left = Math.max(0, box.left), right = Math.min(window.innerWidth, box.right);
    const visible = new Set();
    for (const card of reviews.querySelectorAll(".review-card")) {
      const id = card.dataset.commentId, rect = card.getBoundingClientRect();
      const a = Math.max(top, rect.top), b = Math.min(bottom, rect.bottom);
      const horizontal = Math.max(0, Math.min(right, rect.right) - Math.max(left, rect.left)) / Math.max(1, Math.min(rect.width, box.width));
      const fraction = height > 0 ? Math.min(1, Math.max(0, b - a) / Math.max(1, Math.min(rect.height, nominalHeight))) * Math.min(1, horizontal) : 0;
      if (fraction < .5) continue;
      visible.add(id);
      // Visibility uses the browser intersection; position stays relative to
      // the phone viewport when the outer page scrolls toward the research UI.
      const center = Math.max(0, Math.min(1, ((rect.top + rect.bottom) / 2 - box.top) / box.height));
      let segment = active.get(id);
      if (segment && segment.initial_screen !== !scrolled) { finishSegment(id); segment = null; }
      if (!segment) {
        active.set(id, { start_ms: time, last_ms: time, visible_sum: fraction, center_sum: center, samples: 1, initial_screen: !scrolled });
      } else {
        if (elapsed <= 750) seconds += Math.max(0, time - segment.last_ms) / 1000;
        segment.last_ms = time; segment.visible_sum += fraction; segment.center_sum += center; segment.samples++;
      }
    }
    for (const id of Array.from(active.keys())) if (!visible.has(id)) finishSegment(id);
    lastVisible = visible.size;
    sync();
  }
  async function flush({ keepalive = false, token = generation } = {}) {
    guard(token);
    if (sending?.token === token) { await sending.promise; guard(token); if (!pending.length) return; }
    if (!ownedId || !pending.length) return;
    const id = ownedId;
    const operation = { token, promise: null };
    operation.promise = (async () => {
      while (pending.length && ownedId === id) {
        guard(token);
        const batch = pending.slice(0, 200);
        const result = await api("/api/exposures", { episode_id: id, events: batch }, { keepalive, token });
        guard(token);
        if (ownedId !== id) return;
        pending.splice(0, batch.length);
        submitted += Number(result.accepted || 0);
        sync();
      }
    })();
    sending = operation;
    try { await operation.promise; }
    catch (error) {
      if (isCurrent(token) && ownedId === id) fail(`曝光提交失败，记录已暂停：${error.message} 缓存保留在本页。`, retryCapture, "重试提交");
      throw error;
    } finally { if (isCurrent(token) && sending === operation) sending = null; }
  }
  async function retryCapture() {
    if (busy || !ownedId || departed) return;
    const token = generation;
    busy = true; stopCapture();
    try {
      const fresh = await api("/api/state", undefined, { token });
      guard(token);
      if (fresh.episode?.episode_id !== ownedId || fresh.episode.phase !== "active") throw new Error("本轮已失效，请点击“返回商品”重新进入。");
      acceptState(fresh, token);
      await flush({ token });
      guard(token);
      clearNotice(); armed = true;
    } catch (error) { if (isCurrent(token)) fail(`仍未恢复记录：${error.message}`, retryCapture, "重试提交"); }
    finally { if (isCurrent(token)) { busy = false; sync(); finishNavigation(); } }
  }
  function finishNavigation() {
    if (!busy && intent === "product" && ownedId && !departed) void leaveReviews();
  }
  function requireForeground() {
    if (document.hidden || !focused || !document.hasFocus()) {
      throw new Error("评论已准备好，尚未激活。请回到此页面前台，再点击“重试进入评论”。");
    }
    if (contentOpen || transitioning) {
      throw new Error("评论已准备好，尚未激活。请关闭浮层后重试进入评论。");
    }
  }
  async function activatePrepared(token = generation) {
    guard(token);
    requireForeground();
    await waitForLayout();
    guard(token);
    if (intent !== "reviews" || screen !== "reviews") return;
    requireForeground();
    updateRowGeometry();
    const box = viewport.getBoundingClientRect();
    if (box.height <= 0 || box.width <= 0) throw new Error("评论区尚未完成布局，请重试进入。");
    renderReady = true;
    const activated = await api("/api/activate", { episode_id: ownedId }, { token });
    guard(token);
    if (activated.episode?.episode_id !== ownedId || activated.episode.phase !== "active" || activated.episode.closed || !activated.episode.started_at) throw new Error("评论片段未激活，请重试进入。");
    acceptState(activated, token);
    const start = Date.parse(activated.episode.started_at);
    if (!Number.isFinite(start)) throw new Error("服务未返回有效的阅读开始时间。");
    origin = performance.now() - Math.max(0, Date.now() - start);
    lastSample = performance.now();
    if (intent === "reviews") { clearNotice(); armed = true; }
  }
  async function retryActivation() {
    if (busy || !ownedId || screen !== "reviews" || departed) return;
    const token = generation;
    busy = true; stopCapture();
    try { await activatePrepared(token); }
    catch (error) { if (isCurrent(token)) fail(`评论尚未开始记录：${error.message}`, retryActivation, "重试进入评论"); }
    finally { if (isCurrent(token)) { busy = false; sync(); sample(); finishNavigation(); } }
  }
  async function enterReviews() {
    if (busy || transitioning || !state || ownedId || pendingStopRound || screen !== "product" || departed || roundComplete()) return;
    const token = generation;
    busy = true; intent = "reviews"; clearNotice(); sync();
    try {
      activeStrategy = state.round?.strategy || $("input[name=strategy]:checked").value;
      const prepared = await api("/api/start", { strategy: activeStrategy }, { token });
      guard(token);
      if (!prepared.episode?.episode_id || prepared.episode.phase !== "prepared" || prepared.episode.started_at !== null) throw new Error("服务未返回待进入的评论片段，请更新并重启服务。");
      acceptState(prepared, token); ownedId = prepared.episode.episode_id; resetEpisode();
      if (intent !== "reviews") return;
      await transitionScreen("reviews", { token, prepare: () => { renderComments(); renderHeatmap(); renderScores(); } });
      guard(token);
      if (intent !== "reviews") return;
      history.pushState({ view: "reviews" }, "", "#reviews");
      $("#comments-title").focus({ preventScroll: true });
      await activatePrepared(token);
    } catch (error) {
      if (isCurrent(token)) fail(`无法进入评论：${error.message}`, ownedId ? retryActivation : refreshEntry, ownedId ? "重试进入评论" : "重试打开评论");
    } finally { if (isCurrent(token)) { busy = false; sync(); sample(); finishNavigation(); } }
  }
  async function completeProduct(data, message = "", token = generation, kind = "return") {
    guard(token);
    const next = roundComplete(data || state) ? "summary" : "product";
    ownedId = null; intent = next; armed = false; renderReady = false;
    active.clear(); pending = []; errorPaused = false;
    closeContentDialog(false);
    await transitionScreen(next, { token, kind, prepare: () => { if (data) acceptState(data, token); clearNotice(); } });
    guard(token);
    history.replaceState({ view: next }, "", `#${next}`);
    if (message) notice(message);
    $(next === "summary" ? "#summary-title" : "#enter-reviews").focus({ preventScroll: true });
  }
  async function leaveReviews() {
    if (departed || settling || pendingStopRound) return;
    if (roundComplete()) { intent = "summary"; showScreen("summary"); history.replaceState({ view: "summary" }, "", "#summary"); return; }
    intent = "product"; stopCapture(); cancelMotion();
    if (busy) return;
    if (!ownedId) { showScreen("product"); history.replaceState({ view: "product" }, "", "#product"); return; }
    const token = generation;
    busy = true; sync();
    try {
      // Reconcile first: a lost outcome reply or a restarted local service must
      // not trap navigation behind an obsolete episode or resend old exposure.
      const fresh = await api("/api/state", undefined, { token });
      guard(token);
      if (fresh.last_result?.episode_id === ownedId) {
        await handoffViewer(fresh, ownedId, token);
      } else if (fresh.episode?.episode_id !== ownedId) {
        await completeProduct(fresh, "上一轮片段已失效，本地未提交记录已丢弃。可从评论入口重新开始。", token);
      } else if (fresh.episode.closed) {
        await completeProduct(fresh, "", token);
      } else {
        await flush({ token });
        guard(token);
        const left = await api("/api/leave", { episode_id: ownedId }, { token });
        guard(token);
        await completeProduct(left, "", token);
      }
    } catch (error) {
      if (!isCurrent(token)) return;
      intent = screen; // Stay stopped on the current screen; retry is explicit.
      history.replaceState({ view: screen }, "", `#${screen}`);
      fail(`已停止记录，但暂时无法完成返回：${error.message}`, leaveReviews, "重试返回商品");
    } finally { if (isCurrent(token)) { busy = false; sync(); } }
  }
  async function changeView(sort, filter) {
    if (departed) return;
    if (busy || errorPaused || screen !== "reviews") { updateViewControls(); return; }
    const token = generation;
    busy = true; finishAll(); sync();
    try {
      await flush({ token });
      guard(token);
      if (isActive()) await api("/api/view-mode", { episode_id: ownedId, sort, filter }, { token });
      guard(token);
      if (intent !== "reviews") return;
      currentSort = sort; currentFilter = filter; scrolled = true;
      updateViewControls(); renderComments();
      $("#view-mode-note").textContent = `当前：${sort === "recent" ? "最新发布" : "推荐排序"} · ${filterNames[filter]}。已手动调整，初始首位概率不描述当前列表。`;
    } catch (error) {
      if (!isCurrent(token)) return;
      updateViewControls();
      fail(`评论视图未切换，记录已暂停：${error.message}`, () => retryView(sort, filter), "重试切换");
    } finally { if (isCurrent(token)) { busy = false; sync(); sample(); finishNavigation(); } }
  }
  async function retryView(sort, filter) {
    if (departed) return;
    const token = generation;
    errorPaused = false;
    await changeView(sort, filter);
    if (!isCurrent(token)) return;
    if (!errorPaused && isActive()) { clearNotice(); armed = true; sync(); }
  }
  async function submitOutcome(outcome, retry = false) {
    if (busy || !ownedId || screen !== "reviews" || departed) return;
    const token = generation;
    const episodeId = ownedId;
    busy = true; settling = true; stopCapture();
    try {
      if (retry) {
        const fresh = await api("/api/state", undefined, { token });
        guard(token);
        if (fresh.last_result?.episode_id === episodeId) { await handoffViewer(fresh, episodeId, token); return; }
        if (fresh.episode?.episode_id !== episodeId || fresh.episode.phase !== "active") throw new Error("未找到本轮对应的结算回执，请返回商品重新进入。");
      }
      await flush({ token });
      guard(token);
      const settled = await api("/api/outcome", { episode_id: episodeId, outcome }, { token });
      guard(token);
      if (settled.last_result?.episode_id !== episodeId) throw new Error("结果尚未返回对应回执，请重试确认。");
      const fresh = await api("/api/state", undefined, { token });
      guard(token);
      await handoffViewer(fresh, episodeId, token);
    } catch (error) { if (isCurrent(token)) fail(`结果尚未确认，记录已停止：${error.message}`, () => submitOutcome(outcome, true), "重试确认结果"); }
    finally { if (isCurrent(token)) { busy = false; settling = false; sync(); finishNavigation(); } }
  }
  async function handoffViewer(data, episodeId, token) {
    guard(token);
    const receipt = data.last_result;
    const completed = roundComplete(data);
    const viewerMatches = completed
      ? receipt?.to_viewer === null && receipt?.from_viewer?.user_key === data.viewer?.user_key && data.round.completed === data.round.limit
      : receipt?.to_viewer?.user_key === data.viewer?.user_key;
    if (!receipt || receipt.episode_id !== episodeId || !data.viewer?.user_key || !viewerMatches || (state?.round?.id && receipt.round_id !== state.round.id)) throw new Error("回执与当前访客未对应，请重试确认；不会重复结算。");
    // One confirmed receipt owns one handoff. Old callbacks, timers and locks
    // cannot touch the next visitor after the generation changes here.
    invalidateOperations();
    const nextToken = generation;
    ownedId = null; busy = true; armed = false; renderReady = false;
    intent = "product";
    closeDrawer(false); closeContentDialog(false);
    resetEpisode();
    try { await completeProduct(data, "", nextToken, completed ? "complete" : "handoff"); }
    finally { if (isCurrent(nextToken)) { busy = false; settling = false; sync(); } }
  }
  async function stopRound() {
    if (departed || resetting || !(pendingStopRound || hasRoundProgress())) return;
    pendingStopRound ??= state.round.id;
    // Retire every in-flight operation before resetting the synthetic round.
    // A late start, exposure or outcome reply cannot restore the old visitor.
    invalidateOperations();
    intent = "product"; stopCapture();
    ownedId = null; active.clear(); pending = [];
    busy = false; settling = false;
    closeContentDialog(false);
    await restartRound(pendingStopRound, true);
  }
  async function restartRound(previousRound = null, discardRunning = false) {
    if (busy || departed || (!roundComplete() && !previousRound)) return;
    const roundId = previousRound || state.round.id;
    let token = generation;
    busy = true; settling = true; resetting = true; stopCapture();
    try {
      const fresh = await api("/api/reset", { round_id: roundId, ...(discardRunning ? { discard_running: true } : {}) }, { token });
      guard(token);
      if (!fresh.round?.id || fresh.round.id === roundId || fresh.last_reset_from !== roundId) throw new Error("未收到对应的新轮回执，请重试；不会重复重置。");
      invalidateOperations(); token = generation;
      ownedId = null; busy = true; settling = true;
      resetEpisode(); displayedReceipt = null;
      activeStrategy = fresh.round.strategy || fresh.strategy || "center_lower";
      document.querySelectorAll("input[name=strategy]").forEach(input => { input.checked = input.value === activeStrategy; });
      $("#selected-strategy-label").replaceChildren(document.createTextNode(`${strategyNames[activeStrategy]} `), node("b", "", "⌄"));
      $("#research-setup").open = false;
      $("#last-result").open = false;
      $("#live-research").scrollTop = 0;
      $(".product-detail").scrollTop = 0;
      viewport.scrollTop = 0;
      $("#score-list").replaceChildren(node("p", "score-note", "进入评论后显示推荐评分"));
      $("#policy-action").textContent = "初始首位：—";
      $("#policy-probability").textContent = "进入评论后生成排序";
      await completeProduct(fresh, "", token, "restart");
      pendingStopRound = null;
      renderHeatmap();
    } catch (error) {
      if (isCurrent(token)) fail(discardRunning ? `已停止采集，但本轮尚未清空：${error.message}` : `新一轮尚未确认：${error.message}`,
        discardRunning ? stopRound : () => restartRound(roundId), discardRunning ? "重试停止并清空" : "重试开始新一轮");
    }
    finally { if (isCurrent(token)) { busy = false; settling = false; resetting = false; sync(); } }
  }
  function pauseForVisibility() {
    finishAll(); sync();
    if (ownedId && !errorPaused) flush({ keepalive: true }).catch(() => {});
  }
  function openDrawer() {
    if (busy || departed) return;
    const panel = $("#research-panel");
    panel.focus({ preventScroll: true });
    if (panel.getBoundingClientRect().bottom > window.innerHeight) panel.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
  }
  function closeDrawer(restoreFocus = true) {
    drawerOpen = false;
    $("#research-panel").classList.remove("mobile-open");
    $("#research-backdrop").hidden = true;
    $("#toggle-research").removeAttribute("aria-expanded");
    $("#research-panel").removeAttribute("role");
    $("#research-panel").removeAttribute("aria-modal");
    $(".comment-panel").inert = false;
    $(".decision-bar").inert = false;
    if (restoreFocus && screen === "reviews") $("#toggle-research").focus();
    lastSample = performance.now(); sync();
  }
  function showContentDialog(title, kicker, paragraphs, opener) {
    if (busy || departed) return;
    contentOpen = true;
    closeDrawer(false);
    pauseForVisibility();
    dialogOpener = opener || document.activeElement;
    $("#content-dialog-title").textContent = title;
    $("#content-dialog-kicker").textContent = kicker;
    $("#content-dialog-body").replaceChildren(...paragraphs.map(text => node("p", "", text)));
    contentDialog.showModal();
    $("#close-content-dialog").focus();
    sync();
  }
  function openReview(comment, name, opener) {
    if (screen !== "reviews") return;
    showContentDialog(`${name}的使用体验`, comment.topic || "评论全文", [comment.text], opener);
  }
  function closeContentDialog(restoreFocus = true) {
    contentOpen = false;
    if (contentDialog.open) contentDialog.close();
    if (restoreFocus && dialogOpener?.isConnected) dialogOpener.focus({ preventScroll: true });
    dialogOpener = null;
    lastSample = performance.now();
    sync();
  }
  function openAbout() {
    showContentDialog("关于这次体验", "使用说明", [
      "这里的商品、72 条评论、访客及支付结果都是合成数据。按钮只用来体验阅读与后续选择的关联，不发生真实交易。",
      browserRuntime ? "阅读记录和评分只保存在当前标签页内存中，不上传。刷新或关闭页面会清空体验；深浅色偏好保存在本机。" : "当前使用本地 Python 演示服务，轮次与评分保存在服务进程中，重启服务后恢复初始状态。",
      "评论视窗每屏固定八条摘要，点击可看全文。右侧 1–8 表示所在屏幕位置的权重：首屏全为 8；滑动后按研究参数变化。权重不是该条评论的质量分或购买概率。",
      "只有主动进入评论、过渡动画及布局完成且前台获得焦点后才记录。页面切换和全文弹层会暂停列表采集；外置研究台不会遮挡评论，评论滚出浏览器可见区域后不累计时间。完成选择后切到下一位访客；下一位仍需自行进入评论。共享评分保留，上轮贡献可在商品页展开查看。",
      "每轮最多 6 位访客，首次进入时固定本轮位置策略。研究台的停止按钮结束并清空整轮体验，恢复初始评分、第一位访客和零进度；手机内的返回按钮只离开当前评论页。第 6 位完成后显示本轮总结，开始新一轮同样恢复初始数据。6 人用于体验流程，不是统计验证所需样本量。",
      "这些关联不能证明评论导致购买，也不能证明转化提升。真实平台仍需可信订单、授权日志和随机实验验证。"
    ], $("#about-open"));
  }
  async function loadProduct() {
    if (busy || departed) return;
    const token = generation;
    busy = true; sync();
    try {
      const data = await api("/api/state", undefined, { token });
      guard(token); acceptState(data, token); renderHeatmap(); clearNotice();
      if (roundComplete(data)) {
        intent = "summary"; showScreen("summary"); history.replaceState({ view: "summary" }, "", "#summary");
      }
    }
    catch (error) { if (isCurrent(token)) fail(`${browserRuntime ? "演示加载失败" : "暂时无法连接本地服务"}：${error.message}`, loadProduct, browserRuntime ? "重新加载" : "重新连接"); }
    finally { if (isCurrent(token)) { busy = false; sync(); } }
  }
  async function refreshEntry() {
    const token = generation;
    await loadProduct();
    if (isCurrent(token) && !errorPaused && !roundComplete()) await enterReviews();
  }
  function routeChanged() {
    if (departed) return;
    if (roundComplete()) { intent = "summary"; showScreen("summary"); history.replaceState({ view: "summary" }, "", "#summary"); return; }
    if (location.hash === "#reviews" && screen === "reviews" && ownedId) return;
    if (ownedId || busy && intent === "reviews") { intent = "product"; stopCapture(); finishNavigation(); }
    else { intent = "product"; history.replaceState({ view: "product" }, "", "#product"); showScreen("product"); }
  }

  $("#enter-reviews").addEventListener("click", enterReviews);
  $("#back-product").addEventListener("click", leaveReviews);
  $("#stop-reading").addEventListener("click", stopRound);
  $("#restart-round").addEventListener("click", () => restartRound());
  $("#return-to-client").addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });
    $(screen === "reviews" ? "#comments-title" : screen === "summary" ? "#summary-title" : "#enter-reviews").focus({ preventScroll: true });
  });
  $(".brand").addEventListener("click", event => { event.preventDefault(); void leaveReviews(); });
  $("#retry-action").addEventListener("click", () => { if (!busy && retryAction) void retryAction(); });
  $("#dismiss-notice").addEventListener("click", clearNotice);
  document.querySelectorAll("input[name=strategy]").forEach(input => input.addEventListener("change", () => {
    activeStrategy = input.value; renderHeatmap();
    $("#selected-strategy-label").replaceChildren(document.createTextNode(`${strategyNames[input.value]} `), node("b", "", "⌄"));
  }));
  document.querySelectorAll("[data-filter]").forEach(button => button.addEventListener("click", () => changeView(currentSort, button.dataset.filter)));
  $("#sort").addEventListener("change", () => changeView($("#sort").value, currentFilter));
  document.querySelectorAll("[data-outcome]").forEach(button => button.addEventListener("click", () => submitOutcome(button.dataset.outcome)));
  viewport.addEventListener("scroll", () => {
    if (!scrolled && viewport.scrollTop > 1) { finishAll(); scrolled = true; renderWeightRuler(); }
    updateProgress();
  }, { passive: true });
  $("#previous-page").addEventListener("click", () => movePage(-1));
  $("#next-page").addEventListener("click", () => movePage(1));
  $("#about-open").addEventListener("click", openAbout);
  themeToggle?.addEventListener("click", () => {
    setColorMode(document.body.dataset.colorMode === "dark" ? "light" : "dark");
  });
  $("#close-content-dialog").addEventListener("click", () => closeContentDialog());
  contentDialog.addEventListener("cancel", event => { event.preventDefault(); closeContentDialog(); });
  contentDialog.addEventListener("close", () => {
    if (!contentDialog.open) { contentOpen = false; lastSample = performance.now(); sync(); }
  });
  $("#toggle-research").addEventListener("click", openDrawer);
  $("#close-research").addEventListener("click", () => closeDrawer());
  $("#research-backdrop").addEventListener("click", () => closeDrawer());
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) cancelMotion(); });
  if (typeof ResizeObserver !== "undefined") {
    const rowObserver = new ResizeObserver(updateRowGeometry);
    rowObserver.observe(viewport);
  }
  window.addEventListener("resize", updateRowGeometry);
  window.addEventListener("resize", updateSignaturePosition);
  window.addEventListener("load", updateSignaturePosition, { once: true });
  window.addEventListener("hashchange", routeChanged);
  window.addEventListener("popstate", routeChanged);
  document.addEventListener("visibilitychange", () => { if (document.hidden) { stopPhoneClock(); cancelMotion(); pauseForVisibility(); } else { updatePhoneClock(); lastSample = performance.now(); sample(); } });
  window.addEventListener("blur", () => { focused = false; cancelMotion(); pauseForVisibility(); });
  window.addEventListener("focus", () => { updatePhoneClock(); focused = true; lastSample = performance.now(); sample(); });
  window.addEventListener("offline", () => { if (!browserRuntime && ownedId) fail("网络连接中断，记录已停止。恢复连接后点击重试；请保持页面打开以保留本地缓存。", retryCapture, "重试提交"); });
  async function sendDeparture(id, events, roundId) {
    // Unload work owns only an immutable snapshot. It cannot read or write the
    // restored page's state, queue, locks or current episode. Duplicate segments
    // from a request whose reply was lost are deduplicated by the local service.
    for (let offset = 0; offset < events.length; offset += 200) {
      await api("/api/exposures", { round_id: roundId, episode_id: id, events: events.slice(offset, offset + 200) }, { keepalive: true, detached: true });
    }
    await api("/api/leave", { round_id: roundId, episode_id: id }, { keepalive: true, detached: true });
  }
  window.addEventListener("pagehide", () => {
    stopPhoneClock();
    departed = true; intent = "product"; stopCapture();
    const id = ownedId, events = pending.slice(0, MAX_PENDING), roundId = state?.round?.id;
    invalidateOperations();
    if (id) void sendDeparture(id, events, roundId).catch(() => {});
  });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    // A restored document is a new generation. Every await/catch/finally from
    // the previous generation is inert, even if an aborted transport replies.
    invalidateOperations();
    departed = false; busy = false; settling = false; resetting = false; state = null; ownedId = null;
    updatePhoneClock();
    focused = document.hasFocus(); lastSample = performance.now();
    resetEpisode(); clearNotice();
    intent = "product"; showScreen("product"); history.replaceState({ view: "product" }, "", "#product");
    if (pendingStopRound) void stopRound();
    else void loadProduct();
  });
  setInterval(sample, 250);
  setInterval(() => {
    if (!canRecord()) return;
    for (const [id, segment] of active) if (segment.last_ms - segment.start_ms >= 1000) finishSegment(id);
    sample(); flush().catch(() => {});
  }, 5000);

  // GET may describe another/previous episode. This document never owns or
  // activates it: fresh loads, including #reviews, always start at the product.
  restoreColorMode();
  updatePhoneClock();
  updateSignaturePosition();
  history.replaceState({ view: "product" }, "", "#product");
  showScreen("product");
  void loadProduct();
})();
