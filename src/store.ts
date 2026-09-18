import { defineStore } from "pinia";
import { startOfMonth } from "date-fns";
import { uniqBy, merge, unionBy } from "lodash";

export enum ViewMode {
    Day = 'day',
    Week = 'week',
    Month = 'month'
}

export interface Entry {
    title?: string;
    type?: string;
    room?: string[];
    date?: string;
    timeStart?: string;
    timeEnd?: string;
    num?: number;
    group?: string;
    hash?: string;
    prof?: string;
}

export interface Subject {
    title?: string;
    short?: string;
    color?: string;
    type?: string;
    prof?: string;
    numH?: number;
}

export interface Semester {
    id: string;
    name: string;
    start: string;
    end: string;
}

export interface Period {
    start: string;
    end: string;
}

export interface Note {
    hash: string;
    group: string | null;
    content: string;
    updated: number;
}

export type EntryMap = { [group: string]: Entry[] };
export type SubjectMap = { [group: string]: Subject[] };

export interface SemesterData {
    entries: EntryMap;
    subjects: SubjectMap;
}

export interface State {
    group: string;
    date: Date;
    data: {
        [id: string]: SemesterData;
    };
    readyIds: string[];
    recent: string[];
    loading: boolean;
    semesters: Semester[];
    periods: Period[];
    now: Date;
    mode: ViewMode;
    month: Date;
    search: string;
    searchType: string;
    subSearch: Entry | undefined;
    canSync: boolean;
    settings: {
        group: string;
        hideWeekends: boolean;
        forceWeekView: boolean;
        useMarkers: boolean;
        useCustomColors: boolean;
        defaultView: ViewMode;
        markers: {
            [key: string]: string;
        },
        customColors: {
            [key: string]: string;
        },
        id?: string;
        pinned: string[];
    };
    notes: Note[];
    privEvents: Entry[];
    transferred: {
        group: string;
        hash: string;
    }[];
    msg?: ReturnType<typeof useMessage>;
    loadingBar?: ReturnType<typeof useLoadingBar>;
}

const DATA_PATH = '/data';
const SEMESTERS_URL = `${DATA_PATH}/semesters.json`;
const DATA_CACHE = 'watplan-data-v1';
const LEGACY_CACHE = 'data';
const MAX_CACHED_FILES = 8;
const MAX_LOADED_SEMESTERS = 3;
const REVALIDATE_TTL = 5 * 60 * 1000;

const lastCheck = new Map<string, number>();
var pending: { key: string, promise: Promise<void> } | null = null;

function parseDay(day: string, endOfDay = false) {
    return new Date(`${day}T${endOfDay ? '23:59:59' : '00:00:00'}`);
}

function entriesUrl(id: string) {
    return `${DATA_PATH}/entries-${id}.json`;
}

function subjectsUrl(id: string) {
    return `${DATA_PATH}/subjects-${id}.json`;
}

async function openDataCache() {
    if (typeof caches === 'undefined')
        return undefined;
    try {
        return await caches.open(DATA_CACHE);
    } catch (err) {
        console.error(err);
        return undefined;
    }
}

function cacheOrder(): string[] {
    try {
        return JSON.parse(localStorage.getItem('dataCache') ?? '[]');
    } catch {
        return [];
    }
}

function touchCached(url: string) {
    const order = [url, ...cacheOrder().filter(u => u !== url)];
    localStorage.setItem('dataCache', JSON.stringify(order));
}

async function trimCache(cache: Cache) {
    const keep = cacheOrder().slice(0, MAX_CACHED_FILES);
    localStorage.setItem('dataCache', JSON.stringify(keep));
    for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path !== SEMESTERS_URL && !keep.includes(path))
            await cache.delete(req);
    }
}

async function loadJSON(url: string) {
    const cache = await openDataCache();
    const cached = await cache?.match(url);
    if (cached !== undefined) {
        touchCached(url);
        return cached.json();
    }
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok)
        throw new Error(`${url}: ${res.status}`);
    lastCheck.set(url, Date.now());
    if (cache !== undefined) {
        await cache.put(url, res.clone());
        touchCached(url);
        await trimCache(cache);
    }
    return res.json();
}

async function revalidateJSON(url: string, force = false) {
    const cache = await openDataCache();
    const cached = await cache?.match(url);
    if (cache === undefined || cached === undefined)
        return undefined;
    if (!force && Date.now() - (lastCheck.get(url) ?? 0) < REVALIDATE_TTL)
        return undefined;
    const headers: HeadersInit = {};
    const etag = cached.headers.get('etag');
    const modified = cached.headers.get('last-modified');
    if (etag !== null && etag !== '')
        headers['If-None-Match'] = etag;
    if (modified !== null)
        headers['If-Modified-Since'] = modified;
    if (Object.keys(headers).length === 0)
        return undefined;
    lastCheck.set(url, Date.now());
    const res = await fetch(url, { cache: 'no-store', headers });
    if (res.status === 304 || !res.ok)
        return undefined;
    await cache.put(url, res.clone());
    touchCached(url);
    return res.json();
}

async function loadSemester(id: string): Promise<SemesterData> {
    const [entries, subjects] = await Promise.all([
        loadJSON(entriesUrl(id)),
        loadJSON(subjectsUrl(id))
    ]);
    return { entries: entries ?? {}, subjects: subjects ?? {} };
}

async function loadSemesters(): Promise<Semester[]> {
    const cache = await openDataCache();
    try {
        const res = await fetch(SEMESTERS_URL, { cache: 'no-store' });
        if (res.ok) {
            await cache?.put(SEMESTERS_URL, res.clone());
            return await res.json();
        }
    } catch (err) {
        console.error(err);
    }
    const cached = await cache?.match(SEMESTERS_URL);
    if (cached !== undefined)
        return cached.json();
    return [];
}

export default defineStore('store', {
    state: (): State => ({
        group: 'WCY22IY1S1',
        date: new Date(),
        data: {},
        readyIds: [],
        recent: [],
        loading: false,
        periods: [
            { start: '08:00', end: '09:35' },
            { start: '09:50', end: '11:25' },
            { start: '11:40', end: '13:15' },
            { start: '13:30', end: '15:05' },
            { start: '16:00', end: '17:35' },
            { start: '17:50', end: '19:25' },
            { start: '19:40', end: '21:15' },
        ],
        now: new Date(),
        mode: ViewMode.Day,
        month: startOfMonth(new Date()),
        search: '',
        searchType: '',
        subSearch: undefined,
        semesters: [],
        canSync: false,
        settings: {
            group: '',
            hideWeekends: false,
            forceWeekView: false,
            useMarkers: false,
            useCustomColors: false,
            defaultView: ViewMode.Week,
            markers: {},
            customColors: {},
            pinned: []
        },
        notes: [],
        privEvents: [],
        transferred: []
    }),
    getters: {
        semesterIds: (state): string[] => {
            if (state.semesters.length === 0)
                return [];
            const date = state.date.getTime();
            const within = state.semesters.filter((s) => date >= parseDay(s.start).getTime() && date <= parseDay(s.end, true).getTime());
            if (within.length > 0)
                return within.map((s) => s.id);
            const next = state.semesters
                .filter((s) => parseDay(s.start).getTime() > date)
                .sort((a, b) => parseDay(a.start).getTime() - parseDay(b.start).getTime())[0];
            if (next !== undefined)
                return [next.id];
            const last = [...state.semesters].sort((a, b) => parseDay(a.end).getTime() - parseDay(b.end).getTime()).pop();
            return last !== undefined ? [last.id] : [];
        },
        activeSemesters(): Semester[] {
            return this.semesterIds
                .map((id) => this.semesters.find((s) => s.id === id))
                .filter((s) => s !== undefined) as Semester[];
        },
        entries(): EntryMap {
            if (this.readyIds.length === 1)
                return this.data[this.readyIds[0]]?.entries ?? {};
            var res: EntryMap = {};
            for (const id of this.readyIds) {
                const sem = this.data[id];
                if (sem === undefined) continue;
                for (const group in sem.entries) {
                    if (res[group] === undefined) res[group] = [];
                    res[group].push(...sem.entries[group]);
                }
            }
            for (const group in res)
                res[group] = uniqBy(res[group], x => x.hash!);
            return res;
        },
        subjects(): SubjectMap {
            if (this.readyIds.length === 1)
                return this.data[this.readyIds[0]]?.subjects ?? {};
            var res: SubjectMap = {};
            for (const id of this.readyIds) {
                const sem = this.data[id];
                if (sem === undefined) continue;
                for (const group in sem.subjects) {
                    if (res[group] === undefined) res[group] = [];
                    res[group].push(...sem.subjects[group]);
                }
            }
            for (const group in res)
                res[group] = uniqBy(res[group], x => (x.title! + x.short! + x.color! + x.type! + x.prof! + x.numH!));
            return res;
        },
        year(): string {
            const ids = this.readyIds.length > 0 ? this.readyIds : this.semesterIds;
            return (ids[ids.length - 1] ?? '').slice(0, 4);
        },
        groups(): string[] {
            return Object.keys(this.entries).sort();
        },
        gEntries(): Entry[] {
            return this.entries[this.group] ?? [];
        },
        gSubjects(): Subject[] {
            return this.subjects[this.group] ?? [];
        },
        subTypes(): string[] {
            return Array.from(new Set(this.gSubjects.map((sub) => sub.type ?? '')));
        },
        years: (state) => {
            return Array.from(new Set(state.semesters.map((semester) => semester.id.slice(0, 4))));
        },
        yearsText: (state) => {
            return Array.from(new Set(state.semesters.map((semester) => semester.name.slice(0, 7))));
        },
        yearsDates: (state) => {
            var res: { [key: string]: { start: Date, end: Date } } = {};
            state.semesters.forEach((semester) => {
                const start = new Date(semester.start);
                const end = new Date(semester.end);
                const year = semester.name.slice(0, 7);
                if (res[year] === undefined) res[year] = { start, end };
                else {
                    if (start < res[year].start) res[year].start = start;
                    if (end > res[year].end) res[year].end = end;
                }
            });
            return res;
        },
        monthMode: (state) => {
            return state.mode === ViewMode.Month;
        },
        transferredEntries(): Entry[] {
            if (this.group !== this.settings.group) return [];
            return (this.transferred?.map((t) => {
                let ent = this.entries[t.group]?.find((e) => e.hash === t.hash);
                if (ent !== undefined) ent.group = t.group;
                return ent
            }).filter((e) => e !== undefined) ?? []) as Entry[];
        }
    },
    actions: {
        getNotes(entry: Entry | undefined) {
            if (entry === undefined)
                return [];
            //console.log(entry.hash);
            try {
                var notes = this.notes.filter((note) => note.hash !== undefined && RegExp(note.hash.replace(':', ':(.*:)?')).test(entry.hash ?? ''));
                notes.sort((a, b) => b.updated - a.updated);
                return notes;
            } catch (err) {
                console.error(err);
                return [];
            }
        },
        loadState() {
            if (localStorage.getItem('settings') === null)
                return;
            this.group = localStorage.getItem('group') ?? 'WCY22IY1S1';
            this.settings = merge(this.settings, JSON.parse(localStorage.getItem('settings') ?? '{}'));
            this.notes = JSON.parse(localStorage.getItem('notes') ?? '[]');
            this.transferred = JSON.parse(localStorage.getItem('transferred') ?? '[]');
            localStorage.removeItem('year');
        },
        saveState(local = false) {
            localStorage.setItem('group', this.group);
            localStorage.setItem('settings', JSON.stringify(this.settings ?? {}));
            localStorage.setItem('notes', JSON.stringify(this.notes ?? []));
            localStorage.setItem('transferred', JSON.stringify(this.transferred ?? []));
            if (!local)
                this.pushSettings();
        },
        async pullSettings() {
          return;
            fetch(`${(import.meta.env.API_URL ?? 'https://api.watplan.coobie.dev')}/${this.settings.id}`).then((res) => res.json()).then((res) => {
                if (res.success) {
                    this.canSync = true;
                    this.settings = merge(this.settings, res.data.settings ?? {});
                    this.notes = unionBy(this.notes, res.data.notes ?? [], x => x.hash);
                    this.transferred = merge(this.transferred, res.data.transferred ?? [])
                }
                else
                    this.canSync = false;
            }).catch((err) => {
                this.canSync = false;
                console.error(err);
            });
        },
        async pushSettings() {
          return;
            fetch(`${(import.meta.env.API_URL ?? 'https://api.watplan.coobie.dev')}/${this.settings.id}`, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    settings: this.settings,
                    notes: this.notes,
                    transferred: this.transferred
                })
            }).then((res) => res.json()).then((res) => {
                if (res.success) {
                    this.canSync = true;
                }
                else
                    this.canSync = false;
            }).catch((err) => {
                this.canSync = false;
                console.error(err);
            });
        },
        async init() {
            if (typeof caches !== 'undefined')
                caches.delete(LEGACY_CACHE).catch((err) => console.error(err));
            const semesters = await loadSemesters();
            this.semesters = [...semesters].sort((a, b) => a.id.localeCompare(b.id));
            await this.ensureData();
        },
        ensureData(force = false) {
            const ids = this.semesterIds;
            const key = ids.join(',');
            if (!force && pending !== null && pending.key === key)
                return pending.promise;
            const promise = this.loadScope(ids, force).finally(() => {
                if (pending !== null && pending.promise === promise)
                    pending = null;
            });
            pending = { key, promise };
            return promise;
        },
        async loadScope(ids: string[], force = false) {
            if (ids.length === 0)
                return;
            const missing = force ? ids : ids.filter((id) => this.data[id] === undefined);
            if (missing.length > 0) {
                this.loading = true;
                this.loadingBar?.start();
                try {
                    const loaded = await Promise.all(missing.map(async (id) => [id, await loadSemester(id)] as const));
                    loaded.forEach(([id, data]) => { this.data[id] = data; });
                    this.loadingBar?.finish();
                } catch (err) {
                    console.error(err);
                    this.loadingBar?.error();
                    this.msg?.error('Nie udało się pobrać planu. Sprawdź połączenie.');
                } finally {
                    this.loading = false;
                }
            }
            const ready = ids.filter((id) => this.data[id] !== undefined);
            if (ready.length === 0 && this.readyIds.length > 0)
                return;
            this.readyIds = ready;
            this.recent = [...ready, ...this.recent.filter((id) => !ready.includes(id))];
            this.prune();
            this.checkUpdates(ready);
        },
        prune() {
            const keep = this.recent.slice(0, MAX_LOADED_SEMESTERS);
            for (const id in this.data) {
                if (!keep.includes(id))
                    delete this.data[id];
            }
            this.recent = keep;
        },
        async checkUpdates(ids: string[], force = false) {
            var changed = false;
            for (const id of ids) {
                try {
                    const [entries, subjects] = await Promise.all([
                        revalidateJSON(entriesUrl(id), force),
                        revalidateJSON(subjectsUrl(id), force)
                    ]);
                    if (entries === undefined && subjects === undefined)
                        continue;
                    this.data[id] = {
                        entries: entries ?? this.data[id]?.entries ?? {},
                        subjects: subjects ?? this.data[id]?.subjects ?? {}
                    };
                    changed = true;
                } catch (err) {
                    console.error(err);
                }
            }
            return changed;
        },
        async refresh() {
            this.loadingBar?.start();
            try {
                const semesters = await loadSemesters();
                if (semesters.length > 0)
                    this.semesters = [...semesters].sort((a, b) => a.id.localeCompare(b.id));
                await this.ensureData();
                const changed = await this.checkUpdates(this.readyIds, true);
                this.loadingBar?.finish();
                this.msg?.success(changed ? 'Plan został zaktualizowany.' : 'Plan jest aktualny.');
            } catch (err) {
                console.error(err);
                this.loadingBar?.error();
                this.msg?.error('Nie udało się odświeżyć planu.');
            }
        },
        goToYear(year: string) {
            const semesters = this.semesters
                .filter((s) => s.id.startsWith(year))
                .sort((a, b) => parseDay(a.start).getTime() - parseDay(b.start).getTime());
            if (semesters.length === 0)
                return;
            const now = new Date();
            const current = semesters.find((s) => now >= parseDay(s.start) && now <= parseDay(s.end, true));
            this.date = current !== undefined ? now : parseDay(semesters[0].start);
            this.month = startOfMonth(this.date);
        },
        subColor(sub: Subject) {
            if (this.settings.useCustomColors)
                return this.settings.customColors[sub.title!];
            return undefined;
        },
        generateID() {
            this.settings.id = ''
            var sum = 0
            for (var i = 0; i < 11; i++) {
                var n = Math.random().toString(36).substring(2, 3)
                if (Math.random() > 0.5) n = n.toUpperCase()
                this.settings.id += n
                sum += parseInt(n, 36)
            }
            this.settings.id += (sum % 36).toString(36)
        },
        checkID(id: string) {
            if (id.match(/^[a-z0-9]{12}$/i) === null) return false
            var sum = 0
            for (var i = 0; i < 11; i++) {
                sum += parseInt(id[i], 36)
            }
            return id[11] == (sum % 36).toString(36)
        },
        togglePinned(group: string) {
            if (this.settings.pinned.includes(group))
                this.settings.pinned = this.settings.pinned.filter((g) => g !== group);
            else
                this.settings.pinned.push(group);
        }
    }
});
