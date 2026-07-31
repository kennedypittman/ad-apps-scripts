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

  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  var yesterdayStr = Utilities.formatDate(yesterday, timeZone, 'yyyy-MM-dd');

  var rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - (CONFIG.BASELINE_DAYS + 1));
  var rangeStartStr = Utilities.formatDate(rangeStart, timeZone, 'yyyy-MM-dd');

  var query = buildQuery_(rangeStartStr, yesterdayStr);
  var campaignData = fetchCampaignData_(query, yesterdayStr);

  var flagged = [];
  for (var campaignId in campaignData) {
    var result = checkCampaign_(campaignData[campaignId]);
    if (result) flagged.push(result);
  }

  Logger.log('Checked ' + Object.keys(campaignData).length + ' campaign(s). Flagged: ' + flagged.length + '.');

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
 * Returns a flag object, or null if neither signal crossed its threshold.
 */
function checkCampaign_(entry) {
  var yesterdayConversions = entry.yesterdayConversions;
  var yesterdaySpend = entry.yesterdaySpend;
  var baselineAvgConversions = entry.baselineConversions / CONFIG.BASELINE_DAYS;
  var baselineAvgSpend = entry.baselineSpend / CONFIG.BASELINE_DAYS;

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
    name: entry.name,
    id: entry.id,
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
