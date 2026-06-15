// HOTFIX: station ID normalization for TAF/METAR matching.
//
// IEM ASOS/METAR CSV often returns stations as 3-letter IDs like BTR, while
// TAF products use 4-letter IDs like KBTR. The verification matcher needs both
// sides to use the same ID format. Add this as a separate Apps Script file after
// Code.gs, or copy these edits into Code.gs.

function normalizeStation(station) {
  station = String(station || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(station)) return 'K' + station;
  return station;
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
    rec.station = normalizeStation(rec.station);
    rec.valid = rec.valid ? iso(new Date(rec.valid + 'Z')) : '';
    rec.vsby = numberOrNull(rec.vsby);
    ['skyl1', 'skyl2', 'skyl3', 'skyl4'].forEach(k => rec[k] = numberOrNull(rec[k]));
    rec.ceiling_ft = observedCeiling(rec);
    rec.obs_category = flightCategory(rec.vsby, rec.ceiling_ft);
    return rec;
  }).sort((a, b) => (a.station + a.valid).localeCompare(b.station + b.valid));
}

function parseTafBlock(tafText, issueTime, windowStart, windowEnd) {
  const compact = tafText.replace(/=/g, ' ').replace(/\s+/g, ' ').trim();
  const stationMatch = compact.match(/\b(K[A-Z0-9]{3})\b/);
  const station = stationMatch ? normalizeStation(stationMatch[1]) : 'UNKNOWN';
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
      station: station,
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
