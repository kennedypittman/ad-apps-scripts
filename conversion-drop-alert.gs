/**
 * Conversion Drop Alert
 *
 * Compares yesterday's conversions to a trailing 7-day baseline
 * (the 7 days *before* yesterday, so it doesn't include yesterday
 * itself) and emails you if conversions dropped more than the
 * configured threshold.
 *
 * SETUP:
 * 1. Paste this into: Tools & Settings > Bulk Actions > Scripts > + (new script)
 * 2. Update EMAIL_RECIPIENT below.
 * 3. Run once manually to authorize (Google Ads will prompt for permissions).
 * 4. Schedule it: Scripts list > this script > Schedule > Daily, ideally
 *    mid-morning (e.g. 8-10am) to give conversion data time to settle.
 */

// ===== CONFIG =====
var THRESHOLD_PCT = 0.35;            // Alert if yesterday is 35%+ below the 7-day baseline
var MIN_BASELINE_CONVERSIONS = 3;    // Skip alerting if baseline avg/day is below this (avoids noise on naturally low-volume days)
var EMAIL_RECIPIENT = 'you@example.com'; // <-- CHANGE THIS
var ACCOUNT_LABEL = '';              // optional 

function main() {
  var account = AdsApp.currentAccount();
  var timeZone = account.getTimeZone();
  var today = new Date();

  // Yesterday's conversions
  var yesterdayStats = account.getStatsFor('YESTERDAY');
  var yesterdayConversions = yesterdayStats.getConversions();

  // Baseline window: 7 days, ending 2 days ago (keeps yesterday out of its own baseline)
  var baselineEnd = new Date(today);
  baselineEnd.setDate(baselineEnd.getDate() - 2);
  var baselineStart = new Date(today);
  baselineStart.setDate(baselineStart.getDate() - 8);

  var baselineRange = {
    min: Utilities.formatDate(baselineStart, timeZone, 'yyyyMMdd'),
    max: Utilities.formatDate(baselineEnd, timeZone, 'yyyyMMdd')
  };

  var baselineStats = account.getStatsFor(baselineRange);
  var baselineAvgConversions = baselineStats.getConversions() / 7;

  Logger.log('Yesterday conversions: ' + yesterdayConversions);
  Logger.log('Baseline avg/day (prior 7 days): ' + baselineAvgConversions.toFixed(2));

  // Guard against alerting on noise when volume is naturally very low
  if (baselineAvgConversions < MIN_BASELINE_CONVERSIONS) {
    Logger.log('Baseline below minimum threshold (' + MIN_BASELINE_CONVERSIONS + '); skipping check.');
    return;
  }

  var dropThresholdValue = baselineAvgConversions * (1 - THRESHOLD_PCT);

  if (yesterdayConversions < dropThresholdValue) {
    var pctChange = ((yesterdayConversions - baselineAvgConversions) / baselineAvgConversions) * 100;
    sendAlertEmail(account, yesterdayConversions, baselineAvgConversions, pctChange);
  } else {
    Logger.log('No alert needed — yesterday is within normal range.');
  }
}

function sendAlertEmail(account, yesterdayConversions, baselineAvg, pctChange) {
  var accountName = account.getName();
  var subject = '\u26A0\uFE0F Conversion Drop Alert' +
    (ACCOUNT_LABEL ? ' - ' + ACCOUNT_LABEL : '') +
    ' (' + accountName + ')';

  var body = 'Conversions dropped below normal for ' + accountName + '.\n\n' +
    'Yesterday: ' + yesterdayConversions.toFixed(2) + ' conversions\n' +
    '7-day baseline average: ' + baselineAvg.toFixed(2) + ' conversions/day\n' +
    'Change: ' + pctChange.toFixed(1) + '%\n' +
    'Alert threshold: ' + (THRESHOLD_PCT * 100) + '% drop\n\n' +
    'Account: ' + accountName + ' (' + account.getCustomerId() + ')';

  MailApp.sendEmail(EMAIL_RECIPIENT, subject, body);
  Logger.log('Alert email sent to ' + EMAIL_RECIPIENT);
}
