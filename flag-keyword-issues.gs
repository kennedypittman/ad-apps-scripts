/**
 * Google Ads Script — Keyword Performance Report
 *
 * Monthly-style report (no changes ever made to the account):
 *   1. Top N best-performing keywords, ranked by CPA or ROAS
 *   2. Bottom N worst-performing keywords, same ranking
 *   3. All zero-conversion keywords above a minimum spend, with their cost
 *
 * Set CFG.BREAK_OUT_BY_CAMPAIGN to true to get separate Top N / Bottom N
 * tables per campaign instead of one combined ranking across all of them.
 * The zero-conversion list always stays combined and sorted by spend —
 * that section is about surfacing the single biggest wasters first, which
 * splitting by campaign would work against.
 *
 */

const CFG = {
  CAMPAIGN_NAME_FILTER: '',      // '' = all campaigns. Or a substring like 'atmo' (case-insensitive) to scope to matching campaigns only.
  LOOKBACK_DAYS: 30,
  CONVERSION_LAG_BUFFER_DAYS: 3, // exclude the most recent N days so keywords that just haven't had time to convert yet aren't misjudged
  MIN_CONVERSIONS: 3,            // a keyword needs at least this many conversions to be eligible for the best/worst tables
  USE_ROAS: false,               // true = rank by ROAS (conversions_value / cost, higher is better). false = rank by CPA (cost / conversions, lower is better).
  MIN_SPEND: 20,                 // applies to the whole report — a keyword must have spent more than this (account currency) to appear anywhere below, including the zero-conversion list
  BREAK_OUT_BY_CAMPAIGN: false,  // false = one combined ranking across all matching campaigns. true = separate Top N / Bottom N per campaign.
  TOP_N: 5,                      // how many keywords in each best/worst table. Consider a smaller number (2-3) if BREAK_OUT_BY_CAMPAIGN is true and you have several campaigns — otherwise the email gets long.
  CHECK_PAUSED: false,           // false = ENABLED campaigns/ad groups/keywords only. true = also include PAUSED.
  EMAILS: ['your.email@email.com']
};

function main() {
  const account = AdsApp.currentAccount();
  const tz = account.getTimeZone();

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1 - CFG.CONVERSION_LAG_BUFFER_DAYS);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - CFG.LOOKBACK_DAYS - CFG.CONVERSION_LAG_BUFFER_DAYS);

  const startStr = Utilities.formatDate(startDate, tz, 'yyyy-MM-dd');
  const endStr = Utilities.formatDate(endDate, tz, 'yyyy-MM-dd');

  const allKeywords = fetchKeywordData_(buildQuery_(startStr, endStr));
  const nameFiltered = filterByCampaignName_(allKeywords);

  // MIN_SPEND applies to the whole report — everything below (best/worst
  // and zero-conversion alike) is drawn from this same spend-qualified pool.
  const keywords = nameFiltered.filter(function (k) { return k.cost > CFG.MIN_SPEND; });

  const zeroConv = keywords
    .filter(function (k) { return k.conversions === 0; })
    .sort(function (a, b) { return b.cost - a.cost; });

  if (CFG.BREAK_OUT_BY_CAMPAIGN) {
    const campaignGroups = groupByCampaign_(keywords).map(function (g) {
      const ranked = rankKeywords_(g.keywords);
      return {
        campaign: g.campaign,
        eligibleCount: ranked.eligible.length,
        best: ranked.best,
        worst: ranked.worst
      };
    });

    sendReportEmailByCampaign_(account, tz, startStr, endStr, campaignGroups, zeroConv);

    Logger.log('Campaigns in report: ' + campaignGroups.length +
      ' | Spend-qualified keywords: ' + keywords.length +
      ' | Zero-conversion: ' + zeroConv.length);
  } else {
    const ranked = rankKeywords_(keywords);

    sendReportEmail_(account, tz, startStr, endStr, ranked.eligible.length, ranked.best, ranked.worst, zeroConv);

    Logger.log('Spend-qualified keywords: ' + keywords.length +
      ' | Eligible for best/worst: ' + ranked.eligible.length +
      ' | Zero-conversion: ' + zeroConv.length);
  }
}

/** Filters to eligible keywords, computes each one's ranking metric, and returns sorted best/worst slices of size CFG.TOP_N. */
function rankKeywords_(keywords) {
  const eligible = keywords
    .filter(function (k) { return k.conversions >= CFG.MIN_CONVERSIONS; })
    .map(function (k) {
      k.metric = CFG.USE_ROAS ? (k.convValue / k.cost) : (k.cost / k.conversions);
      return k;
    });

  // Best-first ordering: for ROAS, higher metric = better; for CPA, lower metric = better.
  eligible.sort(function (a, b) {
    return CFG.USE_ROAS ? (b.metric - a.metric) : (a.metric - b.metric);
  });

  return {
    eligible: eligible,
    best: eligible.slice(0, CFG.TOP_N),
    worst: eligible.slice(-CFG.TOP_N).reverse()
  };
}

function groupByCampaign_(keywords) {
  const groups = {};
  keywords.forEach(function (k) {
    if (!groups[k.campaignId]) {
      groups[k.campaignId] = { campaignId: k.campaignId, campaign: k.campaign, keywords: [] };
    }
    groups[k.campaignId].keywords.push(k);
  });
  return Object.keys(groups)
    .map(function (id) { return groups[id]; })
    .sort(function (a, b) { return a.campaign.localeCompare(b.campaign); });
}

function statusCondition_(field) {
  return CFG.CHECK_PAUSED
    ? field + " IN ('ENABLED','PAUSED')"
    : field + " = 'ENABLED'";
}

function buildQuery_(startStr, endStr) {
  return "SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, " +
    "ad_group_criterion.keyword.match_type, campaign.id, campaign.name, ad_group.id, ad_group.name, " +
    "metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value " +
    "FROM keyword_view " +
    "WHERE segments.date BETWEEN '" + startStr + "' AND '" + endStr + "' " +
    "AND " + statusCondition_('campaign.status') + " " +
    "AND " + statusCondition_('ad_group.status') + " " +
    "AND " + statusCondition_('ad_group_criterion.status');
}

function fetchKeywordData_(query) {
  const data = [];
  const rows = AdsApp.report(query).rows();
  while (rows.hasNext()) {
    const row = rows.next();
    data.push({
      campaignId: row['campaign.id'],
      campaign: row['campaign.name'],
      adGroupId: row['ad_group.id'],
      adgroup: row['ad_group.name'],
      criterionId: row['ad_group_criterion.criterion_id'],
      text: row['ad_group_criterion.keyword.text'],
      matchType: row['ad_group_criterion.keyword.match_type'],
      cost: (parseFloat(row['metrics.cost_micros']) || 0) / 1000000,
      clicks: parseInt(row['metrics.clicks'], 10) || 0,
      conversions: parseFloat(row['metrics.conversions']) || 0,
      convValue: parseFloat(row['metrics.conversions_value']) || 0
    });
  }
  return data;
}

/** Case-insensitive substring match on campaign name. Blank filter = everything. */
function filterByCampaignName_(keywords) {
  const filter = CFG.CAMPAIGN_NAME_FILTER ? CFG.CAMPAIGN_NAME_FILTER.toLowerCase() : null;
  if (!filter) return keywords;
  return keywords.filter(function (k) {
    return k.campaign.toLowerCase().indexOf(filter) !== -1;
  });
}

function formatMoney_(currencyCode, amount) {
  return currencyCode + ' ' + amount.toFixed(2);
}

function formatMetric_(k, currencyCode) {
  return CFG.USE_ROAS ? (k.metric.toFixed(2) + 'x') : formatMoney_(currencyCode, k.metric);
}

function tableRow_(cells) {
  return '<tr>' + cells.map(function (c) {
    return '<td style="padding:6px 10px;border-bottom:1px solid #e2e2e2;">' + c + '</td>';
  }).join('') + '</tr>';
}

function tableHeader_(labels) {
  return '<tr>' + labels.map(function (l) {
    return '<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #999;background:#f5f5f5;">' + l + '</th>';
  }).join('') + '</tr>';
}

function buildPerformanceTable_(rows, currencyCode, includeCampaignColumn) {
  if (rows.length === 0) {
    return '<p style="color:#666;">No keywords met the MIN_CONVERSIONS floor (' + CFG.MIN_CONVERSIONS + ') for this window.</p>';
  }
  const metricLabel = CFG.USE_ROAS ? 'ROAS' : 'CPA';
  const headers = ['#', 'Keyword', 'Match'];
  if (includeCampaignColumn) headers.push('Campaign › Ad Group');
  else headers.push('Ad Group');
  headers.push('Conversions', 'Cost', metricLabel);

  let html = '<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">';
  html += tableHeader_(headers);
  rows.forEach(function (k, i) {
    const cells = [i + 1, escapeHtml_(k.text), k.matchType];
    cells.push(includeCampaignColumn ? (escapeHtml_(k.campaign) + ' › ' + escapeHtml_(k.adgroup)) : escapeHtml_(k.adgroup));
    cells.push(k.conversions.toFixed(2), formatMoney_(currencyCode, k.cost), formatMetric_(k, currencyCode));
    html += tableRow_(cells);
  });
  html += '</table>';
  return html;
}

function buildZeroConvTable_(rows, currencyCode) {
  if (rows.length === 0) {
    return '<p style="color:#666;">No zero-conversion keywords spent more than ' +
      formatMoney_(currencyCode, CFG.MIN_SPEND) + '.</p>';
  }
  const headers = ['#', 'Keyword', 'Match', 'Campaign › Ad Group', 'Clicks', 'Cost'];
  let html = '<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px;">';
  html += tableHeader_(headers);
  rows.forEach(function (k, i) {
    html += tableRow_([
      i + 1,
      escapeHtml_(k.text),
      k.matchType,
      escapeHtml_(k.campaign) + ' › ' + escapeHtml_(k.adgroup),
      k.clicks,
      formatMoney_(currencyCode, k.cost)
    ]);
  });
  html += '</table>';
  return html;
}

function escapeHtml_(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function emailHeader_(account, currencyCode, startStr, endStr, extraLine) {
  const modeLabel = CFG.USE_ROAS ? 'ROAS' : 'CPA';
  const filterLabel = CFG.CAMPAIGN_NAME_FILTER ? ('"' + CFG.CAMPAIGN_NAME_FILTER + '"') : 'all campaigns';

  let html = '<p><strong>Account:</strong> ' + account.getCustomerId() + ' - ' + escapeHtml_(account.getName()) + '<br>';
  html += '<strong>Window:</strong> ' + startStr + ' to ' + endStr + ' (' + CFG.LOOKBACK_DAYS + 'd, ' +
    CFG.CONVERSION_LAG_BUFFER_DAYS + 'd lag buffer)<br>';
  html += '<strong>Campaign filter:</strong> ' + filterLabel + '<br>';
  html += '<strong>Ranking by:</strong> ' + modeLabel + ' (min ' + CFG.MIN_CONVERSIONS + ' conversions to qualify)<br>';
  html += '<strong>Min spend to appear anywhere in this report:</strong> ' + formatMoney_(currencyCode, CFG.MIN_SPEND);
  if (extraLine) html += '<br>' + extraLine;
  html += '</p>';
  return html;
}

function sendReportEmail_(account, tz, startStr, endStr, eligibleCount, best, worst, zeroConv) {
  const currencyCode = account.getCurrencyCode();

  let html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">';
  html += emailHeader_(account, currencyCode, startStr, endStr, eligibleCount + ' keyword(s) eligible for best/worst');

  html += '<h3>Top ' + CFG.TOP_N + ' Best Performing Keywords</h3>';
  html += buildPerformanceTable_(best, currencyCode, true);

  html += '<h3 style="margin-top:24px;">Bottom ' + CFG.TOP_N + ' Worst Performing Keywords</h3>';
  html += buildPerformanceTable_(worst, currencyCode, true);

  html += '<h3 style="margin-top:24px;">Zero-Conversion Keywords (spent over ' +
    formatMoney_(currencyCode, CFG.MIN_SPEND) + ')</h3>';
  html += buildZeroConvTable_(zeroConv, currencyCode);

  html += '</div>';

  sendHtmlEmail_(account, tz, html);
}

function sendReportEmailByCampaign_(account, tz, startStr, endStr, campaignGroups, zeroConv) {
  const currencyCode = account.getCurrencyCode();

  let html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">';
  html += emailHeader_(account, currencyCode, startStr, endStr, campaignGroups.length + ' campaign(s) in this report');

  campaignGroups.forEach(function (g) {
    html += '<h2 style="margin-top:28px;border-top:2px solid #333;padding-top:12px;">' + escapeHtml_(g.campaign) + '</h2>';
    html += '<p style="color:#666;margin:4px 0;">' + g.eligibleCount + ' keyword(s) eligible for best/worst</p>';

    html += '<h3>Top ' + CFG.TOP_N + ' Best Performing Keywords</h3>';
    html += buildPerformanceTable_(g.best, currencyCode, false);

    html += '<h3 style="margin-top:16px;">Bottom ' + CFG.TOP_N + ' Worst Performing Keywords</h3>';
    html += buildPerformanceTable_(g.worst, currencyCode, false);
  });

  html += '<h2 style="margin-top:28px;border-top:2px solid #333;padding-top:12px;">Zero-Conversion Keywords (all campaigns, spent over ' +
    formatMoney_(currencyCode, CFG.MIN_SPEND) + ')</h2>';
  html += buildZeroConvTable_(zeroConv, currencyCode);

  html += '</div>';

  sendHtmlEmail_(account, tz, html);
}

function sendHtmlEmail_(account, tz, html) {
  const subject = 'Keyword Performance Report - ' + account.getName() + ' - ' +
    Utilities.formatDate(new Date(), tz, 'MMM d, yyyy');
  const plainFallback = 'This report contains HTML tables. Please view it in an HTML-capable email client.';

  MailApp.sendEmail(CFG.EMAILS.join(','), subject, plainFallback, { htmlBody: html });
  Logger.log('Report sent to ' + CFG.EMAILS.join(','));
}
