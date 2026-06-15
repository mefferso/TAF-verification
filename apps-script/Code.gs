/**
 * TAF Verification Web App - Google Apps Script backend.
 *
 * GitHub stores source code. Google Apps Script runs the web app and fetches
 * IEM data server-side. Coworkers use a normal Web App URL.
 */

const CONFIG = {
  WFO: 'LIX',
  PIL_PREFIX: 'TAF',
  SITES: ['KMSY', 'KBTR', 'KNEW', 'KHDC', 'KHUM', 'KGPT', 'KASD', 'KMCB'],
  IEM_AFOS_LIST_URL: 'https://mesonet.agron.iastate.edu/wx/afos/list.phtml',
  IEM_ASOS_URL: 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py',
};

const CEILING_COVERS = ['BKN', 'OVC', 'VV'];
const CATEGORY_RANK = { LIFR: 0, IFR: 1, MVFR: 2, VFR: 3 };

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('TAF Verification')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getConfig() {
  return {
    wfo: CONFIG.WFO,
    pilPrefix: CONFIG.PIL_PREFIX,
    sites: CONFIG.SITES,
  };
}

function runVerification(request) {
  const dateText = request.date;
  const cycle = Number(request.cycle);
  const threshold = request.threshold || 'IFR';
  const windowHours = Number(request.windowHours || 6);
  const sites = request.site === 'All' ? CONFIG.SITES : [request.site];

  const start = new Date(Date.UTC(
    Number(dateText.slice(0, 4)),
    Number(dateText.slice(5, 7)) - 1,
    Number(dateText.slice(8, 10)),
    cycle,
    0,
    0
  ));
  const end = new Date(start.getTime() + windowHours * 60 * 60 * 1000);

  const tafProducts = [];
  const tafErrors = [];
  sites.forEach(site => {
    try {
      tafProducts.push(fetchTafProductForSite(site, CONFIG.WFO, start));
    } catch (err) {
      tafErrors.push({ site, error: err.message || String(err) });
    }
  });

  if (!tafProducts.length) {
    throw new Error('No station TAF products found. First error: ' + (tafErrors[0] ? tafErrors[0].error : 'unknown'));
  }

  const tafBlocks = {};
  tafProducts.forEach(product => {
    const blocks = splitTafBySite(product.text, [product.site]);
    tafBlocks[product.site] = blocks[product.site] || product.text;
  });

  const metars = fetchMetars(sites, start, end);

  let tafPeriods = [];
  Object.keys(tafBlocks).forEach(site => {
    const product = tafProducts.find(p => p.site === site);
    const issueTime = product && product.issued ? new Date(product.issued) : start;
    const periods = parseTafBlock(tafBlocks[site], issueTime, start, end);
    periods.forEach(p => {
      p.station = site;
      tafPeriods.push(p);
    });
  });

  const matched = attachForecastToObs(metars, tafPeriods, Boolean(request.includeTempo));
  const overall = contingency(matched, threshold);
  const byStation = sites.map(station => {
    const stationRows = matched.filter(r => r.station === station);
    return Object.assign({ station }, contingency(stationRows, threshold));
  });

  return {
    request: {
      date: dateText,
      cycle,
      threshold,
      windowHours,
      sites,
      start: iso(start),
      end: iso(end),
      includeTempo: Boolean(request.includeTempo),
    },
    tafProducts,
    tafErrors,
    tafBlocks,
    tafPeriods,
    metars,
    matched,
    overall,
    byStation,
  };
}

function fetchTafProductForSite(site, wfo, start) {
  const pil = CONFIG.PIL_PREFIX + site.replace(/^K/, '');
  const nextDay = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const params = {
    source: wfo,
    pil: pil,
    year1: start.getUTCFullYear(),
    month1: start.getUTCMonth() + 1,
    day1: start.getUTCDate(),
    year2: nextDay.getUTCFullYear(),
    month2: nextDay.getUTCMonth() + 1,
    day2: nextDay.getUTCDate(),
    sort: 'asc',
  };
  const listUrl = CONFIG.IEM_AFOS_LIST_URL + '?' + toQuery(params);
  const html = fetchText(listUrl);
  const links = [];
  const safePil = pil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const linkRegex = new RegExp('<a[^>]+href="([^"]*p\\.php[^"]*pil=' + safePil + '[^"]*)"[^>]*>\\s*' + safePil + '\\s*</a>', 'gi');
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = htmlDecode(match[1]).replace(/&amp;/g, '&');
    const issued = issuedFromUrl(href);
    if (issued) links.push({ href, issued });
  }

  if (!links.length) {
    throw new Error('No ' + pil + ' products found from IEM listing. URL tried: ' + listUrl);
  }

  links.sort((a, b) => Math.abs(a.issued.getTime() - start.getTime()) - Math.abs(b.issued.getTime() - start.getTime()));
  const chosen = links[0];
  const productUrl = absolutizeIemUrl(chosen.href);
  const productHtml = fetchText(productUrl);
  const text = extractPreText(productHtml);

  return {
    site,
    pil,
    issued: iso(chosen.issued),
    sourceUrl: productUrl,
    listingUrl: listUrl,
    text,
  };
}

function fetchMetars(sites, start, end) {
  const pairs = [];
  sites.forEach(site => pairs.push(['station', site]));
  ['vsby', 'skyc1', 'skyc2', 'skyc3', 'skyc4', 'skyl1', 'skyl2', 'skyl3', 'skyl4', 'wxcodes', 'metar']
    .forEach(field => pairs.push(['data', field]));
  pairs.push(
    ['year1', start.getUTCFullYear()], ['month1', start.getUTCMonth() + 1], ['day1', start.getUTCDate()], ['hour1', start.getUTCHours()], ['minute1', start.getUTCMinutes()],
    ['year2', end.getUTCFullYear()], ['month2', end.getUTCMonth() + 1], ['day2', end.getUTCDate()], ['hour2', end.getUTCHours()], ['minute2', end.getUTCMinutes()],
    ['tz', 'Etc/UTC'], ['format', 'comma'], ['latlon', 'no'], ['elev', 'no'], ['missing', 'M'], ['trace', 'T'], ['direct', 'no'],
    ['report_type', '1'], ['report_type', '2']
  );

  const url = CONFIG.IEM_ASOS_URL + '?' + pairs.map(p => encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1])).join('&');
  const csv = fetchText(url);
  const lines = csv.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  if (!lines.length) return [];

  const rows = Utilities.parseCsv(lines.join('\n'));
  const header = rows.shift();
  return rows.map(row => {
    const rec = rowToObject(header, row);
    rec.valid = rec.valid ? iso(new Date(rec.valid + 'Z')) : '';
    rec.vsby = numberOrNull(rec.vsby);
    ['skyl1', 'skyl2', 'skyl3', 'skyl4'].forEach(k => rec[k] = numberOrNull(rec[k]));
    rec.ceiling_ft = observedCeiling(rec);
    rec.obs_category = flightCategory(rec.vsby, rec.ceiling_ft);
    return rec;
  }).sort((a, b) => (a.station + a.valid).localeCompare(b.station + b.valid));
}

function splitTafBySite(productText, sites) {
  const wanted = new Set(sites);
  const blocks = {};
  let current = null;
  const lines = productText.split(/\r?\n/);
  const siteRe = /^(TAF\s+)?(K[A-Z0-9]{3})\b/;

  lines.forEach(raw => {
    const line = raw.trim();
    if (!line) return;
    const match = line.match(siteRe);
    if (match && wanted.has(match[2])) {
      current = match[2];
      blocks[current] = [line];
    } else if (current) {
      const other = line.match(siteRe);
      if (other && !wanted.has(other[2])) current = null;
      else blocks[current].push(line);
    }
  });

  Object.keys(blocks).forEach(site => blocks[site] = blocks[site].join('\n'));
  return blocks;
}

function parseTafBlock(tafText, issueTime, windowStart, windowEnd) {
  const compact = tafText.replace(/=/g, ' ').replace(/\s+/g, ' ').trim();
  const stationMatch = compact.match(/\b(K[A-Z0-9]{3})\b/);
  const station = stationMatch ? stationMatch[1] : 'UNKNOWN';
  const groupRe = /\b(FM\d{6}|TEMPO\s+\d{4}\/\d{4}|BECMG\s+\d{4}\/\d{4}|PROB\d{2}\s+\d{4}\/\d{4})\b/g;
  const markers = [];
  let m;
  while ((m = groupRe.exec(compact)) !== null) markers.push({ index: m.index, marker: m[1] });
  const spans = [{ index: 0, marker: 'PREVAILING' }].concat(markers);

  let periods = spans.map((span, i) => {
    const nextIndex = i + 1 < spans.length ? spans[i + 1].index : compact.length;
    const text = compact.slice(span.index, nextIndex).trim();
    const period = periodFromMarker(span.marker, issueTime, windowStart, windowEnd);
    const vis = forecastVisibility(text);
    const cig = forecastCeiling(text);
    return {
      station,
      group_type: span.marker.split(/\s+/)[0],
      start: period.start,
      end: period.end,
      forecast_visibility_sm: vis,
      forecast_ceiling_ft: cig,
      forecast_category: flightCategory(vis, cig),
      is_prevailing: span.marker === 'PREVAILING' || span.marker.startsWith('FM'),
      group_text: text,
    };
  });

  const prevailing = periods.filter(p => p.is_prevailing).sort((a, b) => new Date(a.start) - new Date(b.start));
  for (let i = 0; i < prevailing.length - 1; i++) prevailing[i].end = prevailing[i + 1].start;

  periods = periods
    .filter(p => new Date(p.end) > windowStart && new Date(p.start) < windowEnd)
    .map(p => {
      p.start = iso(maxDate(new Date(p.start), windowStart));
      p.end = iso(minDate(new Date(p.end), windowEnd));
      return p;
    });
  return periods;
}

function attachForecastToObs(obs, tafPeriods, includeTempo) {
  return obs.map(ob => {
    const valid = new Date(ob.valid);
    let periods = tafPeriods.filter(p => p.station === ob.station);
    if (!includeTempo) periods = periods.filter(p => p.is_prevailing);
    const matches = periods.filter(p => new Date(p.start) <= valid && new Date(p.end) > valid).sort((a, b) => new Date(a.start) - new Date(b.start));
    const chosen = matches.length ? matches[matches.length - 1] : null;
    return Object.assign({}, ob, {
      forecast_category: chosen ? chosen.forecast_category : '',
      forecast_group: chosen ? chosen.group_text : '',
    });
  });
}

function contingency(rows, threshold) {
  let hits = 0, misses = 0, falseAlarms = 0, correctNegatives = 0;
  rows.forEach(r => {
    if (!r.forecast_category || !r.obs_category) return;
    const f = eventBool(r.forecast_category, threshold);
    const o = eventBool(r.obs_category, threshold);
    if (f && o) hits++;
    else if (!f && o) misses++;
    else if (f && !o) falseAlarms++;
    else correctNegatives++;
  });
  return {
    hits,
    misses,
    false_alarms: falseAlarms,
    correct_negatives: correctNegatives,
    POD: hits + misses ? hits / (hits + misses) : null,
    FAR: hits + falseAlarms ? falseAlarms / (hits + falseAlarms) : null,
    CSI: hits + misses + falseAlarms ? hits / (hits + misses + falseAlarms) : null,
  };
}

function observedCeiling(rec) {
  const ceilings = [];
  for (let i = 1; i <= 4; i++) {
    const cover = String(rec['skyc' + i] || '').trim().toUpperCase();
    const height = numberOrNull(rec['skyl' + i]);
    if (CEILING_COVERS.indexOf(cover) >= 0 && height !== null) ceilings.push(height);
  }
  return ceilings.length ? Math.min.apply(null, ceilings) : null;
}

function flightCategory(vis, cig) {
  if ((cig !== null && cig < 500) || (vis !== null && vis < 1)) return 'LIFR';
  if ((cig !== null && cig < 1000) || (vis !== null && vis < 3)) return 'IFR';
  if ((cig !== null && cig <= 3000) || (vis !== null && vis <= 5)) return 'MVFR';
  return 'VFR';
}

function forecastCeiling(text) {
  const ceilings = [];
  const re = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) if (CEILING_COVERS.indexOf(m[1]) >= 0) ceilings.push(Number(m[2]) * 100);
  return ceilings.length ? Math.min.apply(null, ceilings) : null;
}

function forecastVisibility(text) {
  const m = text.match(/\b(P?\d+\s+\d\/\d|P?\d+\/\d|P?\d+)SM\b/);
  if (!m) return null;
  return parseSm(m[1].replace(/^P/, ''));
}

function periodFromMarker(marker, issueTime, windowStart, windowEnd) {
  marker = String(marker || '').trim();
  if (marker.startsWith('FM')) {
    const day = Number(marker.slice(2, 4));
    const hour = Number(marker.slice(4, 6));
    const minute = Number(marker.slice(6, 8));
    return { start: iso(resolveTafTime(issueTime, day, hour, minute)), end: iso(windowEnd) };
  }
  const m = marker.match(/(\d{4})\/(\d{4})/);
  if (m) {
    const start = resolveTafTime(issueTime, Number(m[1].slice(0, 2)), Number(m[1].slice(2, 4)), 0);
    let end = resolveTafTime(issueTime, Number(m[2].slice(0, 2)), Number(m[2].slice(2, 4)), 0);
    if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    return { start: iso(start), end: iso(end) };
  }
  return { start: iso(windowStart), end: iso(windowEnd) };
}

function resolveTafTime(reference, day, hour, minute) {
  const ref = new Date(reference);
  const candidates = [];
  for (let offset = -3; offset <= 35; offset++) {
    const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + offset, hour % 24, minute || 0, 0));
    if (d.getUTCDate() === day) {
      if (hour === 24) d.setUTCDate(d.getUTCDate() + 1);
      candidates.push(d);
    }
  }
  if (!candidates.length) throw new Error('Could not resolve TAF time ' + day + '/' + hour + ' near ' + iso(ref));
  candidates.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
  return candidates[0];
}

function eventBool(category, threshold) { return CATEGORY_RANK[category] <= CATEGORY_RANK[threshold]; }

function fetchText(url) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code < 200 || code >= 300) throw new Error('HTTP ' + code + ' fetching ' + url + ': ' + text.slice(0, 300));
  return text;
}

function issuedFromUrl(url) {
  const m = String(url).match(/[?&]e=(\d{12})/);
  if (!m) return null;
  const s = m[1];
  return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12)), 0));
}

function extractPreText(html) {
  const m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const raw = m ? m[1] : html;
  return htmlDecode(raw.replace(/<[^>]+>/g, '')).trim();
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

function absolutizeIemUrl(href) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return 'https://mesonet.agron.iastate.edu' + href;
  return 'https://mesonet.agron.iastate.edu/wx/afos/' + href;
}

function rowToObject(header, row) { const obj = {}; header.forEach((name, i) => obj[name] = row[i]); return obj; }

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || value === 'M' || value === 'null') return null;
  const n = Number(value);
  return isNaN(n) ? null : n;
}

function parseSm(value) {
  value = String(value || '').trim();
  if (!value) return null;
  if (value.indexOf(' ') > -1) {
    const parts = value.split(/\s+/);
    return Number(parts[0]) + parseSm(parts[1]);
  }
  if (value.indexOf('/') > -1) {
    const p = value.split('/');
    return Number(p[0]) / Number(p[1]);
  }
  return Number(value);
}

function toQuery(params) { return Object.keys(params).map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&'); }
function iso(d) { return new Date(d).toISOString(); }
function maxDate(a, b) { return a > b ? a : b; }
function minDate(a, b) { return a < b ? a : b; }
