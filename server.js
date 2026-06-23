'use strict';

/**
 * MoonLight "Community" markers backend (minimal reference — `site/` is the full thing).
 *
 * Zero-dependency Node.js HTTP server. Same party-scoped marker logic as the site, without the
 * web dashboard. Markers are PRIVATE: a marker is only shown to a viewer who shares the owner's
 * party AND is on the same game mode. Markers always expire 120 seconds after placement.
 *
 *   POST /api/markers          { server, owner, mode?, x, y, z, color?, label? }  -> { ok, id, expiresAt }
 *   GET  /api/markers?server=&viewer=&mode=                                        -> { ok, markers: [...] }
 *   POST /api/markers/delete   { server, id, viewer? }                            -> { ok }
 *   POST /api/party/invite     { server, player, target }                         -> { ok }
 *   POST /api/party/accept     { server, player, target? }                        -> { ok, party }
 *   POST /api/party/decline    { server, player, target }                         -> { ok }
 *   POST /api/party/leave      { server, player }                                 -> { ok }
 *   GET  /api/party?server=&player=                                               -> { ok, party, invites }
 *   GET  /api/client/funtime/events?mode=current|upcoming|mines                   -> { success, entries, ... }
 *   POST /api/admin/funtime    { secret, action:"token"|"refresh", token? }        -> { ok, ...adminState }
 *   GET  /api/irc/messages?since=<id>                                              -> { ok, messages, lastId, now }
 *   POST /api/irc/send         { user, text }                                      -> { ok, id }
 *   POST /api/users/heartbeat  { user }                                            -> { ok, count, users }
 *   GET  /api/users/online                                                         -> { ok, count, users }
 *   POST /api/configs/share    { owner, name, data }                               -> { ok, code }   (5/owner, 8-digit)
 *   GET  /api/configs/get?code=XXXXXXXX                                            -> { ok, name, data, owner }
 *   GET  /api/configs/list?owner=                                                  -> { ok, configs:[...] }
 *   POST /api/configs/delete   { owner, code }                                     -> { ok }
 *
 * Run:   PORT=8080 node server.js
 * Health check:  GET /            -> { ok, markers, servers, parties }
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const funtime = require('./funtime');

const PORT = parseInt(process.env.PORT || '8080', 10);
const FUNTIME_ADMIN_SECRET = (process.env.FUNTIME_ADMIN_SECRET || '').trim();
const MARKER_TTL_SECONDS = parseInt(process.env.MARKER_TTL || '120', 10); // hard 120s lifetime
const INVITE_TTL_SECONDS = parseInt(process.env.INVITE_TTL || '120', 10);
const MAX_MARKERS_PER_SERVER = parseInt(process.env.MAX_PER_SERVER || '256', 10);
const MAX_MARKERS_PER_OWNER = parseInt(process.env.MAX_PER_OWNER || '5', 10); // one player keeps at most 5 markers
const MAX_BODY_BYTES = 16 * 1024;

// ------------------------------ cloud configs ----------------------------

const CONFIG_CODE_DIGITS = parseInt(process.env.CONFIG_CODE_DIGITS || '8', 10); // 8-digit share codes
const MAX_PUBLIC_CONFIGS_PER_OWNER = parseInt(process.env.MAX_CONFIGS_PER_OWNER || '5', 10);
const CONFIG_UNUSED_TTL_MS = parseInt(process.env.CONFIG_UNUSED_DAYS || '30', 10) * 24 * 60 * 60 * 1000;
const CONFIG_SWEEP_MS = parseInt(process.env.CONFIG_SWEEP_DAYS || '7', 10) * 24 * 60 * 60 * 1000; // weekly cleanup
const MAX_CONFIG_BODY_BYTES = parseInt(process.env.MAX_CONFIG_BYTES || String(1024 * 1024), 10); // ~1MB config payloads
const CONFIG_STORE_FILE = path.join(__dirname, 'configs-store.json');

// code -> { code, owner, ownerLower, name, data, createdAt, lastAccessAt }
const configs = new Map();
let configSaveTimer = null;

function loadConfigs() {
   try {
      if (!fs.existsSync(CONFIG_STORE_FILE)) {
         return;
      }
      const raw = fs.readFileSync(CONFIG_STORE_FILE, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
         for (const entry of arr) {
            if (entry && entry.code) {
               configs.set(String(entry.code), entry);
            }
         }
      }
      console.log(`Loaded ${configs.size} cloud config(s) from disk`);
   } catch (err) {
      console.error('Could not load configs store:', err.message);
   }
}

function persistConfigs() {
   // Debounced write so a burst of shares/downloads doesn't hammer the disk.
   if (configSaveTimer) {
      return;
   }
   configSaveTimer = setTimeout(() => {
      configSaveTimer = null;
      try {
         fs.writeFileSync(CONFIG_STORE_FILE, JSON.stringify([...configs.values()]), 'utf8');
      } catch (err) {
         console.error('Could not persist configs store:', err.message);
      }
   }, 500);
   configSaveTimer.unref && configSaveTimer.unref();
}

function newConfigCode() {
   const max = 10 ** CONFIG_CODE_DIGITS;
   for (let attempt = 0; attempt < 50; attempt += 1) {
      const n = crypto.randomInt(0, max);
      const code = String(n).padStart(CONFIG_CODE_DIGITS, '0');
      if (!configs.has(code)) {
         return code;
      }
   }
   return null;
}

function shareConfig(input) {
   const owner = sanitizeString(input.owner, 32);
   const name = sanitizeString(input.name, 48);
   const data = typeof input.data === 'string' ? input.data : '';
   if (!owner || !name || !data) {
      return { error: 'missing fields' };
   }
   const ownerLower = nickKey(owner);

   // Re-sharing a config of the same name from the same owner overwrites their existing entry
   // (keeps its code) instead of consuming another slot.
   let existing = null;
   let ownerCount = 0;
   for (const entry of configs.values()) {
      if (entry.ownerLower === ownerLower) {
         ownerCount += 1;
         if (entry.name === name) {
            existing = entry;
         }
      }
   }

   if (existing) {
      existing.data = data;
      existing.lastAccessAt = now();
      persistConfigs();
      return { code: existing.code };
   }

   if (ownerCount >= MAX_PUBLIC_CONFIGS_PER_OWNER) {
      return { error: 'limit' };
   }

   const code = newConfigCode();
   if (!code) {
      return { error: 'code collision' };
   }

   const entry = { code, owner, ownerLower, name, data, createdAt: now(), lastAccessAt: now() };
   configs.set(code, entry);
   persistConfigs();
   return { code };
}

function getConfig(codeRaw) {
   const code = sanitizeString(codeRaw, 16);
   if (!code) {
      return { error: 'missing fields' };
   }
   const entry = configs.get(code);
   if (!entry) {
      return { error: 'not found' };
   }
   entry.lastAccessAt = now(); // a download keeps the config alive
   persistConfigs();
   return { name: entry.name, data: entry.data, owner: entry.owner };
}

function listConfigs(ownerRaw) {
   const ownerLower = nickKey(sanitizeString(ownerRaw, 32));
   const out = [];
   for (const entry of configs.values()) {
      if (entry.ownerLower === ownerLower) {
         out.push({ code: entry.code, name: entry.name, createdAt: entry.createdAt, lastAccessAt: entry.lastAccessAt });
      }
   }
   return out;
}

function deleteConfig(input) {
   const ownerLower = nickKey(sanitizeString(input.owner, 32));
   const code = sanitizeString(input.code, 16);
   const entry = configs.get(code);
   if (!entry || entry.ownerLower !== ownerLower) {
      return false;
   }
   configs.delete(code);
   persistConfigs();
   return true;
}

function sweepConfigs() {
   const t = now();
   let removed = 0;
   for (const [code, entry] of configs) {
      if (t - (entry.lastAccessAt || entry.createdAt || 0) > CONFIG_UNUSED_TTL_MS) {
         configs.delete(code);
         removed += 1;
      }
   }
   if (removed > 0) {
      console.log(`Config cleanup: removed ${removed} config(s) unused for over 30 days`);
      persistConfigs();
   }
}

loadConfigs();
sweepConfigs();
setInterval(sweepConfigs, CONFIG_SWEEP_MS).unref();

// ------------------------------ IRC + presence ---------------------------

const IRC_MAX_MESSAGES = parseInt(process.env.IRC_MAX || '100', 10); // global ring buffer of last N messages
const IRC_MAX_TEXT = 256;
const PRESENCE_TTL_MS = parseInt(process.env.PRESENCE_TTL || '30', 10) * 1000; // MoonUsers heartbeat lifetime

const ircMessages = [];   // [{ id, user, text, ts }] — global channel, oldest first
let ircNextId = 1;
const presence = new Map(); // userLower -> { display, expiresAt }

const START_TIME = Date.now();

// server-id -> ServerState { markers, parties, memberOf, invites, display }
const STORE = new Map();

function now() {
   return Date.now();
}

function getState(server) {
   let st = STORE.get(server);
   if (!st) {
      st = { markers: new Map(), parties: new Map(), memberOf: new Map(), invites: new Map(), display: new Map() };
      STORE.set(server, st);
   }
   return st;
}

function stateIsEmpty(st) {
   return st.markers.size === 0 && st.parties.size === 0 && st.memberOf.size === 0 && st.invites.size === 0;
}

function sweep() {
   const t = now();
   for (const [server, st] of STORE) {
      for (const [id, marker] of st.markers) {
         if (marker.expiresAt > 0 && t >= marker.expiresAt) {
            st.markers.delete(id);
         }
      }
      for (const [target, byInviter] of st.invites) {
         for (const [inviter, expiresAt] of byInviter) {
            if (t >= expiresAt) {
               byInviter.delete(inviter);
            }
         }
         if (byInviter.size === 0) {
            st.invites.delete(target);
         }
      }
      if (stateIsEmpty(st)) {
         STORE.delete(server);
      }
   }
}

setInterval(sweep, 5000).unref();

function clampNumber(value, fallback) {
   const n = Number(value);
   return Number.isFinite(n) ? n : fallback;
}

function sanitizeString(value, maxLen) {
   if (typeof value !== 'string') {
      return '';
   }
   let out = '';
   for (const ch of value) {
      const code = ch.codePointAt(0);
      if (code >= 32 && code !== 127) {
         out += ch;
      }
   }
   return out.trim().slice(0, maxLen);
}

function nickKey(display) {
   return display.toLowerCase();
}

function rememberDisplay(st, display) {
   const lower = nickKey(display);
   if (display && !st.display.has(lower)) {
      st.display.set(lower, display);
   }
   return lower;
}

function displayOf(st, lower) {
   return st.display.get(lower) || lower;
}

function blockKey(marker) {
   return Math.floor(marker.x) + ':' + Math.floor(marker.y) + ':' + Math.floor(marker.z);
}

// ------------------------------ party model ------------------------------

function newPartyId() {
   return crypto.randomBytes(6).toString('hex');
}

function familyOf(st, viewerLower) {
   const pid = st.memberOf.get(viewerLower);
   if (pid) {
      const members = st.parties.get(pid);
      if (members && members.size > 0) {
         return members;
      }
   }
   return new Set([viewerLower]);
}

function joinParty(st, playerLower, targetLower) {
   let tid = st.memberOf.get(targetLower);
   if (!tid) {
      tid = newPartyId();
      st.parties.set(tid, new Set([targetLower]));
      st.memberOf.set(targetLower, tid);
   }
   const pid = st.memberOf.get(playerLower);
   if (pid === tid) {
      return tid;
   }
   if (pid) {
      removeFromParty(st, playerLower);
   }
   st.parties.get(tid).add(playerLower);
   st.memberOf.set(playerLower, tid);
   return tid;
}

function removeFromParty(st, playerLower) {
   const pid = st.memberOf.get(playerLower);
   if (!pid) {
      return false;
   }
   const members = st.parties.get(pid);
   st.memberOf.delete(playerLower);
   if (members) {
      members.delete(playerLower);
      if (members.size <= 1) {
         for (const remaining of members) {
            st.memberOf.delete(remaining);
         }
         st.parties.delete(pid);
      }
   }
   return true;
}

function partySnapshot(st, playerLower) {
   const pid = st.memberOf.get(playerLower);
   if (!pid) {
      return { id: '', members: [displayOf(st, playerLower)] };
   }
   const members = st.parties.get(pid) || new Set([playerLower]);
   return { id: pid, members: [...members].map((m) => displayOf(st, m)) };
}

function pendingInvitesFor(st, playerLower) {
   const byInviter = st.invites.get(playerLower);
   if (!byInviter) {
      return [];
   }
   return [...byInviter.keys()].map((inviter) => displayOf(st, inviter));
}

// ------------------------------ HTTP plumbing ----------------------------

function sendJson(res, status, payload) {
   const body = JSON.stringify(payload);
   res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
   });
   res.end(body);
}

function adminSecretOk(provided) {
   if (!FUNTIME_ADMIN_SECRET) {
      return false; // admin endpoints disabled until a secret is configured
   }
   const a = Buffer.from(String(provided || ''), 'utf8');
   const b = Buffer.from(FUNTIME_ADMIN_SECRET, 'utf8');
   if (a.length !== b.length) {
      return false;
   }
   return crypto.timingSafeEqual(a, b);
}

function readBody(req, maxBytes) {
   const limit = maxBytes || MAX_BODY_BYTES;
   return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
         size += chunk.length;
         if (size > limit) {
            reject(new Error('body too large'));
            req.destroy();
            return;
         }
         chunks.push(chunk);
      });
      req.on('end', () => {
         const raw = Buffer.concat(chunks).toString('utf8');
         if (!raw) {
            resolve({});
            return;
         }
         try {
            resolve(JSON.parse(raw));
         } catch (err) {
            reject(err);
         }
      });
      req.on('error', reject);
   });
}

// ------------------------------ marker logic -----------------------------

function publicMarker(st, m) {
   return {
      id: m.id,
      owner: m.owner,
      mode: m.mode,
      party: st.memberOf.get(m.ownerLower) || '',
      x: m.x,
      y: m.y,
      z: m.z,
      color: m.color,
      label: m.label,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
   };
}

function listVisibleMarkers(server, viewer, mode) {
   sweep();
   const st = STORE.get(server);
   if (!st) {
      return [];
   }
   const viewerLower = nickKey(viewer);
   if (!viewerLower) {
      return [];
   }
   const family = familyOf(st, viewerLower);
   const wantMode = mode || '';
   const out = [];
   for (const m of st.markers.values()) {
      if (!family.has(m.ownerLower)) {
         continue;
      }
      if ((m.mode || '') !== wantMode) {
         continue;
      }
      out.push(publicMarker(st, m));
   }
   return out;
}

function placeMarker(input) {
   const server = sanitizeString(input.server, 128).toLowerCase();
   if (!server) {
      return { error: 'missing server' };
   }
   const owner = sanitizeString(input.owner, 32);
   if (!owner) {
      return { error: 'missing owner' };
   }

   const st = getState(server);
   const ownerLower = rememberDisplay(st, owner);

   const marker = {
      id: crypto.randomBytes(8).toString('hex'),
      owner,
      ownerLower,
      mode: sanitizeString(input.mode, 64),
      x: clampNumber(input.x, 0),
      y: clampNumber(input.y, 0),
      z: clampNumber(input.z, 0),
      color: Math.trunc(clampNumber(input.color, -1)),
      label: sanitizeString(input.label, 48),
      createdAt: now(),
      expiresAt: 0,
   };
   marker.expiresAt = marker.createdAt + MARKER_TTL_SECONDS * 1000;

   const key = blockKey(marker);
   for (const [id, existing] of st.markers) {
      if (existing.ownerLower === ownerLower && existing.mode === marker.mode && blockKey(existing) === key) {
         st.markers.delete(id);
      }
   }

   // Per-owner cap: one player may hold at most MAX_MARKERS_PER_OWNER markers; placing more evicts
   // that owner's oldest one(s). Counted across modes — a player just has N live markers total.
   let ownerMarkers = [];
   for (const [id, existing] of st.markers) {
      if (existing.ownerLower === ownerLower) {
         ownerMarkers.push({ id, createdAt: existing.createdAt });
      }
   }
   if (ownerMarkers.length >= MAX_MARKERS_PER_OWNER) {
      ownerMarkers.sort((a, b) => a.createdAt - b.createdAt);
      const evictCount = ownerMarkers.length - MAX_MARKERS_PER_OWNER + 1; // make room for the new one
      for (let i = 0; i < evictCount; i += 1) {
         st.markers.delete(ownerMarkers[i].id);
      }
   }

   while (st.markers.size >= MAX_MARKERS_PER_SERVER) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, existing] of st.markers) {
         if (existing.createdAt < oldestAt) {
            oldestAt = existing.createdAt;
            oldestId = id;
         }
      }
      if (oldestId === null) {
         break;
      }
      st.markers.delete(oldestId);
   }

   st.markers.set(marker.id, marker);
   return { marker };
}

function deleteMarker(input) {
   const server = sanitizeString(input.server, 128).toLowerCase();
   const id = sanitizeString(input.id, 32);
   if (!server || !id) {
      return false;
   }
   const st = STORE.get(server);
   if (!st) {
      return false;
   }
   const marker = st.markers.get(id);
   if (!marker) {
      return false;
   }
   // Owner-only when a viewer is supplied; otherwise allowed (markers self-destruct in 120s).
   const viewer = sanitizeString(input.viewer, 32);
   if (viewer && nickKey(viewer) !== marker.ownerLower) {
      return false;
   }
   return st.markers.delete(id);
}

// ------------------------------ party logic ------------------------------

function partyInvite(input) {
   const server = sanitizeString(input.server, 128).toLowerCase();
   const player = sanitizeString(input.player, 32);
   const target = sanitizeString(input.target, 32);
   if (!server || !player || !target) {
      return { error: 'missing fields' };
   }
   const playerLower = nickKey(player);
   const targetLower = nickKey(target);
   if (playerLower === targetLower) {
      return { error: 'cannot invite yourself' };
   }

   const st = getState(server);
   rememberDisplay(st, player);
   rememberDisplay(st, target);

   const pp = st.memberOf.get(playerLower);
   if (pp && st.memberOf.get(targetLower) === pp) {
      return { error: 'already in your party' };
   }

   let byInviter = st.invites.get(targetLower);
   if (!byInviter) {
      byInviter = new Map();
      st.invites.set(targetLower, byInviter);
   }
   byInviter.set(playerLower, now() + INVITE_TTL_SECONDS * 1000);
   return { ok: true };
}

function partyAccept(input) {
   const server = sanitizeString(input.server, 128).toLowerCase();
   const player = sanitizeString(input.player, 32);
   let target = sanitizeString(input.target, 32);
   if (!server || !player) {
      return { error: 'missing fields' };
   }
   const playerLower = nickKey(player);

   const st = STORE.get(server);
   const byInviter = st && st.invites.get(playerLower);
   if (!byInviter || byInviter.size === 0) {
      return { error: 'no pending invite' };
   }

   let targetLower = target ? nickKey(target) : '';
   let expiresAt = targetLower ? byInviter.get(targetLower) : 0;

   if (!targetLower) {
      for (const [inviter, inviteExpiresAt] of byInviter.entries()) {
         if (inviteExpiresAt && now() < inviteExpiresAt) {
            targetLower = inviter;
            target = displayOf(st, inviter);
            expiresAt = inviteExpiresAt;
            break;
         }
      }
   }

   if (!targetLower || !expiresAt || now() >= expiresAt) {
      return { error: 'no pending invite' };
   }

   byInviter.delete(targetLower);
   if (byInviter.size === 0) {
      st.invites.delete(playerLower);
   }
   rememberDisplay(st, player);
   rememberDisplay(st, target);

   joinParty(st, playerLower, targetLower);
   return { ok: true, party: partySnapshot(st, playerLower) };
}

function partyDecline(input) {
   const server = sanitizeString(input.server, 128).toLowerCase();
   const player = sanitizeString(input.player, 32);
   const target = sanitizeString(input.target, 32);
   if (!server || !player) {
      return { error: 'missing fields' };
   }
   const st = STORE.get(server);
   if (!st) {
      return { ok: true };
   }
   const byInviter = st.invites.get(nickKey(player));
   if (byInviter) {
      if (target) {
         byInviter.delete(nickKey(target));
      } else {
         byInviter.clear();
      }
      if (byInviter.size === 0) {
         st.invites.delete(nickKey(player));
      }
   }
   return { ok: true };
}

function partyLeave(input) {
   const server = sanitizeString(input.server, 128).toLowerCase();
   const player = sanitizeString(input.player, 32);
   if (!server || !player) {
      return { error: 'missing fields' };
   }
   const st = STORE.get(server);
   if (st) {
      removeFromParty(st, nickKey(player));
   }
   return { ok: true };
}

function partyInfo(server, player) {
   sweep();
   const st = STORE.get(server);
   const playerLower = nickKey(player);
   if (!st || !playerLower) {
      return { party: { id: '', members: player ? [player] : [] }, invites: [] };
   }
   return { party: partySnapshot(st, playerLower), invites: pendingInvitesFor(st, playerLower) };
}

// ------------------------------ IRC chat ---------------------------------

function ircPost(input) {
   const user = sanitizeString(input.user, 32);
   const text = sanitizeString(input.text, IRC_MAX_TEXT);
   if (!user) {
      return { error: 'missing user' };
   }
   if (!text) {
      return { error: 'empty message' };
   }
   touchPresence(user); // sending counts as being online
   const message = { id: ircNextId++, user, text, ts: now() };
   ircMessages.push(message);
   while (ircMessages.length > IRC_MAX_MESSAGES) {
      ircMessages.shift();
   }
   return { ok: true, id: message.id };
}

function ircList(sinceRaw) {
   const since = Number.parseInt(sinceRaw, 10);
   const cutoff = Number.isFinite(since) ? since : 0;
   const messages = cutoff > 0 ? ircMessages.filter((m) => m.id > cutoff) : ircMessages.slice();
   const lastId = ircMessages.length ? ircMessages[ircMessages.length - 1].id : 0;
   return { ok: true, messages, lastId, now: now() };
}

// ------------------------------ presence (MoonUsers) ---------------------

function touchPresence(display) {
   const lower = nickKey(display);
   if (!lower) {
      return;
   }
   presence.set(lower, { display, expiresAt: now() + PRESENCE_TTL_MS });
}

function sweepPresence() {
   const t = now();
   for (const [lower, info] of presence) {
      if (t >= info.expiresAt) {
         presence.delete(lower);
      }
   }
}

function onlineUsers() {
   sweepPresence();
   const users = [...presence.values()].map((info) => info.display);
   return { ok: true, count: users.length, users };
}

setInterval(sweepPresence, 5000).unref();

// ------------------------------- router ---------------------------------

const server = http.createServer(async (req, res) => {
   try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'OPTIONS') {
         sendJson(res, 204, {});
         return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/health')) {
         let total = 0;
         let parties = 0;
         for (const st of STORE.values()) {
            total += st.markers.size;
            parties += st.parties.size;
         }
         sendJson(res, 200, { ok: true, markers: total, servers: STORE.size, parties, uptime: Math.floor((now() - START_TIME) / 1000) });
         return;
      }

      if (req.method === 'GET' && url.pathname === '/api/markers') {
         const serverId = sanitizeString(url.searchParams.get('server') || '', 128).toLowerCase();
         if (!serverId) {
            sendJson(res, 400, { ok: false, error: 'missing server' });
            return;
         }
         const viewer = sanitizeString(url.searchParams.get('viewer') || '', 32);
         const mode = sanitizeString(url.searchParams.get('mode') || '', 64);
         sendJson(res, 200, { ok: true, markers: listVisibleMarkers(serverId, viewer, mode) });
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/markers') {
         const result = placeMarker(await readBody(req));
         if (result.error) {
            sendJson(res, 400, { ok: false, error: result.error });
            return;
         }
         sendJson(res, 200, { ok: true, id: result.marker.id, expiresAt: result.marker.expiresAt });
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/markers/delete') {
         const removed = deleteMarker(await readBody(req));
         sendJson(res, 200, { ok: removed });
         return;
      }

      // ---------------------------- cloud configs -----------------------------

      if (req.method === 'POST' && url.pathname === '/api/configs/share') {
         const result = shareConfig(await readBody(req, MAX_CONFIG_BODY_BYTES));
         if (result.error) {
            sendJson(res, result.error === 'limit' ? 409 : 400, { ok: false, error: result.error });
            return;
         }
         sendJson(res, 200, { ok: true, code: result.code });
         return;
      }

      if (req.method === 'GET' && url.pathname === '/api/configs/get') {
         const result = getConfig(url.searchParams.get('code') || '');
         if (result.error) {
            sendJson(res, result.error === 'not found' ? 404 : 400, { ok: false, error: result.error });
            return;
         }
         sendJson(res, 200, { ok: true, name: result.name, data: result.data, owner: result.owner });
         return;
      }

      if (req.method === 'GET' && url.pathname === '/api/configs/list') {
         sendJson(res, 200, { ok: true, configs: listConfigs(url.searchParams.get('owner') || '') });
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/configs/delete') {
         const removed = deleteConfig(await readBody(req));
         sendJson(res, 200, { ok: removed });
         return;
      }

      // ---------------------------- FunTime events ----------------------------

      if (req.method === 'GET' && (url.pathname === '/api/client/funtime/events' || url.pathname === '/api/funtime/events')) {
         const mode = sanitizeString(url.searchParams.get('mode') || '', 64);
         sendJson(res, 200, funtime.getSnapshot(mode));
         return;
      }

      if (req.method === 'GET' && url.pathname === '/api/admin/funtime') {
         if (!adminSecretOk(url.searchParams.get('secret'))) {
            sendJson(res, FUNTIME_ADMIN_SECRET ? 403 : 503, { ok: false, error: FUNTIME_ADMIN_SECRET ? 'forbidden' : 'admin disabled' });
            return;
         }
         sendJson(res, 200, { ok: true, ...funtime.getAdminState() });
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/admin/funtime') {
         const body = await readBody(req);
         if (!adminSecretOk(body.secret)) {
            sendJson(res, FUNTIME_ADMIN_SECRET ? 403 : 503, { ok: false, error: FUNTIME_ADMIN_SECRET ? 'forbidden' : 'admin disabled' });
            return;
         }
         const action = typeof body.action === 'string' ? body.action : 'token';
         if (action === 'refresh') {
            const snapshot = await funtime.forceRefresh();
            sendJson(res, 200, { ok: true, ...funtime.getAdminState(), refreshed: true, snapshot });
            return;
         }
         const state = funtime.setToken(typeof body.token === 'string' ? body.token : '');
         sendJson(res, 200, { ok: true, ...state, ...funtime.getAdminState(), message: state.configured ? 'FunTime token saved' : 'FunTime token cleared' });
         return;
      }

      // ------------------------------ IRC chat ------------------------------

      if (req.method === 'GET' && url.pathname === '/api/irc/messages') {
         sendJson(res, 200, ircList(url.searchParams.get('since')));
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/irc/send') {
         const result = ircPost(await readBody(req));
         sendJson(res, result.error ? 400 : 200, result.error ? { ok: false, error: result.error } : result);
         return;
      }

      // ----------------------------- MoonUsers ------------------------------

      if (req.method === 'POST' && url.pathname === '/api/users/heartbeat') {
         const body = await readBody(req);
         const user = sanitizeString(body.user, 32);
         if (!user) {
            sendJson(res, 400, { ok: false, error: 'missing user' });
            return;
         }
         touchPresence(user);
         sendJson(res, 200, onlineUsers());
         return;
      }

      if (req.method === 'GET' && url.pathname === '/api/users/online') {
         sendJson(res, 200, onlineUsers());
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/party/invite') {
         const result = partyInvite(await readBody(req));
         sendJson(res, result.error ? 400 : 200, result.error ? { ok: false, error: result.error } : result);
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/party/accept') {
         const result = partyAccept(await readBody(req));
         sendJson(res, result.error ? 400 : 200, result.error ? { ok: false, error: result.error } : result);
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/party/decline') {
         const result = partyDecline(await readBody(req));
         sendJson(res, result.error ? 400 : 200, result.error ? { ok: false, error: result.error } : result);
         return;
      }

      if (req.method === 'POST' && url.pathname === '/api/party/leave') {
         const result = partyLeave(await readBody(req));
         sendJson(res, result.error ? 400 : 200, result.error ? { ok: false, error: result.error } : result);
         return;
      }

      if (req.method === 'GET' && url.pathname === '/api/party') {
         const serverId = sanitizeString(url.searchParams.get('server') || '', 128).toLowerCase();
         const player = sanitizeString(url.searchParams.get('player') || '', 32);
         if (!serverId || !player) {
            sendJson(res, 400, { ok: false, error: 'missing server or player' });
            return;
         }
         sendJson(res, 200, { ok: true, ...partyInfo(serverId, player) });
         return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
   } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err && err.message ? err.message : err) });
   }
});

server.listen(PORT, () => {
   funtime.startPoller();
   console.log(`MoonLight Community backend listening on :${PORT} · markers expire after ${MARKER_TTL_SECONDS}s · party-scoped · FunTime events ${FUNTIME_ADMIN_SECRET ? 'admin-enabled' : 'admin-disabled (set FUNTIME_ADMIN_SECRET)'}`);
});
