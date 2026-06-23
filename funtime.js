'use strict';

/**
 * FunTime events checker — VPS port of the site's `lib/funtime-events.ts`.
 *
 * The site ran this on Vercel (serverless), so it needed a Postgres cache + locks to survive cold
 * starts. On this persistent VPS process we drop the database entirely: a single background poller
 * refreshes from the FunTime API once per second and keeps the snapshot in memory. Every client read
 * is served instantly from that snapshot, so the FunTime API sees exactly one refresh per second
 * regardless of how many players are connected.
 *
 * Token: seeded from FUNTIME_API_TOKEN, settable at runtime via the admin endpoint, and persisted to
 * a small file (FUNTIME_TOKEN_FILE, default `.funtime-token`) so it survives restarts.
 *
 * All parsing / translation / filtering helpers below are ported verbatim from funtime-events.ts.
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.funtime.su';
const REQUEST_INTERVAL_MS = 667;
const FUNTIME_REQUEST_TIMEOUT_MS = 9000;
const FUNTIME_REQUEST_RETRIES = 3;
const BATCH_LIMIT = 30;

const POLL_MS = parseInt(process.env.FUNTIME_POLL_MS || '1000', 10);
const TOKEN_FILE = process.env.FUNTIME_TOKEN_FILE || path.join(__dirname, '.funtime-token');

// ------------------------------ module state -----------------------------

let cache = null; // { fetchedAt, raw, entries, error, success }
let token = '';
let polling = false;
let pollTimer = null;

function now() {
   return Date.now();
}

function sleep(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------ token handling ---------------------------

function envToken() {
   return (process.env.FUNTIME_API_TOKEN || '').trim();
}

function loadToken() {
   try {
      const fileToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (fileToken) {
         token = fileToken;
         return token;
      }
   } catch {
      // no token file yet — fall back to env
   }
   token = envToken();
   return token;
}

function persistToken(value) {
   try {
      fs.writeFileSync(TOKEN_FILE, value, { mode: 0o600 });
   } catch {
      // best-effort; token still lives in memory for this process
   }
}

function setToken(value) {
   const normalized = (value || '').trim();
   token = normalized;
   persistToken(normalized);
   cache = null;
   // kick a fresh refresh in the background; caller doesn't need to await it
   refresh().catch(() => undefined);
   return {
      configured: normalized.length > 0,
      tokenPreview: tokenPreview(normalized),
   };
}

function tokenPreview(value) {
   if (!value) return '';
   if (value.length <= 12) return value;
   return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

// ------------------------------ public surface ---------------------------

function normalizeFunTimeMode(value) {
   if (value === 'upcoming' || value === 'mines') return value;
   return 'current';
}

function nextRefreshInMs() {
   if (!cache) return 0;
   return Math.max(0, REQUEST_INTERVAL_MS - (now() - cache.fetchedAt));
}

function getSnapshot(modeRaw) {
   const mode = normalizeFunTimeMode(modeRaw);
   const state = cache || { fetchedAt: 0, raw: '', entries: [], error: 'FunTime events not loaded yet', success: false };
   const entries = filterByMode(mode, state.entries);

   return {
      success: state.success,
      error: state.error,
      entries,
      raw: state.raw,
      updatedAt: state.fetchedAt,
      mode,
      source: state.entries.length ? (now() - state.fetchedAt < REQUEST_INTERVAL_MS ? 'cache' : 'fresh') : 'empty',
      nextRefreshInMs: nextRefreshInMs(),
   };
}

function getAdminState() {
   return {
      configured: token.length > 0,
      tokenPreview: tokenPreview(token),
      cachedAt: cache ? cache.fetchedAt : null,
      cachedEntries: cache ? cache.entries.length : 0,
      cacheSuccess: cache ? cache.success : false,
      cacheError: cache ? cache.error : null,
      pollMs: POLL_MS,
      nextRefreshInMs: nextRefreshInMs(),
   };
}

async function forceRefresh() {
   await refresh();
   return getSnapshot('current');
}

function startPoller() {
   loadToken();
   if (pollTimer) return;
   // prime once immediately, then poll on the interval
   refresh().catch(() => undefined);
   pollTimer = setInterval(() => {
      refresh().catch(() => undefined);
   }, POLL_MS);
   pollTimer.unref();
}

// ------------------------------ refresh core -----------------------------

async function refresh() {
   if (polling) return cache; // a refresh is already in flight — skip this tick
   polling = true;
   const fetchedAt = now();
   try {
      if (!token) {
         cache = {
            fetchedAt,
            raw: '',
            entries: [],
            error: 'FunTime token is not configured',
            success: false,
         };
         return cache;
      }

      const servers = await fetchServers(token);
      const eventEntries = await fetchEvents(token, servers);
      const mineResult = await fetchMines(token, servers);
      const entries = dedupe([...eventEntries, ...mineResult.entries]);

      cache = {
         fetchedAt,
         raw: JSON.stringify({
            servers: servers.length,
            events: eventEntries.length,
            mines: mineResult.entries.length,
            mineErrors: mineResult.errors.slice(0, 4),
            entries: entries.length,
         }),
         entries,
         error: null,
         success: true,
      };
      return cache;
   } catch (error) {
      // keep the last good snapshot if we have one; only overwrite when nothing usable exists
      const failure = {
         fetchedAt,
         raw: '',
         entries: cache && cache.success ? cache.entries : [],
         error: error instanceof Error ? error.message : 'FunTime API request failed',
         success: false,
      };
      if (!cache || !cache.success) {
         cache = failure;
      } else {
         // preserve good entries but surface the error + bump the timestamp
         cache = { ...cache, fetchedAt, error: failure.error };
      }
      return cache;
   } finally {
      polling = false;
   }
}

class PermanentFunTimeError extends Error {}

async function funtimeRequest(authToken, reqPath) {
   let lastError = null;

   for (let attempt = 0; attempt < FUNTIME_REQUEST_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FUNTIME_REQUEST_TIMEOUT_MS);

      try {
         const response = await fetch(`${BASE_URL}${reqPath}`, {
            cache: 'no-store',
            signal: controller.signal,
            headers: {
               Accept: 'application/json',
               'User-Agent': 'Moonlight-VPS/1.0',
               'authorization-token': authToken,
            },
         });

         const text = await response.text();
         if (response.status === 401 || response.status === 403) {
            throw new PermanentFunTimeError(`FunTime authorization failed: HTTP ${response.status}`);
         }
         if (response.status === 402) {
            throw new PermanentFunTimeError('FunTime token request limit reached');
         }
         if (!response.ok) {
            throw new Error(`FunTime HTTP ${response.status}`);
         }
         const payload = text ? JSON.parse(text) : {};
         if (payload && typeof payload === 'object' && payload.success === false) {
            const message = typeof payload['error-message'] === 'string' ? payload['error-message'] : 'FunTime API returned an error';
            throw new Error(message);
         }
         return payload;
      } catch (error) {
         lastError = error;
         if (error instanceof PermanentFunTimeError || attempt === FUNTIME_REQUEST_RETRIES - 1) {
            throw error;
         }
         await sleep(220 + attempt * 280);
      } finally {
         clearTimeout(timeout);
      }
   }

   throw lastError instanceof Error ? lastError : new Error('FunTime API request failed');
}

async function fetchServers(authToken) {
   const payload = await funtimeRequest(authToken, '/method/servers-info?server-type=anarchy');
   const response = Array.isArray(payload && payload.response) ? payload.response : [];
   const servers = response
      .map((item) => normalizeServer(String(item == null ? '' : item)))
      .filter(isAllowedServer);
   return uniqueSorted(servers);
}

async function fetchEvents(authToken, servers) {
   const entries = [];
   for (let index = 0; index < servers.length; index += BATCH_LIMIT) {
      const chunk = servers.slice(index, index + BATCH_LIMIT).join(',');
      const payload = await funtimeRequest(
         authToken,
         `/method/events-info?event-type=all&server-type=${encodeURIComponent(chunk)}`
      );
      collect(entries, payload, '', '/method/events-info', false);
   }
   return entries.filter((entry) => isAllowedServer(entry.server) && !isHiddenEvent(entry));
}

async function fetchMines(authToken, servers) {
   const entries = [];
   const errors = [];

   try {
      const payload = await funtimeRequest(authToken, '/method/mines-info?server-types=anarchy');
      collect(entries, payload, '', '/method/mines-info', true);
   } catch (error) {
      errors.push(error instanceof Error ? error.message : 'mines-info failed');
   }

   if (entries.length > 0) {
      return {
         entries: entries.filter((entry) => isAllowedServer(entry.server)),
         errors,
      };
   }

   for (let index = 0; index < servers.length; index += BATCH_LIMIT) {
      const chunk = servers.slice(index, index + BATCH_LIMIT).join(',');
      try {
         const payload = await funtimeRequest(
            authToken,
            `/method/mines-info?server-types=${encodeURIComponent(chunk)}`
         );
         collect(entries, payload, '', '/method/mines-info', true);
      } catch (error) {
         errors.push(error instanceof Error ? error.message : 'mines-info chunk failed');
      }
   }

   return {
      entries: entries.filter((entry) => isAllowedServer(entry.server)),
      errors,
   };
}

// ------------------------------ parsing (verbatim) -----------------------

function collect(out, value, serverHint, source, mine, runningHint = null) {
   if (value == null) return;
   if (Array.isArray(value)) {
      for (const item of value) collect(out, item, serverHint, source, mine, runningHint);
      return;
   }
   if (typeof value !== 'object') return;

   const map = value;
   const server = normalizeServer(firstString(map, 'server', 'server-type', 'serverType', 'anarchy') || serverHint);

   for (const key of ['response', 'events', 'items', 'data', 'result', 'servers', 'current', 'running', 'active', 'upcoming', 'future', 'pending', 'mines', 'mine', 'list']) {
      const child = getIgnoreCase(map, key);
      if (Array.isArray(child) || (child && typeof child === 'object')) {
         collect(out, child, server, source, mine, branchRunningHint(key, runningHint));
      }
   }

   if (looksLikeEntry(map, mine)) {
      const entry = entryOf(map, server, source, mine, runningHint);
      if (entry) out.push(entry);
      return;
   }

   for (const [key, child] of Object.entries(map)) {
      const nestedServer = looksLikeServerKey(key) ? normalizeServer(key) : server;
      collect(out, child, nestedServer, source, mine, branchRunningHint(key, runningHint));
   }
}

function looksLikeEntry(map, mine) {
   const keys = mine
      ? ['id', 'name', 'title', 'mine', 'mine-name', 'mineName', 'mine-type', 'mineType', 'mine-rarity', 'mineRarity', 'next-mine-rarity', 'nextMineRarity', 'reset-seconds-left', 'resetSecondsLeft', 'time-second', 'time-seconds-left', 'time', 'timer', 'left', 'remaining', 'rarity', 'quality', 'loot', 'coordinates', 'coords']
      : ['id', 'name', 'title', 'event', 'event-name', 'eventName', 'type', 'event-type', 'eventType', 'time-second', 'time-seconds-left', 'time', 'timer', 'left', 'remaining', 'phase', 'status', 'state', 'coordinates', 'coords'];
   return keys.some((key) => getIgnoreCase(map, key) != null);
}

function entryOf(map, server, source, mine, runningHint = null) {
   let name = firstGoodName(map, mine);
   const status = statusOf(map);
   const loot = mine ? mineRarityOf(map) : firstString(map, 'loot', 'rarity', 'quality', 'type', 'event-type', 'eventType');
   const timeSeconds = parseSeconds(firstString(map, 'time-second', 'time-seconds-left', 'time_seconds_left', 'seconds_left', 'reset-seconds-left', 'resetSecondsLeft', 'time', 'timer', 'left', 'remaining', 'delay'));
   const running = isRunning(status, timeSeconds, mine, eventRunningHint(map, runningHint));

   if (mine) {
      name = translateMineRarity(loot, name) || name || 'Авто-шахта';
   } else {
      name = translateEventName(name || 'Ивент');
   }

   if (mine) {
      name = translateNextMineRarity(loot) || 'Авто-шахта';
   }

   const coords = coordsOf(map);
   const details = [
      timeSeconds > 0 ? `${running ? 'осталось' : 'через'} ${formatSeconds(timeSeconds)}` : '',
      shouldShowStatus(status) ? `статус: ${translateStatus(status)}` : '',
      coords ? `коорд: ${coords}` : '',
   ].filter(Boolean).join(' • ');

   return {
      server: normalizeServer(server),
      name,
      details,
      coords,
      source,
      status,
      timeSeconds,
      mine,
      running,
   };
}

function filterByMode(mode, entries) {
   const filtered = entries.filter((entry) => {
      if (!isAllowedServer(entry.server)) return false;
      if (mode === 'mines') return entry.mine && !entry.running && entry.timeSeconds > 0;
      if (mode === 'upcoming') return !entry.mine && !entry.running && entry.timeSeconds > 0;
      return !entry.mine && entry.running && (entry.timeSeconds > 0 || isCurrentStatus(entry.status));
   });

   return sortForMode(mode, filtered);
}

function sortForMode(mode, entries) {
   return [...entries].sort((a, b) => {
      if (mode === 'mines') {
         const priority = minePriority(b) - minePriority(a);
         if (priority) return priority;
      }
      const server = serverNumber(a.server) - serverNumber(b.server);
      if (server) return server;
      const time = normalizeTime(a.timeSeconds) - normalizeTime(b.timeSeconds);
      if (time) return time;
      return a.name.localeCompare(b.name, 'ru');
   });
}

function dedupe(entries) {
   const map = new Map();
   for (const entry of entries) {
      const key = `${normalizeServer(entry.server)}|${entry.name.toLowerCase()}|${entry.timeSeconds}|${entry.running}|${entry.mine ? 'm' : 'e'}`;
      const current = map.get(key);
      if (!current || scoreEntry(entry) > scoreEntry(current)) {
         map.set(key, entry);
      }
   }
   return [...map.values()];
}

function scoreEntry(entry) {
   return (entry.details ? 10 : 0) + (entry.coords ? 5 : 0) + (entry.status ? 5 : 0) + (entry.timeSeconds >= 0 ? 10 : 0);
}

function normalizeTime(value) {
   return value < 0 ? Number.MAX_SAFE_INTEGER : value;
}

function minePriority(entry) {
   const text = `${entry.name} ${entry.status} ${entry.details}`.toLowerCase().replace('ё', 'е');
   if (text.includes('легендар')) return 300;
   if (text.includes('миф')) return 250;
   if (text.includes('эпич')) return 200;
   if (text.includes('редк')) return 150;
   if (text.includes('обыч')) return 100;
   return 0;
}

function isHiddenEvent(entry) {
   const text = `${entry.name} ${entry.details} ${entry.source}`.toLowerCase().replace('ё', 'е');
   const compact = text.replace(/[_\-\s]/g, '');
   if (text.includes('загадоч') && text.includes('маяк')) return true;
   if (compact.includes('mysterybeacon') || compact.includes('mysteriousbeacon') || compact.includes('mystbeacon') || compact.includes('mysticbeacon')) return true;
   if (compact.includes('airdrop') || text.includes('air drop') || compact.includes('аирдроп') || compact.includes('эйрдроп')) return true;
   return compact.includes('altar') || compact.includes('altars') || compact.includes('алтар');
}

function firstGoodName(map, mine) {
   const keys = mine
      ? ['loot', 'rarity', 'quality', 'name', 'title', 'mine', 'mine-name', 'mineName', 'id', 'mine-type', 'mineType', 'type']
      : ['name', 'title', 'event-name', 'eventName', 'id', 'event', 'type', 'event-type'];

   for (const key of keys) {
      const value = valueToString(getIgnoreCase(map, key));
      if (goodName(value)) return value;
   }
   return '';
}

function firstString(map, ...keys) {
   for (const key of keys) {
      const value = valueToString(getIgnoreCase(map, key));
      if (value) return value;
   }
   return '';
}

function mineRarityOf(map) {
   return firstString(
      map,
      'next-mine-rarity',
      'nextMineRarity',
      'next_mine_rarity',
      'next-rarity',
      'nextRarity',
      'mine-rarity',
      'mineRarity',
      'mine_rarity',
      'rarity',
      'quality',
      'loot',
      'mine-type',
      'mineType'
   );
}

function statusOf(map) {
   const direct = firstString(map, 'phase', 'status', 'state', 'event-status', 'eventStatus');
   if (isStatusLike(direct)) return direct;

   for (const key of ['event-state', 'eventState', 'type', 'event-type', 'eventType']) {
      const value = firstString(map, key);
      if (isStatusLike(value)) return value;
   }

   return '';
}

function getIgnoreCase(map, key) {
   const lower = key.toLowerCase();
   const found = Object.entries(map).find(([entryKey]) => entryKey.toLowerCase() === lower);
   return found ? found[1] : undefined;
}

function valueToString(value) {
   if (value == null || typeof value === 'object') return '';
   return String(value).trim();
}

function goodName(value) {
   if (!value) return false;
   const lower = value.toLowerCase();
   if (['system', 'user', 'all', 'event', 'events', 'running'].includes(lower)) return false;
   if (lower.startsWith('anarchy') || /^\d+$/.test(lower)) return false;
   return lower.length >= 3;
}

function translateEventName(value) {
   const text = value.trim();
   const lower = text.toLowerCase().replace('ё', 'е');
   const compact = lower.replace(/[_\-\s]/g, '');
   const dictionary = {
      vulkan: 'Вулкан',
      volcano: 'Вулкан',
      meteor: 'Метеорит',
      meteorite: 'Метеорит',
      beaconkiller: 'Маяк убийца',
      killerbeacon: 'Маяк убийца',
      mysterybeacon: 'Загадочный маяк',
      mysteriousbeacon: 'Загадочный маяк',
      mystbeacon: 'Загадочный маяк',
      airdrop: 'Аирдроп',
      altar: 'Алтарь',
      altars: 'Алтари',
      geyser: 'Гейзер',
      dragon: 'Дракон',
      boss: 'Босс',
      treasure: 'Сокровище',
      cargo: 'Груз',
      convoy: 'Конвой',
      ship: 'Корабль',
      pirate: 'Пиратский ивент',
      arena: 'Арена',
      duel: 'Дуэль',
      king: 'Король',
   };
   if (dictionary[compact]) return dictionary[compact];
   if (compact.includes('beacon')) return 'Маяк';
   if (compact.includes('airdrop')) return 'Аирдроп';
   if (containsCyrillic(text)) return text;
   return text.replace(/[_-]/g, ' ').replace(/(?<=[a-z])(?=[A-Z])/g, ' ');
}

function translateNextMineRarity(loot) {
   const text = loot.toLowerCase().replace('ё', 'е');
   const compact = text.replace(/[_\-\s]/g, '');
   if (compact.includes('legendary') || text.includes('легендар')) return 'Легендарная';
   if (compact.includes('myth') || text.includes('миф')) return 'Мифическая';
   if (compact.includes('epic') || text.includes('эпич')) return 'Эпическая';
   if (compact.includes('rare') || text.includes('редк')) return 'Редкая';
   if (compact.includes('default') || compact.includes('common') || text.includes('обыч')) return 'Обычная';
   return '';
}

function translateMineRarity(loot, name) {
   const text = `${loot} ${name}`.toLowerCase().replace('ё', 'е');
   const compact = text.replace(/[_\-\s]/g, '');
   if (compact.includes('legendary') || text.includes('легендар')) return 'Легендарная';
   if (compact.includes('myth') || text.includes('миф')) return 'Мифическая';
   if (compact.includes('epic') || text.includes('эпич')) return 'Эпическая';
   if (compact.includes('rare') || text.includes('редк')) return 'Редкая';
   if (compact.includes('default') || compact.includes('common') || text.includes('обыч')) return 'Обычная';
   if (compact.includes('automine') || compact.includes('mine')) return 'Авто-шахта';
   return containsCyrillic(name) ? name : '';
}

function translateStatus(value) {
   const lower = value.toLowerCase().replace('ё', 'е');
   if (lower.includes('opened') || lower === 'open') return 'открыт';
   if (lower.includes('running') || lower.includes('active')) return 'идёт';
   if (lower.includes('activating')) return 'активация';
   if (lower.includes('starting') || lower.includes('pending') || lower.includes('queued')) return 'ожидается';
   if (lower.includes('finished') || lower.includes('done') || lower.includes('ended') || lower.includes('closed')) return 'завершён';
   return value;
}

function eventRunningHint(map, fallback) {
   const phase = firstString(map, 'phase', 'status', 'state').toLowerCase().replace(/[_\-\s]/g, '');
   if (phase.includes('finished') || phase.includes('ended') || phase.includes('closed') || phase.includes('done')) return false;
   if (phase.includes('looting') || phase.includes('running') || phase.includes('active') || phase.includes('activating') || phase.includes('opened') || phase === 'open') return true;
   if (phase.includes('pending') || phase.includes('queued') || phase.includes('soon') || phase.includes('waiting')) return false;

   const type = firstString(map, 'event-type', 'eventType', 'event_type', 'type').toLowerCase().replace(/[_\-\s]/g, '');
   if (type === 'user' || type === 'current' || type === 'running' || type === 'active') return true;
   if (type === 'system' || type === 'upcoming' || type === 'future' || type === 'pending') return false;

   return fallback;
}

function isRunning(status, timeSeconds, mine, runningHint = null) {
   if (runningHint !== null) return runningHint;
   const lower = status.toLowerCase().replace('ё', 'е');
   if (lower.includes('finished') || lower.includes('done') || lower.includes('ended') || lower.includes('closed') || lower.includes('заверш')) return false;
   if (lower.includes('starting') || lower.includes('ожидан') || lower.includes('soon') || lower.includes('pending') || lower.includes('queued')) return false;
   if (lower.includes('activating')) return timeSeconds > 0;
   if (lower.includes('opened') || lower === 'open' || lower.includes('running') || lower.includes('active') || lower.includes('started') || lower.includes('current') || lower.includes('process') || lower.includes('идет') || lower.includes('актив')) return timeSeconds > 0;
   if (runningHint !== null) return runningHint && timeSeconds !== 0;
   if (mine) return false;
   return timeSeconds === 0;
}

function isCurrentStatus(status) {
   const lower = status.toLowerCase().replace('ё', 'е');
   return lower.includes('opened')
      || lower === 'open'
      || lower.includes('running')
      || lower.includes('active')
      || lower.includes('started')
      || lower.includes('current')
      || lower.includes('process')
      || lower.includes('activating')
      || lower.includes('идет')
      || lower.includes('актив');
}

function isStatusLike(value) {
   if (!value) return false;
   const lower = value.toLowerCase().replace('ё', 'е');
   if (['system', 'user', 'all', 'event', 'events'].includes(lower)) return false;
   return lower.includes('opened')
      || lower === 'open'
      || lower.includes('running')
      || lower.includes('active')
      || lower.includes('started')
      || lower.includes('current')
      || lower.includes('process')
      || lower.includes('activating')
      || lower.includes('starting')
      || lower.includes('pending')
      || lower.includes('queued')
      || lower.includes('soon')
      || lower.includes('finished')
      || lower.includes('closed')
      || lower.includes('done')
      || lower.includes('ended')
      || lower.includes('идет')
      || lower.includes('актив')
      || lower.includes('ожидан')
      || lower.includes('заверш');
}

function shouldShowStatus(value) {
   if (!value) return false;
   const lower = value.toLowerCase();
   return !['system', 'user', 'all', 'event', 'events'].includes(lower);
}

function branchRunningHint(key, fallback) {
   const normalized = key.toLowerCase().replace(/[_\-\s]/g, '');
   if (['current', 'running', 'active', 'started', 'process', 'now', 'opened', 'open', 'looting'].includes(normalized)) return true;
   if (['upcoming', 'future', 'pending', 'queued', 'soon', 'next'].includes(normalized)) return false;
   return fallback;
}

function coordsOf(map) {
   const direct = getIgnoreCase(map, 'coordinates') ?? getIgnoreCase(map, 'coords') ?? getIgnoreCase(map, 'position');
   if (Array.isArray(direct)) return direct.join(', ');
   if (direct && typeof direct === 'object') return JSON.stringify(direct);
   const stringValue = valueToString(direct);
   if (stringValue) return stringValue;
   const x = firstString(map, 'x');
   const y = firstString(map, 'y');
   const z = firstString(map, 'z');
   if (x && z) return y ? `${x}, ${y}, ${z}` : `${x}, ${z}`;
   return '';
}

function looksLikeServerKey(value) {
   return /(?:anarchy|анарх)[^0-9]*\d+/i.test(value);
}

function normalizeServer(value) {
   const lower = value.toLowerCase().replace('анархия', 'anarchy').replace(/[-_\s]/g, '');
   const match = lower.match(/.*?anarchy(\d+).*/);
   if (match) return `anarchy${match[1]}`;
   const digits = lower.match(/.*?(\d+).*/);
   if (digits) return `anarchy${digits[1]}`;
   return lower;
}

function serverNumber(value) {
   const match = String(value).match(/(\d+)/);
   return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function uniqueSorted(values) {
   return [...new Set(values.filter(isAllowedServer))].sort((a, b) => {
      const diff = serverNumber(a) - serverNumber(b);
      return diff || a.localeCompare(b);
   });
}

function isAllowedServer(value) {
   const number = serverNumber(value);
   return Number.isFinite(number) && number > 0 && number < 1000;
}

function parseSeconds(value) {
   if (!value) return -1;
   const normalized = value.replace(/[^0-9.-]/g, '');
   if (!normalized) return -1;
   const seconds = Number.parseFloat(normalized);
   if (!Number.isFinite(seconds)) return -1;
   return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(seconds)));
}

function formatSeconds(value) {
   if (value < 0) return '?';
   const hours = Math.floor(value / 3600);
   const minutes = Math.floor((value % 3600) / 60);
   const seconds = value % 60;
   if (hours > 0) return `${hours}ч ${String(minutes).padStart(2, '0')}м`;
   if (minutes > 0) return `${minutes}м ${String(seconds).padStart(2, '0')}с`;
   return `${seconds}с`;
}

function containsCyrillic(value) {
   return /[А-Яа-яЁё]/.test(value);
}

module.exports = {
   startPoller,
   getSnapshot,
   getAdminState,
   setToken,
   forceRefresh,
   normalizeFunTimeMode,
};
