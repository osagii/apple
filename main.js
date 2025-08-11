require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');

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

function banner(){
  const title = 'CREATE BY NANDA';
  const line  = '═'.repeat(title.length + 6);
  console.log('\n' + chalk.cyan(`╔${line}╗`));
  console.log(chalk.cyan(`║   ${title}   ║`));
  console.log(chalk.cyan(`╚${line}╝\n`));
  console.log(chalk.cyan('Harvest sweep → Plant all → Wait → Harvest all • cookie-based • tRPC\n'));
}

const BASE_URL  = envStr('BASE_URL','https://app.appleville.xyz');
const SLOT_INDEXES = envCSVInt('SLOT_INDEXES','1,2');
const SEED_KEY  = envStr('SEED_KEY','tomato');
const SEED_TYPE = envStr('SEED_TYPE','SEED');

const ROUTES = {
  plant:   envStr('ROUTE_PLANT','core.plantSeed'),
  harvest: envStr('ROUTE_HARVEST','core.harvest'),
  buySeed: envStr('ROUTE_BUY_SEED','core.buyItem'),
};

const GROWTH_SECONDS  = envInt('GROWTH_SECONDS',900);
const AUTO_BUY_SEED   = envBool('AUTO_BUY_SEED',true);
const BUY_SEED_AMOUNT = envInt('BUY_SEED_AMOUNT',10);
const LOOP_PAUSE_MS   = envInt('LOOP_PAUSE_MS',700);

const DEFAULT_HEADERS = {
  'Accept':'*/*',
  'Content-Type':'application/json',
  'Origin': BASE_URL,
  'Referer': BASE_URL + '/',
  2024: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  'X-Trpc-Source':'nextjs-react',
};
DEFAULT_HEADERS['User-Agent'] = DEFAULT_HEADERS[2024]; delete DEFAULT_HEADERS[2024];

const TOKENS_FILE = path.resolve('token.txt');
if (!fs.existsSync(TOKENS_FILE)) die('token.txt tidak ditemukan.');
const ACCOUNTS = fs.readFileSync(TOKENS_FILE,'utf8')
  .split('\n').map(s=>s.trim()).filter(Boolean).filter(s=>!s.startsWith('#'))
  .map(l=>{ const i=l.indexOf('|'); return i!==-1 ? {name:l.slice(0,i).trim(), cookie:l.slice(i+1).trim()} : {name:mask(l),cookie:l}; });
if (ACCOUNTS.length===0) die('token.txt kosong.');

function clientFor(cookie){
  return axios.create({
    baseURL: BASE_URL,
    headers: { ...DEFAULT_HEADERS, Cookie: cookie },
    timeout: 30000,
    validateStatus: () => true,
  });
}
async function trpcPost(client, route, jsonObj){
  try{
    const url  = `/api/trpc/${route}?batch=1`;
    const body = { "0": { json: jsonObj || {} } };
    const res  = await client.post(url, body);
    return { ok: res.status>=200 && res.status<300, status: res.status, data: res.data };
  }catch(e){
    return { ok:false, status:0, data:{ error:'network', message: e?.message || String(e) } };
  }
}

const toTxt = (d)=>JSON.stringify(d||'').toLowerCase();
const isNoHarvest = (d)=>/no\s*(crop|plant|harvest)|not\s*planted|empty\s*slot|nothing\s*to\s*harvest|belum\s*ditanam|kosong/.test(toTxt(d));
const isOccupied  = (d)=>/already\s*planted|occupied|slot\s*not\s*empty|growing|sedang\s*tumbuh|sudah\s*tertanam|plot\s*not\s*available/.test(toTxt(d));
const needSeed    = (d)=>/no\s*seeds|need\s*seed|stock|insufficient|not\s*enough|lack|quantity/.test(toTxt(d));
const coinsLess   = (d)=>/insufficient\s*coins|not\s*enough\s*coins|saldo\s*tidak\s*cukup/.test(toTxt(d));

async function harvestSweep(cli, accName){
  for (const slotIndex of SLOT_INDEXES){
    const r = await trpcPost(cli, ROUTES.harvest, { slotIndex });
    if (r.ok) okLog(accName, `Panen slot ${slotIndex} ✓`);
    else if (isNoHarvest(r.data)) info(accName, `Slot ${slotIndex}: tidak ada tanaman untuk dipanen`);
    else info(accName, `Panen slot ${slotIndex} ditunda: ${short(r.data)}`);
    await sleep(120);
  }
}

async function plantSweep(cli, accName){
  let needBuy = false;
  const retrySlots = [];
  for (const slotIndex of SLOT_INDEXES){
    const r = await trpcPost(cli, ROUTES.plant, { slotIndex, seedKey: SEED_KEY });
    if (r.ok) {
      okLog(accName, `Tanam slot ${slotIndex} ✓`);
    } else if (isOccupied(r.data)) {
      info(accName, `Slot ${slotIndex} sedang tumbuh — lewati`);
    } else if (AUTO_BUY_SEED && needSeed(r.data)) {
      needBuy = true;
      retrySlots.push(slotIndex);
      info(accName, `Slot ${slotIndex} butuh benih — akan dibeli & coba lagi`);
    } else {
      info(accName, `Tanam slot ${slotIndex} ditunda: ${short(r.data)}`);
    }
    await sleep(120);
  }

  if (needBuy){
    const rb = await trpcPost(cli, ROUTES.buySeed, { key: SEED_KEY, type: SEED_TYPE, quantity: BUY_SEED_AMOUNT });
    if (rb.ok){
      okLog(accName, `Beli ${SEED_KEY} x${BUY_SEED_AMOUNT} ✓`);
      for (const slotIndex of retrySlots){
        const r2 = await trpcPost(cli, ROUTES.plant, { slotIndex, seedKey: SEED_KEY });
        if (r2.ok) okLog(accName, `Retry tanam slot ${slotIndex} ✓`);
        else if (isOccupied(r2.data)) info(accName, `Slot ${slotIndex} sudah terisi — lewati`);
        else info(accName, `Retry tanam slot ${slotIndex} ditunda: ${short(r2.data)}`);
        await sleep(120);
      }
    } else {
      if (coinsLess(rb.data)) info(accName, `Koin belum cukup untuk beli benih — lanjut siklus tanpa tanam baru`);
      else info(accName, `Pembelian benih ditunda: ${short(rb.data)}`);
    }
  }
}

async function runForAccount(acc){
  const cli = clientFor(acc.cookie);
  info(acc.name, `Mulai. Growth=${GROWTH_SECONDS}s • AutoBuySeed=${AUTO_BUY_SEED?'ON':'OFF'} • Seed=${SEED_KEY} • Slots=[${SLOT_INDEXES.join(', ')}]`);
  while(true){
    await harvestSweep(cli, acc.name);
    await plantSweep(cli, acc.name);
    await sleep(GROWTH_SECONDS*1000);
    await harvestSweep(cli, acc.name);
    await sleep(LOOP_PAUSE_MS);
  }
}

(async()=>{
  banner();
  console.log(`${ts()} Base URL: ${BASE_URL}`);
  console.log(`${ts()} Akun: ${ACCOUNTS.map(a=>a.name).join(', ')}`);
  for (const acc of ACCOUNTS){
    runForAccount(acc).catch(e=>info(acc.name, `Catatan loop: ${e.message||e}`));
    await sleep(250);
  }
})();
