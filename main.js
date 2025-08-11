require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const figlet = require('figlet');

/* ========== Utils (hoisted) ========== */
const short = (x)=>{ try{ const s=JSON.stringify(x); return s.length>350?s.slice(0,350)+'…':s; }catch{ return String(x);} };
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const envStr=(k,d='')=>{const v=process.env[k]; return (v===undefined||v==='')?d:v;};
const envInt=(k,d)=>{const n=parseInt(process.env[k]||'',10); return Number.isFinite(n)?n:d;};
const envBool=(k,d)=>{const v=(process.env[k]||'').toLowerCase(); return v?['1','true','yes','on'].includes(v):d;};
const envCSVInt=(k,def)=>envStr(k,def).split(',').map(s=>parseInt(s.trim(),10)).filter(Number.isFinite);
const die=(m)=>{ console.error(chalk.red(m)); process.exit(1); };
const mask=(s)=> s.length<=12 ? s : s.slice(0,6)+'...'+s.slice(-6);
const ts=()=> new Date().toISOString().replace('T',' ').replace('Z','');
const okLog=(n,m)=>console.log(ts(), chalk.green(`[${n}]`), chalk.green(m));
const info =(n,m)=>console.log(ts(), chalk.cyan(`[${n}]`),  chalk.cyan(m));
const warn =(n,m)=>console.log(ts(), chalk.yellow(`[${n}]`), chalk.yellow(m));

/* ========== Banner (besar & jelas) ========== */
function banner(){
  const title = figlet.textSync('CREATE BY NANDAA', {
    font: 'Big',           // tebal & mudah dibaca di terminal
    horizontalLayout: 'fitted',
    verticalLayout: 'default',
  });
  console.log('\n' + chalk.white(title));
  const tagline = 'Plant (all) → Wait → Harvest (all) • cookie-based • tRPC batch object';
  const line = '─'.repeat(tagline.length);
  console.log(chalk.cyan(tagline));
  console.log(chalk.gray(line + '\n'));
}

/* ========== ENV & CONFIG ========== */
const BASE_URL  = envStr('BASE_URL','https://app.appleville.xyz');
const SLOT_INDEXES = envCSVInt('SLOT_INDEXES','1,2'); // tanam & panen serentak di slot-slot ini
const SEED_KEY  = envStr('SEED_KEY','tomato');        // default: tomato
const SEED_TYPE = envStr('SEED_TYPE','SEED');

const ROUTES = {
  plant:   envStr('ROUTE_PLANT','core.plantSeed'),
  harvest: envStr('ROUTE_HARVEST','core.harvest'),
  buySeed: envStr('ROUTE_BUY_SEED','core.buyItem'),
};

const GROWTH_SECONDS  = envInt('GROWTH_SECONDS',900); // default 15 menit
const AUTO_BUY_SEED   = envBool('AUTO_BUY_SEED',true);
const BUY_SEED_AMOUNT = envInt('BUY_SEED_AMOUNT',10);
const LOOP_PAUSE_MS   = envInt('LOOP_PAUSE_MS',700);

const DEFAULT_HEADERS = {
  'Accept':'*/*',
  'Content-Type':'application/json',
  'Origin': BASE_URL,
  'Referer': BASE_URL + '/',
  'User-Agent':'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  'X-Trpc-Source':'nextjs-react',
};

/* ========== Token loader ========== */
const TOKENS_FILE = path.resolve('token.txt');
// Baris: nanda|__Host-authjs.csrf-token=...; __Secure-authjs.callback-url=...; session-token=...
if (!fs.existsSync(TOKENS_FILE)) die('token.txt tidak ditemukan.');
const ACCOUNTS = fs.readFileSync(TOKENS_FILE,'utf8')
  .split('\n').map(s=>s.trim()).filter(Boolean).filter(s=>!s.startsWith('#'))
  .map(l=>{ const i=l.indexOf('|'); return i!==-1 ? {name:l.slice(0,i).trim(), cookie:l.slice(i+1).trim()} : {name:mask(l),cookie:l}; });
if (ACCOUNTS.length===0) die('token.txt kosong.');

/* ========== HTTP / tRPC ========== */
function clientFor(cookie){
  return axios.create({
    baseURL: BASE_URL,
    headers: { ...DEFAULT_HEADERS, Cookie: cookie },
    timeout: 30000,
    validateStatus: () => true,
  });
}
// body benar utk batch=1 → { "0": { "json": {...} } }
async function trpcPost(client, route, jsonObj){
  const url  = `/api/trpc/${route}?batch=1`;
  const body = { "0": { json: jsonObj || {} } };
  const res  = await client.post(url, body);
  return { ok: res.status>=200 && res.status<300, status: res.status, data: res.data };
}

/* ========== Detectors ========== */
const isNoHarvest = (d)=>/no\s*(crop|plant)|not\s*planted|empty\s*slot|nothing\s*to\s*harvest|belum\s*ditanam|kosong/i.test(JSON.stringify(d||'')); 
const isOccupied  = (d)=>/already\s*planted|occupied|slot\s*not\s*empty|growing|sedang\s*tumbuh|sudah\s*tertanam/i.test(JSON.stringify(d||'')); 
const needSeed    = (d)=>/seed|stock|insufficient|not\s*enough|lack|quantity/i.test(JSON.stringify(d||'')); 

/* ========== Worker per akun (serentak) ========== */
async function runForAccount(acc){
  const cli = clientFor(acc.cookie);
  info(acc.name, `Mulai. Growth=${GROWTH_SECONDS}s | AutoBuySeed=${AUTO_BUY_SEED?'ON':'OFF'} | Seed=${SEED_KEY} | Slots=[${SLOT_INDEXES.join(', ')}]`);

  while(true){
    /* ---- PHASE 1: PLANT ALL ---- */
    let buyPromise = null;           // beli seed cukup SEKALI per siklus
    const toRetryAfterBuy = [];      // slot yang gagal karena stok

    await Promise.all(SLOT_INDEXES.map(async (slotIndex)=>{
      const r = await trpcPost(cli, ROUTES.plant, { slotIndex, seedKey: SEED_KEY });
      if (!r.ok){
        if (isOccupied(r.data)) {
          info(acc.name, `Slot ${slotIndex} sudah terisi / sedang tumbuh`);
        } else if (AUTO_BUY_SEED && needSeed(r.data)) {
          toRetryAfterBuy.push(slotIndex);
          if (!buyPromise) buyPromise = trpcPost(cli, ROUTES.buySeed, { key: SEED_KEY, type: SEED_TYPE, quantity: BUY_SEED_AMOUNT });
        } else {
          warn(acc.name, `Tanam slot ${slotIndex} gagal: ${short(r.data)}`);
        }
      } else {
        okLog(acc.name, `Tanam slot ${slotIndex} OK`);
      }
      await sleep(120); // kecilin burst
    }));

    if (buyPromise){
      const rb = await buyPromise;
      if (rb.ok) okLog(acc.name, `Auto-beli ${SEED_KEY} x${BUY_SEED_AMOUNT} OK`);
      else warn(acc.name, `Auto-beli gagal: ${short(rb.data)}`);

      await Promise.all(toRetryAfterBuy.map(async (slotIndex)=>{
        const r2 = await trpcPost(cli, ROUTES.plant, { slotIndex, seedKey: SEED_KEY });
        if (r2.ok) okLog(acc.name, `Retry tanam slot ${slotIndex} OK`);
        else warn(acc.name, `Retry tanam slot ${slotIndex} gagal: ${short(r2.data)}`);
        await sleep(120);
      }));
    }

    /* ---- PHASE 2: WAIT ---- */
    await sleep(GROWTH_SECONDS*1000);

    /* ---- PHASE 3: HARVEST ALL ---- */
    await Promise.all(SLOT_INDEXES.map(async (slotIndex)=>{
      const r = await trpcPost(cli, ROUTES.harvest, { slotIndex });
      if (!r.ok){
        if (isNoHarvest(r.data)) info(acc.name, `Slot ${slotIndex}: tidak ada tanaman untuk dipanen`);
        else warn(acc.name, `Panen slot ${slotIndex} gagal: ${short(r.data)}`);
      } else {
        okLog(acc.name, `Panen slot ${slotIndex} OK`);
      }
      await sleep(120);
    }));

    await sleep(LOOP_PAUSE_MS);
  }
}

/* ========== Main ========== */
(async()=>{
  banner();
  console.log(`${ts()} Base URL: ${BASE_URL}`);
  console.log(`${ts()} Akun: ${ACCOUNTS.map(a=>a.name).join(', ')}`);
  for (const acc of ACCOUNTS){
    runForAccount(acc).catch(e=>warn(acc.name, `Fatal: ${e.message||e}`));
    await sleep(250);
  }
})();
