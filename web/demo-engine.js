"use strict";

// The hosted demo runs entirely in this page. Scores and reading intervals are
// kept in memory and disappear on reload. No orders or customer data are used.
// The Python reference remains in src/comment_ranker.py and src/demo_server.py.
(() => {
  const STRATEGIES = ["uniform", "slide", "center_lower"];
  const VISITORS = [
    ["小禾", "禾", "forest"], ["小海", "海", "ocean"],
    ["小橙", "橙", "sunset"], ["小紫", "紫", "violet"],
    ["小林", "林", "forest"], ["小岚", "岚", "ocean"],
  ];
  const DAY = 86400000;
  const clone = value => JSON.parse(JSON.stringify(value));
  const id = () => crypto.randomUUID().replaceAll("-", "");
  const fail = message => { throw new Error(message); };
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

  // MT19937 with CPython's integer seeding, random() and getrandbits(). Using
  // the same seed makes first-slot exploration reproducible in both demos.
  // This generator chooses synthetic ranking actions, never security tokens.
  class DemoRandom {
    constructor(seed) {
      this.values = new Uint32Array(624);
      this.values[0] = 19650218;
      for (let i = 1; i < 624; i++) {
        this.values[i] = (Math.imul(1812433253, this.values[i - 1] ^ (this.values[i - 1] >>> 30)) + i) >>> 0;
      }
      let value = BigInt(seed);
      const key = [];
      do { key.push(Number(value & 0xffffffffn)); value >>= 32n; } while (value);
      let i = 1, j = 0;
      for (let k = Math.max(624, key.length); k; k--) {
        this.values[i] = ((this.values[i] ^ Math.imul(this.values[i - 1] ^ (this.values[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
        if (++i >= 624) { this.values[0] = this.values[623]; i = 1; }
        if (++j >= key.length) j = 0;
      }
      for (let k = 623; k; k--) {
        this.values[i] = ((this.values[i] ^ Math.imul(this.values[i - 1] ^ (this.values[i - 1] >>> 30), 1566083941)) - i) >>> 0;
        if (++i >= 624) { this.values[0] = this.values[623]; i = 1; }
      }
      this.values[0] = 0x80000000;
      this.index = 624;
    }
    uint32() {
      if (this.index >= 624) {
        for (let i = 0; i < 624; i++) {
          const y = (this.values[i] & 0x80000000) | (this.values[(i + 1) % 624] & 0x7fffffff);
          this.values[i] = (this.values[(i + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0)) >>> 0;
        }
        this.index = 0;
      }
      let y = this.values[this.index++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    }
    random() { return ((this.uint32() >>> 5) * 67108864 + (this.uint32() >>> 6)) / 9007199254740992; }
    seed64() { const low = BigInt(this.uint32()); return low | (BigInt(this.uint32()) << 32n); }
    choice(values) {
      const bits = Math.floor(Math.log2(values.length)) + 1;
      let pick;
      do { pick = this.uint32() >>> (32 - bits); } while (pick >= values.length);
      return values[pick];
    }
  }

  function positionWeight(strategy, y, scrolling) {
    if (strategy === "uniform" || !scrolling) return 1;
    if (strategy === "slide") return Math.min(8, Math.max(1, 8 * y + .5)) / 8;
    const weights = [1, 3, 5, 7, 8, 8, 7, 5];
    const z = Math.min(7, Math.max(0, y * 8 - .5));
    const left = Math.floor(z);
    return (weights[left] + (weights[Math.min(7, left + 1)] - weights[left]) * (z - left)) / 8;
  }
  function validExposure(event) {
    const duration = Math.trunc(event.end_ms - event.start_ms);
    return event.visible_fraction >= .5 && duration >= 1000 && duration <= 60000;
  }
  function effectiveSeconds(events, strategy, cutoff) {
    const clipped = events.map(event => ({ ...event,
      start_ms: Math.max(0, event.start_ms), end_ms: Math.min(cutoff, event.end_ms),
    })).filter(validExposure);
    const points = [...new Set(clipped.flatMap(event => [event.start_ms, event.end_ms]))].sort((a, b) => a - b);
    let total = 0, elapsed = 0;
    for (let i = 1; i < points.length && elapsed < 30; i++) {
      const a = points[i - 1], b = points[i];
      const active = clipped.filter(event => event.start_ms <= a && event.end_ms >= b);
      if (!active.length) continue;
      const seconds = Math.min((b - a) / 1000, 30 - elapsed);
      const weight = Math.max(...active.map(event => event.visible_fraction * positionWeight(strategy, event.center_y, !event.initial_screen)));
      total += seconds * weight;
      elapsed += seconds;
    }
    return total;
  }

  class Demo {
    constructor() {
      if (!Array.isArray(globalThis.ReviewDemoData) || globalThis.ReviewDemoData.length !== 72) {
        fail("演示评论数据未加载，请刷新页面。");
      }
      this.comments = globalThis.ReviewDemoData;
      this.lastResetFrom = null;
      this.beginRound(1);
    }
    viewerAt(ordinal) {
      const [nickname, avatar, theme] = VISITORS[(ordinal - 1) % VISITORS.length];
      return { user_key: `demo-user-${ordinal}`, ordinal, nickname, avatar, theme };
    }
    beginRound(ordinal) {
      this.stats = Object.fromEntries(STRATEGIES.map(strategy => [strategy, Object.fromEntries(this.comments.map(comment => [comment.comment_id, {
        positive: 0, negative: 0, prior: Math.max(0, Math.min(1, comment.quality_prior)),
      }]))]));
      this.initialScores = Object.fromEntries(STRATEGIES.map(strategy => [strategy, this.scores(strategy)]));
      this.rng = new DemoRandom(20260911);
      this.round = { id: id(), ordinal, limit: 6, completed: 0, status: "running", strategy: null,
        outcome_counts: { purchase: 0, abandon: 0, refund: 0 }, results: [], summary: null };
      this.strategy = "center_lower";
      this.viewer = this.viewerAt(1);
      this.lastResult = null;
      this.episode = null;
      this.ranking = {};
      this.ledger = new Map();
      this.closed = true;
      this.phase = "product";
      this.activated = false;
      this.currentViewMode = { sort: "recommended", filter: "all" };
      this.eventCount = 0;
      this.episodeCount = 0;
      this.eventKeys = new Set();
      this.segmentCounts = new Map();
    }
    scores(strategy = this.strategy) {
      return Object.fromEntries(this.comments.map(comment => {
        const stat = this.stats[strategy][comment.comment_id];
        return [comment.comment_id, .7 * comment.quality_prior + .3 * ((stat.prior + stat.positive) / (1 + stat.positive + stat.negative))];
      }));
    }
    state() {
      const episode = this.episode ? { episode_id: this.episode.id, round_id: this.round.id,
        user_key: this.episode.user_key, started_at: this.activated ? new Date(this.episode.startedAt).toISOString() : null,
        closed: this.closed, phase: this.phase } : null;
      // Responses are snapshots, as with JSON over HTTP. A caller cannot edit
      // engine state by retaining and changing a response object.
      return clone({ comments: this.comments, scores: this.scores(), stats: this.stats[this.strategy],
        episode, viewer: this.viewer, phase: this.closed ? "product" : this.phase,
        last_result: this.lastResult, round: this.round, last_reset_from: this.lastResetFrom,
        ranking: this.ranking, strategy: this.strategy, view_mode: this.currentViewMode,
        counts: { events: this.eventCount, episodes: this.episodeCount }, strategies: STRATEGIES,
        demo: true, version: "0.5.0", runtime: "browser" });
    }
    checkRound(body, allowCompleted = false) {
      if (body.round_id !== this.round.id) fail("round_id缺失或此轮已被替换，请刷新当前页面");
      if (!allowCompleted && this.round.status === "completed") fail("本轮6位访客均已完成，请查看总结后开启新一轮");
    }
    checkEpisode(body, requireActive = true) {
      this.checkRound(body);
      if (!this.episode || body.episode_id !== this.episode.id) fail("此浏览片段不存在或已被替换，请从商品页重新进入评论");
      if (this.closed) fail("此浏览片段已结束，请从商品页重新进入评论");
      if (requireActive && this.phase !== "active") fail("评论界面尚未就绪，未开始采集");
    }
    rank() {
      const scores = this.scores();
      const candidates = this.comments.filter(comment => comment.eligible).map(comment => comment.comment_id);
      const base = [...candidates].sort((a, b) => scores[b] - scores[a] || (a < b ? -1 : a > b ? 1 : 0));
      const risk = base.find(cid => this.comments.find(comment => comment.comment_id === cid).risk >= .5);
      if (risk && base.length > 1) { base.splice(base.indexOf(risk), 1); base.splice(1, 0, risk); }
      const epsilon = .1;
      const probabilities = Object.fromEntries(candidates.map(cid => [cid, epsilon / candidates.length]));
      probabilities[base[0]] += 1 - epsilon;
      const random = new DemoRandom(this.rng.seed64());
      let action = base[0];
      if (candidates.length > 1 && random.random() < epsilon) action = random.choice(candidates);
      return { order: [action, ...base.filter(cid => cid !== action)], action,
        logging_probability: probabilities[action], epsilon, baseline_order: base,
        candidate_ids: candidates, probabilities, policy_version: "prototype-0.1.0", ranking_id: id() };
    }
    start(body) {
      this.checkRound(body);
      const strategy = Object.hasOwn(body, "strategy") ? body.strategy : this.round.strategy ?? "center_lower";
      if (!STRATEGIES.includes(strategy)) fail("未知策略");
      if (this.round.strategy !== null && strategy !== this.round.strategy) fail("本轮策略已锁定，完成本轮并重置后才能选择其他策略");
      this.strategy = strategy;
      this.round.strategy = strategy;
      this.episode = { id: id(), user_key: this.viewer.user_key, startedAt: Date.now(), purchasedAt: null, refunded: null };
      this.ledger = new Map();
      this.closed = false;
      this.phase = "prepared";
      this.activated = false;
      this.currentViewMode = { sort: "recommended", filter: "all" };
      this.eventKeys = new Set();
      this.segmentCounts = new Map();
      this.ranking = this.rank();
      this.episodeCount++;
      return this.state();
    }
    activate(body) {
      this.checkEpisode(body, false);
      if (this.phase === "active") return this.state();
      if (this.phase !== "prepared") fail("当前片段不能开始采集");
      this.episode.startedAt = Date.now();
      this.activated = true;
      this.phase = "active";
      return this.state();
    }
    leave(body) {
      this.checkRound(body, true);
      if (!this.episode || body.episode_id !== this.episode.id) fail("片段已被替换");
      if (!this.closed) { this.phase = "left"; this.closed = true; }
      return this.state();
    }
    exposures(body) {
      this.checkEpisode(body);
      if (!Array.isArray(body.events) || body.events.length > 200) fail("曝光批次需为列表且不超过200条");
      const elapsed = Date.now() - this.episode.startedAt;
      // Validate the whole batch before counting any event, so a rejected
      // batch may be corrected and retried without a partial update.
      const parsed = body.events.map(row => {
        if (!isObject(row)) fail("曝光必须是对象");
        if (!this.ranking.order.includes(row.comment_id)) fail("评论不属于本次排序");
        const values = [row.start_ms, row.end_ms, row.visible_fraction, row.center_y];
        if (values.some(value => typeof value !== "number" || !Number.isFinite(value))) fail("曝光数值无效");
        const [a, b, v, y] = values;
        if (!(0 <= a && a <= b && b <= elapsed + 1500 && b - a <= 60000 && 0 <= v && v <= 1 && 0 <= y && y <= 1)) fail("曝光区间或可见位置越界");
        const initial = Object.hasOwn(row, "initial_screen") ? row.initial_screen : false;
        if (typeof initial !== "boolean") fail("首屏标记无效");
        return { comment_id: row.comment_id, start_ms: a, end_ms: b, visible_fraction: v, center_y: y, initial_screen: initial };
      });
      let accepted = 0;
      for (const event of parsed) {
        const cid = event.comment_id;
        const key = JSON.stringify(event);
        if (this.eventKeys.has(key) || (this.segmentCounts.get(cid) || 0) >= 240) continue;
        this.eventKeys.add(key);
        this.segmentCounts.set(cid, (this.segmentCounts.get(cid) || 0) + 1);
        if (validExposure(event)) {
          if (!this.ledger.has(cid)) this.ledger.set(cid, []);
          this.ledger.get(cid).push(event);
        }
        this.eventCount++;
        accepted++;
      }
      return { accepted };
    }
    outcome(body) {
      this.checkEpisode(body);
      const outcome = body.outcome;
      if (!["purchase", "abandon", "refund"].includes(outcome)) fail("未知结果，请选择购买、未购买或退款");
      const now = Date.now();
      if (now - this.episode.startedAt > DAY) fail("本次演示已超过24小时，请返回商品页重新进入评论");
      if (outcome !== "abandon") {
        this.episode.purchasedAt = Math.max(now, this.episode.startedAt + 1);
        this.episode.refunded = outcome === "refund";
      }
      // The explicit demo outcome advances its observation time by 32 days:
      // 24 h purchase window + 2 h delay, and 30 days + 2 h for refunds.
      // It is a synthetic mature label, not a client-submitted real payment.
      const asOf = this.episode.startedAt + 32 * DAY;
      const gross = asOf >= this.episode.startedAt + 26 * 3600000 && this.episode.purchasedAt !== null
        && this.episode.startedAt < this.episode.purchasedAt && this.episode.purchasedAt <= this.episode.startedAt + DAY ? 1 : 0;
      const net = gross === 1 && asOf >= this.episode.purchasedAt + 30 * DAY + 2 * 3600000 && this.episode.refunded === false ? 1 : 0;
      const cutoff = Math.min(DAY, this.episode.purchasedAt === null ? DAY : this.episode.purchasedAt - this.episode.startedAt);
      const values = [...this.ledger].map(([cid, events]) => [cid, effectiveSeconds(events, this.strategy, cutoff)]);
      const denominator = values.reduce((total, [, seconds]) => total + seconds, 0);
      const contributions = Object.fromEntries(values.filter(([, seconds]) => seconds > 0).map(([cid, seconds]) => [cid, seconds / denominator]));
      const before = this.scores();
      for (const [cid, share] of Object.entries(contributions)) this.stats[this.strategy][cid][net ? "positive" : "negative"] += share;
      const after = this.scores();
      const scoreChanges = Object.fromEntries(Object.entries(after).filter(([cid, score]) => cid in contributions || score !== before[cid])
        .map(([cid, score]) => [cid, { before: before[cid], after: score, delta: score - before[cid] }]));
      const completed = this.round.completed + 1;
      const toViewer = completed < this.round.limit ? this.viewerAt(this.viewer.ordinal + 1) : null;
      this.lastResult = { round_id: this.round.id, episode_id: this.episode.id, from_viewer: this.viewer,
        to_viewer: toViewer, outcome, strategy: this.strategy, has_contribution: Object.keys(contributions).length > 0,
        contributions, score_changes: scoreChanges };
      this.closed = true;
      this.phase = "settled";
      this.round.completed = completed;
      this.round.outcome_counts[outcome]++;
      this.round.results.push(clone(this.lastResult));
      if (toViewer) this.viewer = toViewer;
      else { this.round.status = "completed"; this.round.summary = this.roundSummary(); }
      return { ...this.state(), message: toViewer ? "结果已结算，已切换到下一位访客。进入评论可查看继承后的排序。" : "本轮6位访客已全部完成，可查看总结并开启新一轮。" };
    }
    roundSummary() {
      const completed = this.round.results.length;
      const counts = clone(this.round.outcome_counts);
      const effective = this.round.results.filter(result => result.has_contribution).length;
      const paid = counts.purchase + counts.refund;
      const strategies = Object.fromEntries(STRATEGIES.map(strategy => {
        const records = this.round.results.filter(result => result.strategy === strategy);
        const count = records.filter(result => result.has_contribution).length;
        return [strategy, { completed: records.length, with_contribution: count, without_contribution: records.length - count,
          score_changes: Object.fromEntries(Object.entries(this.scores(strategy)).map(([cid, score]) => [cid, {
            before: this.initialScores[strategy][cid], after: score, delta: score - this.initialScores[strategy][cid],
          }])) }];
      }));
      return { completed, limit: this.round.limit, started_episodes: this.episodeCount, outcome_counts: counts,
        with_contribution: effective, without_contribution: completed - effective,
        paid: { count: paid, denominator: completed, rate: completed ? paid / completed : null },
        net_purchase: { count: counts.purchase, denominator: completed, rate: completed ? counts.purchase / completed : null },
        strategy_summaries: strategies };
    }
    reset(body) {
      const roundId = body.round_id;
      if (typeof roundId !== "string" || !roundId) fail("重置体验必须提供对应的round_id");
      const discard = Object.hasOwn(body, "discard_running") ? body.discard_running : false;
      if (typeof discard !== "boolean") fail("discard_running必须是布尔值");
      if (roundId === this.lastResetFrom) return this.state();
      if (roundId !== this.round.id) fail("此重置请求属于旧轮次，不会影响当前体验");
      if (this.round.status !== "completed" && !discard) fail("请完成本轮6位访客后再开启新一轮");
      this.beginRound(this.round.ordinal + 1);
      this.lastResetFrom = roundId;
      return this.state();
    }
    viewMode(body) {
      this.checkRound(body);
      if (!this.episode || body.episode_id !== this.episode.id) fail("片段已被替换");
      if (!["recommended", "recent", "recommend"].includes(body.sort) || !["all", "positive", "neutral", "negative"].includes(body.filter)) fail("未知浏览模式");
      this.currentViewMode = { sort: body.sort, filter: body.filter };
      return { recorded: true };
    }
    async request(path, body = null) {
      if (path === "/api/state" && body === null) return this.state();
      if (!isObject(body)) fail("请求必须是JSON对象");
      const method = { "/api/start": "start", "/api/activate": "activate", "/api/leave": "leave",
        "/api/exposures": "exposures", "/api/outcome": "outcome", "/api/reset": "reset", "/api/view-mode": "viewMode" }[path];
      if (!method) fail("不存在");
      return this[method](body);
    }
  }

  const demo = new Demo();
  globalThis.ReviewDemoEngine = Object.freeze({ request: (path, body = null) => demo.request(path, body) });
})();
