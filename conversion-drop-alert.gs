/**
 * Conversion Drop Alert
 *
 * Compares yesterday's per-campaign performance to a trailing baseline
 * (CONFIG.BASELINE_DAYS days, ending 2 days ago so it doesn't include
 * yesterday itself) and emails you if either conversion volume drops
 * or cost-per-conversion rises beyond the configured thresholds.
 *
 * NOISE CONTROL: single-day comparisons are naturally volatile. To avoid
 * emailing on every one-day blip, a campaign must cross the threshold on
 * CONFIG.CONSECUTIVE_DAYS_REQUIRED consecutive runs before it's actually
 * included in the email. Set that to 1 to alert immediately, same as
 * before. This uses PropertiesService to remember streaks between runs,
 * so it only works correctly if the script runs once per day on schedule.
 *
 * SETUP:
 * 1. Paste this into: Tools & Settings > Bulk Actions > Scripts > + (new script)
 * 2. Update CONFIG.EMAILS below (and CAMPAIGN_NAME_FILTER if needed).
 * 3. Run once manually to authorize (Google Ads will prompt for permissions).
 * 4. Schedule it: Scripts list > this script > Schedule > Daily, ideally
 *    mid-morning (e.g. 8-10am) to give conversion data time to settle.
 *
 * NOTE: if you raise CONSECUTIVE_DAYS_REQUIRED above 1, an issue that's
 * already ongoing won't email you until it's been flagged that many runs
 * in a row (e.g. with a value of 2, you'll see it on the 2nd day, not the 1st).
 */

// ===== CONFIG =====
var CONFIG = {
  CAMPAIGN_NAME_FILTER: 'atmo',        // substring to match (case-insensitive). Leave '' to check ALL campaigns.
  INCLUDE_PAUSED_CAMPAIGNS: false,     // false = ENABLED campaigns only. true = ENABLED + PAUSED.
  BASELINE_DAYS: 7,                    // how many days to average for the "normal" baseline
  CONVERSION_DROP_THRESHOLD_PCT: 0.35, // alert if conversions drop this much vs the baseline
  CPA_INCREASE_THRESHOLD_PCT: 0.35,    // alert if cost-per-conversion rises this much vs the baseline
  MIN_BASELINE_CONVERSIONS: 15,        // skip a campaign if its baseline avg/day is below this (avoids noise on low-volume campaigns)
  CONSECUTIVE_DAYS_REQUIRED: 2,        // require a campaign to cross the threshold this many days in a row before emailing. 1 = alert immediately (old behavior).
  EMAILS: ['your.email@email.com']          // <-- CHANGE THIS (add more addresses if needed)
};

function main() {
  var account = AdsApp.currentAccount();
  var timeZone = account.getTimeZone();
  var today = new Date();

  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  var yesterdayStr = Utilities.formatDate(yesterday, timeZone, 'yyyy-MM-dd');

  var rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - (CONFIG.BASELINE_DAYS + 1));
  var rangeStartStr = Utilities.formatDate(rangeStart, timeZone, 'yyyy-MM-dd');

  var query = buildQuery_(rangeStartStr, yesterdayStr);
  var campaignData = fetchCampaignData_(query, yesterdayStr);

  var candidates = [];
  for (var campaignId in campaignData) {
    var result = checkCampaign_(campaignData[campaignId]);
    if (result) candidates.push(result);
  }

  var flagged = applyConsecutiveDayFilter_(candidates, yesterdayStr);

  Logger.log('Checked ' + Object.keys(campaignData).length + ' campaign(s). Candidates: ' +
    candidates.length + '. Alerting on: ' + flagged.length + '.');

  if (flagged.length > 0) {
    sendAlertEmail_(account, flagged);
  }
}

/** Build the GAQL query covering the full lookback window (baseline days + yesterday). */
function buildQuery_(rangeStartStr, yesterdayStr) {
  var query = "SELECT campaign.id, campaign.name, segments.date, metrics.conversions, metrics.cost_micros " +
    "FROM campaign " +
    "WHERE segments.date BETWEEN '" + rangeStartStr + "' AND '" + yesterdayStr + "'";

  query += CONFIG.INCLUDE_PAUSED_CAMPAIGNS
    ? " AND campaign.status IN ('ENABLED', 'PAUSED')"
    : " AND campaign.status = 'ENABLED'";

  return query;
}

/**
 * Run the report and bucket each row into per-campaign totals:
 * yesterday's numbers vs. the sum of everything else in the window (the baseline).
 * Campaign name filtering happens here (case-insensitive), not in GAQL.
 */
function fetchCampaignData_(query, yesterdayStr) {
  var data = {};
  var nameFilter = CONFIG.CAMPAIGN_NAME_FILTER ? CONFIG.CAMPAIGN_NAME_FILTER.toLowerCase() : null;
  var rows = AdsApp.report(query).rows();

  while (rows.hasNext()) {
    var row = rows.next();
    var name = row['campaign.name'];

    if (nameFilter && name.toLowerCase().indexOf(nameFilter) === -1) {
      continue;
    }

    var campaignId = row['campaign.id'];
    var date = row['segments.date'];
    var conversions = parseFloat(row['metrics.conversions']) || 0;
    var cost = (parseFloat(row['metrics.cost_micros']) || 0) / 1000000;

    if (!data[campaignId]) {
      data[campaignId] = {
        id: campaignId,
        name: name,
        yesterdayConversions: 0,
        yesterdaySpend: 0,
        baselineConversions: 0,
        baselineSpend: 0
      };
    }

    var entry = data[campaignId];
    if (date === yesterdayStr) {
      entry.yesterdayConversions += conversions;
      entry.yesterdaySpend += cost;
    } else {
      entry.baselineConversions += conversions;
      entry.baselineSpend += cost;
    }
  }

  return data;
}

/**
 * Check one campaign's yesterday vs its own baseline on two independent signals:
 *  - conversion volume (raw conversions dropped)
 *  - efficiency (cost per conversion rose)
 * Either signal on its own is enough to flag the campaign.
 * Returns a flag object (a "candidate" — still subject to the consecutive-day
 * filter in applyConsecutiveDayFilter_), or null if neither signal crossed
 * its threshold.
 */
function checkCampaign_(entry) {
  var yesterdayConversions = entry.yesterdayConversions;
  var yesterdaySpend = entry.yesterdaySpend;
  var baselineAvgConversions = entry.baselineConversions / CONFIG.BASELINE_DAYS;
  var baselineAvgSpend = entry.baselineSpend / CONFIG.BASELINE_DAYS;
  var yesterdayCPA = yesterdayConversions > 0 ? yesterdaySpend / yesterdayConversions : null;
  var baselineCPA = (baselineAvgConversions > 0 && baselineAvgSpend > 0)
    ? baselineAvgSpend / baselineAvgConversions
    : null;

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
  var cpaIncreasePct = null;
  if (baselineCPA) {
    if (yesterdayConversions > 0) {
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
    id: entry.id,
    name: entry.name,
    reasons: reasons,
    yesterdayConversions: yesterdayConversions,
    baselineAvgConversions: baselineAvgConversions,
    conversionDropPct: conversionDropPct * 100,
    yesterdaySpend: yesterdaySpend,
    baselineAvgSpend: baselineAvgSpend,
    yesterdayCPA: yesterdayCPA,
    baselineCPA: baselineCPA,
    cpaIncreasePct: cpaIncreasePct !== null ? cpaIncreasePct * 100 : null
  };
}

/**
 * Only let a candidate through to the email once it's crossed the threshold
 * on CONFIG.CONSECUTIVE_DAYS_REQUIRED consecutive daily runs. Streak state is
 * stored in Script Properties, keyed by campaign ID, and reset for any
 * campaign that isn't a candidate today (or whose last flagged day wasn't
 * literally the day before yesterday — e.g. the script missed a scheduled run).
 */
function applyConsecutiveDayFilter_(candidates, yesterdayStr) {
  if (CONFIG.CONSECUTIVE_DAYS_REQUIRED <= 1) {
    return candidates;
  }

  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('flagTracking');
  var tracking = stored ? JSON.parse(stored) : {};

  var newTracking = {};
  var toAlert = [];

  candidates.forEach(function (c) {
    var prev = tracking[c.id];
    var streak = 1;
    if (prev && isDayBefore_(prev.lastFlaggedDate, yesterdayStr)) {
      streak = prev.streak + 1;
    }
    newTracking[c.id] = { streak: streak, lastFlaggedDate: yesterdayStr };
    c.streak = streak;
    if (streak >= CONFIG.CONSECUTIVE_DAYS_REQUIRED) {
      toAlert.push(c);
    }
  });

  props.setProperty('flagTracking', JSON.stringify(newTracking));
  return toAlert;
}

/** True if dateStr is exactly one calendar day before referenceDateStr (both 'yyyy-MM-dd'). */
function isDayBefore_(dateStr, referenceDateStr) {
  var d = new Date(dateStr + 'T00:00:00');
  var ref = new Date(referenceDateStr + 'T00:00:00');
  var diffDays = Math.round((ref - d) / 86400000);
  return diffDays === 1;
}

function sendAlertEmail_(account, flagged) {
  var accountName = account.getName();
  var subject = '\u26A0\uFE0F Conversion Alert (' + accountName + ') - ' +
    flagged.length + ' campaign' + (flagged.length > 1 ? 's' : '');

  var lines = ['The following campaign(s) in ' + accountName + ' crossed an alert threshold:', ''];

  flagged.forEach(function (f) {
    lines.push(f.name + ' (ID ' + f.id + ')');
    lines.push('  Triggered by: ' + f.reasons.join(', '));
    if (CONFIG.CONSECUTIVE_DAYS_REQUIRED > 1) {
      lines.push('  Flagged for: ' + f.streak + ' consecutive day(s)');
    }
    lines.push('  Conversions — yesterday: ' + f.yesterdayConversions.toFixed(2) +
      ' | baseline: ' + f.baselineAvgConversions.toFixed(2) + '/day (' + f.conversionDropPct.toFixed(1) + '% drop)');
    lines.push('  Spend — yesterday: $' + f.yesterdaySpend.toFixed(2) +
      ' | baseline: $' + f.baselineAvgSpend.toFixed(2) + '/day');
    lines.push('  CPA — yesterday: ' + (f.yesterdayCPA !== null ? '$' + f.yesterdayCPA.toFixed(2) : 'n/a (zero conversions)') +
      ' | baseline: ' + (f.baselineCPA !== null ? '$' + f.baselineCPA.toFixed(2) : 'n/a') +
      (f.cpaIncreasePct !== null ? ' (' + (f.cpaIncreasePct >= 0 ? '+' : '') + f.cpaIncreasePct.toFixed(1) + '%)' : ''));
    lines.push('');
  });

  MailApp.sendEmail(CONFIG.EMAILS.join(','), subject, lines.join('\n'));
  Logger.log('Alert email sent to ' + CONFIG.EMAILS.join(','));
}
