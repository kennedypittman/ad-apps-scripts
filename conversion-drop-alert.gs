/**
 * Conversion Drop Alert
 *
 * Compares yesterday's per-campaign performance to a trailing baseline
 * (CONFIG.BASELINE_DAYS days, ending 2 days ago so it doesn't include
 * yesterday itself) and emails you if either conversion volume drops
 * or cost-per-conversion rises beyond the configured thresholds.
 *
 * SETUP:
 * 1. Paste this into: Tools & Settings > Bulk Actions > Scripts > + (new script)
 * 2. Update CONFIG.EMAILS below (and CAMPAIGN_NAME_FILTER if needed).
 * 3. Run once manually to authorize (Google Ads will prompt for permissions).
 * 4. Schedule it: Scripts list > this script > Schedule > Daily, ideally
 *    mid-morning (e.g. 8-10am) to give conversion data time to settle.
 */

// ===== CONFIG =====
var CONFIG = {
  CAMPAIGN_NAME_FILTER: 'atmo',        // substring to match (case-insensitive). Leave '' to check ALL campaigns.
  INCLUDE_PAUSED_CAMPAIGNS: false,     // false = ENABLED campaigns only. true = ENABLED + PAUSED.
  BASELINE_DAYS: 7,                    // how many days to average for the "normal" baseline
  CONVERSION_DROP_THRESHOLD_PCT: 0.35, // alert if conversions drop this much vs the baseline
  CPA_INCREASE_THRESHOLD_PCT: 0.35,    // alert if cost-per-conversion rises this much vs the baseline
  MIN_BASELINE_CONVERSIONS: 3,         // skip a campaign if its baseline avg/day is below this (avoids noise on low-volume campaigns)
  EMAILS: ['you@example.com']          // <-- CHANGE THIS (add more addresses if needed)
};

function main() {
  var account = AdsApp.currentAccount();
  var timeZone = account.getTimeZone();
  var today = new Date();

  // Baseline window: CONFIG.BASELINE_DAYS days, ending 2 days ago (keeps yesterday out of its own baseline)
  var baselineEnd = new Date(today);
  baselineEnd.setDate(baselineEnd.getDate() - 2);
  var baselineStart = new Date(today);
  baselineStart.setDate(baselineStart.getDate() - (CONFIG.BASELINE_DAYS + 1));
  var baselineRange = {
    min: Utilities.formatDate(baselineStart, timeZone, 'yyyyMMdd'),
    max: Utilities.formatDate(baselineEnd, timeZone, 'yyyyMMdd')
  };

  var campaigns = getCampaignsToCheck_();
  var flagged = [];

  for (var i = 0; i < campaigns.length; i++) {
    var result = checkCampaign_(campaigns[i], baselineRange);
    if (result) flagged.push(result);
  }

  Logger.log('Checked ' + campaigns.length + ' campaign(s). Flagged: ' + flagged.length + '.');

  if (flagged.length > 0) {
    sendAlertEmail_(account, flagged);
  }
}

/** Build the list of campaigns to check, per CONFIG filters. */
function getCampaignsToCheck_() {
  var selector = AdsApp.campaigns();

  if (CONFIG.CAMPAIGN_NAME_FILTER) {
    var safeFilter = CONFIG.CAMPAIGN_NAME_FILTER.replace(/'/g, "\\'");
    selector = selector.withCondition("Name CONTAINS_IGNORE_CASE '" + safeFilter + "'");
  }

  selector = CONFIG.INCLUDE_PAUSED_CAMPAIGNS
    ? selector.withCondition('Status IN [ENABLED, PAUSED]')
    : selector.withCondition('Status = ENABLED');

  var out = [];
  var it = selector.get();
  while (it.hasNext()) out.push(it.next());
  return out;
}

/**
 * Compare one campaign's yesterday vs its own 7-day baseline on two independent signals:
 *  - conversion volume (raw conversions dropped)
 *  - efficiency (cost per conversion rose)
 * Either signal on its own is enough to flag the campaign.
 * Returns a flag object, or null if neither signal crossed its threshold.
 */
function checkCampaign_(campaign, baselineRange) {
  var yesterdayStats = campaign.getStatsFor('YESTERDAY');
  var yesterdayConversions = yesterdayStats.getConversions();
  var yesterdaySpend = yesterdayStats.getCost();

  var baselineStats = campaign.getStatsFor(baselineRange);
  var baselineAvgConversions = baselineStats.getConversions() / CONFIG.BASELINE_DAYS;
  var baselineAvgSpend = baselineStats.getCost() / CONFIG.BASELINE_DAYS;

  // Not enough volume to judge reliably
  if (baselineAvgConversions < CONFIG.MIN_BASELINE_CONVERSIONS) {
    return null;
  }

  var reasons = [];

  // Signal 1: raw conversion volume dropped
  var conversionDropPct = (baselineAvgConversions - yesterdayConversions) / baselineAvgConversions;
  if (conversionDropPct >= CONFIG.CONVERSION_DROP_THRESHOLD_PCT) {
    reasons.push('Conversion volume drop');
  }

  // Signal 2: cost per conversion rose (unit economics got worse), independent of volume
  var baselineCPA = baselineAvgSpend > 0 ? baselineAvgSpend / baselineAvgConversions : null;
  var cpaIncreasePct = null;

  if (baselineCPA) {
    if (yesterdayConversions > 0) {
      var yesterdayCPA = yesterdaySpend / yesterdayConversions;
      cpaIncreasePct = (yesterdayCPA - baselineCPA) / baselineCPA;
      if (cpaIncreasePct >= CONFIG.CPA_INCREASE_THRESHOLD_PCT) {
        reasons.push('CPA increase');
      }
    } else if (yesterdaySpend > 0) {
      // Spent money, got zero conversions — worst-case CPA, always worth flagging
      reasons.push('CPA increase (spend with zero conversions)');
    }
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    name: campaign.getName(),
    id: campaign.getId(),
    reasons: reasons,
    yesterdayConversions: yesterdayConversions,
    baselineAvgConversions: baselineAvgConversions,
    conversionDropPct: conversionDropPct * 100,
    yesterdaySpend: yesterdaySpend,
    baselineAvgSpend: baselineAvgSpend,
    baselineCPA: baselineCPA,
    cpaIncreasePct: cpaIncreasePct !== null ? cpaIncreasePct * 100 : null
  };
}

function sendAlertEmail_(account, flagged) {
  var accountName = account.getName();
  var subject = '\u26A0\uFE0F Conversion Alert (' + accountName + ') - ' +
    flagged.length + ' campaign' + (flagged.length > 1 ? 's' : '');

  var lines = ['The following campaign(s) in ' + accountName + ' crossed an alert threshold:', ''];

  flagged.forEach(function (f) {
    lines.push(f.name + ' (ID ' + f.id + ')');
    lines.push('  Triggered by: ' + f.reasons.join(', '));
    lines.push('  Yesterday: ' + f.yesterdayConversions.toFixed(2) + ' conversions, $' + f.yesterdaySpend.toFixed(2) + ' spend');
    lines.push('  ' + CONFIG.BASELINE_DAYS + '-day baseline: ' + f.baselineAvgConversions.toFixed(2) + ' conversions/day, $' + f.baselineAvgSpend.toFixed(2) + '/day spend');
    lines.push('  Conversion drop: ' + f.conversionDropPct.toFixed(1) + '%');
    if (f.baselineCPA) {
      lines.push('  Baseline CPA: $' + f.baselineCPA.toFixed(2));
      lines.push('  CPA change: ' + (f.cpaIncreasePct !== null ? f.cpaIncreasePct.toFixed(1) + '%' : 'n/a (zero conversions yesterday)'));
    }
    lines.push('');
  });

  MailApp.sendEmail(CONFIG.EMAILS.join(','), subject, lines.join('\n'));
  Logger.log('Alert email sent to ' + CONFIG.EMAILS.join(','));
}
