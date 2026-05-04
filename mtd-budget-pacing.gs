/**
 * Google Ads Script — Account-level Budget Pacing (Monthly OR Daily)
 * - Enter either MONTHLY_BUDGET or DAILY_BUDGET (you can enter both; see logic).
 * - Expected-by-today comes from DAILY if provided, else from MONTHLY / daysInMonth.
 * - Monthly cap is MONTHLY if provided; else DAILY * daysInMonth.
 * - Anti-spam cooldown + hysteresis + optional PAUSE_AT_100 included.
 * - WEEKDAYS ONLY: Script exits if run on Saturday or Sunday
 * - COMPLETED DAYS: Uses yesterday's date for calculations to avoid mid-day skew
 * - CAMPAIGN FILTER: If set, only campaigns whose name contains this string are counted
 *
 * Setup:
 *   Tools & Settings → Bulk actions → Scripts → + → paste, Save, Authorize, Preview, Run once.
 *   On the Scripts list page, set Frequency (e.g., hourly 8–20).
 */

const CONFIG = {
  // === Fill ONE of these (or both). Leave the other as null. ===
  MONTHLY_BUDGET: 15000,   // e.g., 20000  (account currency); leave null to derive from daily
  DAILY_BUDGET: null,      // e.g., 600; leave null if you only use monthly

  // Optional: only count campaigns whose name contains this string (case-insensitive).
  // Set to null to count ALL campaigns in the account.
  // Example: 'Atmo' will match "Atmo_Brand", "Search_Atmo", "atmo_remarketing", etc.
  CAMPAIGN_FILTER: null,

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
  EMAILS: ['your_emails@here.com'],      // recipients

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

  // Exit if weekend
  const dayOfWeek = parseInt(Utilities.formatDate(now, tz, 'u'), 10); // 1=Mon, 7=Sun
  if (dayOfWeek === 6 || dayOfWeek === 7) {
    Logger.log('Weekend detected. Skipping script execution.');
    return;
  }

  // Use completed days only (yesterday's date for calculations)
  const year = parseInt(Utilities.formatDate(now, tz, 'yyyy'), 10);
  const month = parseInt(Utilities.formatDate(now, tz, 'M'), 10); // 1..12
  const todayNum = parseInt(Utilities.formatDate(now, tz, 'd'), 10);
  const dayOfMonth = todayNum - 1; // completed days = today minus 1
  const daysInMonth = new Date(year, month, 0).getDate();

  // Determine effective monthly cap and expected spend by yesterday
  const monthlyCap = deriveMonthlyCap_(daysInMonth);
  if (!isFinite_(monthlyCap) || monthlyCap <= 0) {
    throw new Error('You must set either CONFIG.MONTHLY_BUDGET or CONFIG.DAILY_BUDGET to a positive number.');
  }
  const expectedByToday = deriveExpectedByToday_(dayOfMonth, daysInMonth);

  // Account MTD spend — filtered by CAMPAIGN_FILTER if set, else full account
  const costMTD = getCostMTD_();

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
    if (severityChanged && state.lastSeverity !== 'OK') shouldAlert = true;
  } else {
    if (severityChanged || worsenedEnough || outOfCooldown) shouldAlert = true;
  }

  // Build lines for email/log
  const filterNote = CONFIG.CAMPAIGN_FILTER ? `Campaigns matching: "${CONFIG.CAMPAIGN_FILTER}"` : 'Campaigns: ALL';
  const lines = [
    `Account: ${account.getCustomerId()} – ${account.getName()}`,
    `Time zone: ${tz} | Currency: ${currency}`,
    filterNote,
    `Month days: ${daysInMonth} | Completed days: ${dayOfMonth}/${daysInMonth}`,
    `Monthly cap: ${fmtMoney_(monthlyCap, currency)}`,
    `Daily budget (if set): ${isFinite_(CONFIG.DAILY_BUDGET) ? fmtMoney_(CONFIG.DAILY_BUDGET, currency) : '—'}`,
    `Spend MTD: ${fmtMoney_(costMTD, currency)}`,
    `Expected through day ${dayOfMonth}: ${fmtMoney_((expectedByToday), currency)}`,
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
    state.cooldownUntil = nowMs + CONFIG.COOLDOWN_HOURS * 3600 * 1000;
    state.lastDeviationPct = deviationPct;
    state.lastSeverity = severity;
    setState_(state);
  }

  // Optional: daily summary
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

  // Optional: pause all matching campaigns at/above 100% monthly cap
  if (pctOfBudget >= 1 && CONFIG.PAUSE_AT_100) {
    pauseAllCampaigns_();
  }

  Logger.log(lines.join(' | '));
}

/* ======= Helpers ======= */

/** Returns MTD cost, filtered to campaigns matching CAMPAIGN_FILTER if set. */
function getCostMTD_() {
  if (!CONFIG.CAMPAIGN_FILTER) {
    // No filter — use fast account-level stats
    return AdsApp.currentAccount().getStatsFor('THIS_MONTH').getCost();
  }

  // Filter is set — sum spend only from matching campaigns
  const filter = CONFIG.CAMPAIGN_FILTER.toLowerCase();
  let total = 0;
  const it = AdsApp.campaigns().get();
  while (it.hasNext()) {
    const campaign = it.next();
    if (campaign.getName().toLowerCase().indexOf(filter) !== -1) {
      total += campaign.getStatsFor('THIS_MONTH').getCost();
    }
  }
  return total;
}

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
  const monthly = deriveMonthlyCap_(daysInMonth);
  return (monthly / daysInMonth) * dayOfMonth;
}

function classifySeverity_(pctOfBudget, expectedByToday, delta) {
  let sev = 'OK';
  if (expectedByToday > 0) {
    if (delta > expectedByToday * CONFIG.WARN_AHEAD_PCT) sev = 'AHEAD';
    if (delta < -expectedByToday * CONFIG.WARN_BEHIND_PCT) sev = 'BEHIND';
  }
  if (pctOfBudget >= CONFIG.WARN_AT_PCT && pctOfBudget < CONFIG.CRITICAL_AT_PCT) sev = 'NEAR';
  if (pctOfBudget >= CONFIG.CRITICAL_AT_PCT && pctOfBudget < 1) sev = 'CRITICAL';
  if (pctOfBudget >= 1) sev = 'CAP';
  return sev;
}

function pauseAllCampaigns_() {
  const filter = CONFIG.CAMPAIGN_FILTER ? CONFIG.CAMPAIGN_FILTER.toLowerCase() : null;
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
    while (it.hasNext()) {
      const campaign = it.next();
      if (!filter || campaign.getName().toLowerCase().indexOf(filter) !== -1) {
        campaign.pause();
      }
    }
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
