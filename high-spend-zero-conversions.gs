/**
 * Google Ads Script — High Spend with Zero Conversions
 *
 * Finds keywords that have spent more than SPEND_LIMIT in the last N days
 * and produced 0 conversions. Sends an email (and optionally pauses them).
 */

const CFG = {
  LOOKBACK_DAYS: 14,
  SPEND_LIMIT: 100,          // currency = account currency
  AUTO_PAUSE: false,        // true = pause; false = just email
  EMAILS: ['you@yourdomain.com'],
  CHECK_PAUSED: false,
  COOLDOWN_HOURS: 24
};

function main() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const nextOk = parseInt(props.getProperty('HSZC_COOLDOWN_UNTIL')||'0',10);

  const dateRange = `LAST_${CFG.LOOKBACK_DAYS}_DAYS`;
  const statusCond = CFG.CHECK_PAUSED ? "IN [ENABLED, PAUSED]" : "= ENABLED";

  const it = AdsApp.keywords()
    .withCondition(`CampaignStatus ${statusCond}`)
    .withCondition(`AdGroupStatus ${statusCond}`)
    .withCondition(`Status ${statusCond}`)
    .forDateRange(dateRange)
    .withCondition(`Cost > ${CFG.SPEND_LIMIT}`)
    .withCondition(`Conversions = 0`)
    .get();

  const offenders = [];
  while (it.hasNext()) {
    const kw = it.next();
    const ag = kw.getAdGroup(); const cg = ag.getCampaign();
    const st = kw.getStatsFor(dateRange);
    offenders.push({
      text: kw.getText(), id: kw.getId(),
      campaign: cg.getName(), adgroup: ag.getName(),
      cost: st.getCost(), clicks: st.getClicks(), conv: st.getConversions(), kw
    });
  }

  if (offenders.length) {
    if (CFG.AUTO_PAUSE) {
      offenders.forEach(o=>{ try { o.kw.pause(); } catch(e){} });
    }
    if (now >= nextOk) {
      const acct = AdsApp.currentAccount(); const tz = acct.getTimeZone();
      const lines = [
        `Account: ${acct.getCustomerId()} – ${acct.getName()}`,
        `Lookback: ${CFG.LOOKBACK_DAYS}d | Spend limit: ${acct.getCurrencyCode()} ${CFG.SPEND_LIMIT}`,
        `Offenders: ${offenders.length}${CFG.AUTO_PAUSE?' (paused)':''}`,
        `----------------------------------------`
      ];
      offenders.slice(0,200).forEach((o,i)=>{
        lines.push(`${i+1}. "${o.text}" | ${o.campaign} › ${o.adgroup} | Cost ${o.cost.toFixed(2)}, Clicks ${o.clicks}, Conv ${o.conv}`);
      });
      if (offenders.length>200) lines.push(`(+${offenders.length-200} more…)`);
      MailApp.sendEmail(CFG.EMAILS.join(','), `High Spend / No Conv – ${Utilities.formatDate(new Date(), tz, 'MMM d, HH:mm')}`, lines.join('\n'));
      props.setProperty('HSZC_COOLDOWN_UNTIL', String(now + CFG.COOLDOWN_HOURS*3600*1000));
    }
  }

  Logger.log(`Found offenders: ${offenders.length}`);
}
