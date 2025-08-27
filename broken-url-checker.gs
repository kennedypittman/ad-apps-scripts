/**
 * Google Ads Script — Broken URL Checker (Ads + Keywords)
 * 
 * SETUP:
 * 1) Tools & Settings → Bulk actions → Scripts → +
 * 2) Paste this script, Save, Authorize, Preview, then Run once.
 * 3) Click the clock icon on the Scripts page to Schedule (e.g., daily).
 */

const CONFIG = {
  EMAILS: ['you@yourdomain.com'],   // ← where to send alerts
  CHECK_PAUSED: false,               // include paused ads/keywords? usually false
  MAX_URLS_PER_RUN: 1000,            // 0 = no limit; keep sane to avoid quotas
  CONSIDER_403_AS_FAIL: true,        // 403 often means blocked = treat as broken
  COOLDOWN_HOURS: 24,                // wait this long before emailing again
  PAUSE_ADS_ON_FAILURE: false,       // set true to auto-pause ads with broken URLs
  USER_AGENT: 'Google-Ads-Script-URLChecker/1.1',
  TIMEOUT_MS: 15000,                 // soft timeout via Utilities.sleep guard
  // If your tracking templates add parameters with {ignore}, we strip it.
};

function main() {
  const acct = AdsApp.currentAccount();
  const tz = acct.getTimeZone();
  const now = new Date();
  const props = PropertiesService.getScriptProperties();
  const cooldownUntil = parseInt(props.getProperty('URLCHECK_COOLDOWN_UNTIL') || '0', 10);
  const nowMs = now.getTime();

  const entities = collectEntities_();
  const unique = buildUniqueUrlList_(entities);

  const sample = CONFIG.MAX_URLS_PER_RUN > 0 
    ? unique.slice(0, CONFIG.MAX_URLS_PER_RUN) 
    : unique;

  const failures = [];
  for (let i = 0; i < sample.length; i++) {
    const item = sample[i];
    const res = checkUrl_(item.resolvedUrl);
    if (!res.ok) {
      failures.push({
        status: res.status,
        reason: res.reason,
        url: item.resolvedUrl,
        rawFinal: item.finalUrl,
        entityType: item.entityType,
        campaign: item.campaign,
        adGroup: item.adGroup,
        adId: item.adId || '',
        keywordText: item.keywordText || ''
      });
      if (CONFIG.PAUSE_ADS_ON_FAILURE && item.entityType === 'AD') {
        try { item.ad.pause(); } catch (e) {}
      }
    }
  }

  // Email only if failures AND we're out of cooldown
  if (failures.length > 0 && nowMs >= cooldownUntil) {
    sendEmail_(failures, tz);
    const next = nowMs + CONFIG.COOLDOWN_HOURS * 3600 * 1000;
    props.setProperty('URLCHECK_COOLDOWN_UNTIL', String(next));
  }

  Logger.log(`Checked ${sample.length} URLs (unique of ${unique.length}). Failures: ${failures.length}.`);
}

/** Gather enabled Ads and Keywords (optionally paused) with their URL settings. */
function collectEntities_() {
  const statusCond = CONFIG.CHECK_PAUSED ? "IN [ENABLED, PAUSED]" : "= ENABLED";
  const ents = [];

  // Ads
  let adIt = AdsApp.ads()
    .withCondition(`Status ${statusCond}`)
    .withCondition(`AdGroupStatus ${statusCond}`)
    .withCondition(`CampaignStatus ${statusCond}`)
    .get();

  while (adIt.hasNext()) {
    const ad = adIt.next();
    const u = ad.urls();
    const finalUrl = safeCall_(() => u.getFinalUrl());
    const mobileUrl = safeCall_(() => u.getMobileFinalUrl && u.getMobileFinalUrl());
    const suffix = safeCall_(() => u.getFinalUrlSuffix && u.getFinalUrlSuffix());
    const tmpl = safeCall_(() => u.getTrackingTemplate && u.getTrackingTemplate());

    const ag = ad.getAdGroup();
    const cg = ag.getCampaign();

    pushUrlEnt_(ents, 'AD', finalUrl, tmpl, suffix, {
      ad, adId: String(ad.getId()),
      adGroup: ag.getName(),
      campaign: cg.getName()
    });
    if (mobileUrl && mobileUrl !== finalUrl) {
      pushUrlEnt_(ents, 'AD', mobileUrl, tmpl, suffix, {
        ad, adId: String(ad.getId()),
        adGroup: ag.getName(),
        campaign: ag.getCampaign().getName()
      });
    }
  }

  // Keywords (only those with their own final URL overrides)
  let kwIt = AdsApp.keywords()
    .withCondition(`Status ${statusCond}`)
    .withCondition(`AdGroupStatus ${statusCond}`)
    .withCondition(`CampaignStatus ${statusCond}`)
    .get();

  while (kwIt.hasNext()) {
    const kw = kwIt.next();
    const u = kw.urls();
    const finalUrl = safeCall_(() => u.getFinalUrl());
    if (!finalUrl) continue; // most keywords inherit ad URL; skip to avoid duplicates
    const suffix = safeCall_(() => u.getFinalUrlSuffix && u.getFinalUrlSuffix());
    const tmpl = safeCall_(() => u.getTrackingTemplate && u.getTrackingTemplate());

    const ag = kw.getAdGroup();
    const cg = ag.getCampaign();

    pushUrlEnt_(ents, 'KEYWORD', finalUrl, tmpl, suffix, {
      keywordText: kw.getText(),
      adGroup: ag.getName(),
      campaign: cg.getName()
    });
  }

  return ents;
}

function pushUrlEnt_(arr, entityType, finalUrl, tmpl, suffix, extra) {
  if (!finalUrl) return;
  const resolvedUrl = resolveUrl_(finalUrl, tmpl, suffix);
  arr.push({
    entityType, finalUrl, resolvedUrl, ...extra
  });
}

function buildUniqueUrlList_(entities) {
  const seen = {};
  const out = [];
  for (const e of entities) {
    const key = e.resolvedUrl.trim();
    if (seen[key]) { 
      // keep at least one reference (first one kept)
      continue; 
    }
    seen[key] = true;
    out.push(e);
  }
  return out;
}

/** Resolve tracking template + suffix into a testable URL. */
function resolveUrl_(finalUrl, trackingTemplate, finalSuffix) {
  let url = String(finalUrl).trim();

  if (trackingTemplate) {
    // Replace {lpurl} with encoded final URL
    let t = String(trackingTemplate);
    t = t.replace(/\{lpurl\}/gi, encodeURIComponent(url));
    t = t.replace(/\{ignore\}/gi, '');
    // Remove other value track macros so they don't break fetch
    t = t.replace(/\{[^\}]+\}/g, '');
    url = t;
  }

  if (finalSuffix) {
    const sep = url.indexOf('?') === -1 ? '?' : '&';
    url = url + sep + finalSuffix;
  }

  return url;
}

/** Fetch URL, follow redirects, return status. Treat 4xx/5xx (and 403 if configured) as failures. */
function checkUrl_(url) {
  try {
    const start = new Date().getTime();
    const resp = UrlFetchApp.fetch(url, {
      followRedirects: true,
      muteHttpExceptions: true,
      method: 'get',
      validateHttpsCertificates: true,
      headers: { 'User-Agent': CONFIG.USER_AGENT }
    });
    const code = resp.getResponseCode();

    // Soft timeout guard
    const took = new Date().getTime() - start;
    if (took > CONFIG.TIMEOUT_MS) {
      return { ok: false, status: code, reason: `Timeout>${CONFIG.TIMEOUT_MS}ms` };
    }

    const ok2xx3xx = code >= 200 && code < 400;
    const is403 = code === 403 && CONFIG.CONSIDER_403_AS_FAIL;
    if (ok2xx3xx && !is403) return { ok: true, status: code, reason: 'OK' };
    return { ok: false, status: code, reason: httpReason_(code) };
  } catch (e) {
    return { ok: false, status: -1, reason: `Exception: ${String(e).slice(0,180)}` };
  }
}

function httpReason_(code) {
  const map = {
    0: 'Network error',
    301: 'Moved Permanently',
    302: 'Found',
    307: 'Temporary Redirect',
    308: 'Permanent Redirect',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden (blocked)',
    404: 'Not Found',
    410: 'Gone',
    429: 'Too Many Requests',
    500: 'Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  };
  return map[code] || `HTTP ${code}`;
}

function sendEmail_(failures, tz) {
  const acct = AdsApp.currentAccount();
  const now = new Date();
  const title = `Broken URL Alert – ${acct.getName()} – ${Utilities.formatDate(now, tz, 'MMM d, HH:mm')}`;

  // Summarize by campaign/adgroup for quick triage
  const lines = [
    `Account: ${acct.getCustomerId()} – ${acct.getName()}`,
    `Time zone: ${tz}`,
    `Failures found: ${failures.length}`,
    `----------------------------------------`
  ];

  failures.slice(0, 100).forEach((f, i) => {
    const where = f.entityType === 'AD'
      ? `Ad ID ${f.adId}`
      : `Keyword "${f.keywordText}"`;
    lines.push(
      `${i+1}. ${where} | ${f.campaign} › ${f.adGroup}`,
      `    URL: ${f.url}`,
      `    Status: ${f.status} (${f.reason})`,
      ``
    );
  });

  if (failures.length > 100) {
    lines.push(`(+${failures.length - 100} more…)`);
  }

  MailApp.sendEmail(CONFIG.EMAILS.join(','), title, lines.join('\n'));
}

function safeCall_(fn) {
  try { return fn && fn(); } catch (e) { return null; }
}
