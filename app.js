/* Budget — private budget PWA. Progress is drawn as rings.
   budget.data.v2 is the on-device store. The first launch copies budget.data.v1
   and keeps pay, bills, the savings plan, the emergency goal, saved amounts,
   goal progress, and savings deposits. Spending transactions are dropped.
   All data lives in localStorage on this device. Nothing is ever sent anywhere. */
'use strict';

(() => {
  // ==========================================================================
  // Constants & defaults
  // ==========================================================================
  const DATA_KEY = 'budget.data.v2';
  const LEGACY_DATA_KEY = 'budget.data.v1';
  const PIN_KEY = 'budget.pin.v2';
  const FAIL_KEY = 'budget.pinFails.v2';
  const HIDDEN_KEY = 'budget.hiddenAt.v2';
  const LOCK_AFTER_MS = 60 * 1000;
  const COLORS = ['#B388FF', '#81C784', '#FFB74D', '#4FC3F7', '#F06292', '#9575CD', '#4DB6AC', '#E57373', '#AED581', '#FFD54F'];
  const SUBS_COLOR = '#CE93D8';
  const OTHER_COLOR = '#90A4AE';

  function defaultData() {
    return {
      version: 1,
      createdAt: todayISO(),
      settings: { pay: 1166, firstPayday: '', savingsPlan: 1000, startingSavings: 0, emergencyGoal: 3000, lastExport: '' },
      bills: [
        { id: 'house', name: 'House bills', amount: 400, dueDay: null, fixed: true },
        { id: 'groceries', name: 'Groceries', amount: 300, dueDay: null, fixed: false },
        { id: 'fun', name: 'Random/fun', amount: 100, dueDay: null, fixed: false },
        { id: 'pc', name: 'Gaming PC', amount: 90, dueDay: null, fixed: true },
        { id: 'phone', name: 'Phone', amount: 60, dueDay: null, fixed: true },
        { id: 'internet', name: 'Internet', amount: 50, dueDay: null, fixed: true },
      ],
      subscriptions: [],
      goals: [],
      debts: [{ id: 'debt-pc', name: 'Gaming PC', balance: null, payment: 90 }],
      transactions: [],
    };
  }

  // ==========================================================================
  // Small helpers
  // ==========================================================================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const cents = (n) => Math.round((Number(n) || 0) * 100);
  const r2 = (n) => cents(n) / 100;
  const sumBy = (arr, fn) => arr.reduce((acc, x) => acc + cents(fn(x)), 0) / 100;
  const pct = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : (part > 0 ? 100 : 0));

  const fmt0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const fmt2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  /** $1,166 for whole dollars, $12.50 otherwise. Never shows "-$0". */
  function money(n) {
    let v = r2(n);
    if (v === 0) v = 0;
    return (Number.isInteger(v) ? fmt0 : fmt2).format(v);
  }
  /** Parse "$1,234.50" / "12" into a number, or null if it isn't one. */
  function parseMoney(str) {
    const cleaned = String(str ?? '').replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? r2(n) : null;
  }

  // Dates are stored as local "YYYY-MM-DD" strings; months as "YYYY-MM".
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isISODate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  function todayISO() { return toISO(new Date()); }
  const ymOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const currentYM = () => ymOf(new Date());
  const ymParts = (ym) => ym.split('-').map(Number);
  const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
  function addMonths(ym, n) { const [y, m] = ymParts(ym); return ymOf(new Date(y, m - 1 + n, 1)); }
  function monthLabel(ym, opts = { month: 'long', year: 'numeric' }) {
    const [y, m] = ymParts(ym);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', opts);
  }
  const shortDate = (iso) => parseISO(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const dayNumber = (d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  // ==========================================================================
  // State & persistence
  // ==========================================================================
  let state = defaultData();
  const ui = { tab: 'home', activityMonth: currentYM(), unlocked: false, lastCategory: null };

  /** Coerce any stored or imported object into a valid data shape. */
  function normalize(raw) {
    const d = defaultData();
    if (!raw || typeof raw !== 'object') return d;
    const num = (v, dflt = 0) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? r2(n) : dflt; };
    const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : r2(Number(v)));
    const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : '');
    const objs = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : null);
    const safeId = (v) => { const s = str(v, 64); return s && s !== 'subs' && s !== 'other' ? s : uid(); };
    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};

    if (isISODate(raw.createdAt)) d.createdAt = raw.createdAt;
    d.settings = {
      pay: num(s.pay, 1166),
      firstPayday: isISODate(s.firstPayday) ? s.firstPayday : '',
      savingsPlan: num(s.savingsPlan, 1000),
      startingSavings: num(s.startingSavings, 0),
      emergencyGoal: num(s.emergencyGoal, 3000),
      lastExport: str(s.lastExport, 40),
    };
    const bills = objs(raw.bills);
    if (bills) {
      d.bills = bills.map((b) => {
        const due = numOrNull(b.dueDay);
        return {
          id: safeId(b.id), name: str(b.name, 40) || 'Bill', amount: num(b.amount),
          dueDay: due === null ? null : Math.min(31, Math.max(1, Math.round(due))), fixed: !!b.fixed,
        };
      });
    }
    const subs = objs(raw.subscriptions);
    if (subs) {
      d.subscriptions = subs.map((x) => ({
        id: safeId(x.id), name: str(x.name, 60) || 'Subscription', cost: num(x.cost),
        cycle: x.cycle === 'yearly' ? 'yearly' : 'monthly', renewal: isISODate(x.renewal) ? x.renewal : '', keep: x.keep !== false,
      }));
    }
    const goals = objs(raw.goals);
    if (goals) {
      d.goals = goals.map((g) => ({
        id: safeId(g.id), name: str(g.name, 60) || 'Goal', target: num(g.target), saved: num(g.saved), date: isISODate(g.date) ? g.date : '',
      }));
    }
    const debts = objs(raw.debts);
    if (debts) {
      d.debts = debts.map((x) => ({ id: safeId(x.id), name: str(x.name, 60) || 'Debt', balance: numOrNull(x.balance), payment: num(x.payment) }));
    }
    const txs = objs(raw.transactions);
    if (txs) {
      d.transactions = txs
        .filter((t) => isISODate(t.date) && Number.isFinite(Number(t.amount)))
        .map((t) => ({
          id: safeId(t.id), type: t.type === 'savings' ? 'savings' : 'purchase', amount: r2(Number(t.amount)),
          category: str(t.category, 64) || 'other', note: str(t.note, 120), date: t.date, created: num(t.created, Date.now()),
        }));
    }
    return d;
  }

  function load() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      if (raw) {
        state = normalize(JSON.parse(raw));
        return;
      }
      const legacy = localStorage.getItem(LEGACY_DATA_KEY);
      if (legacy) {
        state = normalize(JSON.parse(legacy));
        // Next paycheck: clear spending. Keep savings deposits and goal progress.
        state.transactions = state.transactions.filter((t) => t.type === 'savings');
        if (save()) {
          try { localStorage.removeItem(LEGACY_DATA_KEY); } catch { /* legacy copy can stay if removal fails */ }
        }
        return;
      }
      state = defaultData();
    } catch {
      state = defaultData();
    }
  }
  function save() {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(state));
      return true;
    } catch {
      toast('Couldn’t save — device storage is full');
      return false;
    }
  }
  function commit() { save(); render(); }

  // ==========================================================================
  // Budget math
  // ==========================================================================
  /** Paydays (as Date) in a month, following the biweekly schedule from firstPayday. */
  function paydaysIn(ym) {
    const fp = state.settings.firstPayday;
    if (!fp) return null;
    const [y, m] = ymParts(ym);
    const first = dayNumber(parseISO(fp));
    const start = dayNumber(new Date(y, m - 1, 1));
    const end = dayNumber(new Date(y, m, 0));
    const out = [];
    for (let p = first + 14 * Math.ceil((start - first) / 14); p <= end; p += 14) {
      out.push(new Date(y, m - 1, 1 + (p - start)));
    }
    return out;
  }
  const paychecksIn = (ym) => { const days = paydaysIn(ym); return days ? days.length : 2; };

  function subsTotals() {
    let monthly = 0, yearly = 0, cancelMonthly = 0, cancelYearly = 0;
    for (const s of state.subscriptions) {
      const mo = s.cycle === 'yearly' ? s.cost / 12 : s.cost;
      const yr = s.cycle === 'yearly' ? s.cost : s.cost * 12;
      monthly += mo; yearly += yr;
      if (!s.keep) { cancelMonthly += mo; cancelYearly += yr; }
    }
    return { monthly: r2(monthly), yearly: r2(yearly), cancelMonthly: r2(cancelMonthly), cancelYearly: r2(cancelYearly) };
  }

  /** Every category a purchase can use: bills, then Subscriptions, then Other. */
  function categories() {
    return [
      ...state.bills.map((b, i) => ({ id: b.id, name: b.name, budget: b.amount, fixed: b.fixed, color: COLORS[i % COLORS.length] })),
      { id: 'subs', name: 'Subscriptions', budget: subsTotals().monthly, fixed: true, color: SUBS_COLOR },
      { id: 'other', name: 'Other', budget: 0, fixed: false, color: OTHER_COLOR },
    ];
  }
  function categoryOf(id) {
    const cats = categories();
    return cats.find((c) => c.id === id) || cats[cats.length - 1];
  }

  const monthTx = (ym) => state.transactions.filter((t) => t.date.startsWith(ym));
  const totalSavings = () => r2(state.settings.startingSavings + sumBy(state.transactions.filter((t) => t.type === 'savings'), (t) => t.amount));
  function savingsThrough(ym) {
    return r2(state.settings.startingSavings +
      sumBy(state.transactions.filter((t) => t.type === 'savings' && t.date.slice(0, 7) <= ym), (t) => t.amount));
  }

  /** Everything the Home screen and History need for one month. */
  function monthStats(ym) {
    const { pay, savingsPlan } = state.settings;
    const checks = paychecksIn(ym);
    const income = r2(checks * pay);
    const extra = r2(Math.max(0, checks - 2) * pay);
    const plan = r2(savingsPlan + extra);
    const txs = monthTx(ym);
    const purchases = txs.filter((t) => t.type === 'purchase');
    const saved = sumBy(txs.filter((t) => t.type === 'savings'), (t) => t.amount);
    const spent = sumBy(purchases, (t) => t.amount);

    const cats = categories().map((c) => ({ ...c, spent: 0 }));
    const byId = Object.fromEntries(cats.map((c) => [c.id, c]));
    for (const t of purchases) {
      const c = byId[t.category] || byId.other;
      c.spent = r2(c.spent + t.amount);
    }
    const budgetTotal = sumBy(cats, (c) => c.budget);

    // Same definitions as the old spreadsheet:
    // Left = income − spent − saved. Flexible ("Left to spend") = Left − savings still to go − unpaid fixed bills.
    const left = r2(income - spent - saved);
    const stillToSave = r2(Math.max(0, plan - saved));
    const unpaidFixed = sumBy(cats.filter((c) => c.fixed), (c) => Math.max(0, c.budget - c.spent));
    const flexible = r2(left - stillToSave - unpaidFixed);

    const [y, m] = ymParts(ym);
    const dim = daysInMonth(y, m);
    const cur = currentYM();
    const daysLeft = ym === cur ? dim - new Date().getDate() + 1 : (ym < cur ? 0 : dim); // includes today
    const daily = r2(flexible / Math.max(1, daysLeft));
    const cushion = r2(income - budgetTotal - plan);

    return { ym, checks, income, extra, plan, saved, spent, cats, budgetTotal, left, stillToSave, unpaidFixed, flexible, daysLeft, daily, cushion, count: txs.length };
  }

  /** Day of month a subscription renews in (y, m), or null if it doesn't renew that month. */
  function subRenewalDay(s, y, m) {
    if (!s.renewal) return null;
    const r = parseISO(s.renewal);
    const dim = daysInMonth(y, m);
    if (s.cycle === 'monthly') {
      if (y * 12 + m < r.getFullYear() * 12 + r.getMonth() + 1) return null;
      return Math.min(r.getDate(), dim);
    }
    if (r.getMonth() + 1 === m && y >= r.getFullYear()) return Math.min(r.getDate(), dim);
    return null;
  }
  /** Next renewal on or after today. */
  function nextRenewal(s) {
    if (!s.renewal) return null;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    let d = parseISO(s.renewal);
    const step = s.cycle === 'yearly' ? 12 : 1;
    const base = d.getDate();
    for (let i = 0; d < t && i < 1200; i++) {
      const next = new Date(d.getFullYear(), d.getMonth() + step, 1);
      d = new Date(next.getFullYear(), next.getMonth(), Math.min(base, daysInMonth(next.getFullYear(), next.getMonth() + 1)));
    }
    return d;
  }

  /** Bills with due days (and subscriptions renewing) this month, with status. */
  function dueThisMonth(stats) {
    const today = new Date().getDate();
    const [y, m] = ymParts(stats.ym);
    const dim = daysInMonth(y, m);
    const spentBy = Object.fromEntries(stats.cats.map((c) => [c.id, c.spent]));
    const items = [];
    for (const b of state.bills) {
      if (b.dueDay == null) continue;
      const day = Math.min(b.dueDay, dim);
      const paid = (spentBy[b.id] || 0) > 0;
      items.push({ name: b.name, amount: b.amount, day, status: paid ? 'paid' : day >= today ? 'due' : 'late' });
    }
    for (const s of state.subscriptions) {
      const day = subRenewalDay(s, y, m);
      if (day != null && day >= today) items.push({ name: s.name, amount: s.cost, day, status: 'due', sub: true });
    }
    items.sort((a, b) => a.day - b.day);
    const open = items.filter((i) => i.status !== 'paid');
    return {
      items, open, paid: items.filter((i) => i.status === 'paid'),
      amount: sumBy(open, (i) => i.amount), hasDueDays: state.bills.some((b) => b.dueDay != null),
    };
  }

  function goalInfo(g) {
    const left = r2(Math.max(0, g.target - g.saved));
    let months = null, perMonth = null, passed = false;
    if (g.date) {
      const [ty, tm] = ymParts(g.date.slice(0, 7));
      const [cy, cm] = ymParts(currentYM());
      passed = g.date < todayISO();
      months = Math.max(1, (ty - cy) * 12 + (tm - cm));
      perMonth = r2(left / months);
    }
    return { left, months, perMonth, passed, done: g.target > 0 && g.saved >= g.target, progress: pct(g.saved, g.target) };
  }

  function debtInfo(d) {
    if (d.balance == null) return { known: false };
    if (d.balance <= 0) return { known: true, monthsLeft: 0, payoff: null, paidOff: true };
    if (!(d.payment > 0)) return { known: true, monthsLeft: null, payoff: null };
    const monthsLeft = Math.ceil(d.balance / d.payment - 1e-9);
    return { known: true, monthsLeft, payoff: addMonths(currentYM(), monthsLeft - 1) }; // this month = 1st payment
  }

  function historyMonths() {
    const end = currentYM();
    let start = state.createdAt.slice(0, 7);
    for (const t of state.transactions) if (t.date.slice(0, 7) < start) start = t.date.slice(0, 7);
    if (start > end) start = end;
    const out = [];
    for (let ym = end; ym >= start && out.length < 600; ym = addMonths(ym, -1)) out.push(ym);
    return out;
  }

  // ==========================================================================
  // Rendering helpers
  // ==========================================================================
  const ICON = {
    chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5m0 0-4 4m4-4 4 4M5 19h14"/></svg>',
  };

  /** Circular progress. Same percent math as the old bar (capped 0–100). Over budget stays red even when the arc is capped. */
  function bar(value, total, { over = false, variant = '', thick = false, large = false } = {}) {
    const p = pct(value, total);
    const shown = Math.min(100, Math.max(0, p));
    const cap = shown > 0.4 && shown < 99.9 ? 'round' : 'butt';
    const cls = ['ring', over ? 'over' : '', variant, thick ? 'thick' : '', large ? 'lg' : ''].filter(Boolean).join(' ');
    const gap = Math.max(0, 100 - shown);
    return `<svg class="${cls}" viewBox="0 0 36 36" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(shown)}">
      <circle class="ring-track" cx="18" cy="18" r="15.9155"></circle>
      <circle class="ring-value" cx="18" cy="18" r="15.9155" stroke-linecap="${cap}" stroke-dasharray="${shown.toFixed(2)} ${gap.toFixed(2)}" transform="rotate(-90 18 18)"></circle>
    </svg>`;
  }

  function pageHead(eyebrow, title, sub = '', action = '') {
    return `<header class="page-head"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}<h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>${action}</header>`;
  }

  function catRow(c) {
    const over = cents(c.spent) > cents(c.budget);
    const left = r2(c.budget - c.spent);
    const attrs = c.id === 'subs' ? 'data-action="tab" data-tab="subs" role="button" tabindex="0"' : '';
    return `<div class="cat" ${attrs}>
      <div class="cat-top">
        <div class="cat-copy">
          <div class="cat-name">${esc(c.name)}</div>
          <div class="cat-amt">${money(c.spent)} of ${money(c.budget)}</div>
          <div class="cat-left ${over ? 'bad' : 'good'}">${over ? `${money(-left)} over` : `${money(left)} left`}</div>
        </div>
        ${bar(c.spent, c.budget, { over })}
      </div>
    </div>`;
  }

  const cardButton = 'class="card" style="display:block;width:100%;text-align:left"';

  // ==========================================================================
  // Screens
  // ==========================================================================
  function viewHome() {
    const ym = currentYM();
    const st = monthStats(ym);
    const due = dueThisMonth(st);
    const efGoal = state.settings.emergencyGoal;
    const total = totalSavings();
    const ef = Math.min(total, efGoal);
    const cats = st.cats.filter((c) => c.id !== 'other' || c.spent > 0);
    const overall = cents(st.spent) > cents(st.budgetTotal);
    const paydays = paydaysIn(ym);
    const sub = `${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left · ${st.checks} paychecks${paydays ? ` (${paydays.map((d) => shortDate(toISO(d))).join(', ')})` : ''}`;

    let dueHTML;
    if (!due.hasDueDays && !due.items.length) {
      dueHTML = '<p class="note" style="margin:0">Add due days to your bills in Settings to see what’s still due.</p>';
    } else {
      const open = due.open.map((i) => `
        <div class="kv"><span class="k">${esc(i.name)} <span class="badge ${i.status}">${i.status === 'late' ? 'Past due?' : `${i.sub ? 'Renews' : 'Due'} ${ordinal(i.day)}`}</span></span><span class="v">${money(i.amount)}</span></div>`).join('');
      dueHTML = `${open || '<p class="note" style="margin:0 0 4px">Nothing left to pay this month.</p>'}
        ${due.paid.length ? `<p class="note">Paid: ${due.paid.map((i) => esc(i.name)).join(', ')}</p>` : ''}`;
    }

    const budgetLeft = r2(st.budgetTotal - st.spent);
    const budgetLeftPct = pct(Math.max(0, budgetLeft), st.budgetTotal);
    const ringCaption = overall
      ? `Over this month’s budget by ${money(st.spent - st.budgetTotal)}`
      : `${Math.round(budgetLeftPct)}% of this month’s budget still left`;
    return `
      ${pageHead('Circle view', monthLabel(ym, { month: 'long' }), esc(sub))}
      <section class="hero hero-circle" aria-label="Left to spend">
        <div class="hero-ring-wrap">
          ${bar(overall ? st.budgetTotal : Math.max(0, budgetLeft), st.budgetTotal || 1, { over: overall, large: true })}
          <div class="hero-ring-center">
            <div class="hero-label">Left to spend</div>
            <div class="hero-amount ${st.flexible < 0 ? 'neg' : ''}" id="left-to-spend">${money(st.flexible)}</div>
            <div class="hero-daily"><strong class="${st.daily < 0 ? 'neg' : ''}">${money(st.daily)}</strong> per day</div>
          </div>
        </div>
        <div class="hero-caption ring-caption">${ringCaption}</div>
        <div class="hero-stats hero-stats-2">
          <div class="hero-stat"><span>Income</span><strong>${money(st.income)}</strong></div>
          <div class="hero-stat"><span>Days left</span><strong>${st.daysLeft}</strong></div>
        </div>
      </section>

      <h2 class="section-title"><span>Budget</span><span class="${overall ? 'bad' : 'good'}">${money(st.spent)} of ${money(st.budgetTotal)}</span></h2>
      <section class="card">${cats.map(catRow).join('')}</section>

      <h2 class="section-title"><span>Savings this month</span><button class="link" data-action="add" data-type="savings">Add</button></h2>
      <section class="card">
        <div class="metric">
          ${bar(st.saved, st.plan, { variant: st.saved >= st.plan ? '' : 'violet', thick: true })}
          <div class="metric-body">
            <div class="big-pair"><span class="big ${st.saved >= st.plan ? 'good' : ''}">${money(st.saved)}</span><span class="of">of ${money(st.plan)} plan</span></div>
            <p class="note">${st.stillToSave > 0 ? `${money(st.stillToSave)} still to save this month.` : 'Savings plan met for this month.'}${st.extra > 0 ? ` Includes the extra 3rd paycheck (+${money(st.extra)}).` : ''}</p>
          </div>
        </div>
      </section>

      <h2 class="section-title"><span>Emergency fund</span><button class="link" data-action="tab" data-tab="goals">Goals</button></h2>
      <section class="card">
        <div class="metric">
          ${bar(ef, efGoal, { variant: ef >= efGoal ? '' : 'violet', thick: true })}
          <div class="metric-body">
            <div class="big-pair"><span class="big">${money(ef)}</span><span class="of">of ${money(efGoal)}</span></div>
            <p class="note">${ef >= efGoal ? 'Fully funded.' : `${money(efGoal - ef)} to go.`} Total saved: ${money(total)}.</p>
          </div>
        </div>
      </section>

      <h2 class="section-title"><span>Still due this month</span>${due.amount > 0 ? `<span>${money(due.amount)}</span>` : ''}</h2>
      <section class="card">${dueHTML}</section>

      <h2 class="section-title"><span>How it adds up</span></h2>
      <section class="card">
        <div class="kv"><span class="k">Income</span><span class="v">${money(st.income)}</span></div>
        <div class="kv"><span class="k">Spent so far</span><span class="v">−${money(st.spent)}</span></div>
        <div class="kv"><span class="k">Saved so far</span><span class="v">−${money(st.saved)}</span></div>
        <div class="kv total"><span class="k">Left this month</span><span class="v ${st.left < 0 ? 'bad' : ''}">${money(st.left)}</span></div>
        <div class="kv"><span class="k">Savings still to go</span><span class="v">−${money(st.stillToSave)}</span></div>
        <div class="kv"><span class="k">Fixed bills not paid yet</span><span class="v">−${money(st.unpaidFixed)}</span></div>
        <div class="kv total"><span class="k">Left to spend</span><span class="v ${st.flexible < 0 ? 'bad' : 'good'}">${money(st.flexible)}</span></div>
        <p class="note">Cushion after the full plan (income − all budgets − savings plan): <b class="${st.cushion < 0 ? 'bad' : 'good'}">${money(st.cushion)}</b></p>
      </section>`;
  }

  function txRow(t) {
    if (t.type === 'savings') {
      const out = t.amount < 0;
      return `<button class="row" data-action="edit-tx" data-id="${esc(t.id)}">
        <span class="dot" style="background:${out ? '#8D6E63' : '#43A047'}">$</span>
        <span class="row-main"><span class="row-title">${esc(t.note || (out ? 'Savings withdrawal' : 'Savings deposit'))}</span><span class="row-sub">Savings · ${shortDate(t.date)}</span></span>
        <span class="row-end"><span class="amt ${out ? 'bad' : 'good'}">${out ? '−' : '+'}${money(Math.abs(t.amount))}</span></span>${ICON.chev}
      </button>`;
    }
    const c = categoryOf(t.category);
    return `<button class="row" data-action="edit-tx" data-id="${esc(t.id)}">
      <span class="dot" style="background:${c.color}">${esc(c.name.charAt(0).toUpperCase())}</span>
      <span class="row-main"><span class="row-title">${esc(t.note || c.name)}</span><span class="row-sub">${esc(c.name)} · ${shortDate(t.date)}</span></span>
      <span class="row-end"><span class="amt">−${money(t.amount)}</span></span>${ICON.chev}
    </button>`;
  }

  function viewActivity() {
    const ym = ui.activityMonth;
    const latest = state.transactions.reduce((mx, t) => (t.date.slice(0, 7) > mx ? t.date.slice(0, 7) : mx), currentYM());
    const earliest = historyMonths().at(-1);
    const st = monthStats(ym);
    const txs = monthTx(ym).sort((a, b) => b.date.localeCompare(a.date) || b.created - a.created);
    const groups = [];
    for (const t of txs) {
      const g = groups.at(-1);
      if (g && g.date === t.date) g.items.push(t); else groups.push({ date: t.date, items: [t] });
    }
    const dayTitle = (iso) => {
      if (iso === todayISO()) return 'Today';
      const y = new Date(); y.setDate(y.getDate() - 1);
      if (iso === toISO(y)) return 'Yesterday';
      return parseISO(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    };
    return `
      ${pageHead('', 'Activity', `${st.count} transaction${st.count === 1 ? '' : 's'}`)}
      <div class="month-switch">
        <button class="arrow" data-action="month-step" data-step="-1" aria-label="Previous month" ${ym <= earliest ? 'disabled' : ''}>${ICON.left}</button>
        <label class="month-label">${esc(monthLabel(ym))}<input type="month" id="month-pick" value="${ym}" max="${latest}" aria-label="Pick a month"></label>
        <button class="arrow" data-action="month-step" data-step="1" aria-label="Next month" ${ym >= latest ? 'disabled' : ''}>${ICON.right}</button>
      </div>
      <div class="chips">
        <div class="chip-stat"><span>Spent</span><strong>${money(st.spent)}</strong></div>
        <div class="chip-stat"><span>Saved</span><strong class="good">${money(st.saved)}</strong></div>
        <div class="chip-stat"><span>Left over</span><strong class="${st.left < 0 ? 'bad' : ''}">${money(st.left)}</strong></div>
      </div>
      ${groups.length
        ? groups.map((g) => `<div class="day-label">${esc(dayTitle(g.date))}</div><div class="list">${g.items.map(txRow).join('')}</div>`).join('')
        : `<div class="card empty" style="margin-top:12px"><strong>No activity in ${esc(monthLabel(ym, { month: 'long' }))}</strong>Tap + to add a purchase or savings.</div>`}`;
  }

  function viewSubs() {
    const t = subsTotals();
    const subsCat = monthStats(currentYM()).cats.find((c) => c.id === 'subs');
    const subs = [...state.subscriptions].sort((a, b) => {
      const na = nextRenewal(a), nb = nextRenewal(b);
      return (na ? na.getTime() : Infinity) - (nb ? nb.getTime() : Infinity) || a.name.localeCompare(b.name);
    });
    const rows = subs.map((s) => {
      const nr = nextRenewal(s);
      return `<button class="row" data-action="edit-sub" data-id="${esc(s.id)}">
        <span class="row-main"><span class="row-title">${esc(s.name)}</span><span class="row-sub">${s.cycle === 'yearly' ? 'Yearly' : 'Monthly'} · ${nr ? `renews ${shortDate(toISO(nr))}` : 'no renewal date'}</span></span>
        <span class="row-end"><span class="amt">${money(s.cost)}<span class="sm">/${s.cycle === 'yearly' ? 'yr' : 'mo'}</span></span><br><span class="badge ${s.keep ? 'keep' : 'cancel'}">${s.keep ? 'Keep' : 'Cancel'}</span></span>${ICON.chev}
      </button>`;
    }).join('');
    const n = state.subscriptions.length;
    return `
      ${pageHead('', 'Subscriptions', `${n} subscription${n === 1 ? '' : 's'}`, `<button class="head-btn" data-action="add-sub" aria-label="Add subscription">${ICON.plus}</button>`)}
      <section class="hero">
        <div class="hero-label">Per month</div>
        <div class="hero-amount" style="font-size:44px">${money(t.monthly)}</div>
        <div class="hero-caption">${money(t.yearly)} per year</div>
        <div class="hero-stats" style="grid-template-columns:1fr 1fr">
          <div class="hero-stat"><span>Canceling saves / mo</span><strong class="${t.cancelMonthly > 0 ? '' : ''}">${money(t.cancelMonthly)}</strong></div>
          <div class="hero-stat"><span>Canceling saves / yr</span><strong>${money(t.cancelYearly)}</strong></div>
        </div>
      </section>
      <section class="card">
        <div class="kv"><span class="k">Budget line on Home</span><span class="v">${money(t.monthly)}/mo</span></div>
        <div class="kv"><span class="k">Logged this month</span><span class="v ${cents(subsCat.spent) > cents(subsCat.budget) ? 'bad' : ''}">${money(subsCat.spent)}</span></div>
        <p class="note">Yearly plans count as 1/12 per month. Log actual charges with + using the Subscriptions category.</p>
      </section>
      <h2 class="section-title"><span>Your subscriptions</span></h2>
      ${subs.length ? `<div class="list">${rows}</div>`
        : '<div class="card empty"><strong>No subscriptions yet</strong>Add the services you pay for to see what they cost per month and per year.</div>'}
      <button class="btn" data-action="add-sub">${ICON.plus} Add subscription</button>`;
  }

  function viewGoals() {
    const total = totalSavings();
    const efGoal = state.settings.emergencyGoal;
    const ef = Math.min(total, efGoal);
    const goals = state.goals.map((g) => {
      const gi = goalInfo(g);
      let line;
      if (gi.done) line = '<span class="good">Goal reached!</span>';
      else if (!g.date) line = 'Add a target date to see the monthly amount.';
      else if (gi.passed) line = `<span class="bad">Target date passed</span> · ${money(gi.left)} to go`;
      else line = `<b>${money(gi.perMonth)}/mo</b> needed for ${gi.months} month${gi.months === 1 ? '' : 's'} · ${money(gi.left)} to go`;
      return `<button ${cardButton} data-action="edit-goal" data-id="${esc(g.id)}">
        <div class="card-head"><h3>${esc(g.name)}</h3><span class="meta">${g.date ? `by ${parseISO(g.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : 'No date'}</span></div>
        <div class="metric">
          ${bar(g.saved, g.target, { variant: gi.done ? '' : 'violet', thick: true })}
          <div class="metric-body">
            <div class="big-pair"><span class="big">${money(g.saved)}</span><span class="of">of ${money(g.target)} · ${Math.round(gi.progress)}%</span></div>
            <p class="note">${line}</p>
          </div>
        </div>
      </button>`;
    }).join('');
    const debts = state.debts.map((d) => {
      const di = debtInfo(d);
      let body;
      if (!di.known) body = '<p class="note" style="margin:0">Tap to enter the balance you still owe.</p>';
      else if (di.paidOff) body = '<p class="note good" style="margin:0">Paid off!</p>';
      else {
        body = `
        <div class="kv"><span class="k">Balance</span><span class="v">${money(d.balance)}</span></div>
        <div class="kv"><span class="k">Months left</span><span class="v">${di.monthsLeft ?? '—'}</span></div>
        <div class="kv"><span class="k">Payoff month</span><span class="v">${di.payoff ? esc(monthLabel(di.payoff, { month: 'short', year: 'numeric' })) : '—'}</span></div>`;
      }
      return `<button ${cardButton} data-action="edit-debt" data-id="${esc(d.id)}">
        <div class="card-head"><h3>${esc(d.name)}</h3><span class="meta">${money(d.payment)}/mo</span></div>${body}
      </button>`;
    }).join('');

    return `
      ${pageHead('', 'Goals', `Total saved ${money(total)}`, `<button class="head-btn" data-action="add-goal" aria-label="Add goal">${ICON.plus}</button>`)}
      <section class="hero">
        <div class="metric">
          ${bar(ef, efGoal, { variant: ef >= efGoal ? '' : 'violet', thick: true })}
          <div class="metric-body">
            <div class="hero-label">Emergency fund</div>
            <div class="hero-amount" style="font-size:40px">${money(ef)}</div>
            <div class="hero-caption">of ${money(efGoal)} goal · ${Math.round(pct(ef, efGoal))}%</div>
          </div>
        </div>
        <div class="hero-caption" style="margin-top:12px">${ef >= efGoal ? `Fully funded${total > efGoal ? ` · ${money(total - efGoal)} extra saved` : ''}` : `${money(efGoal - ef)} to go · built from your total savings`}</div>
      </section>
      <h2 class="section-title"><span>Goals</span><button class="link" data-action="add-goal">Add</button></h2>
      ${goals || '<div class="card empty"><strong>No custom goals yet</strong>Saving for something? Add a goal to see how much to put away each month.</div>'}
      <h2 class="section-title"><span>Debts</span><button class="link" data-action="add-debt">Add</button></h2>
      ${debts || '<div class="card empty"><strong>No debts</strong>Nice.</div>'}
      <p class="note" style="margin:0 4px">Payoff month counts this month as the first payment. Update the balance as you pay it down.</p>`;
  }

  function paydayHint() {
    const ym = currentYM();
    const days = paydaysIn(ym);
    if (!days) return 'Optional. Blank means every month counts as 2 paychecks.';
    const next = addMonths(ym, 1);
    const nd = paydaysIn(next);
    const list = (arr) => arr.map((d) => shortDate(toISO(d))).join(', ');
    return `${monthLabel(ym, { month: 'long' })}: ${days.length} paychecks (${list(days)}). ${monthLabel(next, { month: 'long' })}: ${nd.length} (${list(nd)}).`;
  }

  function viewSettings() {
    const s = state.settings;
    const bills = state.bills.map((b, i) => `
      <button class="row" data-action="edit-bill" data-id="${esc(b.id)}">
        <span class="dot" style="background:${COLORS[i % COLORS.length]}">${esc(b.name.charAt(0).toUpperCase())}</span>
        <span class="row-main"><span class="row-title">${esc(b.name)}</span><span class="row-sub">${b.dueDay ? `Due the ${ordinal(b.dueDay)}` : 'No due day'} · ${b.fixed ? 'Fixed' : 'Flexible'}</span></span>
        <span class="row-end"><span class="amt">${money(b.amount)}</span></span>${ICON.chev}
      </button>`).join('');
    const moneyInput = (key, label) => `
      <label class="row"><span class="label">${label}</span>
        <input class="inline" data-setting="${key}" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" value="${esc(money(s[key]))}"></label>`;
    const lastExport = s.lastExport
      ? `Last exported ${esc(new Date(s.lastExport).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}.`
      : 'Not backed up yet.';
    return `
      ${pageHead('', 'Settings', 'Everything stays on this iPhone')}
      <h2 class="section-title"><span>Income</span></h2>
      <div class="list">
        ${moneyInput('pay', 'Pay per check')}
        <div class="row"><span class="label">How often</span><span class="muted">Every 2 weeks</span></div>
        <label class="row"><span class="label">First payday</span>
          <input class="inline" data-setting="firstPayday" type="date" value="${esc(s.firstPayday)}" aria-label="First payday (optional)"></label>
      </div>
      <p class="note" id="payday-hint" style="margin:-4px 4px 0">${esc(paydayHint())}</p>

      <h2 class="section-title"><span>Bills</span><button class="link" data-action="add-bill">Add</button></h2>
      <div class="list">${bills || '<div class="empty">No bills</div>'}</div>
      <p class="note" style="margin:-4px 4px 0">Fixed bills are held back from “Left to spend” until you log them. The Subscriptions line comes from the Subscriptions tab.</p>

      <h2 class="section-title"><span>Savings &amp; goals</span></h2>
      <div class="list">
        ${moneyInput('savingsPlan', 'Savings plan / mo')}
        ${moneyInput('startingSavings', 'Starting savings')}
        ${moneyInput('emergencyGoal', 'Emergency fund goal')}
        <button class="row accent" data-action="tab" data-tab="goals"><span class="row-main"><span class="row-title">Custom goals &amp; debts</span></span>${ICON.chev}</button>
      </div>
      <p class="note" style="margin:-4px 4px 0">A month with a 3rd paycheck adds that paycheck to the month’s savings plan.</p>

      <h2 class="section-title"><span>History</span></h2>
      <div class="list">
        <button class="row" data-action="history"><span class="row-main"><span class="row-title">Month-by-month history</span><span class="row-sub">Income, spent, saved, left over</span></span>${ICON.chev}</button>
      </div>

      <h2 class="section-title"><span>Security</span></h2>
      <div class="list">
        <button class="row accent" data-action="change-pin"><span class="row-main"><span class="row-title">Change PIN</span></span>${ICON.chev}</button>
        <button class="row accent" data-action="lock-now"><span class="row-main"><span class="row-title">Lock now</span></span></button>
      </div>
      <p class="note" style="margin:-4px 4px 0">Asks for your PIN every time the app opens, or after 1 minute in the background.</p>

      <h2 class="section-title"><span>Backup</span></h2>
      <div class="btn-row">
        <button class="btn" data-action="export">${ICON.download} Export backup</button>
        <button class="btn" data-action="import">${ICON.upload} Import backup</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <p class="note" style="margin:8px 4px 0">${lastExport} Export saves a JSON file you can keep in Files or iCloud Drive. Your PIN isn’t included.</p>

      <h2 class="section-title"><span>Data</span></h2>
      <div class="list">
        <button class="row danger" data-action="erase"><span class="row-main"><span class="row-title">Erase all data</span></span></button>
      </div>
      <p class="note" style="margin:-4px 4px 16px;text-align:center">Works offline. No accounts, no tracking. Nothing leaves this device.</p>`;
  }

  const VIEWS = { home: viewHome, activity: viewActivity, subs: viewSubs, goals: viewGoals, settings: viewSettings };

  function render(animate = false) {
    if (!ui.unlocked) return;
    const view = $('#view');
    view.innerHTML = VIEWS[ui.tab]();
    for (const t of $$('.tab')) {
      const on = t.dataset.tab === ui.tab;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    }
    $('#fab').hidden = !(ui.tab === 'home' || ui.tab === 'activity');
    if (animate) {
      view.classList.remove('enter');
      void view.offsetWidth; // restart the animation
      view.classList.add('enter');
    }
  }

  function goTab(tab) {
    if (!VIEWS[tab]) return;
    const same = tab === ui.tab;
    ui.tab = tab;
    render(!same);
    window.scrollTo({ top: 0, behavior: same ? 'smooth' : 'auto' });
  }

  // ==========================================================================
  // Bottom sheets & forms
  // ==========================================================================
  let sheet = null;
  let sheetTimer = 0;

  function openSheet({ title, body, saveLabel = 'Save', onSave, onMount, tall = false }) {
    clearTimeout(sheetTimer);
    const root = $('#sheet-root');
    root.innerHTML = `
      <div class="sheet-backdrop" data-close></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-grabber"></div>
        <div class="sheet-head">
          <button type="button" class="link" data-close>${onSave ? 'Cancel' : 'Done'}</button>
          <h2>${esc(title)}</h2>
          ${onSave ? `<button type="button" class="link strong" data-sheet-save>${esc(saveLabel)}</button>` : '<span></span>'}
        </div>
        <form class="sheet-body ${tall ? 'tall' : ''}" novalidate>${body}<button type="submit" hidden></button></form>
      </div>`;
    sheet = { onSave, el: root.querySelector('.sheet') };
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('show')));
    if (onMount) onMount(sheet.el);
  }

  function closeSheet() {
    const root = $('#sheet-root');
    if (!sheet) return;
    sheet = null;
    root.classList.remove('show');
    root.setAttribute('aria-hidden', 'true');
    if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
    sheetTimer = setTimeout(() => { root.classList.remove('open'); root.innerHTML = ''; }, 300);
  }

  function trySave() {
    if (sheet && sheet.onSave && sheet.onSave(sheet.el) !== false) closeSheet();
  }

  const segHTML = (name, options, value) => `<div class="seg" data-seg="${name}" role="radiogroup">${options.map(([v, label]) =>
    `<button type="button" role="radio" aria-checked="${v === value}" data-val="${esc(v)}" class="${v === value ? 'on' : ''}">${esc(label)}</button>`).join('')}</div>`;
  const segVal = (el, name) => el.querySelector(`[data-seg="${name}"] .on`)?.dataset.val;
  const field = (label, input) => `<div class="field"><label>${esc(label)}</label>${input}</div>`;
  const moneyAttr = 'type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done"';
  const valueOf = (el, name) => (el.querySelector(`[name="${name}"]`)?.value ?? '').trim();
  function formError(el, msg) { const e = el.querySelector('.form-error'); if (e) e.textContent = msg; return false; }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /** Show/hide elements tagged data-when="seg:value" to match the current segment choices. */
  function syncWhen(el) {
    for (const node of $$('[data-when]', el)) {
      const [seg, val] = node.dataset.when.split(':');
      node.hidden = segVal(el, seg) !== val;
    }
  }

  function openTxSheet(tx, presetType = 'purchase') {
    const editing = !!tx;
    const cats = categories();
    const known = (id) => id && cats.some((c) => c.id === id);
    const type = tx ? tx.type : presetType;
    const cat = tx ? (known(tx.category) ? tx.category : 'other') : (known(ui.lastCategory) ? ui.lastCategory : cats[0].id);
    const body = `
      ${segHTML('type', [['purchase', 'Purchase'], ['savings', 'Savings']], type)}
      <div class="amount-field"><span>$</span><input name="amount" ${moneyAttr} placeholder="0.00" aria-label="Amount" value="${tx ? esc(String(Math.abs(tx.amount))) : ''}"></div>
      <div data-when="type:purchase">
        <div class="cat-grid" role="radiogroup" aria-label="Category">${cats.map((c) =>
          `<button type="button" class="cat-chip ${c.id === cat ? 'on' : ''}" role="radio" aria-checked="${c.id === cat}" data-cat="${esc(c.id)}"><i style="background:${c.color}"></i>${esc(c.name)}</button>`).join('')}</div>
      </div>
      <div data-when="type:savings">${segHTML('dir', [['in', 'Deposit'], ['out', 'Withdraw']], tx && tx.amount < 0 ? 'out' : 'in')}</div>
      <div class="field-list">
        ${field('Note', `<input name="note" type="text" maxlength="120" placeholder="Optional" autocomplete="off" enterkeyhint="done" value="${esc(tx?.note || '')}">`)}
        ${field('Date', `<input name="date" type="date" required value="${esc(tx?.date || todayISO())}">`)}
      </div>
      <div class="form-error" role="alert"></div>
      ${editing ? '<button type="button" class="btn danger" data-del>Delete transaction</button>' : ''}`;

    openSheet({
      title: editing ? 'Edit transaction' : 'Add',
      saveLabel: editing ? 'Save' : 'Add',
      body,
      onMount: (el) => {
        syncWhen(el);
        el.addEventListener('seg-change', () => syncWhen(el));
        fitAmount(el.querySelector('[name="amount"]'));
        const del = el.querySelector('[data-del]');
        if (del) del.addEventListener('click', () => {
          if (!confirm('Delete this transaction?')) return;
          state.transactions = state.transactions.filter((t) => t.id !== tx.id);
          commit(); closeSheet(); toast('Transaction deleted');
        });
        if (!editing) el.querySelector('[name="amount"]').focus({ preventScroll: true });
      },
      onSave: (el) => {
        const kind = segVal(el, 'type');
        const amount = parseMoney(valueOf(el, 'amount'));
        const date = valueOf(el, 'date');
        if (amount == null || amount <= 0) return formError(el, 'Enter an amount greater than $0.');
        if (amount >= 1e7) return formError(el, 'That amount looks too large.');
        if (!isISODate(date)) return formError(el, 'Pick a date.');
        const category = kind === 'purchase' ? (el.querySelector('.cat-chip.on')?.dataset.cat || 'other') : 'savings';
        const signed = kind === 'savings' && segVal(el, 'dir') === 'out' ? -amount : amount;
        const record = { type: kind, amount: signed, category, note: valueOf(el, 'note').slice(0, 120), date };
        if (editing) Object.assign(tx, record);
        else state.transactions.push({ id: uid(), created: Date.now(), ...record });
        if (kind === 'purchase') ui.lastCategory = category;
        commit();
        if (editing) toast('Saved');
        else if (kind === 'purchase') toast(`Added ${money(amount)} · ${categoryOf(category).name}`);
        else toast(`${signed < 0 ? 'Withdrew' : 'Saved'} ${money(amount)}`);
        return true;
      },
    });
  }

  /** Shared add/edit/delete sheet for list items (subscriptions, goals, debts, bills). */
  function openItemSheet({ item, listKey, noun, body, read, onDelete, confirmDelete }) {
    const editing = !!item;
    openSheet({
      title: editing ? `Edit ${noun}` : `New ${noun}`,
      saveLabel: editing ? 'Save' : 'Add',
      body: `${body}<div class="form-error" role="alert"></div>${editing ? `<button type="button" class="btn danger" data-del>Delete ${noun}</button>` : ''}`,
      onMount: (el) => {
        syncWhen(el);
        const del = el.querySelector('[data-del]');
        if (del) del.addEventListener('click', () => {
          if (!confirm(confirmDelete || `Delete this ${noun}?`)) return;
          state[listKey] = state[listKey].filter((x) => x.id !== item.id);
          if (onDelete) onDelete(item);
          commit(); closeSheet(); toast(`${cap(noun)} deleted`);
        });
        if (!editing) el.querySelector('input')?.focus({ preventScroll: true });
      },
      onSave: (el) => {
        const values = read(el);
        if (!values) return false;
        if (editing) Object.assign(item, values);
        else state[listKey].push({ id: uid(), ...values });
        commit();
        toast(editing ? 'Saved' : `${cap(noun)} added`);
        return true;
      },
    });
  }

  function openSubSheet(item) {
    openItemSheet({
      item, listKey: 'subscriptions', noun: 'subscription',
      body: `
        <div class="field-list">
          ${field('Name', `<input name="name" type="text" maxlength="60" placeholder="Netflix" autocomplete="off" value="${esc(item?.name || '')}">`)}
          ${field('Cost', `<input name="cost" ${moneyAttr} placeholder="$0.00" value="${item ? esc(money(item.cost)) : ''}">`)}
          <div class="field"><span class="flabel">Billed</span>${segHTML('cycle', [['monthly', 'Monthly'], ['yearly', 'Yearly']], item?.cycle || 'monthly')}</div>
          ${field('Renewal date', `<input name="renewal" type="date" value="${esc(item?.renewal || '')}">`)}
          <div class="field"><span class="flabel">Plan</span>${segHTML('keep', [['keep', 'Keep'], ['cancel', 'Cancel']], item && !item.keep ? 'cancel' : 'keep')}</div>
        </div>
        <p class="field-hint">Mark “Cancel” to see how much you’d save on the Subscriptions tab.</p>`,
      read: (el) => {
        const name = valueOf(el, 'name');
        const cost = parseMoney(valueOf(el, 'cost'));
        const renewal = valueOf(el, 'renewal');
        if (!name) return formError(el, 'Give it a name.');
        if (cost == null || cost < 0) return formError(el, 'Enter the cost.');
        return { name: name.slice(0, 60), cost, cycle: segVal(el, 'cycle'), renewal: isISODate(renewal) ? renewal : '', keep: segVal(el, 'keep') === 'keep' };
      },
    });
  }

  function openGoalSheet(item) {
    openItemSheet({
      item, listKey: 'goals', noun: 'goal',
      body: `
        <div class="field-list">
          ${field('Name', `<input name="name" type="text" maxlength="60" placeholder="New car" autocomplete="off" value="${esc(item?.name || '')}">`)}
          ${field('Target', `<input name="target" ${moneyAttr} placeholder="$0" value="${item ? esc(money(item.target)) : ''}">`)}
          ${field('Saved so far', `<input name="saved" ${moneyAttr} placeholder="$0" value="${item ? esc(money(item.saved)) : ''}">`)}
          ${field('Target date', `<input name="date" type="date" value="${esc(item?.date || '')}">`)}
        </div>
        <p class="field-hint">Needed per month = what’s left ÷ months until the target date (min 1). Update “Saved so far” as you go.</p>`,
      read: (el) => {
        const name = valueOf(el, 'name');
        const target = parseMoney(valueOf(el, 'target'));
        const saved = parseMoney(valueOf(el, 'saved')) ?? 0;
        const date = valueOf(el, 'date');
        if (!name) return formError(el, 'Give the goal a name.');
        if (target == null || target <= 0) return formError(el, 'Enter a target amount.');
        if (saved < 0) return formError(el, 'Saved can’t be negative.');
        return { name: name.slice(0, 60), target, saved, date: isISODate(date) ? date : '' };
      },
    });
  }

  function openDebtSheet(item) {
    openItemSheet({
      item, listKey: 'debts', noun: 'debt',
      body: `
        <div class="field-list">
          ${field('Name', `<input name="name" type="text" maxlength="60" placeholder="Credit card" autocomplete="off" value="${esc(item?.name || '')}">`)}
          ${field('Balance left', `<input name="balance" ${moneyAttr} placeholder="Unknown" value="${item && item.balance != null ? esc(money(item.balance)) : ''}">`)}
          ${field('Monthly payment', `<input name="payment" ${moneyAttr} placeholder="$0" value="${item ? esc(money(item.payment)) : ''}">`)}
        </div>
        <p class="field-hint">Leave the balance blank if you don’t know it yet.</p>`,
      read: (el) => {
        const name = valueOf(el, 'name');
        const balRaw = valueOf(el, 'balance');
        const balance = balRaw === '' ? null : parseMoney(balRaw);
        const payment = parseMoney(valueOf(el, 'payment'));
        if (!name) return formError(el, 'Give the debt a name.');
        if (balRaw !== '' && (balance == null || balance < 0)) return formError(el, 'Enter a valid balance or leave it blank.');
        if (payment == null || payment < 0) return formError(el, 'Enter the monthly payment.');
        return { name: name.slice(0, 60), balance, payment };
      },
    });
  }

  function openBillSheet(item) {
    openItemSheet({
      item, listKey: 'bills', noun: 'bill',
      confirmDelete: 'Delete this bill? Purchases already logged under it will move to “Other”.',
      onDelete: (bill) => { for (const t of state.transactions) if (t.category === bill.id) t.category = 'other'; },
      body: `
        <div class="field-list">
          ${field('Name', `<input name="name" type="text" maxlength="40" placeholder="Car insurance" autocomplete="off" value="${esc(item?.name || '')}">`)}
          ${field('Monthly budget', `<input name="amount" ${moneyAttr} placeholder="$0" value="${item ? esc(money(item.amount)) : ''}">`)}
          ${field('Due day', `<input name="dueDay" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="2" placeholder="None (1–31)" autocomplete="off" value="${item?.dueDay ?? ''}">`)}
          <div class="field"><span class="flabel">Type</span>${segHTML('fixed', [['fixed', 'Fixed'], ['flex', 'Flexible']], item ? (item.fixed ? 'fixed' : 'flex') : 'fixed')}</div>
        </div>
        <p class="field-hint">Fixed = a set bill (rent, phone). Flexible = day-to-day spending (groceries, fun). The due day powers “Still due this month”.</p>`,
      read: (el) => {
        const name = valueOf(el, 'name');
        const amount = parseMoney(valueOf(el, 'amount'));
        const dueRaw = valueOf(el, 'dueDay');
        const dueDay = dueRaw === '' ? null : Number(dueRaw);
        if (!name) return formError(el, 'Give the bill a name.');
        if (amount == null || amount < 0) return formError(el, 'Enter the monthly amount.');
        if (dueDay !== null && !(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) return formError(el, 'Due day must be 1–31 or blank.');
        return { name: name.slice(0, 40), amount, dueDay, fixed: segVal(el, 'fixed') === 'fixed' };
      },
    });
  }

  function openHistorySheet() {
    const rows = historyMonths().map((ym) => {
      const st = monthStats(ym);
      return `<button type="button" class="hist-row" style="display:block;width:100%;text-align:left" data-action="history-month" data-ym="${ym}">
        <div class="hist-top"><strong>${esc(monthLabel(ym))}${ym === currentYM() ? ' <span class="badge due">Now</span>' : ''}</strong>
          <span class="${st.left < 0 ? 'bad' : 'good'}" style="font-weight:700">${money(st.left)} <span class="muted" style="font-weight:400;font-size:13px">left over</span></span></div>
        <div class="hist-grid">
          <div><span>Income</span><b>${money(st.income)}</b></div>
          <div><span>Spent</span><b>${money(st.spent)}</b></div>
          <div><span>Saved</span><b>${money(st.saved)}</b></div>
          <div><span>Total saved</span><b>${money(savingsThrough(ym))}</b></div>
        </div>
      </button>`;
    }).join('');
    openSheet({
      title: 'History', tall: true,
      body: `<p class="field-hint" style="margin:0 4px 10px">Left over = income − spent − saved. Tap a month to see its activity.</p><div class="list">${rows}</div>`,
    });
  }

  // ==========================================================================
  // Backup (export / import) & erase
  // ==========================================================================
  async function exportBackup() {
    const payload = { app: 'budget-pwa', format: 1, exportedAt: new Date().toISOString(), data: state };
    const name = `budget-backup-${todayISO()}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    let shared = false;
    try {
      // iOS: the share sheet offers "Save to Files".
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Budget backup' });
        shared = true;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // closed the share sheet
    }
    if (!shared) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
    state.settings.lastExport = new Date().toISOString();
    commit();
    toast('Backup exported');
  }

  async function importBackup(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast('That file isn’t a valid backup');
      return;
    }
    const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    if (!data || typeof data !== 'object' || !data.settings || !Array.isArray(data.transactions)) {
      toast('That file isn’t a budget backup');
      return;
    }
    const when = parsed.exportedAt ? ` from ${new Date(parsed.exportedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
    if (!confirm(`Replace everything on this device with the backup${when}? It has ${data.transactions.length} transaction(s).`)) return;
    state = normalize(data);
    commit();
    toast('Backup restored');
  }

  function eraseAll(message) {
    if (!confirm(message)) return;
    if (!confirm('This can’t be undone. Erase everything?')) return;
    for (const k of [DATA_KEY, LEGACY_DATA_KEY, PIN_KEY, FAIL_KEY, HIDDEN_KEY]) localStorage.removeItem(k);
    location.reload();
  }

  // ==========================================================================
  // Toast
  // ==========================================================================
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ==========================================================================
  // PIN lock — salted SHA-256 via WebCrypto; only the salt + hash are stored.
  // ==========================================================================
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const Lock = {
    mode: 'unlock', // setup | confirm | unlock | change-current | change-new | change-confirm
    digits: '',
    first: '',
    busy: false,
    open: false,
    timer: 0,

    record() {
      try {
        const r = JSON.parse(localStorage.getItem(PIN_KEY));
        return r && r.salt && r.hash ? r : null;
      } catch {
        return null;
      }
    },
    hasPin() { return !!this.record(); },
    async hash(pin, salt) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
      return hex(new Uint8Array(digest));
    },
    async setPin(pin) {
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await this.hash(pin, salt);
      localStorage.setItem(PIN_KEY, JSON.stringify({ v: 1, alg: 'SHA-256', salt, hash, length: pin.length }));
    },
    async verify(pin) {
      const r = this.record();
      return !!r && (await this.hash(pin, r.salt)) === r.hash;
    },

    fails() {
      try { return JSON.parse(localStorage.getItem(FAIL_KEY)) || { count: 0, until: 0 }; } catch { return { count: 0, until: 0 }; }
    },
    setFails(f) { localStorage.setItem(FAIL_KEY, JSON.stringify(f)); },

    show(mode) {
      this.mode = mode;
      this.digits = '';
      if (mode === 'setup' || mode === 'unlock' || mode === 'change-current') this.first = '';
      this.open = true;
      $('#lock').classList.add('show');
      document.body.classList.add('is-locked');
      if (mode === 'unlock') closeSheet();
      this.message('');
      this.tickLockout();
    },
    hide() {
      this.open = false;
      this.digits = '';
      this.first = '';
      clearInterval(this.timer);
      $('#lock').classList.remove('show');
      document.body.classList.remove('is-locked');
    },

    maxLen() {
      if (this.mode === 'setup' || this.mode === 'change-new') return 6;
      if (this.mode === 'confirm' || this.mode === 'change-confirm') return this.first.length;
      return this.record()?.length || 6;
    },
    choosing() { return this.mode === 'setup' || this.mode === 'change-new'; },

    update() {
      const titles = {
        setup: ['Create a PIN', 'Choose 4–6 digits. It never leaves this iPhone.'],
        confirm: ['Confirm your PIN', 'Enter it once more.'],
        unlock: ['Enter PIN', ''],
        'change-current': ['Enter current PIN', ''],
        'change-new': ['Enter a new PIN', '4–6 digits, then tap Next.'],
        'change-confirm': ['Confirm new PIN', 'Enter it once more.'],
      };
      const [title, sub] = titles[this.mode];
      $('#lock-title').textContent = title;
      const subEl = $('#lock-sub');
      if (!subEl.classList.contains('err')) subEl.textContent = sub || '\u00a0';
      const slots = this.choosing() ? Math.max(4, this.digits.length) : this.maxLen();
      $('#lock-dots').innerHTML = Array.from({ length: slots }, (_, i) => `<i class="${i < this.digits.length ? 'on' : ''}"></i>`).join('');
      const next = $('#lock-next');
      next.style.visibility = this.choosing() ? 'visible' : 'hidden';
      next.disabled = !(this.choosing() && this.digits.length >= 4);
      $('#lock-cancel').hidden = !this.mode.startsWith('change');
      $('#lock-forgot').hidden = this.mode !== 'unlock';
    },

    message(text, isError = false) {
      const el = $('#lock-sub');
      el.classList.toggle('err', isError);
      el.textContent = text || '\u00a0';
      this.update();
    },

    shake() {
      const dots = $('#lock-dots');
      dots.classList.remove('shake');
      void dots.offsetWidth;
      dots.classList.add('shake');
      if (navigator.vibrate) navigator.vibrate(80);
    },

    lockedOut() {
      if (this.mode !== 'unlock' && this.mode !== 'change-current') return 0;
      return Math.max(0, this.fails().until - Date.now());
    },
    tickLockout() {
      clearInterval(this.timer);
      if (this.lockedOut() <= 0) return;
      const tick = () => {
        const ms = this.lockedOut();
        if (ms > 0) this.message(`Too many tries. Try again in ${Math.ceil(ms / 1000)}s.`, true);
        else { clearInterval(this.timer); this.message(''); }
      };
      tick();
      this.timer = setInterval(tick, 1000);
    },

    press(key) {
      if (!this.open || this.busy) return;
      if (this.lockedOut() > 0) { this.shake(); return; }
      if ($('#lock-sub').classList.contains('err')) this.message('');
      if (key === 'back') { this.digits = this.digits.slice(0, -1); this.update(); return; }
      if (key === 'next') { if (this.choosing() && this.digits.length >= 4) this.submit(); return; }
      if (!/^\d$/.test(key) || this.digits.length >= this.maxLen()) return;
      this.digits += key;
      this.update();
      if (this.digits.length === this.maxLen()) {
        this.busy = true; // let the last dot fill in before checking
        setTimeout(() => { this.busy = false; this.submit(); }, 120);
      }
    },

    async submit() {
      const pin = this.digits;
      this.busy = true;
      try {
        if (this.choosing()) {
          this.first = pin;
          this.show(this.mode === 'setup' ? 'confirm' : 'change-confirm');
        } else if (this.mode === 'confirm' || this.mode === 'change-confirm') {
          const initial = this.mode === 'confirm';
          if (pin !== this.first) {
            this.shake();
            this.show(initial ? 'setup' : 'change-new');
            this.first = '';
            this.message('PINs didn’t match. Try again.', true);
            return;
          }
          await this.setPin(pin);
          this.setFails({ count: 0, until: 0 });
          this.hide();
          if (initial) { onUnlocked(); toast('PIN set'); } else toast('PIN changed');
        } else if (await this.verify(pin)) {
          this.setFails({ count: 0, until: 0 });
          if (this.mode === 'unlock') { this.hide(); onUnlocked(); } else this.show('change-new');
        } else {
          const f = this.fails();
          f.count += 1;
          if (f.count % 5 === 0) f.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (f.count / 5 - 1)) * 1000;
          this.setFails(f);
          this.digits = '';
          this.shake();
          if (f.until > Date.now()) this.tickLockout(); else this.message('Wrong PIN. Try again.', true);
        }
      } finally {
        this.busy = false;
      }
    },
  };

  let hiddenAt = 0;
  function onUnlocked() {
    if (!ui.unlocked) { ui.unlocked = true; ui.tab = 'home'; }
    $('#app').hidden = false;
    render(true);
  }
  function lockIfStale() {
    const stale = hiddenAt && Date.now() - hiddenAt >= LOCK_AFTER_MS;
    hiddenAt = 0;
    if (stale && Lock.hasPin() && !(Lock.open && Lock.mode === 'unlock')) Lock.show('unlock');
  }

  // ==========================================================================
  // Events
  // ==========================================================================
  function onClick(e) {
    const t = e.target;
    const key = t.closest('.key');
    if (key) { Lock.press(key.dataset.key); return; }
    if (t.closest('[data-close]')) { closeSheet(); return; }
    if (t.closest('[data-sheet-save]')) { trySave(); return; }

    const segBtn = t.closest('.seg button');
    if (segBtn) {
      const seg = segBtn.parentElement;
      for (const b of seg.children) { b.classList.toggle('on', b === segBtn); b.setAttribute('aria-checked', String(b === segBtn)); }
      seg.dispatchEvent(new CustomEvent('seg-change', { bubbles: true }));
      return;
    }
    const chip = t.closest('.cat-chip');
    if (chip) {
      for (const c of chip.parentElement.children) { c.classList.toggle('on', c === chip); c.setAttribute('aria-checked', String(c === chip)); }
      return;
    }
    const tab = t.closest('.tab');
    if (tab) { goTab(tab.dataset.tab); return; }

    const el = t.closest('[data-action]');
    if (!el) return;
    const id = el.dataset.id;
    const find = (list) => state[list].find((x) => x.id === id);
    switch (el.dataset.action) {
      case 'tab': goTab(el.dataset.tab); break;
      case 'add': openTxSheet(null, el.dataset.type || 'purchase'); break;
      case 'edit-tx': { const tx = find('transactions'); if (tx) openTxSheet(tx); break; }
      case 'month-step': ui.activityMonth = addMonths(ui.activityMonth, Number(el.dataset.step)); render(); break;
      case 'add-sub': openSubSheet(null); break;
      case 'edit-sub': openSubSheet(find('subscriptions')); break;
      case 'add-goal': openGoalSheet(null); break;
      case 'edit-goal': openGoalSheet(find('goals')); break;
      case 'add-debt': openDebtSheet(null); break;
      case 'edit-debt': openDebtSheet(find('debts')); break;
      case 'add-bill': openBillSheet(null); break;
      case 'edit-bill': openBillSheet(find('bills')); break;
      case 'history': openHistorySheet(); break;
      case 'history-month': ui.activityMonth = el.dataset.ym; closeSheet(); goTab('activity'); break;
      case 'change-pin': Lock.show('change-current'); break;
      case 'lock-now': Lock.show('unlock'); break;
      case 'export': exportBackup(); break;
      case 'import': $('#import-file').click(); break;
      case 'erase': eraseAll('Erase all budget data and your PIN from this device? Export a backup first if you might want it.'); break;
      default: break;
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'month-pick') {
      if (/^\d{4}-\d{2}$/.test(t.value)) { ui.activityMonth = t.value; render(); }
      return;
    }
    if (t.id === 'import-file') {
      const file = t.files && t.files[0];
      t.value = '';
      if (file) importBackup(file);
      return;
    }
    const key = t.dataset.setting;
    if (!key) return;
    const s = state.settings;
    if (key === 'firstPayday') {
      s.firstPayday = isISODate(t.value) ? t.value : '';
    } else {
      const v = parseMoney(t.value);
      if (v == null || v < 0 || v >= 1e7) { t.value = money(s[key]); toast('Enter a valid amount'); return; }
      s[key] = v;
      t.value = money(v);
    }
    save();
    const hint = $('#payday-hint');
    if (hint) hint.textContent = paydayHint();
    toast('Saved');
  }

  /** Size the big amount input to its text so "$12.50" stays centered. */
  function fitAmount(input) {
    const len = (input.value || input.placeholder).length;
    input.style.width = `${Math.min(12, Math.max(1, len)) + 0.4}ch`;
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', (e) => { if (e.target.matches('.amount-field input')) fitAmount(e.target); });
    document.addEventListener('change', onChange);
    document.addEventListener('submit', (e) => { e.preventDefault(); trySave(); });
    document.addEventListener('focusin', (e) => { if (e.target.matches('input.inline[inputmode="decimal"]')) e.target.select(); });
    $('#fab').addEventListener('click', () => openTxSheet(null, 'purchase'));
    $('#lock-cancel').addEventListener('click', () => Lock.hide());
    $('#lock-forgot').addEventListener('click', () => eraseAll('Forgot your PIN? The only way back in is to erase all data on this device (you can import a backup afterward). Continue?'));

    document.addEventListener('keydown', (e) => {
      if (Lock.open) {
        if (/^\d$/.test(e.key)) Lock.press(e.key);
        else if (e.key === 'Backspace') Lock.press('back');
        else if (e.key === 'Enter') Lock.press('next');
        return;
      }
      if (e.key === 'Escape' && sheet) closeSheet();
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.cat[role="button"]')) { e.preventDefault(); e.target.click(); }
    });

    // Re-lock after ~1 minute in the background.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        try { localStorage.setItem(HIDDEN_KEY, String(hiddenAt)); } catch { /* ignore */ }
        document.body.classList.add('privacy');
      } else {
        document.body.classList.remove('privacy');
        lockIfStale();
        if (ui.unlocked && !sheet && ui.tab !== 'settings') render(); // pick up a new day or month
      }
    });
    window.addEventListener('pageshow', (e) => { if (e.persisted) lockIfStale(); });
  }

  // ==========================================================================
  // Boot
  // ==========================================================================
  function boot() {
    load();
    bindEvents();
    Lock.show(Lock.hasPin() ? 'unlock' : 'setup'); // always ask on open; first visit sets a PIN
    if (!window.isSecureContext || !(window.crypto && crypto.subtle)) {
      Lock.message('Open this app over HTTPS to use the PIN lock.', true);
      Lock.busy = true;
      return;
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./service-worker.js').catch(() => { /* offline mode unavailable */ });
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  boot();
})();
