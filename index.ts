import 'source-map-support/register';

import * as fs from 'fs';
import * as path from 'path';
import * as wrapr from 'wrapr';

import fetch from 'node-fetch';
import stringify from 'json-stringify-pretty-compact';
import WebSocket from 'ws';
import ReconnectingWebSocket from 'reconnecting-websocket';

type Rankings = [number, number, number, number, number];
interface Index {[file: string]: [number, number]}
interface Data {
  id: string;
  p1: string;
  p2: string;
  time: number;
  rating?: number;
  threshold: number | 'tour';
}

const getText = wrapr.retrying(wrapr.throttling(async (url: string) => (await fetch(url)).text()));
const getJSON = wrapr.retrying(wrapr.throttling(
  async (url: string) => (await fetch(url)).json(), 10, 5 * 1000
), 10, 10 * 1000);

const DATA = path.resolve(__dirname, '../data');
const STATE = process.argv[2]
  ? path.resolve(__dirname, process.argv[2])
  : path.join(DATA, 'state.json');

let state: {
  backfill: number;
  rankings?: {[format: string]: number};
  stale: number;
  battles: Data[];
  n: number;
  replays: {[format: string]: {recent: Data[]; best: Data[]}};
  last: {replay: number; battle: {main: number; tours: number}};
} = {
  backfill: 10,
  stale: 15 * 60,
  battles: [],
  n: 50,
  replays: {},
  // NOTE: last.replay is a timestamp and last.battle is the number portion of the room ID. The room
  // ID number is strictly increasing, but a replay with a later ID may be uploaded before a replay
  // with an earlier ID and thus we need to rely on upload time instead.
  last: {replay: 0, battle: {main: 0, tours: 0}},
};

// TODO: wire up to a flag?
const TOURS = true;
const connect = (url: string) => new ReconnectingWebSocket(url, undefined, {WebSocket});
const sockets = TOURS ? {
  main: connect('ws://sim.smogon.com:8000/showdown/websocket'),
  tours: connect('ws://sim.smogon.com:8002/showdown/websocket'),
} : {
  main: connect('ws://sim.smogon.com:8000/showdown/websocket'),
};

const QUERYRESPONSE = '|queryresponse|roomlist|';
for (const s in sockets) {
  const server = s as keyof typeof sockets;
  const ws = sockets[server]!;
  ws.onmessage = ({data}: {data: string}) => {
    if (data.startsWith(QUERYRESPONSE)) {
      const starttime = Math.floor(Date.now() / 1000);
      try {
        const battles = JSON.parse(data.slice(QUERYRESPONSE.length)).rooms;
        for (const id in battles) {
          const battle = battles[id];
          const [_, format, n] = id.split('-');
          const num = Number(n);

          if (state.last.battle[server] && state.last.battle[server] >= num) continue;
          if (state.last.battle[server] < num) state.last.battle[server] = num;

          const threshold = state.rankings![format];
          if (!threshold) continue;

          const data: Data = {
            id,
            p1: battle.p1,
            p2: battle.p2,
            time: starttime,
            rating: isNaN(battle.minElo) ? undefined : battle.minElo,
            threshold: server === 'tours' ? 'tour' : threshold,
          };

          let stale = 0;
          for (const b of state.battles) {
            if (starttime - b.time > state.stale) stale++;
          }
          state.battles.splice(0, stale);
          state.battles.push(data);
          // Because these battles come in from both main and tours we can't guarantee they are
          // correctly sorted so we must manually sort.
          state.battles.sort((a, b) => a.time - b.time);

          report('battle', data);
        }
      } catch (err) {
        console.error(`Error handling queryresponse: '${data}':`, err);
      }
    }
  };
  ws.onopen = () => {
    console.log(`Connected to ${ws.url}`);
  };
  ws.onclose = e => {
    const clean = e.wasClean ? ' cleanly ' : ' ';
    const reason = e.reason ? `: ${e.reason}` : '';
    console.log(`Disconnected${clean}from ${ws.url} with ${e.code}${reason}`);
  };
  ws.onerror = e => {
    const msg = e.message;
    if (msg === 'TIMEOUT') return;
    console.error(`Connection error${e.message ? `: ${e.message}` : ''}`);
  };
}

export class TimedCounter extends Map<string, [number, number]> {
  increment(key: string, timeLimit: number): [number, number] {
    const val = this.get(key);
    const now = Date.now();
    if (!val || now > val[1] + timeLimit) {
      this.set(key, [1, Date.now()]);
      return [1, 0];
    } else {
      val[0]++;
      return [val[0], now - val[1]];
    }
  }
}

const banned = new Set();
const connections = new TimedCounter();
const all = new Set<WebSocket>();

const wss = new WebSocket.Server({port: +process.argv[2] || 9119});
wss.on('connection', (ws: WebSocket & {isAlive?: boolean}, req) => {
  const ip = req.headers['x-forwarded-for']
    ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
    : req.socket.remoteAddress;
  if (!ip || banned.has(ip)) {
    try { ws.terminate(); } catch {}
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const [count, duration] = connections.increment(ip, 30 * 60 * 1000);
  if (count >= 500) {
    console.log(`'${ip}' banned for attempting ${count} connections in ${duration}`);
    banned.add(ip);
    try { ws.terminate(); } catch {}
    return;
  }

  ws.send(backfill());

  ws.on('message', message => {
    if (!message) return;
    if (typeof message !== 'string') return;
    if (message.length > 1024) {
      console.error(`Dropping message greater than 1KB: ${message.slice(0, 160)}`);
      return;
    }
    if (message === '*') {
      all.add(ws);
      ws.send(backfill(false));
    } else if (message === '^') {
      all.delete(ws);
    } else {
      const data = backfill(!all.has(ws), message);
      if (data) ws.send(data);
    }
  });

  ws.on('close', () => all.delete(ws));
});

function backfill(best = true, format?: string) {
  let battles = state.battles;
  if (format) battles = battles.filter(b => b.id.split('-')[1] === format);
  if (best) battles = battles.filter(isBest);
  if (!format) battles = battles.slice(-state.backfill);

  let replays = state.replays[format || '_']?.[best ? 'best' : 'recent'] || [];
  if (!format) replays = replays.slice(-state.backfill);

  return [
    ...battles.map(b => toProtocol('battle', b)),
    ...replays.map(r => toProtocol('replay', r)),
  ].join('\n');
}

const interval = setInterval(() => {
  for (const ws of wss.clients) {
    const client = (ws as WebSocket & {isAlive?: boolean});
    if (client.isAlive === false) {
      client.terminate();
    } else {
      client.isAlive = false;
      client.ping(() => {});
    }
  }
}, 30 * 1000);

wss.on('close', () => clearInterval(interval));

function schedule() {
  const now = new Date();
  const next = new Date();
  // 00:00:02 tomorrow morning
  next.setUTCHours(24, 0, 2, 0);
  setTimeout(() => {
    schedule();
    wrapr.retrying(async () => {
      state.rankings = await getRankings();
      console.log(`Updated rankings for ${formatDate(now)}`);
    }, 5, 30 * 60 * 1000)(0);
  }, +next - +now);
}

function toProtocol(type: 'battle' | 'replay', data: Data) {
  const parts = [type, data.id, data.p1, data.p2, data.time, data.rating];
  if (data.threshold !== 'tour') parts.push(data.threshold);
  return parts.join('|');
}

function isBest(data: Data) {
  return ((data.threshold === 'tour' && !data.rating) ||
    (data.rating && data.rating >= data.threshold));
}

function report(type: 'battle' | 'replay', data: Data) {
  const best = isBest(data);
  const message = toProtocol(type, data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && (best || all.has(client))) {
      client.send(message);
    }
  }

  if (process.env.DEBUG) {
    const rating =
      data.threshold === 'tour' ? 'Tour' : data.rating ? `rating: ${data.rating}` : 'Unrated';
    if (type === 'replay') {
      const url = `https://replay.pokemonshowdown.com/${data.id}`;
      const format = data.id.split('-')[+(data.threshold === 'tour')];
      console.log(`${best ? '*' : ' '} [${format}] ${data.p1} vs. ${data.p2} (${rating}): ${url}`);
    } else {
      const url = data.threshold === 'tour'
        ? `http://smogtours.psim.us/${data.id}`
        : `https://play.pokemonshowdown.com/${data.id}`;
      const [_, format] = data.id.split('-');
      console.log(`${best ? '*' : ' '} [${format}] ${data.p1} vs. ${data.p2} (${rating}): ${url}`);
    }
  }
}

function formatDate(date = new Date()) {
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

async function getRankings(date?: Date) {
  const SETS: Index = await getJSON('https://data.pkmn.cc/sets/index.json');
  const STATS: Index = await getJSON('https://data.pkmn.cc/stats/index.json');
  const RANDOMS: Index = await getJSON('https://data.pkmn.cc/random/index.json');

  const FORMATS = new Set<string>();
  for (const index of [SETS, STATS, RANDOMS]) {
    for (const file in index) {
      if (file === 'index.json' || /gen\d.json/.test(file) || file.endsWith('nfe.json')) continue;
      FORMATS.add(file.slice(0, file.indexOf('.')));
    }
  }

  const all = [];
  for (const format of FORMATS) {
    all.push(getRankingsFor(format));
  }
  const done = await Promise.all(all);

  const output: {[format: string]: Rankings} = {};
  for (const [format, rankings] of done.sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!rankings) continue;
    output[format] = rankings;
  }

  const file = path.join(DATA, `${formatDate(date)}.json`);
  try {
    fs.writeFileSync(file, stringify(output));
  } catch (err) {
    console.error(`Error writing ${file}:`, err);
  }

  const rankings: {[format: string]: number} = {};
  for (const format in output) {
    rankings[format] = output[format][4];
  }

  return rankings;
}

async function getRankingsFor(format: string): Promise<[string, Rankings | undefined]> {
  try {
    const response = await getJSON(`https://pokemonshowdown.com/ladder/${format}.json`);
    if (!response.toplist.length) return [format, undefined];
    const r = (n: number) => response.toplist[n - 1] ? Math.round(response.toplist[n - 1].elo) : -1;
    const length = response.toplist.length;
    return [format, [r(1), r(10), r(50), r(100), r(length)]];
  } catch (err) {
    if (err.message.startsWith('FetchError: invalid json response')) {
      return getRankingsFor(format);
    } else {
      throw err;
    }
  }
}

async function main(first?: boolean) {
  if (first) {
    try {
      if (fs.existsSync(STATE)) state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    } catch (err) {
      console.error(`Error reading ${STATE}:`, err);
    }
    if (!state.rankings) state.rankings = await getRankings();
  }

  const begin = +new Date();

  for (const server in sockets) {
    const ws = sockets[server as keyof typeof sockets]!;
    if (ws.readyState === WebSocket.OPEN) ws.send('|/cmd roomlist');
  }
  try {
    const url = 'https://replay.pokemonshowdown.com/search.json';
    const response = await getText(url);
    // Sadly, Pokémon Showdown will simply return plain text on error.
    if (response.startsWith('[')) {
      const json = JSON.parse(response);
      for (const {id, uploadtime, format} of json) {
        if (uploadtime <= state.last.replay) break;
        const threshold = state.rankings![format];
        if (!threshold) continue;
        try {
          const url = `https://replay.pokemonshowdown.com/${id as string}`;
          const response = await getText(`${url}.json`);
          if (response.startsWith('{')) {
            const replay = JSON.parse(response);

            const data: Data = {
              id,
              p1: replay.p1,
              p2: replay.p2,
              time: replay.uploadtime,
              rating: isNaN(replay.rating) || replay.rating === 0 ? undefined : replay.rating,
              threshold: replay.id.startsWith('smogtours') ? 'tour' : threshold,
            };

            state.replays[format] = state.replays[format] || {best: [], recent: []};
            state.replays._ = state.replays._ || {best: [], recent: []};
            if (isBest(data)) {
              state.replays[format].best.push(data);
              state.replays._ .best.push(data);
            }
            state.replays[format].recent.push(data);
            state.replays._.recent.push(data);

            if (state.replays[format].best.length > state.n) state.replays[format].best.shift();
            if (state.replays[format].recent.length > state.n) state.replays[format].recent.shift();
            if (state.replays._.best.length > state.stale) state.replays._.best.shift();
            if (state.replays._.recent.length > state.stale) state.replays._.recent.shift();

            report('replay', data);
          }
        } catch (err) {
          // Ignore - the replay could have been deleted or made private.
          console.error(`Error fetching ${id as string}:`, err);
        }
      }
      if (Array.isArray(json) && json.length) state.last.replay = json[0].uploadtime;
    }
    save();
  } finally {
    // Poll Pokémon Showdown at most once per second.
    const delay = 1000 - (+new Date() - begin);
    setTimeout(main, delay > 0 ? delay : 0);
  }
}

function save() {
  try {
    if (fs.existsSync(STATE)) {
      fs.writeFileSync(`${STATE}.tmp`, stringify(state, {maxLength: 300}));
      fs.renameSync(STATE, `${STATE}.bak`);
      fs.renameSync(`${STATE}.tmp`, STATE);
      fs.unlinkSync(`${STATE}.bak`);
    } else {
      fs.writeFileSync(STATE, stringify(state));
    }
    return 0;
  } catch (err) {
    console.error(`Error reading ${STATE}:`, err);
    return 1;
  }
}

for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) {
  process.on(signal, () => process.exit(save()));
}

schedule();
main(true);
