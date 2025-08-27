/**
 * Google Ads Script — Account-level Budget Pacing (Monthly OR Daily)
 * - Enter either MONTHLY_BUDGET or DAILY_BUDGET (you can enter both; see logic).
 * - Expected-by-today comes from DAILY if provided, else from MONTHLY / daysInMonth.
 * - Monthly cap is MONTHLY if provided; else DAILY * daysInMonth.
 * - Anti-spam cooldown + hysteresis + optional PAUSE_AT_100 included.
 *
 * Setup:
 *   Tools & Settings → Bulk actions → Scripts → + → paste, Save, Authorize, Preview, Run once.
 *   On the Scripts list page, set Frequency (e.g., hourly 8–20).
 */

const CONFIG = {
  // === Fill ONE of these (or both). Leave the other as null. ===
  MONTHLY_BUDGET: null,   // e.g., 20000  (account currency); leave null to derive from daily
  DAILY_BUDGET: 600,      // e.g., 600; leave null if you only use monthly

  // Pacing bands (hysteresis)
  WARN_AHEAD_PCT: 0.15,   // enter "AHEAD" at +15% vs expected
  WARN_BEHIND_PCT: 0.15,  // enter "BEHIND" at -15% vs expected
  EXIT_AHEAD_PCT: 0.08,   // exit AHEAD when within +8%
  EXIT_BEHIND_PCT: 0.08,  // exit BEHIND when within -8%

  // Near / critical budget checkpoints (based on monthly cap %)
  WARN_AT_PCT: 0.90,
  CRITICAL_AT_PCT: 0.98,

  // Enforcement & notifications
  PAUSE_AT_100: false,                 // pause all campaigns at/beyond 100% of monthly cap
  EMAILS: ['you@yourdomain.com'],      // recipients

  // Anti-spam controls
  SEND_DAILY_SUMMARY: false,           // you asked for alerts only; keep false
  DAILY_SUMMARY_HOUR: 9,               // ignored when SEND_DAILY_SUMMARY=false
  COOLDOWN_HOURS: 24,                  // snooze window after any alert
  MIN_PCT_WORSEN_TO_REALERT: 0.07,     // +7pp worse within same state → re-alert

  // Business-hours window for sending alerts (still logs anytime)
  ACTIVE_HOURS_START: 8,               // 08:00
  ACTIVE_HOURS_END: 20                 // 20:00
};

function main() {
  const account = AdsApp.currentAccount();
  const tz = account.getTimeZone();
  const currency = account.getCurrencyCode();
  const now = new Date();

  // Month math
  const year = parseInt(Utilities.formatDate(now, tz, 'yyyy'), 10);
  const month = parseInt(Utilities.formatDate(now, tz, 'M'), 10); // 1..12
  const dayOfMonth = parseInt(Utilities.formatDate(now, tz, 'd'), 10);
  const daysInMonth = new Date(year, month, 0).getDate();

  // Determine effective monthly cap and expected spend by today
  const monthlyCap = deriveMonthlyCap_(daysInMonth);
  if (!isFinite_(monthlyCap) || monthlyCap <= 0) {
    throw new Error('You must set either CONFIG.MONTHLY_BUDGET or CONFIG.DAILY_BUDGET to a positive number.');
  }
  const expectedByToday = deriveExpectedByToday_(dayOfMonth, daysInMonth);

  // Account MTD spend
  const stats = account.getStatsFor('THIS_MONTH');
  const costMTD = stats.getCost();

  // Budget usage and deviation
  const pctOfBudget = monthlyCap > 0 ? (costMTD / monthlyCap) : 0;
  const delta = costMTD - expectedByToday; // + ahead, - behind
  const deviationPct = expectedByToday > 0 ? Math.abs(delta / expectedByToday) : 0;

  // Severity with hysteresis bands
  let severity = classifySeverity_(pctOfBudget, expectedByToday, delta);

  // Apply exit hysteresis if we were previously AHEAD/BEHIND and moved back within the tighter band
  const state = getState_();
  if (state.lastSeverity === 'AHEAD' &&
      expectedByToday > 0 &&
      delta <= expectedByToday * CONFIG.EXIT_AHEAD_PCT &&
      severity === 'AHEAD') {
    severity = 'OK';
  }
  if (state.lastSeverity === 'BEHIND' &&
      expectedByToday > 0 &&
      delta >= -expectedByToday * CONFIG.EXIT_BEHIND_PCT &&
      severity === 'BEHIND') {
    severity = 'OK';
  }

  // Decide whether to alert now
  const nowMs = now.getTime();
  const outOfCooldown = nowMs >= (state.cooldownUntil || 0);
  const severityChanged = severity !== state.lastSeverity;
  const worsenedEnough = (deviationPct - (state.lastDeviationPct || 0)) >= CONFIG.MIN_PCT_WORSEN_TO_REALERT;
  const inHours = withinBusinessHours_(tz);

  let shouldAlert = false;
  if (severity === 'OK') {
    if (severityChanged && state.lastSeverity !== 'OK') shouldAlert = true; // notify when returning to OK
  } else {
    if (severityChanged || worsenedEnough || outOfCooldown) shouldAlert = true;
  }

  // Build lines for email/log
  const lines = [
    `Account: ${account.getCustomerId()} – ${account.getName()}`,
    `Time zone: ${tz} | Currency: ${currency}`,
    `Month days: ${daysInMonth} | Today: ${dayOfMonth}/${daysInMonth}`,
    `Monthly cap: ${fmtMoney_(monthlyCap, currency)}`,
    `Daily budget (if set): ${isFinite_(CONFIG.DAILY_BUDGET) ? fmtMoney_(CONFIG.DAILY_BUDGET, currency) : '—'}`,
    `Spend MTD: ${fmtMoney_(costMTD, currency)}`,
    `Expected by today: ${fmtMoney_((expectedByToday), currency)}`,
    `Delta vs expected: ${delta >= 0 ? '+' : ''}${fmtMoney_(delta, currency)} (${expectedByToday > 0 ? pct_((delta/expectedByToday)) : '0.0%'})`,
    `Budget used: ${pct_(pctOfBudget)}`,
    `State: ${severity}`
  ];

  // Send alert (honor business hours)
  if (shouldAlert && inHours) {
    MailApp.sendEmail(
      CONFIG.EMAILS.join(','),
      `Google Ads Budget Alert – ${severity} – ${Utilities.formatDate(now, tz, 'MMM d, HH:mm')}`,
      lines.join('\n')
    );
    // cooldown + remember last deviation/severity
    state.cooldownUntil = nowMs + CONFIG.COOLDOWN_HOURS * 3600 * 1000;
    state.lastDeviationPct = deviationPct;
    state.lastSeverity = severity;
    setState_(state);
  }

  // Optional: daily summary (you’ve disabled it by default)
  if (CONFIG.SEND_DAILY_SUMMARY) {
    const hour = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
    const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    if (hour === CONFIG.DAILY_SUMMARY_HOUR && today !== state.lastSummaryDay) {
      MailApp.sendEmail(
        CONFIG.EMAILS.join(','),
        `Google Ads Budget Summary – ${Utilities.formatDate(now, tz, 'MMM d')}`,
        lines.join('\n')
      );
      state.lastSummaryDay = today;
      setState_(state);
    }
  }

  // Optional: pause all campaigns at/above 100% monthly cap (regardless of hours)
  if (pctOfBudget >= 1 && CONFIG.PAUSE_AT_100) {
    pauseAllCampaigns_();
  }

  Logger.log(lines.join(' | '));
}

/* ======= Helpers ======= */

function deriveMonthlyCap_(daysInMonth) {
  const hasMonthly = isFinite_(CONFIG.MONTHLY_BUDGET) && CONFIG.MONTHLY_BUDGET > 0;
  const hasDaily = isFinite_(CONFIG.DAILY_BUDGET) && CONFIG.DAILY_BUDGET > 0;
  if (hasMonthly) return CONFIG.MONTHLY_BUDGET;
  if (hasDaily) return CONFIG.DAILY_BUDGET * daysInMonth;
  return NaN;
}

function deriveExpectedByToday_(dayOfMonth, daysInMonth) {
  const hasDaily = isFinite_(CONFIG.DAILY_BUDGET) && CONFIG.DAILY_BUDGET > 0;
  if (hasDaily) return CONFIG.DAILY_BUDGET * dayOfMonth;
  // else derive from monthly pacing
  const monthly = deriveMonthlyCap_(daysInMonth);
  return (monthly / daysInMonth) * dayOfMonth;
}

function classifySeverity_(pctOfBudget, expectedByToday, delta) {
  // Default state
  let sev = 'OK';
  // Ahead/behind vs expected (enter thresholds)
  if (expectedByToday > 0) {
    if (delta > expectedByToday * CONFIG.WARN_AHEAD_PCT) sev = 'AHEAD';
    if (delta < -expectedByToday * CONFIG.WARN_BEHIND_PCT) sev = 'BEHIND';
  }
  // Near/critical/cap override based on budget %
  if (pctOfBudget >= CONFIG.WARN_AT_PCT && pctOfBudget < CONFIG.CRITICAL_AT_PCT) sev = 'NEAR';
  if (pctOfBudget >= CONFIG.CRITICAL_AT_PCT && pctOfBudget < 1) sev = 'CRITICAL';
  if (pctOfBudget >= 1) sev = 'CAP';
  return sev;
}

function pauseAllCampaigns_() {
  const groups = [
    () => AdsApp.campaigns().withCondition("Status = ENABLED").get(),
    () => typeof AdsApp.shoppingCampaigns === 'function' ? AdsApp.shoppingCampaigns().withCondition("Status = ENABLED").get() : null,
    () => typeof AdsApp.videoCampaigns === 'function' ? AdsApp.videoCampaigns().withCondition("Status = ENABLED").get() : null,
    () => typeof AdsApp.performanceMaxCampaigns === 'function' ? AdsApp.performanceMaxCampaigns().withCondition("Status = ENABLED").get() : null,
    () => typeof AdsApp.appCampaigns === 'function' ? AdsApp.appCampaigns().withCondition("Status = ENABLED").get() : null
  ];
  for (const g of groups) {
    const it = g && g();
    if (!it) continue;
    while (it.hasNext()) it.next().pause();
  }
}

function getState_() {
  const p = PropertiesService.getScriptProperties();
  const raw = p.getProperty('BUDGET_ALERT_STATE');
  return raw ? JSON.parse(raw) : {
    lastSeverity: 'OK',
    lastDeviationPct: 0,
    cooldownUntil: 0,
    lastSummaryDay: ''
  };
}
function setState_(s) {
  PropertiesService.getScriptProperties().setProperty('BUDGET_ALERT_STATE', JSON.stringify(s));
}

function withinBusinessHours_(tz) {
  const now = new Date();
  const hour = parseInt(Utilities.formatDate(now, tz, 'H'), 10);
  return hour >= CONFIG.ACTIVE_HOURS_START && hour <= CONFIG.ACTIVE_HOURS_END;
}

function fmtMoney_(n, currency) { return `${currency} ${Number(n).toFixed(2)}`; }
function pct_(n) { return (n * 100).toFixed(1) + '%'; }
function isFinite_(x) { return typeof x === 'number' && isFinite(x); }
