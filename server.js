import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectDirectory = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(join(projectDirectory, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const dataBaseUrl = (process.env.DATA_BASE_URL ?? 'https://watplan.coobie.dev/data').replace(/\/$/, '');
const calendarDirectory = process.env.CALENDAR_DIRECTORY ?? './data/ics';
const publicApiBaseUrl = (process.env.PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');
const syncIntervalMs = 15 * 60 * 1000;
const fileTtlMs = 15 * 60 * 1000;
const rateLimitWindowMs = positiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const rateLimitMaxRequests = positiveInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 60);
const rateLimitBuckets = new Map();
const maxRateLimitBuckets = 50_000;
let syncInProgress;
let catalogGroups = [];
let catalogSemesters = [];

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const homePage = `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WATplan — kalendarz</title>
  <style>
    body { font: 16px system-ui, sans-serif; margin: 0; padding: 2rem 1rem; color: #202124; background: #f5f7f8; }
    main { max-width: 34rem; margin: 3rem auto; padding: 1.5rem; background: white; border: 1px solid #d9e0e3; border-radius: 10px; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    label { display: block; margin: 1rem 0 .35rem; font-weight: 600; }
    select { box-sizing: border-box; width: 100%; min-height: 2.8rem; padding: .6rem; font: inherit; }
    .actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
    button { display: grid; place-items: center; width: 2.8rem; height: 2.8rem; padding: .55rem; color: white; background: #207b67; border: 0; border-radius: 5px; cursor: pointer; }
    button svg { width: 1.35rem; height: 1.35rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    button svg[hidden] { display: none; }
    button:disabled { opacity: .55; cursor: wait; }
    #status { min-height: 1.5rem; color: #535b60; }
  </style>
</head>
<body>
  <main>
    <h1>Link do kalendarza WATplan</h1>
    <label for="group">Grupa</label>
    <select id="group" disabled><option>Ładowanie grup…</option></select>
    <label for="semester">Semestr</label>
    <select id="semester" disabled><option>Ładowanie semestrów…</option></select>
    <div class="actions">
      <button id="copy" type="button" aria-label="Kopiuj link" title="Kopiuj link" disabled>
        <svg id="copyIcon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"></path></svg>
        <svg id="checkIcon" viewBox="0 0 24 24" aria-hidden="true" hidden><path d="m5 12 4 4L19 6"></path></svg>
      </button>
    </div>
    <p id="status" role="status">Pobieram listę grup i semestrów…</p>
  </main>
  <script>
    const apiBaseUrl = ${JSON.stringify(publicApiBaseUrl)};
    const apiUrl = (path) => new URL(path, apiBaseUrl || window.location.origin);
    const groupSelect = document.querySelector('#group');
    const semesterSelect = document.querySelector('#semester');
    const copyButton = document.querySelector('#copy');
    const copyIcon = document.querySelector('#copyIcon');
    const checkIcon = document.querySelector('#checkIcon');
    const status = document.querySelector('#status');
    let calendarLink = '';
    let resetIconTimer;

    function updateLink() {
      if (!groupSelect.value || !semesterSelect.value) return;
      const url = apiUrl('/api/schedule');
      url.searchParams.set('group', groupSelect.value);
      url.searchParams.set('semester', semesterSelect.value);
      calendarLink = url.href;
      copyButton.disabled = false;
    }

    async function copyToClipboard(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {}
      }

      const temporaryInput = document.createElement('textarea');
      temporaryInput.value = text;
      temporaryInput.setAttribute('readonly', '');
      temporaryInput.setAttribute('aria-hidden', 'true');
      temporaryInput.style.position = 'fixed';
      temporaryInput.style.left = '-10000px';
      temporaryInput.style.top = '0';
      temporaryInput.style.width = '1px';
      temporaryInput.style.height = '1px';
      temporaryInput.style.opacity = '0';
      document.body.append(temporaryInput);
      temporaryInput.focus({ preventScroll: true });
      temporaryInput.select();
      temporaryInput.setSelectionRange(0, temporaryInput.value.length);
      const copied = document.execCommand('copy');
      temporaryInput.remove();
      if (!copied) throw new Error('Nie udało się skopiować linku.');
    }

    async function loadOptions() {
      try {
        const response = await fetch(apiUrl('/api/options'));
        if (!response.ok) throw new Error('Lista jest jeszcze synchronizowana.');
        const options = await response.json();
        groupSelect.replaceChildren(...options.groups.map((group) => new Option(group, group)));
        semesterSelect.replaceChildren(...options.semesters.map((semester) => new Option(semester.name, semester.id)));
        groupSelect.disabled = false;
        semesterSelect.disabled = false;
        if (semesterSelect.options.length) semesterSelect.selectedIndex = semesterSelect.options.length - 1;
        updateLink();
        status.textContent = 'Wybierz grupę i semestr, a następnie skopiuj link.';
      } catch (error) {
        status.textContent = error.message + ' Ponawiam próbę za 5 sekund.';
        setTimeout(loadOptions, 5000);
      }
    }

    groupSelect.addEventListener('change', updateLink);
    semesterSelect.addEventListener('change', updateLink);
    copyButton.addEventListener('click', async () => {
      try {
        await copyToClipboard(calendarLink);
        copyIcon.hidden = true;
        checkIcon.hidden = false;
        copyButton.setAttribute('aria-label', 'Link skopiowany');
        copyButton.title = 'Link skopiowany';
        clearTimeout(resetIconTimer);
        resetIconTimer = setTimeout(() => {
          copyIcon.hidden = false;
          checkIcon.hidden = true;
          copyButton.setAttribute('aria-label', 'Kopiuj link');
          copyButton.title = 'Kopiuj link';
        }, 1500);
        status.textContent = 'Link skopiowany.';
      } catch (error) {
        status.textContent = error.message || 'Nie udało się skopiować linku.';
      }
    });
    loadOptions();
  </script>
</body>
</html>`;

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function allowApiRequest(request, response) {
  const now = Date.now();
  const ip = (request.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + rateLimitWindowMs };
    rateLimitBuckets.set(ip, bucket);
  }

  if (bucket.count >= rateLimitMaxRequests) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    response.setHeader('retry-after', String(retryAfter));
    response.setHeader('x-ratelimit-limit', String(rateLimitMaxRequests));
    response.setHeader('x-ratelimit-remaining', '0');
    response.setHeader('x-ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));
    json(response, 429, { error: 'Too many requests. Try again later.' });
    return false;
  }

  bucket.count++;
  response.setHeader('x-ratelimit-limit', String(rateLimitMaxRequests));
  response.setHeader('x-ratelimit-remaining', String(rateLimitMaxRequests - bucket.count));
  response.setHeader('x-ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));
  if (rateLimitBuckets.size > maxRateLimitBuckets) {
    for (const [key, value] of rateLimitBuckets) {
      if (now >= value.resetAt) rateLimitBuckets.delete(key);
    }
    if (rateLimitBuckets.size > maxRateLimitBuckets)
      rateLimitBuckets.delete(rateLimitBuckets.keys().next().value);
  }
  return true;
}

function validGroup(group) {
  return /^WCY[A-Za-z0-9_*]+$/.test(group ?? '');
}

function calendarFileName(group, semesterId) {
  return `${group}-${semesterId}.ics`;
}

function escapeIcs(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function foldIcsLine(line) {
  const physicalLines = [];
  let current = '';
  let byteLength = 0;
  for (const character of line) {
    const characterLength = Buffer.byteLength(character);
    if (byteLength + characterLength > 75) {
      physicalLines.push(current);
      current = ' ';
      byteLength = 1;
    }
    current += character;
    byteLength += characterLength;
  }
  physicalLines.push(current);
  return physicalLines;
}

function compactDate(date) {
  return String(date ?? '').replaceAll('_', '').replaceAll('-', '');
}

function eventDateTime(date, time) {
  const day = compactDate(date);
  const clock = String(time ?? '').replace(':', '');
  if (!/^\d{8}$/.test(day) || !/^\d{4}$/.test(clock)) return undefined;
  return `${day}T${clock}00`;
}

function findSubject(subjects, entry) {
  const matches = (subjects ?? []).filter((subject) =>
    subject.title === entry.title && subject.type === entry.type);
  if (matches.length === 0) return undefined;
  if (entry.prof) return matches.find((subject) => subject.prof === entry.prof) ?? matches[0];
  return matches[0];
}

function typeMarker(type) {
  return ({
    'Wykład': 'W',
    'Ćwiczenia': 'Ć',
    'Laboratorium': 'L',
    'Projekt': 'P',
    'Seminarium': 'S',
    'Praktyka': 'Pr',
    'Egzamin': 'E',
    'Egzamin poprawkowy': 'E',
    'Zaliczenie': 'Z',
    'Zaliczenie poprawkowe': 'Z',
  })[type] ?? type ?? '';
}

function makeEvent(group, entry, subject) {
  const start = eventDateTime(entry.date, entry.timeStart);
  const end = eventDateTime(entry.date, entry.timeEnd);
  if (!start || !end) return undefined;

  const eventHash = entry.hash || createHash('sha256')
    .update(`${start}|${entry.title ?? ''}|${entry.num ?? ''}`)
    .digest('hex');
  const uid = `${group}-${eventHash}-${start}`;
  const description = [
    entry.title,
    `Rodzaj zajęć: ${entry.type ?? ''}`,
    entry.num !== undefined && `Nr zajęć: ${entry.num}${subject?.numH !== undefined ? `/${subject.numH}` : ''}`,
    `Prowadzący: ${entry.prof ?? subject?.prof ?? ''}`,
  ].filter(Boolean).join('\n');
  const summary = `${subject?.short || entry.title || 'Zajęcia'} (${typeMarker(entry.type)})`;

  return [
    'BEGIN:VEVENT',
    `UID:${escapeIcs(uid)}@watplan`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;TZID=Europe/Warsaw:${start}`,
    `DTEND;TZID=Europe/Warsaw:${end}`,
    `SUMMARY:${escapeIcs(summary)}`,
    ...(entry.room?.length ? [`LOCATION:${escapeIcs(entry.room.join(', '))}`] : []),
    ...(description ? [`DESCRIPTION:${escapeIcs(description)}`] : []),
    `CATEGORIES:${escapeIcs(entry.type)},${escapeIcs(entry.title)}`,
    'END:VEVENT',
  ].flatMap(foldIcsLine).join('\r\n');
}

function eventIdentity(entry, subject) {
  const start = eventDateTime(entry.date, entry.timeStart);
  const end = eventDateTime(entry.date, entry.timeEnd);
  if (!start || !end) return undefined;
  return JSON.stringify([
    start,
    end,
    subject?.short || entry.title || 'Zajęcia',
    typeMarker(entry.type),
    entry.title ?? '',
    entry.type ?? '',
    entry.num !== undefined,
    entry.num ?? null,
    entry.num !== undefined ? subject?.numH ?? null : null,
    entry.room?.length ? entry.room.join(', ') : '',
  ]);
}

function makeCalendar(group, semester, entries, subjects) {
  const groupedEvents = new Map();
  for (const entry of entries) {
    const subject = findSubject(subjects, entry);
    const identity = eventIdentity(entry, subject);
    if (!identity) continue;
    let grouped = groupedEvents.get(identity);
    if (!grouped) {
      grouped = { entry, subject, professors: new Set(), hashes: new Set() };
      groupedEvents.set(identity, grouped);
    }
    const professor = String(entry.prof ?? subject?.prof ?? '').trim().replace(/\s+/g, ' ');
    if (professor) grouped.professors.add(professor);
    if (entry.hash) grouped.hashes.add(entry.hash);
  }
  const events = [...groupedEvents.values()].flatMap((grouped) => {
    const entry = {
      ...grouped.entry,
      hash: [...grouped.hashes].sort()[0] ?? grouped.entry.hash,
      prof: [...grouped.professors].join(', ') || grouped.entry.prof,
    };
    const event = makeEvent(group, entry, grouped.subject);
    return event ? [event] : [];
  });
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WATplan//Schedule//PL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(`${group} ${semester.name}`)}`,
    'X-WR-TIMEZONE:Europe/Warsaw',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Warsaw',
    'X-LIC-LOCATION:Europe/Warsaw',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
  return [
    ...header.flatMap(foldIcsLine),
    ...events,
    ...['END:VCALENDAR', ''].flatMap(foldIcsLine),
  ].join('\r\n');
}

async function fetchJson(path) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${dataBaseUrl}/${path}`, {
        headers: { accept: 'application/json', 'user-agent': 'WATplan server' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Could not load ${path}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function pruneExpiredFiles() {
  const files = await readdir(calendarDirectory, { withFileTypes: true });
  await Promise.all(files.filter((file) => file.isFile()
    && (file.name.endsWith('.ics') || /^ALL-\d{5}\.ics\.tmp$/.test(file.name))).map(async (file) => {
    const path = join(calendarDirectory, file.name);
    try {
      if (/^ALL-\d{5}\.ics$/.test(file.name) || Date.now() - (await stat(path)).mtimeMs >= fileTtlMs)
        await unlink(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }));
}

async function syncCalendars() {
  if (syncInProgress) return syncInProgress;
  syncInProgress = (async () => {
    await mkdir(calendarDirectory, { recursive: true });
    const semesters = await fetchJson('semesters.json');
    const semesterData = [];
    for (const semester of semesters) {
      const [entries, subjects] = await Promise.all([
        fetchJson(`entries-${encodeURIComponent(semester.id)}.json`),
        fetchJson(`subjects-${encodeURIComponent(semester.id)}.json`),
      ]);
      semesterData.push({ semester, entries, subjects });
    }

    const groups = new Set();
    for (const { entries, subjects } of semesterData) {
      Object.keys(entries).forEach((group) => groups.add(group));
      Object.keys(subjects).forEach((group) => groups.add(group));
    }

    let generated = 0;
    const sortedGroups = [...groups].filter(validGroup).sort();
    for (const { semester, entries, subjects } of semesterData) {
      const semesterGroups = new Set([...Object.keys(entries), ...Object.keys(subjects)]);
      for (const group of semesterGroups) {
        if (!validGroup(group)) continue;
        const fileName = calendarFileName(group, semester.id);
        const path = join(calendarDirectory, fileName);
        const temporaryPath = `${path}.tmp`;
        await writeFile(temporaryPath, makeCalendar(group, semester, entries[group] ?? [], subjects[group] ?? []), 'utf8');
        await rename(temporaryPath, path);
        generated++;
      }
    }

    catalogGroups = sortedGroups;
    catalogSemesters = semesterData.map(({ semester }) => ({ id: semester.id, name: semester.name }));
    await pruneExpiredFiles();
    console.log(`Synchronized ${generated} calendars for ${groups.size} groups and ${semesterData.length} semesters`);
  })().finally(() => { syncInProgress = undefined; });
  return syncInProgress;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET');
    return json(response, 405, { error: 'Method not allowed' });
  }
  if (url.pathname.startsWith('/api/') && !allowApiRequest(request, response)) return;
  if (url.pathname === '/') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    return response.end(homePage);
  }
  if (url.pathname === '/health')
    return json(response, 200, { status: 'ok', syncing: Boolean(syncInProgress) });
  if (url.pathname === '/api/options') {
    if (catalogSemesters.length === 0)
      return json(response, 503, { error: 'Schedule data is still synchronizing' });
    return json(response, 200, { groups: catalogGroups, semesters: catalogSemesters });
  }
  if (url.pathname !== '/api/schedule')
    return json(response, 404, { error: 'Not found' });

  const group = url.searchParams.get('group') ?? '';
  const semesterId = url.searchParams.get('semester') ?? '';
  if (!validGroup(group)) return json(response, 400, { error: 'Valid WCY group is required' });
  if (!/^\d{5}$/.test(semesterId)) return json(response, 400, { error: 'A five-digit semester ID is required' });

  const path = join(calendarDirectory, calendarFileName(group, semesterId));
  try {
    const fileStat = await stat(path);
    const age = Date.now() - fileStat.mtimeMs;
    if (age >= fileTtlMs) return json(response, 503, { error: 'Calendar is expired and is being refreshed' });
    response.writeHead(200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${calendarFileName(group, semesterId)}"`,
      'cache-control': `public, max-age=${Math.max(0, Math.floor((fileTtlMs - age) / 1000))}`,
    });
    return response.end(await readFile(path));
  } catch (error) {
    if (error.code !== 'ENOENT') return json(response, 500, { error: 'Could not read calendar file' });
    return json(response, syncInProgress ? 503 : 404, {
      error: syncInProgress ? 'Calendar is being generated' : 'Calendar not found',
    });
  }
});

server.listen(port, host, () => {
  console.log(`WATplan server listening on http://${host}:${port}`);
  syncCalendars().catch((error) => console.error('Initial calendar sync failed:', error));
  setInterval(() => {
    syncCalendars().catch((error) => console.error('Calendar sync failed:', error));
  }, syncIntervalMs).unref();
  setInterval(() => {
    pruneExpiredFiles().catch((error) => console.error('Calendar cleanup failed:', error));
  }, 60_000).unref();
});
