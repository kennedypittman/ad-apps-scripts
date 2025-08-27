/**
 * Google Ads Script: Account-level Monthly Budget Pacing Alert
 * Monitors THIS_MONTH cost for the entire account and sends email alerts.
 * Optional: pause all campaigns at 100% of budget.
 *
 * Setup:
 * - Replace MONTHLY_BUDGET with your monthly cap (in account currency).
 * - Add your email(s).
 * - Schedule to run.
 */
const CONFIG = {
  MONTHLY_BUDGET: 20000,    // your budget
  WARN_AHEAD_PCT: 0.15,     // enter ahead at +15%
  WARN_BEHIND_PCT: 0.15,    // enter behind at -15%
  EXIT_AHEAD_PCT: 0.08,     // exit ahead when within +8%
  EXIT_BEHIND_PCT: 0.08,    // exit behind when within -8%
  WARN_AT_PCT: 0.90,
  CRITICAL_AT_PCT: 0.98,
  PAUSE_AT_100: false,
  EMAILS: ['you@yourdomain.com'],

  // Anti-spam controls
  COOLDOWN_HOURS: 12,             // snooze window after an alert
  MIN_PCT_WORSEN_TO_REALERT: 0.05,// +5 percentage points worse to re-alert
  SEND_DAILY_SUMMARY: true,
  DAILY_SUMMARY_HOUR: 9,          // 0-23, in account time zone

  // Optional: only run alerts during these hours (inclusive)
  ACTIVE_HOURS_START: 8,
  ACTIVE_HOURS_END: 20
};

/**
 * Add these helpers anywhere in your script (e.g., above main()).
 */
function getState_() {
  const p = PropertiesService.getScriptProperties();
  const raw = p.getProperty('BUDGET_ALERT_STATE');
  return raw ? JSON.parse(raw) : {
    lastSeverity: 'OK',           // OK | AHEAD | BEHIND | NEAR | CRITICAL | CAP
    lastDeviationPct: 0,          // abs(delta/expected) at last alert
    cooldownUntil: 0,             // epoch ms
    lastSummaryDay: ''            // 'yyyy-MM-dd'
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
function todayStr_(tz) {
  const now = new Date();
  return Utilities.formatDate(now, tz, 'yyyy-MM-dd');
}

/**
 * Replace your main() body with this upgraded logic,
 * or integrate the "state/shouldAlert" parts into your existing main().
 */
function main() {
  const account = AdsApp.currentAccount();
  const tz = account.getTimeZone();
  const currency = account.getCurrencyCode();
  const now = new Date();
  const hour = parseInt(Utilities.formatDate(now, tz, 'H'), 10);

  // Respect business hours for *alerts* (still OK to log outside these)
  const inHours = withinBusinessHours_(tz);

  // Month math
  const year = parseInt(Utilities.formatDate(now, tz, 'yyyy'), 10);
  const month = parseInt(Utilities.formatDate(now, tz, 'M'), 10);
  const dayOfMonth = parseInt(Utilities.formatDate(now, tz, 'd'), 10);
  const daysInMonth = new Date(year, month, 0).getDate();
  const expectedByToday = (CONFIG.MONTHLY_BUDGET / daysInMonth) * dayOfMonth;

  // MTD cost
  const stats = account.getStatsFor('THIS_MONTH');
  const costMTD = stats.getCost();
  const pctOfBudget = costMTD / CONFIG.MONTHLY_BUDGET;
  const delta = costMTD - expectedByToday; // + = ahead, - = behind
  const deviationPct = expectedByToday > 0 ? Math.abs(delta / expectedByToday) : 0;

  // Hysteresis: determine severity using enter/exit thresholds
  // Start with OK
  let severity = 'OK';

  // Ahead/behind vs expected, using separate enter/exit bands
  if (expectedByToday > 0) {
    if (delta > expectedByToday * CONFIG.WARN_AHEAD_PCT) severity = 'AHEAD';
    if (delta < -expectedByToday * CONFIG.WARN_BEHIND_PCT) severity = 'BEHIND';

    // Exit conditions: if previously AHEAD/BEHIND but we moved back within tighter band, treat as OK
    // We'll check previous state below to avoid flicker.
  }

  // Near/critical/cap based on pct of budget (these can override)
  if (pctOfBudget >= CONFIG.WARN_AT_PCT && pctOfBudget < CONFIG.CRITICAL_AT_PCT) severity = 'NEAR';
  if (pctOfBudget >= CONFIG.CRITICAL_AT_PCT && pctOfBudget < 1) severity = 'CRITICAL';
  if (pctOfBudget >= 1) severity = 'CAP';

  // Apply hysteresis exit if previous state was AHEAD/BEHIND
  const state = getState_();
  if (state.lastSeverity === 'AHEAD' &&
      (delta <= expectedByToday * CONFIG.EXIT_AHEAD_PCT) &&
      severity === 'AHEAD') {
    severity = 'OK';
  }
  if (state.lastSeverity === 'BEHIND' &&
      (delta >= -expectedByToday * CONFIG.EXIT_BEHIND_PCT) &&
      severity === 'BEHIND') {
    severity = 'OK';
  }

  // Decide if we should alert now
  const nowMs = now.getTime();
  const outOfCooldown = nowMs >= (state.cooldownUntil || 0);
  const severityChanged = severity !== state.lastSeverity;
  const worsenedEnough = (deviationPct - (state.lastDeviationPct || 0)) >= CONFIG.MIN_PCT_WORSEN_TO_REALERT;

  let shouldAlert = false;
  if (severity === 'OK') {
    // Only alert when we *return to OK* from a non-OK state
    if (severityChanged && state.lastSeverity !== 'OK') shouldAlert = true;
  } else {
    // Non-OK states must either be new, worsened enough, or out of cooldown
    if (severityChanged || worsenedEnough || outOfCooldown) shouldAlert = true;
  }

  // Daily summary (one email per day at DAILY_SUMMARY_HOUR)
  const isSummaryTime = CONFIG.SEND_DAILY_SUMMARY &&
                        (hour === CONFIG.DAILY_SUMMARY_HOUR) &&
                        (todayStr_(tz) !== state.lastSummaryDay);

  const lines = [
    `Account: ${account.getCustomerId()} – ${account.getName()}`,
    `Time zone: ${tz} | Currency: ${currency}`,
    `Budget (month): ${currency} ${CONFIG.MONTHLY_BUDGET.toFixed(2)}`,
    `Day: ${dayOfMonth}/${daysInMonth}`,
    `Spend MTD: ${currency} ${costMTD.toFixed(2)}`,
    `Expected by today: ${currency} ${expectedByToday.toFixed(2)}`,
    `Delta: ${delta >= 0 ? '+' : ''}${currency} ${delta.toFixed(2)} (${expectedByToday > 0 ? ((delta/expectedByToday)*100).toFixed(1) : '0'}%)`,
    `Budget used: ${(pctOfBudget*100).toFixed(1)}%`,
    `State: ${severity}`
  ];

  // Send alerts (respect business hours for alerts; still allow CAP pause logic any time)
  if (shouldAlert && inHours) {
    MailApp.sendEmail(
      CONFIG.EMAILS.join(','),
      `Google Ads Budget Alert – ${severity} – ${Utilities.formatDate(now, tz, 'MMM d, HH:mm')}`,
      lines.join('\n')
    );
    // Start a cooldown
    state.cooldownUntil = nowMs + CONFIG.COOLDOWN_HOURS * 3600 * 1000;
    state.lastDeviationPct = deviationPct;
    state.lastSeverity = severity;
    setState_(state);
  }

  // Daily summary (sent once per day regardless of state; also respects business hours indirectly by time)
  if (isSummaryTime) {
    MailApp.sendEmail(
      CONFIG.EMAILS.join(','),
      `Google Ads Budget Summary – ${Utilities.formatDate(now, tz, 'MMM d')}`,
      lines.join('\n')
    );
    state.lastSummaryDay = todayStr_(tz);
    setState_(state);
  }

  // Optional: auto-pause when budget hit (do this even outside business hours)
  if (pctOfBudget >= 1 && CONFIG.PAUSE_AT_100) {
    pauseAllCampaigns_();
  }

  Logger.log(lines.join(' | '));
}
