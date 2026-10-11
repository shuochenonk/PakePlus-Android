/* ============================================================
   平静的多巴胺阶段 · 应用逻辑
   块式计时 + 刺激管理。数据全部本地（localStorage），不上传。
   计时基于 Date.now() 目标时间戳差值，锁屏/后台不漂移。
   ============================================================ */
(function () {
  "use strict";

  const A = window.DATA;
  const STORE_STATE = "pd_state";
  const STORE_DAYS = "pd_days";

  // ---------- 默认状态 ----------
  const DEFAULT_STATE = {
    running: false,
    phase: "work",           // 'work' | 'rest'
    endAt: null,             // 目标结束时间戳(ms)
    pausedRemaining: null,   // 暂停时剩余毫秒
    week: 1,
    workMin: 15,
    restMin: 5,
    theme: "light",
    notify: true,
    sound: true,
    profile: "normal",
    checkins: {},            // { 'YYYY-MM-DD': {walk,strength,out} }
    notes: [],               // [{date, text}]
  };

  let state = loadState();
  let days = loadDays();
  let ticker = null;

  // ---------- 工具 ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmt(totalSec) {
    totalSec = Math.max(0, Math.ceil(totalSec));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return pad(m) + ":" + pad(s);
  }
  function dayKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function todayKey() { return dayKey(new Date()); }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // ---------- 存储 ----------
  function loadState() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(STORE_STATE)) || {}; } catch (e) { s = {}; }
    return Object.assign({}, DEFAULT_STATE, s);
  }
  function saveState() {
    localStorage.setItem(STORE_STATE, JSON.stringify(state));
  }
  function loadDays() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(STORE_DAYS)) || {}; } catch (e) { d = {}; }
    return d;
  }
  function saveDays() {
    localStorage.setItem(STORE_DAYS, JSON.stringify(days));
  }
  function todayRecord() {
    const k = todayKey();
    if (!days[k]) days[k] = { blocks: 0, workSec: 0, checkins: {} };
    return days[k];
  }

  // ---------- 派生数据 ----------
  function currentPlan() {
    return A.planWeeks[(state.week - 1) || 0];
  }
  function profileDef() {
    return A.profiles[state.profile] || A.profiles.normal;
  }
  function dailyGoal() {
    const g = currentPlan().blocks;
    const f = profileDef().dailyGoalFactor || 1;
    return Math.max(1, Math.round(g * f));
  }
  function todayBlocks() {
    return (todayRecord().blocks) || 0;
  }
  function weekSeconds() {
    let sum = 0;
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const r = days[dayKey(d)];
      if (r) sum += r.workSec || 0;
    }
    return sum;
  }
  function streak() {
    // 中性展示：连续达标天数（今天未达标则从昨天往前数）
    let n = 0;
    const now = new Date();
    let i = 0;
    while (true) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const r = days[dayKey(d)];
      const b = r ? (r.blocks || 0) : 0;
      if (i === 0 && b < dailyGoal()) { i++; continue; } // 今天未达标，不计今天
      if (b >= dailyGoal()) { n++; i++; }
      else break;
      if (i > 400) break;
    }
    return n;
  }

  // ---------- DOM 引用 ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    weekHint: $("weekHint"), phaseDot: $("phaseDot"), statusLabel: $("statusLabel"),
    timerDigits: $("timerDigits"), phaseHint: $("phaseHint"), btnMain: $("btnMain"),
    btnSkip: $("btnSkip"), btnReset: $("btnReset"), todayText: $("todayText"),
    todayStreak: $("todayStreak"), progressFill: $("progressFill"),
    weekSelector: $("weekSelector"), weekDetail: $("weekDetail"), planRules: $("planRules"),
    scheduleList: $("scheduleList"), audioLadder: $("audioLadder"),
    emergencyList: $("emergencyList"), statGrid: $("statGrid"), barChart: $("barChart"),
    checkinRow: $("checkinRow"), recoveryStages: $("recoveryStages"),
    rewardCard: $("rewardCard"), gapCard: $("gapCard"), knowledgeCard: $("knowledgeCard"),
    profileCard: $("profileCard"), workMinInput: $("workMinInput"), restMinInput: $("restMinInput"),
    themeSwitch: $("themeSwitch"), notifySwitch: $("notifySwitch"), soundSwitch: $("soundSwitch"),
    exportJsonBtn: $("exportJsonBtn"), importBtn: $("importBtn"), clearBtn: $("clearBtn"),
    importFile: $("importFile"), aboutText: $("aboutText"), toast: $("toast"),
  };

  // ---------- 提示音 / 震动 / 通知 ----------
  let audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
  }
  function beep() {
    if (!state.sound) return;
    try {
      ensureAudio();
      const ctx = audioCtx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 800;
      o.type = "sine";
      g.gain.setValueAtTime(0.28, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.6);
    } catch (e) {}
  }
  function vibrate(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }
  function requestNotify() {
    try {
      if (state.notify && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } catch (e) {}
  }
  function notify(title, body) {
    if (!state.notify) return;
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body: body || "" });
      }
    } catch (e) {}
  }

  // ---------- 计时器核心 ----------
  function phaseDurationMs() {
    const min = state.phase === "work" ? state.workMin : state.restMin;
    return min * 60 * 1000;
  }
  function remainingMs() {
    if (!state.running) return state.pausedRemaining != null ? state.pausedRemaining : phaseDurationMs();
    return state.endAt - Date.now();
  }

  function renderTimerFace() {
    const rem = remainingMs();
    const sec = Math.max(0, Math.ceil(rem / 1000));
    el.timerDigits.textContent = fmt(sec);

    const isWork = state.phase === "work";
    el.statusLabel.textContent = isWork ? "工作时间" : "奖励时间";
    el.phaseHint.textContent = isWork
      ? (state.running ? "专注眼前这一块，到点会自动提醒你。" : "完成一个工作块，就有一段确定的奖励。")
      : "奖励时间——按白名单选一个，到点记得关。";
    document.body.classList.toggle("phase-work", isWork);
    document.body.classList.toggle("phase-rest", !isWork);
    el.btnMain.textContent = state.running ? "暂停" : (rem < phaseDurationMs() ? "继续" : "开始");
    el.btnMain.classList.toggle("running", state.running);
    el.btnSkip.hidden = !(isWork === false); // 奖励阶段才显示「跳过奖励」

    const t = (state.phase === "work" ? "工作" : "奖励");
    document.title = (state.running ? fmt(sec) + " · " + t : A.APP.name);
    renderTodayProgress();
  }

  function switchPhase() {
    const wasWork = state.phase === "work";
    if (wasWork) {
      // 完成一个工作块
      const rec = todayRecord();
      rec.blocks = (rec.blocks || 0) + 1;
      rec.workSec = (rec.workSec || 0) + (state.workMin * 60);
      saveDays();
      beep(); vibrate(250); notify("工作块完成", "做得不错。现在是奖励时间（" + state.restMin + " 分钟）。");
    } else {
      beep(); vibrate(150); notify("奖励结束", "回到工作，开始下一个块。");
    }
    state.phase = wasWork ? "rest" : "work";
    state.endAt = Date.now() + phaseDurationMs();
    state.pausedRemaining = null;
    saveState();
    renderTimerFace();
    renderStats();
  }

  function tick() {
    if (!state.running) return;
    if (remainingMs() <= 0) {
      switchPhase();
    } else {
      renderTimerFace();
    }
  }

  function startTimer() {
    ensureAudio();
    requestNotify();
    if (state.running) {
      // 暂停
      state.pausedRemaining = remainingMs();
      state.running = false;
      state.endAt = null;
      stopTicker();
    } else {
      // 开始 / 继续
      const base = (state.pausedRemaining != null) ? state.pausedRemaining : phaseDurationMs();
      state.endAt = Date.now() + base;
      state.pausedRemaining = null;
      state.running = true;
      startTicker();
    }
    saveState();
    renderTimerFace();
  }

  function resetTimer() {
    stopTicker();
    state.running = false;
    state.phase = "work";
    state.endAt = null;
    state.pausedRemaining = null;
    saveState();
    renderTimerFace();
  }

  function skipRest() {
    if (state.phase !== "rest") return;
    stopTicker();
    state.phase = "work";
    state.endAt = Date.now() + phaseDurationMs();
    state.pausedRemaining = null;
    state.running = true;
    startTicker();
    saveState();
    renderTimerFace();
  }

  function startTicker() { if (!ticker) ticker = setInterval(tick, 250); }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  // ---------- 视图切换 ----------
  function switchView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.target === name));
    if (name === "plan") renderPlan();
    else if (name === "emergency") renderEmergency();
    else if (name === "stats") renderStats();
    else if (name === "more") renderMore();
    else renderTimerFace();
  }

  // ---------- 渲染：计时主屏进度 ----------
  function renderTodayProgress() {
    const done = todayBlocks();
    const goal = dailyGoal();
    el.todayText.textContent = "今日 " + done + " / " + goal + " 块";
    el.progressFill.style.width = Math.min(100, (done / goal) * 100) + "%";
    const st = streak();
    el.todayStreak.textContent = st > 0 ? "连续达标 " + st + " 天" : "";
    el.weekHint.textContent = "第 " + state.week + " 周 · " + currentPlan().stage;
  }

  // ---------- 渲染：计划 ----------
  function renderPlan() {
    // 周选择器
    el.weekSelector.innerHTML = A.planWeeks.map((w) =>
      '<button class="week-btn' + (w.week === state.week ? " active" : "") + '" data-week="' + w.week + '">' +
      '<div class="wk">第 ' + w.week + ' 周</div>' +
      '<div class="wk-note">' + w.stage + '</div></button>'
    ).join("");
    el.weekSelector.querySelectorAll("[data-week]").forEach((b) =>
      b.addEventListener("click", () => {
        state.week = Number(b.dataset.week);
        state.workMin = currentPlan().workMin;   // 按周自动套用单块时长
        el.workMinInput.value = state.workMin;
        saveState();
        renderTimerFace(); renderPlan();
      })
    );

    const p = currentPlan();
    el.weekDetail.innerHTML =
      '<div class="card-title">第 ' + p.week + ' 周 · ' + p.stage + '</div>' +
      '<p style="font-size:14px;color:var(--ink-soft);margin-bottom:8px">' + escapeHtml(p.note) + '</p>' +
      '<table class="tbl"><tbody>' +
      '<tr><th>每日目标</th><td>' + dailyGoal() + ' 块（约 ' + (dailyGoal() * p.workMin / 60).toFixed(1) + ' 小时）</td></tr>' +
      '<tr><th>单块时长</th><td>' + p.workMin + ' 分钟</td></tr>' +
      '<tr><th>上午 / 下午</th><td>上午 ' + p.am + ' 块 + 下午 ' + p.pm + ' 块</td></tr>' +
      '</tbody></table>';

    el.planRules.innerHTML = '<ul class="list">' +
      A.planRules.map((r) => "<li>" + escapeHtml(r) + "</li>").join("") + "</ul>";

    el.scheduleList.innerHTML = A.schedule.map((s) =>
      '<li><div class="li-title">' + escapeHtml(s.time) + "　" + escapeHtml(s.title) + "</div>" +
      (s.note ? '<div class="li-desc">' + escapeHtml(s.note) + "</div>" : "") + "</li>"
    ).join("");

    el.audioLadder.innerHTML =
      '<div class="card-title">阶梯降级（每档约 7 天）</div>' +
      '<ul class="list">' +
      A.audioLadder.map((a) =>
        '<li><span class="chip">第 ' + a.step + ' 档</span> ' + escapeHtml(a.content) +
        '<div class="li-desc">' + escapeHtml(a.desc) + "</div></li>").join("") +
      "</ul>" +
      '<div class="tip" style="margin-top:12px">' +
      A.audioNotes.map((n) => "<div style=\"margin:6px 0\">· " + escapeHtml(n) + "</div>").join("") +
      "</div>";
  }

  // ---------- 渲染：应急 ----------
  function renderEmergency() {
    el.emergencyList.innerHTML = A.emergency.map((e, idx) =>
      '<div class="acc" data-acc="' + idx + '">' +
      '<button class="acc-head" aria-expanded="false"><span>' + escapeHtml(e.title) +
      '</span><span class="chev">›</span></button>' +
      '<div class="acc-body">' +
      '<div class="acc-lead">' + escapeHtml(e.lead) + "</div>" +
      "<p>" + escapeHtml(e.body) + "</p>" +
      (e.checklist ? '<ul class="check" data-checklist></ul>' : "") +
      "</div></div>"
    ).join("");

    // 物理隔离清单
    const barrier = A.emergency.find((e) => e.key === "barrier");
    const wrap = el.emergencyList.querySelector('[data-acc="' + (A.emergency.indexOf(barrier)) + '"] [data-checklist]');
    if (wrap) {
      const rec = todayRecord();
      rec.checkins = rec.checkins || {};
      const saved = rec.checkins.barrier || {};
      wrap.innerHTML = barrier.checklist.map((c, i) =>
        '<li class="' + (saved[i] ? "done" : "") + '"><input type="checkbox" data-barrier="' + i + '"' +
        (saved[i] ? " checked" : "") + "><span>" + escapeHtml(c) + "</span></li>"
      ).join("");
      wrap.querySelectorAll("[data-barrier]").forEach((cb) =>
        cb.addEventListener("change", () => {
          rec.checkins.barrier = rec.checkins.barrier || {};
          rec.checkins.barrier[Number(cb.dataset.barrier)] = cb.checked;
          saveDays();
          cb.closest("li").classList.toggle("done", cb.checked);
        })
      );
    }

    el.emergencyList.querySelectorAll(".acc-head").forEach((h) =>
      h.addEventListener("click", () => {
        const acc = h.parentElement;
        const open = acc.classList.toggle("open");
        h.setAttribute("aria-expanded", open ? "true" : "false");
      })
    );
  }

  // ---------- 渲染：统计 ----------
  function renderStats() {
    const t = todayRecord();
    const done = t.blocks || 0;
    const workMin = Math.round((t.workSec || 0) / 60);
    const weekMin = Math.round(weekSeconds() / 60);
    el.statGrid.innerHTML =
      '<div class="stat"><div class="num">' + done + "</div><div class=\"lbl\">今日块数（目标 " + dailyGoal() + "）</div></div>" +
      '<div class="stat"><div class="num">' + workMin + "</div><div class=\"lbl\">今日有效分钟</div></div>" +
      '<div class="stat"><div class="num">' + weekMin + "</div><div class=\"lbl\">近 7 天有效分钟</div></div>" +
      '<div class="stat"><div class="num">' + streak() + "</div><div class=\"lbl\">连续达标天数</div></div>";

    // 近 7 天柱状图
    const wd = ["日", "一", "二", "三", "四", "五", "六"];
    const now = new Date();
    let bars = "";
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const r = days[dayKey(d)];
      const b = r ? (r.blocks || 0) : 0;
      const goal = dailyGoal();
      const h = goal ? Math.min(100, Math.round((b / goal) * 100)) : 0;
      const isToday = i === 0;
      bars += '<div class="bar-col"><div class="bar' + (isToday ? " rest-bar" : "") + '" style="height:' + Math.max(3, h) + '%" title="' + b + ' 块"></div>' +
        '<div class="bar-lbl">' + (isToday ? "今" : wd[d.getDay()]) + "</div></div>";
    }
    el.barChart.innerHTML = bars;

    // 打卡
    const ck = t.checkins || {};
    const items = [
      ["walk", "晨走 5km"], ["strength", "力量训练"], ["out", "出门"],
    ];
    el.checkinRow.innerHTML = items.map(([k, label]) =>
      '<button class="btn-' + (ck[k] ? "solid" : "outline") + '" data-checkin="' + k + '">' +
      (ck[k] ? "✓ " : "") + label + "</button>"
    ).join("");
    el.checkinRow.querySelectorAll("[data-checkin]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.checkin;
        t.checkins[k] = !t.checkins[k];
        saveDays();
        renderStats();
      })
    );

    // 恢复阶段提示
    el.recoveryStages.innerHTML =
      '<div class="card-title">你当前约处于：第 ' + state.week + ' 周</div>' +
      '<ul class="list">' +
      A.recoveryStages.map((r) => '<li><div class="li-title">' + escapeHtml(r.label) + "</div>" +
        '<div class="li-desc">' + escapeHtml(r.desc) + "</div></li>").join("") +
      "</ul>" +
      '<div class="tip good" style="margin-top:10px">' + escapeHtml(A.copy.physiological) + "</div>";
  }

  // ---------- 渲染：更多 ----------
  function renderMore() {
    // 奖励白名单
    el.rewardCard.innerHTML =
      '<div class="card-title">推荐奖励</div>' +
      '<ul class="list">' + A.reward.defaultSuggest.map((s) => "<li>" + escapeHtml(s) + "</li>").join("") + "</ul>" +
      '<div class="tip warn" style="margin:10px 0">禁止作为奖励：' + A.reward.forbidden.map(escapeHtml).join("、") + "</div>" +
      A.reward.notes.map((n) => '<div class="tip">' + escapeHtml(n) + "</div>").join("");

    // 空档决策器
    el.gapCard.innerHTML =
      '<div class="card-title">按空档时长给建议</div>' +
      '<table class="tbl"><thead><tr><th>时长</th><th>首选</th><th>次选</th><th>禁忌</th></tr></thead><tbody>' +
      A.gapDecider.map((g) =>
        "<tr><td>" + escapeHtml(g.range) + "</td><td>" + escapeHtml(g.first) + "</td><td>" +
        escapeHtml(g.second) + "</td><td>" + escapeHtml(g.taboo) + "</td></tr>").join("") +
      "</tbody></table>" +
      '<div class="tip" style="margin-top:12px">' + escapeHtml(A.gapMotto) + "</div>";

    // 求知任务库
    const notes = (state.notes || []).slice(-6).reverse();
    el.knowledgeCard.innerHTML =
      '<div class="card-title">「钻一个问题」</div>' +
      '<p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">' + escapeHtml(A.knowledgeNote) + "</p>" +
      '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<input class="inline-input" id="noteInput" style="flex:1;width:auto" placeholder="想刷刺激时，改钻什么问题？">' +
      '<button class="btn-solid" id="noteSave">记下</button></div>' +
      '<div class="group-label">灵感（低压力、可积累）</div>' +
      '<ul class="list">' + A.knowledgeTasks.map((k) => "<li>" + escapeHtml(k) + "</li>").join("") + "</ul>" +
      (notes.length ? '<div class="group-label">我的求知笔记</div><ul class="list">' +
        notes.map((n) => '<li><div class="li-title">' + escapeHtml(n.text) + '</div><div class="li-desc">' + escapeHtml(n.date) + "</div></li>").join("") +
        "</ul>" : "");
    const ni = el.knowledgeCard.querySelector("#noteInput");
    const ns = el.knowledgeCard.querySelector("#noteSave");
    ns.addEventListener("click", () => {
      const v = (ni.value || "").trim();
      if (!v) return;
      state.notes = state.notes || [];
      state.notes.push({ date: dayKey(new Date()), text: v });
      saveState();
      renderMore();
    });

    // 方案模板
    el.profileCard.innerHTML =
      '<div class="card-title">方案模板</div>' +
      '<div class="week-selector" style="margin-bottom:6px">' +
      Object.keys(A.profiles).map((k) => {
        const p = A.profiles[k];
        return '<button class="week-btn' + (state.profile === k ? " active" : "") + '" data-profile="' + k + '">' +
          '<div class="wk">' + escapeHtml(p.name) + "</div><div class=\"wk-note\">" + escapeHtml(p.desc) + "</div></button>";
      }).join("") + "</div>" +
      '<div class="tip">' + escapeHtml(profileDef().note) + "</div>";
    el.profileCard.querySelectorAll("[data-profile]").forEach((b) =>
      b.addEventListener("click", () => {
        state.profile = b.dataset.profile;
        const p = profileDef();
        state.workMin = p.workMin;
        state.restMin = p.restMin;
        el.workMinInput.value = state.workMin;
        el.restMinInput.value = state.restMin;
        saveState();
        renderMore(); renderTimerFace(); renderPlan(); renderStats();
      })
    );

    el.aboutText.textContent = A.APP.tagline;
  }

  // ---------- 导出 / 导入 / 清空 ----------
  function doExport() {
    const blob = new Blob([JSON.stringify({ version: 1, state: state, days: days }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "平静的多巴胺阶段-备份-" + todayKey() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("备份已导出");
  }
  function doImport(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.state) { state = Object.assign({}, DEFAULT_STATE, data.state); saveState(); }
        if (data.days) { days = data.days; saveDays(); }
        applySettings();
        renderAll();
        toast("已恢复备份");
      } catch (e) { toast("导入失败：文件格式不对"); }
    };
    reader.readAsText(file);
  }
  function doClear() {
    if (!confirm("确定清空全部本地数据？此操作不可撤销。")) return;
    localStorage.removeItem(STORE_STATE);
    localStorage.removeItem(STORE_DAYS);
    state = Object.assign({}, DEFAULT_STATE);
    days = {};
    applySettings();
    renderAll();
    toast("已清空");
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
  }

  // ---------- 设置同步 ----------
  function applySettings() {
    document.body.classList.toggle("theme-dark", state.theme === "dark");
    el.themeSwitch.checked = state.theme === "dark";
    el.notifySwitch.checked = !!state.notify;
    el.soundSwitch.checked = !!state.sound;
    el.workMinInput.value = state.workMin;
    el.restMinInput.value = state.restMin;
  }

  // ---------- 总渲染 ----------
  function renderAll() {
    renderTimerFace();
    renderPlan();
    renderEmergency();
    renderStats();
    renderMore();
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    el.btnMain.addEventListener("click", startTimer);
    el.btnReset.addEventListener("click", resetTimer);
    el.btnSkip.addEventListener("click", skipRest);

    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => switchView(t.dataset.target))
    );

    el.themeSwitch.addEventListener("change", () => { state.theme = el.themeSwitch.checked ? "dark" : "light"; saveState(); applySettings(); });
    el.notifySwitch.addEventListener("change", () => { state.notify = el.notifySwitch.checked; saveState(); if (state.notify) requestNotify(); });
    el.soundSwitch.addEventListener("change", () => { state.sound = el.soundSwitch.checked; saveState(); });

    el.workMinInput.addEventListener("change", () => {
      const v = clampInt(el.workMinInput.value, 5, 60);
      el.workMinInput.value = v;
      state.workMin = v;
      if (!state.running) { state.pausedRemaining = null; }
      saveState(); renderTimerFace();
    });
    el.restMinInput.addEventListener("change", () => {
      const v = clampInt(el.restMinInput.value, 1, 30);
      el.restMinInput.value = v;
      state.restMin = v;
      saveState(); renderTimerFace();
    });

    el.exportJsonBtn.addEventListener("click", doExport);
    el.importBtn.addEventListener("click", () => el.importFile.click());
    el.importFile.addEventListener("change", (e) => { if (e.target.files[0]) doImport(e.target.files[0]); e.target.value = ""; });
    el.clearBtn.addEventListener("click", doClear);

    // 锁屏/后台时刷新标题（尽力而为）
    document.addEventListener("visibilitychange", () => { if (!document.hidden) renderTimerFace(); });
  }
  function clampInt(v, min, max) {
    let n = parseInt(v, 10);
    if (isNaN(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }

  // ---------- 初始化 ----------
  function init() {
    applySettings();
    bindEvents();
    renderAll();

    // 刷新恢复：若之前正在运行且已过期，仅结算当前这一个阶段
    if (state.running && state.endAt) {
      if (remainingMs() <= 0) {
        switchPhase();
      } else {
        startTicker();
      }
    }
  }

  init();
})();
