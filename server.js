import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';
const dataBaseUrl = (process.env.DATA_BASE_URL ?? 'https://watplan.coobie.dev/data').replace(/\/$/, '');
const calendarDirectory = process.env.CALENDAR_DIRECTORY ?? './data/ics';
const syncIntervalMs = 15 * 60 * 1000;
const fileTtlMs = 15 * 60 * 1000;
let syncInProgress;

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
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

function compactDate(date) {
  return String(date ?? '').replaceAll('_', '').replaceAll('-', '');
}

function eventDateTime(date, time) {
  const day = compactDate(date);
  const clock = String(time ?? '').replace(':', '');
  if (!/^\d{8}$/.test(day) || !/^\d{4}$/.test(clock)) return undefined;
  return `${day}T${clock}00`;
}

function makeEvent(group, entry) {
  const start = eventDateTime(entry.date, entry.timeStart);
  const end = eventDateTime(entry.date, entry.timeEnd);
  if (!start || !end) return undefined;

  const uid = entry.hash || createHash('sha256')
    .update(`${group}|${start}|${entry.title ?? ''}|${entry.num ?? ''}`)
    .digest('hex');
  const description = [
    entry.type,
    entry.prof && `Prowadzący: ${entry.prof}`,
    entry.group && `Grupa: ${entry.group}`,
    entry.num !== undefined && `Numer zajęć: ${entry.num}`,
  ].filter(Boolean).join('\n');

  return [
    'BEGIN:VEVENT',
    `UID:${escapeIcs(uid)}@watplan`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART;TZID=Europe/Warsaw:${start}`,
    `DTEND;TZID=Europe/Warsaw:${end}`,
    `SUMMARY:${escapeIcs(entry.title || 'Zajęcia')}`,
    ...(entry.room?.length ? [`LOCATION:${escapeIcs(entry.room.join(', '))}`] : []),
    ...(description ? [`DESCRIPTION:${escapeIcs(description)}`] : []),
    'END:VEVENT',
  ].join('\r\n');
}

function makeCalendar(group, semester, entries) {
  const events = entries
    .map((entry) => makeEvent(group, entry))
    .filter(Boolean);
  return [
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
    ...events,
    'END:VCALENDAR',
    '',
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
  await Promise.all(files.filter((file) => file.isFile() && file.name.endsWith('.ics')).map(async (file) => {
    const path = join(calendarDirectory, file.name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs >= fileTtlMs) await unlink(path);
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
    for (const { semester, entries, subjects } of semesterData) {
      for (const group of new Set([...Object.keys(entries), ...Object.keys(subjects)])) {
        if (!validGroup(group)) continue;
        const fileName = calendarFileName(group, semester.id);
        const path = join(calendarDirectory, fileName);
        const temporaryPath = `${path}.tmp`;
        await writeFile(temporaryPath, makeCalendar(group, semester, entries[group] ?? []), 'utf8');
        await rename(temporaryPath, path);
        generated++;
      }
    }

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
  if (url.pathname === '/health')
    return json(response, 200, { status: 'ok', syncing: Boolean(syncInProgress) });
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
