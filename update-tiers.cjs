#!/usr/bin/env node
/**
 * Computes champion tiers from real ranked games and writes tiers.json.
 *
 * Data comes from Riot's official API: the high-elo ladders for a platform,
 * their recent Ranked Solo/Duo matches, and the champion each participant
 * played in each role. Tiers are percentiles of a shrunk win rate within a
 * role, so "S" means "top of its own lane", not "top of a global list".
 *
 * Usage:
 *   RIOT_API_KEY=RGAPI-... node update-tiers.cjs
 *   node update-tiers.cjs --self-test     # no network, checks the maths
 *
 * Env:
 *   RIOT_API_KEY   required, a Personal or Production key (dev keys expire daily)
 *   PLATFORM       default euw1
 *   MATCH_BUDGET   default 1500, how many matches to sample
 *   MIN_GAMES      default 30, games needed in a role to be tiered at all
 *   OUT            default tiers.json
 *
 * No dependencies: this runs on a bare Node in CI.
 */

'use strict';

const fs = require('node:fs');
const https = require('node:https');
const assert = require('node:assert');

const RANKED_SOLO = 420;
const REMAKE_MAX_SECONDS = 300;

/** Riot splits platform routes (euw1) from regional match routes (europe). */
const REGION_BY_PLATFORM = {
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
};

const ROLE_BY_POSITION = {
  TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid', BOTTOM: 'adc', UTILITY: 'support',
};

/**
 * Tier is a percentile band of shrunk win rate within the champion's main
 * role. Bands are deliberately narrow at the top: a tier list that calls
 * thirty champions S+ is not saying anything.
 */
const TIER_BANDS = [
  { tier: 'S+', upTo: 0.05 },
  { tier: 'S', upTo: 0.20 },
  { tier: 'A', upTo: 0.45 },
  { tier: 'B', upTo: 0.85 },
  { tier: 'C', upTo: 1.00 },
];

/** Phantom games pulling each champion toward its role's mean win rate. */
const PRIOR_GAMES = 150;

// ── Riot API plumbing ───────────────────────────────────────────────────────

/**
 * Serialised requests with a conservative pace plus 429 handling. Development
 * keys allow 20 requests/second and 100 per 2 minutes; approved keys allow far
 * more, but pacing for the strict limit costs only time and never a ban.
 */
class RiotClient {
  constructor(apiKey, { minIntervalMs = 1250 } = {}) {
    this.apiKey = apiKey;
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.requests = 0;
  }

  async get(host, path) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.last));
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.requests += 1;

      const res = await request(host, path, this.apiKey);
      if (res.status === 200) return res.body;
      if (res.status === 429) {
        const retry = Number(res.headers['retry-after']) || 10;
        console.warn(`  rate limited, waiting ${retry}s`);
        await sleep((retry + 1) * 1000);
        continue;
      }
      if (res.status === 404) return null;
      if (res.status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`${path} -> HTTP ${res.status} ${String(res.raw).slice(0, 200)}`);
    }
    return null;
  }
}

function request(host, path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, path, method: 'GET', headers: { 'X-Riot-Token': apiKey }, timeout: 20000 },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { /* non-JSON error page */ }
          resolve({ status: res.statusCode, headers: res.headers, body, raw });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Aggregation (pure, self-tested) ─────────────────────────────────────────

/**
 * Folds one match into per-champion, per-role counters. Keyed `id|role` so a
 * champion played in two roles is judged in each separately.
 */
function collectMatch(match, championById, stats) {
  const info = match?.info;
  if (!info || info.queueId !== RANKED_SOLO) return 0;
  if ((info.gameDuration ?? 0) < REMAKE_MAX_SECONDS) return 0;

  let counted = 0;
  for (const p of info.participants ?? []) {
    const id = championById[p.championId];
    const role = ROLE_BY_POSITION[p.teamPosition];
    // Unknown champion (job ahead of Data Dragon) or no assigned position
    // (remake-ish or an odd game) — skip rather than guess.
    if (!id || !role) continue;
    const key = `${id}|${role}`;
    const s = stats[key] ?? (stats[key] = { id, role, games: 0, wins: 0 });
    s.games += 1;
    if (p.win) s.wins += 1;
    counted += 1;
  }
  return counted;
}

/**
 * Turns per-role counters into one tier per champion.
 *
 * A champion is judged in the role it is played in most, and needs `minGames`
 * there to be tiered at all — an off-meta pick with four games carries no
 * signal, and the app keeps its bundled tier when we omit it. Win rates are
 * shrunk toward the role's own mean, so a small sample cannot reach S+.
 */
function computeTiers(stats, { minGames = 30, priorGames = PRIOR_GAMES } = {}) {
  const mainByChampion = {};
  for (const s of Object.values(stats)) {
    const current = mainByChampion[s.id];
    if (!current || s.games > current.games) mainByChampion[s.id] = s;
  }

  const roleMean = {};
  for (const s of Object.values(stats)) {
    const r = roleMean[s.role] ?? (roleMean[s.role] = { games: 0, wins: 0 });
    r.games += s.games;
    r.wins += s.wins;
  }

  const byRole = {};
  for (const s of Object.values(mainByChampion)) {
    if (s.games < minGames) continue;
    const mean = roleMean[s.role].games > 0 ? roleMean[s.role].wins / roleMean[s.role].games : 0.5;
    const shrunk = (s.wins + priorGames * mean) / (s.games + priorGames);
    (byRole[s.role] ?? (byRole[s.role] = [])).push({ ...s, shrunk, rawWr: s.wins / s.games });
  }

  const tiers = {};
  const detail = [];
  for (const [role, list] of Object.entries(byRole)) {
    // Best first, then banded by position so tiers are relative to the role.
    list.sort((a, b) => b.shrunk - a.shrunk);
    list.forEach((entry, i) => {
      // Midpoint of the entry's slot, so a 1-champion role lands mid-table
      // instead of automatically taking S+.
      const percentile = (i + 0.5) / list.length;
      const band = TIER_BANDS.find((b) => percentile <= b.upTo) ?? TIER_BANDS[TIER_BANDS.length - 1];
      tiers[entry.id] = band.tier;
      detail.push({
        id: entry.id, role, tier: band.tier, games: entry.games,
        winRate: Number(entry.rawWr.toFixed(4)), shrunk: Number(entry.shrunk.toFixed(4)),
      });
    });
  }
  return { tiers, detail };
}

/** Same rules the app enforces, checked here so bad data never publishes. */
function validateFeed(feed) {
  assert.strictEqual(feed.version, 1, 'version must be 1');
  assert.match(feed.patch, /^\d+\.\d+/, 'patch must look like a patch');
  assert.ok(Number.isFinite(Date.parse(feed.generatedAt)), 'generatedAt must parse');
  const ids = Object.keys(feed.tiers);
  assert.ok(ids.length >= 100, `need >= 100 champions, got ${ids.length}`);
  const distinct = new Set(ids.map((id) => feed.tiers[id]));
  assert.ok(distinct.size >= 3, `need >= 3 distinct tiers, got ${distinct.size}`);
  for (const id of ids) {
    assert.ok(['S+', 'S', 'A', 'B', 'C'].includes(feed.tiers[id]), `bad tier for ${id}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) throw new Error('RIOT_API_KEY is not set');
  const platform = process.env.PLATFORM || 'euw1';
  const region = REGION_BY_PLATFORM[platform];
  if (!region) throw new Error(`unknown platform ${platform}`);
  const matchBudget = Number(process.env.MATCH_BUDGET || 1500);
  const minGames = Number(process.env.MIN_GAMES || 30);
  const out = process.env.OUT || 'tiers.json';

  const platformHost = `${platform}.api.riotgames.com`;
  const regionHost = `${region}.api.riotgames.com`;
  const riot = new RiotClient(apiKey);

  const versions = await getJson('https://ddragon.leagueoflegends.com/api/versions.json');
  const patch = versions[0];
  const ddragon = await getJson(
    `https://ddragon.leagueoflegends.com/cdn/${patch}/data/en_US/champion.json`,
  );
  const championById = {};
  for (const c of Object.values(ddragon.data)) championById[Number(c.key)] = c.id;
  console.log(`patch ${patch}, ${Object.keys(championById).length} champions`);

  // High-elo ladders: the strongest signal per game sampled, and small enough
  // to enumerate. Master is the big one; challenger/GM add the very top.
  const puuids = [];
  for (const tierPath of ['challengerleagues', 'grandmasterleagues', 'masterleagues']) {
    const league = await riot.get(
      platformHost, `/lol/league/v4/${tierPath}/by-queue/RANKED_SOLO_5x5`,
    );
    for (const e of league?.entries ?? []) if (e.puuid) puuids.push(e.puuid);
    console.log(`  ${tierPath}: ${league?.entries?.length ?? 0} entries`);
  }
  if (puuids.length === 0) {
    throw new Error('no puuids from the league endpoints — has the response shape changed?');
  }
  shuffle(puuids);

  // Collect match ids until the budget is met. 10 per player spreads the
  // sample across many players rather than deeply into a few.
  const matchIds = new Set();
  for (const puuid of puuids) {
    if (matchIds.size >= matchBudget) break;
    const ids = await riot.get(
      regionHost,
      `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${RANKED_SOLO}&type=ranked&count=10`,
    );
    for (const id of ids ?? []) matchIds.add(id);
  }
  console.log(`collected ${matchIds.size} match ids from ${riot.requests} requests`);

  const stats = {};
  let matches = 0;
  let skippedPatch = 0;
  const patchPrefix = patch.split('.').slice(0, 2).join('.');
  for (const id of matchIds) {
    const match = await riot.get(regionHost, `/lol/match/v5/matches/${id}`);
    if (!match) continue;
    // Keep the sample inside the current patch; older games describe a
    // balance state that no longer exists.
    if (!String(match.info?.gameVersion ?? '').startsWith(patchPrefix)) {
      skippedPatch += 1;
      continue;
    }
    if (collectMatch(match, championById, stats) > 0) matches += 1;
    if (matches % 100 === 0 && matches > 0) console.log(`  ${matches} matches aggregated`);
  }
  console.log(`aggregated ${matches} matches (${skippedPatch} skipped as off-patch)`);

  const { tiers, detail } = computeTiers(stats, { minGames });
  const feed = {
    version: 1,
    patch,
    generatedAt: new Date().toISOString(),
    source: `riot-api:${platform}:high-elo`,
    sampleGames: matches,
    tiers,
  };
  validateFeed(feed);

  fs.writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
  // Kept beside the feed so a surprising tier can be traced to its numbers.
  detail.sort((a, b) => b.shrunk - a.shrunk);
  fs.writeFileSync('tiers-detail.json', `${JSON.stringify({ patch, detail }, null, 2)}\n`);

  const counts = {};
  for (const t of Object.values(tiers)) counts[t] = (counts[t] ?? 0) + 1;
  console.log(`wrote ${out}: ${Object.keys(tiers).length} champions`, counts);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ── Self-test ───────────────────────────────────────────────────────────────

function selfTest() {
  const championById = { 1: 'Annie', 2: 'Olaf', 103: 'Ahri' };
  const stats = {};
  const match = (winnerChampion) => ({
    info: {
      queueId: RANKED_SOLO,
      gameDuration: 1800,
      participants: [
        { championId: 103, teamPosition: 'MIDDLE', win: winnerChampion === 103 },
        { championId: 1, teamPosition: 'MIDDLE', win: winnerChampion === 1 },
        { championId: 2, teamPosition: 'JUNGLE', win: winnerChampion === 2 },
        { championId: 999, teamPosition: 'TOP', win: true },
        { championId: 103, teamPosition: '', win: true },
      ],
    },
  });

  assert.strictEqual(collectMatch(match(103), championById, stats), 3,
    'unknown champion and empty position are skipped');
  assert.strictEqual(collectMatch({ info: { queueId: 450, gameDuration: 1800, participants: [] } },
    championById, stats), 0, 'non-ranked queue ignored');
  assert.strictEqual(collectMatch({ info: { queueId: RANKED_SOLO, gameDuration: 120, participants: [] } },
    championById, stats), 0, 'remake ignored');
  assert.strictEqual(stats['Ahri|mid'].games, 1);
  assert.strictEqual(stats['Ahri|mid'].wins, 1);

  // A role-sized field with a clean win-rate gradient: 40 champions from 40%
  // up to 59.5%. Bands are percentiles, so they need a realistic population —
  // in a 2-champion role nothing reaches S+, which is the intended behaviour.
  const gradient = {};
  for (let i = 0; i < 40; i += 1) {
    const id = `Champ${String(i).padStart(2, '0')}`;
    gradient[`${id}|mid`] = { id, role: 'mid', games: 200, wins: 80 + i };
  }
  // Same champion, second role, fewer games — must not displace its main role.
  gradient['Champ39|top'] = { id: 'Champ39', role: 'top', games: 50, wins: 5 };
  gradient['Fringe|mid'] = { id: 'Fringe', role: 'mid', games: 5, wins: 5 };

  const { tiers } = computeTiers(gradient, { minGames: 30, priorGames: 50 });
  assert.strictEqual(tiers.Champ39, 'S+', 'best win rate in role takes the top band');
  assert.strictEqual(tiers.Champ00, 'C', 'worst win rate in role takes the bottom band');
  assert.ok(!('Fringe' in tiers), 'below minGames is omitted, not guessed');
  assert.ok(!Object.values(tiers).includes(undefined), 'every tiered champion got a band');

  // A tiny role stays mid-table rather than handing out a free S+.
  const thin = computeTiers({
    'Solo|jungle': { id: 'Solo', role: 'jungle', games: 100, wins: 70 },
  }, { minGames: 30 });
  assert.strictEqual(thin.tiers.Solo, 'B', 'a one-champion role lands mid-table, not at S+');

  // Validation must reject the shapes the app also rejects.
  const ok = {
    version: 1, patch: '16.17.1', generatedAt: new Date().toISOString(),
    tiers: Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`C${i}`, ['S+', 'S', 'A', 'B', 'C'][i % 5]]),
    ),
  };
  validateFeed(ok);
  assert.throws(() => validateFeed({ ...ok, version: 2 }), /version/);
  assert.throws(() => validateFeed({ ...ok, patch: 'latest' }), /patch/);
  assert.throws(() => validateFeed({ ...ok, tiers: { Ahri: 'S' } }), />= 100/);
  assert.throws(
    () => validateFeed({
      ...ok,
      tiers: Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`C${i}`, 'B'])),
    }),
    /distinct/,
  );

  console.log('self-test passed');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { collectMatch, computeTiers, validateFeed };
