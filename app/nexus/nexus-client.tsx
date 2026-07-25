"use client";
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { closeLiveTrade } from "../../lib/closeLiveTrade";
import { openLiveTrade } from "../../lib/openLiveTrade";
import { supabase } from "../../lib/supabase";
import { motion, useAnimationControls } from "framer-motion";

const K={c:"#00F2FE",r:"#FF3366",g:"#00FF88",gold:"#FFD700",pu:"#BD00FF",co:"#0044EE",bg:"#04060D",pan:"#060A12",brd:"#0A1D33",dim:"#2A5070",hi:"#A8D0EC",tx:"#4A7090"};
const CAP=10000;
const f2=(n:number,d=2)=>Number(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fP=(n:number)=>`${n>=0?"+":""}${f2(n)}%`;
const fU=(n:number)=>`${n>=0?"+":"-"}$${f2(Math.abs(n))}`;
const ts=()=>new Date().toLocaleTimeString("en-US",{hour12:false});
const fPrice=(p:number)=>p>=1000?"$"+f2(p,0):p>=1?"$"+f2(p,2):p>=0.01?"$"+f2(p,4):p>=0.0001?"$"+f2(p,6):"$"+f2(p,8);

// ── Algo primitives ──────────────────────────────────────────────────
const calcRSI=(prices:number[],period=14):number=>{
  if(prices.length<period+1)return 50;
  let g=0,l=0;
  for(let i=prices.length-period;i<prices.length;i++){const d=prices[i]-prices[i-1];d>0?g+=d:l-=d;}
  const rs=g/(l||0.001);return 100-100/(1+rs);
};
const hasMomentum=(hist:number[]):boolean=>{
  if(hist.length<10)return true;
  const r=hist.slice(-5),pr=hist.slice(-10,-5);
  const ra=r.reduce((a,b)=>a+b,0)/5,pa=pr.reduce((a,b)=>a+b,0)/5;
  return Math.abs(ra-pa)/pa>0.001;
};
const confirmSignal=(hist:number[]):{isBuy:boolean,isSell:boolean,quality:"HIGH"|"MED"|"LOW",conf:number}=>{
  const rsi1m=calcRSI(hist.slice(-15),14);
  const h5m=hist.filter((_,i)=>i%5===0);
  const rsi5m=calcRSI(h5m,Math.min(14,h5m.length-1));
  const trend15m=hist[hist.length-1]>hist[Math.floor(hist.length/4)];
  const isBuy=rsi1m<48&&rsi5m<58&&trend15m;
  const isSell=rsi1m>62&&rsi5m>60&&!trend15m;
  const strength=Math.abs(rsi1m-50)+Math.abs(rsi5m-50);
  const quality=strength>20?"HIGH":strength>10?"MED":"LOW";
  const conf=Math.min(95,50+strength*0.9);
  return{isBuy,isSell,quality,conf};
};
const kellySize=(conf:number,wr:number):number=>{
  const edge=(wr/100)*(conf/100)-(1-wr/100);
  return Math.max(0.05,Math.min(0.20,edge));
};
const getStop=(pos:{avg:number,peak?:number},cur:number):number=>{
  const pct=((cur-pos.avg)/pos.avg)*100;
  if(pct>=5)return(pos.peak||cur)*0.99;
  if(pct>=3)return(pos.peak||cur)*0.985;
  if(pct>=1.5)return pos.avg;
  // Tighter SL: -1.8% (was -2.5%) → smaller losses, bigger net positive EV
  return pos.avg*(1-SWARM_SL_PCT[SWARM_CONFIG.profile]);
};
const CORRELATED:{[k:string]:string[]}={
  SOL:["JUP","RAY","ORCA","JTO","DRIFT"],BTC:["ETH"],ETH:["BTC"],
  JUP:["SOL","RAY"],RAY:["SOL","JUP"],ORCA:["SOL"],JTO:["SOL"],DRIFT:["SOL"],
};
const MISSIONS=[
  {id:1,name:"FIRST BLOOD",target:0.05,reward:"$500",message:"First alpha captured. Swarm efficiency: NOMINAL.",color:"#00FF88",icon:"⚡"},
  {id:2,name:"ALPHA CONFIRMED",target:0.10,reward:"$1,000",message:"10% threshold breached. Swarm intelligence: VALIDATED.",color:"#00F2FE",icon:"◈"},
  {id:3,name:"MOMENTUM PREDATOR",target:0.25,reward:"$2,500",message:"Exceptional performance. You are in the top 2% of traders.",color:"#FFD700",icon:"🏆"},
  {id:4,name:"MARKET DOMINATOR",target:0.50,reward:"$5,000",message:"Extraordinary. KYMIA has doubled your risk-adjusted returns.",color:"#BD00FF",icon:"👑"},
  {id:5,name:"NEXUS ELITE",target:1.00,reward:"$10,000",message:"LEGENDARY. Portfolio doubled. You have transcended normal trading.",color:"#FF3366",icon:"◈"},
];

// ── Live trading: token decimals + USDC output mint ─────────────────────────
// Most Solana SPL tokens use 6 decimals; SOL (wSOL) uses 9; wrapped BTC/ETH use 8.
// Jupiter amount param = qty * 10^decimals (integer, smallest unit).
const TOKEN_DECIMALS:Record<string,number>={SOL:9,BTC:8,ETH:8};
const USDC_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ── Experienced Trader Rules ──────────────────────────────────────────────────
const TRADER_RULES={
  peakHoursUTC:[[7,9],[13,17]] as [number,number][],
  offPeakMinConf:80,          // raised from 72 — only high-conviction off-peak
  peakMinConf:78,             // raised from 70
  peakConfBoost:10,
  loss2SizeMultiplier:0.60,
  loss3SizeMultiplier:0.40,
  loss3PauseMs:5*60*1000,
  maxDailyDrawdownPct:0.08,
  macroBtcThreshold:1.5,      // tightened from 4% → block on BTC ±1.5%
  scaleInInitialFrac:0.07,
  scaleInAddFrac:0.04,
  scaleInTriggerPct:1.0,
};

// ── Swarm leverage & profile config ───────────────────────────────────────────
const SWARM_CONFIG={leverage:3,profile:"balanced" as "safe"|"balanced"|"aggressive"};
const SWARM_BASE_ALLOC:{[k:string]:number}={safe:0.04,balanced:0.07,aggressive:0.12};
// Minimum 1:3 ratio (SL 1.8%, TP 5.5%) enforced across all profiles
const SWARM_SL_PCT:{[k:string]:number}={safe:0.018,balanced:0.018,aggressive:0.025};
const SWARM_TP_PCT:{[k:string]:number}={safe:0.055,balanced:0.08,aggressive:0.15};

function isPeakHour():boolean{
  const h=new Date().getUTCHours();
  return TRADER_RULES.peakHoursUTC.some(([s,e])=>h>=s&&h<e);
}
function getSessionQuality():{quality:"PRIME"|"GOOD"|"LOW"|"AVOID",multiplier:number,label:string,col:string}{
  const h=new Date().getUTCHours();
  if(h>=8&&h<=10)return{quality:"PRIME",multiplier:1.0,label:"EU OPEN",col:K.g};
  if(h>=13&&h<=16)return{quality:"PRIME",multiplier:1.0,label:"NY OPEN",col:K.g};
  if(h>=10&&h<=13)return{quality:"GOOD",multiplier:0.7,label:"EU SESSION",col:K.gold};
  if(h>=16&&h<=20)return{quality:"GOOD",multiplier:0.7,label:"NY SESSION",col:K.gold};
  if(h>=0&&h<=6)return{quality:"AVOID",multiplier:0.5,label:"DEAD ZONE",col:K.r};
  return{quality:"LOW",multiplier:0.4,label:"ASIAN",col:K.dim};
}
async function detectManipulation(sym:string):Promise<{risk:"LOW"|"MEDIUM"|"HIGH",score:number,flags:string[]}>{
  try{
    const res=await fetch(`https://api.dexscreener.com/latest/dex/search?q=${sym}USDC`);
    const data=await res.json();
    const pair=data?.pairs?.[0];
    if(!pair)return{risk:"LOW",score:0,flags:[]};
    let s=0;const flags:string[]=[];
    const pc=Math.abs(pair.priceChange?.h1||0),vr=(pair.volume?.h1||0)/(pair.volume?.h24||1)*24;
    if(pc>15&&vr<2){s+=35;flags.push("Spike w/o vol");}
    if((Date.now()-(pair.pairCreatedAt||0))/3600000<24){s+=25;flags.push("< 24h old");}
    if((pair.liquidity?.usd||0)<100000){s+=20;flags.push("Liq < $100K");}
    const b=pair.txns?.h1?.buys||0,sl2=pair.txns?.h1?.sells||0,br=b/(b+sl2||1);
    if(br>0.90||br<0.10){s+=20;flags.push(`Buy ratio ${(br*100).toFixed(0)}%`);}
    return{risk:s>60?"HIGH":s>30?"MEDIUM":"LOW",score:s,flags};
  }catch{return{risk:"LOW",score:0,flags:[]};}
}

function applyTraderRules(
  conf:number,
  kellyFrac:number,
  trades:{pnl:number}[],
  sessionEquity:number,
  currentEquity:number,
):{allow:boolean;frac:number;reason?:string;isPeak:boolean;consecLosses:number;triggerPause:boolean;triggerCircuit:boolean}{
  const peak=isPeakHour();
  const boostedConf=peak?Math.min(conf+TRADER_RULES.peakConfBoost,100):conf;
  const minConf=peak?TRADER_RULES.peakMinConf:TRADER_RULES.offPeakMinConf;
  if(boostedConf<minConf)return{allow:false,frac:0,reason:`Conf ${Math.round(conf)}% < ${minConf}% min (${peak?"peak":"off-peak"})`,isPeak:peak,consecLosses:0,triggerPause:false,triggerCircuit:false};
  let consecLosses=0;
  for(let i=0;i<trades.length;i++){if(trades[i].pnl<0)consecLosses++;else break;}
  if(consecLosses>=5)return{allow:false,frac:0,reason:`5 consecutive losses — CIRCUIT BREAKER`,isPeak:peak,consecLosses,triggerPause:false,triggerCircuit:true};
  let frac=TRADER_RULES.scaleInInitialFrac;
  let triggerPause=false;
  if(consecLosses>=3){frac*=TRADER_RULES.loss3SizeMultiplier;triggerPause=true;}
  else if(consecLosses>=2){frac*=TRADER_RULES.loss2SizeMultiplier;}
  // Suppress unused kellyFrac param lint warning — Kelly is overridden by scale-in
  void kellyFrac;
  const drawdown=(sessionEquity-currentEquity)/sessionEquity;
  if(drawdown>TRADER_RULES.maxDailyDrawdownPct)return{allow:false,frac:0,reason:`Daily drawdown ${f2(drawdown*100,1)}% exceeds limit`,isPeak:peak,consecLosses,triggerPause:false,triggerCircuit:false};
  return{allow:true,frac,isPeak:peak,consecLosses,triggerPause,triggerCircuit:false};
}

// ── Portfolio exposure helpers (Bug 4) ────────────────────────────────────────
const getMaxPositions=(equity:number):number=>{
  if(equity<8000)return 2;
  if(equity<9000)return 3;
  if(equity<11000)return 4;
  return 5;
};
const getTotalExposure=(pos:Record<string,Position>,px:{[k:string]:PriceData}):number=>
  Object.entries(pos).reduce((t,[sym,p])=>t+p.qty*(px[sym]?.price||p.avg),0);

function OdometerChar({ch,col}:{ch:string,col:string}){
  const prevCh=useRef(ch);
  const [key,setKey]=useState(0);
  const [current,setCurrent]=useState(ch);
  useEffect(()=>{
    if(ch!==prevCh.current){prevCh.current=ch;setCurrent(ch);setKey(k=>k+1);}
  },[ch]);
  if(!/\d/.test(ch))return<span style={{color:col}}>{current}</span>;
  return(
    <span style={{display:"inline-block",overflow:"hidden",height:"1.1em",lineHeight:"1.1em",verticalAlign:"bottom",minWidth:"0.58em",textAlign:"center"}}>
      <span key={key} style={{display:"block",animation:"odometerRoll 0.4s cubic-bezier(0.4,0,0.2,1) both",color:col}}>{current}</span>
    </span>
  );
}
function Odometer({value,col,style}:{value:string,col:string,style?:React.CSSProperties}){
  const chars=value.split("");
  return(
    <span style={{display:"inline-flex",alignItems:"baseline",fontVariantNumeric:"tabular-nums",...style}}>
      {chars.map((ch,i)=><OdometerChar key={chars.length-i} ch={ch} col={col}/>)}
    </span>
  );
}

type SymInfo={base:number,vol:number,col:string,icon:string,mint:string,cat:string};
const SYMS:{[k:string]:SymInfo}={
  // L1
  SOL:{base:178.4,vol:.0028,col:K.c,icon:"◎",mint:"So11111111111111111111111111111111111111112",cat:"L1"},
  BTC:{base:67420,vol:.0012,col:K.gold,icon:"₿",mint:"3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",cat:"L1"},
  ETH:{base:3540,vol:.0016,col:"#627EEA",icon:"Ξ",mint:"7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",cat:"L1"},
  BNB:{base:0,vol:.006,col:"#F0B90B",icon:"◆",mint:"",cat:"L1"},
  XRP:{base:0,vol:.008,col:"#23292F",icon:"✕",mint:"",cat:"L1"},
  AVAX:{base:0,vol:.008,col:"#E84142",icon:"▲",mint:"",cat:"L1"},
  LINK:{base:0,vol:.006,col:"#2A5ADA",icon:"⬡",mint:"",cat:"DEFI"},
  // Solana DeFi
  JUP:{base:1.24,vol:.004,col:K.g,icon:"◆",mint:"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",cat:"DEFI"},
  RAY:{base:2.8,vol:.005,col:"#4D95FF",icon:"◈",mint:"4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",cat:"DEFI"},
  ORCA:{base:2.1,vol:.005,col:"#00B4D8",icon:"⊙",mint:"orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",cat:"DEFI"},
  PYTH:{base:0.38,vol:.006,col:"#E6D55A",icon:"◉",mint:"HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",cat:"DEFI"},
  JTO:{base:3.2,vol:.005,col:"#5CE1E6",icon:"⟁",mint:"jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",cat:"DEFI"},
  DRIFT:{base:0.62,vol:.007,col:"#7B61FF",icon:"⤳",mint:"DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7",cat:"DEFI"},
  MNGO:{base:0.018,vol:.008,col:"#FF9500",icon:"◇",mint:"MangoCzJ36AjZyKwVj3VnYU4GTonjfVEnJmvvWaxLac",cat:"DEFI"},
  FIDA:{base:0.22,vol:.009,col:"#4E44CE",icon:"⬡",mint:"EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp",cat:"DEFI"},
  STEP:{base:0.045,vol:.008,col:"#7FFF00",icon:"↗",mint:"StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT",cat:"DEFI"},
  // Memecoins
  BONK:{base:.0000242,vol:.008,col:"#FF6B00",icon:"⚡",mint:"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",cat:"MEME"},
  WIF:{base:2.8,vol:.009,col:"#FF69B4",icon:"◎",mint:"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",cat:"MEME"},
  POPCAT:{base:0.62,vol:.01,col:"#FF4488",icon:"●",mint:"7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",cat:"MEME"},
  MYRO:{base:0.058,vol:.012,col:"#8B5CF6",icon:"⬡",mint:"HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4",cat:"MEME"},
  BOME:{base:0.0062,vol:.012,col:"#FF6633",icon:"◈",mint:"ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",cat:"MEME"},
  SLERF:{base:0.38,vol:.015,col:"#FF33FF",icon:"⊞",mint:"7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3",cat:"MEME"},
  GUAC:{base:0.00015,vol:.02,col:"#52B788",icon:"◉",mint:"AZsHEMXd36Bj1EMNXhowJajpUXzrKcK57wW4ZGXVa7yR",cat:"MEME"},
  WEN:{base:0.000065,vol:.018,col:"#A8DADC",icon:"◇",mint:"WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",cat:"MEME"},
  // Stablecoins (for depeg detection)
  USDC:{base:1.0,vol:.0001,col:"#2775CA",icon:"$",mint:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",cat:"STABLE"},
  USDT:{base:1.0,vol:.0001,col:"#26A17B",icon:"₮",mint:"Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",cat:"STABLE"},
  // Additional
  COPE:{base:0.12,vol:.01,col:"#E040FB",icon:"⊕",mint:"8HGyAAB1yoM1ttS7pXjHMa3dukTFGQggnFFH3hJZgzQh",cat:"DEFI"},
  ZETA:{base:0.055,vol:.011,col:"#00E5FF",icon:"⟂",mint:"ZETAxsqTWhLDGkGnSPMNUKMqhcJRHRSXVgDoVLRFJvL",cat:"DEFI"},
  JITO:{base:3.8,vol:.005,col:"#FF8800",icon:"◆",mint:"J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",cat:"DEFI"},
};
const STABLE_SYMS=new Set(["USDC","USDT"]);
const SYM_COUNT=Object.keys(SYMS).length;

const AGENTS=[
  {id:"consensus",name:"CONSENSUS",s:"CNSNS",lv:0,ag:0},
  {id:"aegis",name:"AEGIS",s:"AEGIS",lv:1,ag:60},
  {id:"oracle",name:"ORACLE",s:"ORACLE",lv:1,ag:180},
  {id:"phantom",name:"PHANTOM",s:"PHTM",lv:1,ag:300},
  {id:"titan",name:"TITAN",s:"TITAN",lv:2,ag:30},
  {id:"hydra",name:"HYDRA",s:"HYDRA",lv:2,ag:102},
  {id:"shield",name:"SHIELD",s:"SHLD",lv:2,ag:174},
  {id:"neural",name:"NEURAL",s:"NRLA",lv:2,ag:246},
  {id:"watch",name:"WATCH",s:"WTCH",lv:2,ag:318},
  {id:"lens",name:"LENS",s:"LENS",lv:3,ag:0},
  {id:"atlas",name:"ATLAS",s:"ATLAS",lv:3,ag:45},
  {id:"echo",name:"ECHO",s:"ECHO",lv:3,ag:90},
  {id:"leviathan",name:"LEVIATHAN",s:"LVTH",lv:3,ag:135},
  {id:"razor",name:"RAZOR",s:"RAZR",lv:3,ag:180},
  {id:"surge",name:"SURGE",s:"SRGE",lv:3,ag:225},
  {id:"vector",name:"VECTOR",s:"VCTR",lv:3,ag:270},
  {id:"delta",name:"DELTA",s:"DLTA",lv:3,ag:315},
  {id:"radar",name:"RADAR",s:"RADR",lv:3,ag:338},
];

const LR=[0,76,144,212];
const GCX=240,GCY=232;
const gpos=(a:{lv:number,ag:number})=>{
  if(!a.lv)return{x:GCX,y:GCY};
  const r=LR[a.lv],rad=(a.ag-90)*Math.PI/180;
  return{x:GCX+r*Math.cos(rad),y:GCY+r*Math.sin(rad)};
};

const CONNS=[
  ["consensus","aegis"],["consensus","oracle"],["consensus","phantom"],
  ["aegis","titan"],["aegis","shield"],["oracle","lens"],["oracle","atlas"],
  ["phantom","echo"],["phantom","leviathan"],["titan","razor"],["titan","surge"],
  ["hydra","consensus"],["neural","consensus"],["watch","consensus"],
  ["vector","consensus"],["delta","consensus"],["radar","consensus"],
  ["leviathan","consensus"],["surge","consensus"],["atlas","consensus"],
];
// ── Real server-side agents (6 agents + confluence aggregator at center) ──────
const REAL_AGENTS=[
  {id:"confluence",name:"CONFLUENCE",s:"CNSNS",lv:0,ag:0},
  {id:"universe",  name:"UNIVERSE",  s:"UNIV", lv:1,ag:270},
  {id:"regime",    name:"REGIME",    s:"REGM", lv:1,ag:30},
  {id:"signal",    name:"SIGNAL",    s:"SGNL", lv:1,ag:150},
  {id:"sizing",    name:"SIZING",    s:"SIZE", lv:2,ag:330},
  {id:"edge",      name:"EDGE",      s:"EDGE", lv:2,ag:90},
  {id:"risk",      name:"RISK",      s:"RISK", lv:2,ag:210},
];
const REAL_CONNS=[
  ["confluence","universe"],["confluence","regime"],["confluence","signal"],
  ["confluence","sizing"],["confluence","edge"],["confluence","risk"],
  ["universe","sizing"],["regime","edge"],["signal","risk"],
];

const BOOT_STEPS=[
  "[SYSTEM]: Initializing KYMIA Swarm...",
  "[UNIVERSE]: Liquidity Monitor Online...",
  "[REGIME]: Macro Regime Detector Active...",
  "[SIGNAL]: Technical Signal Engine Synced...",
  `[JUPITER]: ${SYM_COUNT} Solana pairs loaded...`,
  "[SWARM]: 6 Cognitive Agents Connected...",
  "[KYMIA]: ◈ KYMIA OPERATIONAL.",
];

const EDGE_EVENTS=[
  {type:"WHALE",icon:"🐋",col:K.pu,title:"WHALE DETECTED",body:"LEVIATHAN: +12,400 SOL\nwithdrawn from Binance"},
  {type:"BREAKOUT",icon:"⚡",col:K.c,title:"BREAKOUT IMMINENT",body:"SURGE: Bull flag 4H confirmed\nVolume confirms entry"},
  {type:"LIQUIDITY",icon:"🎯",col:K.gold,title:"LIQUIDITY CASCADE",body:"TITAN: $180M shorts at\nliquidation zone reached"},
  {type:"EDGE",icon:"📡",col:K.g,title:"EDGE SIGNAL FIRED",body:"RADAR: Pre-move detected\nEdge score: 87/100"},
  {type:"REGIME",icon:"◈",col:K.c,title:"REGIME SHIFT",body:"ATLAS: Macro pivot detected\nRisk-on mode confirmed"},
  {type:"MANIP",icon:"🛡",col:K.r,title:"MANIPULATION BLOCKED",body:"SHIELD: Spoofing detected\nExecution pathway secured"},
];

const TH:{[k:string]:string[]}={
  aegis:["Exposure 14.2% ✓ Kelly OK","Risk matrix: NOMINAL","Max DD guard ACTIVE","VETO: overexposure risk"],
  oracle:["Cycle top prob: 23%","On-chain: accumulation","Derivatives OI +12%","Funding rate neutral"],
  phantom:["Momentum acceleration rising","Ghost orders @$179","Hidden order flow: BUY","Stealth accumulation"],
  titan:["Liquidity imbalance detected","$180M shorts liq @179.5","Short squeeze imminent","Cascade trigger: ACTIVE"],
  hydra:["Multi-leg arb SOL/ETH","Stat revert BTC/ETH ratio","Cross-venue spread +0.08%","Hydra leg 3 executing"],
  shield:["Anti-manipulation: CLEAN","Spoofing blocked @67,800","Wash trading 0.3% filtered","Execution: VERIFIED"],
  neural:["Pattern: 72h wedge break","Historical match 91%","Neural confidence: HIGH","Bull continuation model"],
  watch:["Latency 42ms NOMINAL","Endpoints: 100% healthy","Slippage 0.08% nominal","System status: GREEN"],
  lens:["SOL order book: $2.4M bid wall","JUP/SOL spread: LIQUID","BONK tick flow: 81% buy","RAY VWAP cross confirmed"],
  atlas:["SOL+JUP+WIF correlated","Memecoin β=1.8 to SOL","DeFi tokens lagging L1","Alt rotation in progress"],
  echo:["Fear & Greed: 68 (Greed)","Reddit volume +220%","Sentiment Z-score: +2.1σ","SOL mentions +840%"],
  leviathan:["CEX outflow +12,400 SOL","WIF whale: +2.1M tokens","BONK accumulation 14d HIGH","Whale cluster detected"],
  razor:["POPCAT 1m RSI bounce","WIF scalp LONG confirmed","BONK micro-reversal ✓","DRIFT scalp PnL +0.8%"],
  surge:["WIF bull flag 4H confirmed","BONK breakout imminent","POPCAT ATH retest 61%","SLERF volume spike: ENTER"],
  vector:["Primary trend: BULLISH","EMA 21/55 cross ↑","ADX 38: strong trend","Higher highs + lows"],
  delta:["Shadow: Bull 68% prob","Survival prob: 91.4%","E[R]: μ=+2.1% σ=0.8%","Black swan: 0.6%"],
  radar:["Pre-move: WIF/BONK/SOL","PYTH: smart money entering","Edge score: 87/100 — DRIFT","MEME rotation signal"],
  consensus:["VOTE: BUY SOL 14/18","WIF consensus: 82%","BONK debate: LONG wins","EXECUTE: JUP LONG"],
};

// ── V2.1 Types ───────────────────────────────────────────────────────
type MarketRegime='TRENDING'|'RANGING'|'VOLATILE'|'BLACK SWAN';
interface RegimeState{regime:MarketRegime;confidence:number;direction:'BULL'|'BEAR'|'NEUTRAL';dominantAgents:string[];adx:number;description:string}
interface OpportunityScore{total:number;breakdown:{liquidity:number;momentum:number;volume:number;sentiment:number;risk:number};grade:'A'|'B'|'C'|'D';tradeable:boolean}
interface TradeExplanation{passed:{signal:string;detail:string}[];failed:{signal:string;detail:string}[];decision:'EXECUTE'|'REJECT';reason:string}
interface SignalWithDecay{id:string;sym:string;signal:'BUY'|'SELL';initialConf:number;currentConf:number;createdAt:number;ageSeconds:number;decayPct:number;expired:boolean}
type TokenStatus='WATCHLISTED'|'CONFIRMING'|'ENTRY_CANDIDATE'|'EXECUTING'|'REJECTED';
interface WatchlistedToken{sym:string;name:string;address:string;status:TokenStatus;safetyScore:number;momentumScore:number;watchlistTime:number;confirmationProgress:number;liquidity:number;volume1h:number;buyRatio:number;priceChange1h:number;price:number;dexUrl:string;flags:string[];passed:string[]}
interface MissedOpportunity{sym:string;move:number;reason:string;timestamp:string;wasRightToSkip:boolean}
// Real server-side verdict from /api/public/dashboard/agents
interface AgentFeedVerdict{cycle_ts:string;symbol:string;agent:string;vote:string;confidence:number;reason:string;score_total:number|null;decision:string|null}
interface RejectedTrade{sym:string;confidence:number;reasons:string[];timestamp:string;capitalProtected:number}
// ── V2.1 Constants ───────────────────────────────────────────────────
const AGENT_LAYER_MAP:Record<string,{layer:number,role:string}>={
  titan:{layer:1,role:'Strategy Desk'},atlas:{layer:1,role:'Regime Detector'},
  radar:{layer:2,role:'Edge Radar'},leviathan:{layer:3,role:'Liquidity Snipe'},aegis:{layer:3,role:'Anti-Manipulation'},
};
const LAYER_RING_COLORS:{[k:number]:string}={1:'#00F2FE',2:'#BD00FF',3:'#FF8C00'};
const REGIME_CONFIG:Record<MarketRegime,{col:string;agentWeightBoosts:Record<string,number>;maxExposure:number;description:string}>={
  'TRENDING':{col:'#00FF88',agentWeightBoosts:{titan:1.4,radar:1.3,vector:1.2},maxExposure:0.65,description:'Strong directional move — ride the trend'},
  'RANGING':{col:'#FFD700',agentWeightBoosts:{lens:1.4,oracle:1.3,shield:1.2},maxExposure:0.40,description:'Oscillating market — mean reversion plays'},
  'VOLATILE':{col:'#FF3366',agentWeightBoosts:{aegis:1.8,watch:1.5},maxExposure:0.20,description:'High volatility — reduced exposure only'},
  'BLACK SWAN':{col:'#BD00FF',agentWeightBoosts:{aegis:3.0},maxExposure:0.05,description:'Extreme event — AEGIS dominates, preserve capital'},
};
const DECAY_RATE=2.5;
const SIGNAL_EXPIRY=15*60*1000;

type PriceData={price:number,prev:number,trend:string,change:number,rsi:number,hist:number[],source?:string,isRealPrice?:boolean};
type AgentState={on:boolean,conf:number|null,sig:string|null,th:string,real?:boolean};
type NewToken={address:string,name:string,price:string,change1h:number,volume24h:number,liquidity:number,rugScore:number,buys:number,sells:number};
type DataStatus={jupiter:"ok"|"err"|"loading",binance:"ok"|"err"|"loading",coingecko:"ok"|"err"|"loading",lastUpdate:number};
type Position={qty:number,avg:number,peak?:number,entryMs?:number,trailActive?:boolean,side?:"LONG"|"SHORT",scaledIn?:boolean,leverage?:number,leveragedSize?:number,conviction?:string};
type AgentSignals={lens?:{rsi:number,signal:string},radar?:{ema9:number,ema21:number,signal:string},razor?:{rsi:number,macd:number,signal:string},vector?:{adx:number,signal:string},surge?:{volumeChange:number,signal:string},leviathan?:{buyPressure:number,signal:string},echo?:{fg:number,signal:string}};
type Trade={id:string,sym:string,side:string,qty:number,entry?:number,price:number,pnl:number,pct?:number,conf:number,t:string,ms:number,agent?:string,reason?:string,agentSignals?:AgentSignals};
type LogEntry={t:string,ag:string,msg:string,col:string};
type WinCard={id:string,sym:string,pnl:number,pct:number,price:number,agent:string,t:string,origin?:{x:number,y:number}};
type EdgeToast={id:string,type:string,icon:string,col:string,title:string,body:string};
type MoneyLabel={id:string,x:number,y:number,val:number,born:number};

// ── Part 2: Market Regime Detector ──────────────────────────────────
const detectRegime=async(logFn?:(ag:string,msg:string,col:string)=>void):Promise<RegimeState>=>{
  try{
    const [btc4h,btc1h]=await Promise.all([
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=28').then(r=>r.json()),
      fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=24').then(r=>r.json()),
    ]);
    const highs=btc4h.map((c:unknown[])=>parseFloat(c[2] as string));
    const lows=btc4h.map((c:unknown[])=>parseFloat(c[3] as string));
    const closes4h=btc4h.map((c:unknown[])=>parseFloat(c[4] as string));
    let plusDM=0,minusDM=0,tr=0;
    for(let i=1;i<btc4h.length;i++){
      const um=highs[i]-highs[i-1],dm=lows[i-1]-lows[i];
      plusDM+=um>dm&&um>0?um:0;minusDM+=dm>um&&dm>0?dm:0;
      tr+=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes4h[i-1]),Math.abs(lows[i]-closes4h[i-1]));
    }
    const plusDI=(plusDM/tr)*100,minusDI=(minusDM/tr)*100;
    const adx=Math.abs(plusDI-minusDI)/(plusDI+minusDI)*100;
    const closes1h=btc1h.map((c:unknown[])=>parseFloat(c[4] as string));
    const changes=closes1h.slice(1).map((c:number,i:number)=>Math.abs((c-closes1h[i])/closes1h[i]*100));
    const avgChange=changes.reduce((a:number,b:number)=>a+b,0)/changes.length;
    let regime:MarketRegime,confidence:number,dominantAgents:string[];
    if(avgChange>3.5){regime='BLACK SWAN';confidence=95;dominantAgents=['AEGIS'];}
    else if(avgChange>2.0){regime='VOLATILE';confidence=Math.min(95,avgChange*30);dominantAgents=['AEGIS','WATCH'];}
    else if(adx>28){regime='TRENDING';confidence=Math.min(98,adx*2.5);dominantAgents=['TITAN','RADAR','VECTOR'];}
    else{regime='RANGING';confidence=Math.min(90,(25-adx)*4);dominantAgents=['LENS','ORACLE','SHIELD'];}
    const direction=plusDI>minusDI?'BULL':'BEAR';
    const cfg=REGIME_CONFIG[regime];
    const state:RegimeState={regime,confidence,direction,dominantAgents,adx,description:cfg.description};
    logFn?.('ATLAS',`◈ REGIME: ${regime} (${confidence.toFixed(0)}%) ${direction} | ADX ${adx.toFixed(1)} | ${cfg.description}`,cfg.col);
    return state;
  }catch{
    return{regime:'RANGING',confidence:50,direction:'NEUTRAL',dominantAgents:['AEGIS'],adx:20,description:'Fallback — APIs unavailable'};
  }
};

// ── Part 3: Opportunity Score Engine ────────────────────────────────
const calcOpportunityScore=(
  sym:string,
  pxSnap:{[k:string]:PriceData},
  agSignals:{[k:string]:{on:boolean;conf:number|null;sig:string|null;th:string}},
  regimeSnap:RegimeState|null
):OpportunityScore=>{
  const d=pxSnap[sym];
  const vol=(d as unknown as {volume?:number})?.volume??0;
  const liqScore=Math.min(100,vol/10000000*100);
  const change1h=d?.change??0;
  const momScore=Math.min(100,50+change1h*8);
  const volRatio=(d as unknown as {volRatio?:number})?.volRatio??1;
  const volScore=Math.min(100,volRatio*40);
  const bullSignals=Object.values(agSignals).filter(s=>s.sig==='BUY').length;
  const sentScore=Math.min(100,(bullSignals/18)*100);
  const regCfg=REGIME_CONFIG[regimeSnap?.regime??'RANGING'];
  const aegisConf=agSignals['aegis']?.conf??50;
  const riskScore=Math.min(100,regCfg.maxExposure*150+aegisConf);
  const total=Math.round(liqScore*0.20+momScore*0.25+volScore*0.20+sentScore*0.20+riskScore*0.15);
  return{
    total,
    breakdown:{liquidity:Math.round(liqScore),momentum:Math.round(momScore),volume:Math.round(volScore),sentiment:Math.round(sentScore),risk:Math.round(riskScore)},
    grade:total>=80?'A':total>=65?'B':total>=50?'C':'D',
    tradeable:total>=65,
  };
};

const get1H4HTrend=async(sym:string):Promise<{trend1h:'BULL'|'BEAR'|'NEUTRAL',trend4h:'BULL'|'BEAR'|'NEUTRAL',aligned:boolean}>=>{
  try{
    const pair=sym+'USDT';
    const [r1h,r4h]=await Promise.all([
      fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=22`).then(r=>r.json()),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=22`).then(r=>r.json()),
    ]);
    const calcEMALocal=(data:unknown[],period:number)=>{
      const closes=data.map((c)=>parseFloat((c as string[])[4]));
      const k=2/(period+1);let ema=closes[0];
      for(let i=1;i<closes.length;i++)ema=closes[i]*k+ema*(1-k);
      return{ema,last:closes[closes.length-1]};
    };
    const ema9_1h=calcEMALocal(r1h,9),ema21_1h=calcEMALocal(r1h,21);
    const ema9_4h=calcEMALocal(r4h,9),ema21_4h=calcEMALocal(r4h,21);
    const trend1h=ema9_1h.ema>ema21_1h.ema?'BULL':'BEAR';
    const trend4h=ema9_4h.ema>ema21_4h.ema?'BULL':'BEAR';
    return{trend1h,trend4h,aligned:trend1h===trend4h};
  }catch{return{trend1h:'NEUTRAL',trend4h:'NEUTRAL',aligned:true};}
};

function useIsMobile(){
  const [isMobile,setIsMobile]=useState(false);
  useEffect(()=>{
    const check=()=>setIsMobile(window.innerWidth<768||window.innerHeight<500);
    check();
    window.addEventListener('resize',check);
    return()=>window.removeEventListener('resize',check);
  },[]);
  return isMobile;
}

function usePrices(){
  const [px,setPx]=useState<{[k:string]:PriceData}>(()=>
    Object.fromEntries(Object.entries(SYMS).map(([k,v])=>[k,{
      price:v.base,prev:v.base,trend:"up" as const,change:0,rsi:50,
      hist:Array.from({length:60},()=>v.base),isRealPrice:false,
    }]))
  );
  // Unified price feed — all traded symbols via Kraken+KuCoin, same source as the trading engine
  useEffect(()=>{
    const fetchAllPrices=async()=>{
      try{
        const res=await fetch("/api/market?type=all");
        if(!res.ok)return;
        const data=await res.json();
        setPx(p=>{
          const n={...p};
          for(const[sym,info] of Object.entries(data) as [string,{price:number,change:number}][]){
            if(!n[sym]||!info?.price)continue;
            const cur=n[sym];
            n[sym]={...cur,price:info.price,prev:cur.price,
              trend:info.price>cur.price?"up":"dn",change:info.change||0,
              hist:[...cur.hist.slice(1),info.price],source:"MARKET",isRealPrice:true};
          }
          return n;
        });
      }catch{}
    };
    fetchAllPrices();
    const iv=setInterval(fetchAllPrices,5000);
    return()=>clearInterval(iv);
  },[]);
  return px;
}

function Spark({data,color,w=80,h=22}:{data:number[],color:string,w?:number,h?:number}){
  if(!data||data.length<2)return null;
  const mn=Math.min(...data),mx=Math.max(...data),rng=mx-mn||1;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*w},${h-((v-mn)/rng)*(h-2)-1}`).join(" ");
  const gid="g"+color.replace(/[^a-z0-9]/gi,"");
  return(
    <svg width={w} height={h} style={{display:"block",overflow:"visible"}}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity=".3"/>
        <stop offset="100%" stopColor={color} stopOpacity="0"/>
      </linearGradient></defs>
      <polygon points={`${pts} ${w},${h} 0,${h}`} fill={`url(#${gid})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

function BootSequence({onDone}:{onDone:()=>void}){
  const [lines,setLines]=useState<string[]>([]);
  const [sweeping,setSweeping]=useState(false);
  const doneRef=useRef(false);
  useEffect(()=>{
    let i=0;
    const add=()=>{
      if(doneRef.current)return;
      if(i<BOOT_STEPS.length){
        setLines(l=>[...l,BOOT_STEPS[i++]]);
        setTimeout(add,500+Math.random()*300);
      }else{
        setSweeping(true);
        setTimeout(()=>{doneRef.current=true;onDone();},700);
      }
    };
    const t=setTimeout(add,300);
    return()=>{clearTimeout(t);};
  },[onDone]);
  return(
    <div style={{position:"fixed",inset:0,background:"#000",zIndex:1000,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"'JetBrains Mono','Courier New',monospace"}}>
      {sweeping&&<div style={{position:"absolute",inset:0,background:"linear-gradient(90deg,transparent 0%,"+K.c+"40 50%,transparent 100%)",animation:"laserSweep .5s ease forwards",pointerEvents:"none"}}/>}
      <div style={{marginBottom:36,display:"flex",alignItems:"center",gap:14,animation:"breathe 2s ease-in-out infinite"}}>
        <svg width="36" height="36" viewBox="0 0 30 30" style={{filter:"drop-shadow(0 0 10px "+K.c+")"}}>
          <polygon points="15,1 27,8 27,22 15,29 3,22 3,8" fill="none" stroke={K.c} strokeWidth="1.5"/>
          <ellipse cx="15" cy="15" rx="7" ry="4.2" fill="none" stroke={K.c} strokeWidth="1" opacity=".8"/>
          <circle cx="15" cy="15" r="2.8" fill={K.c} opacity=".9"/>
          <circle cx="15" cy="15" r="1.1" fill="#000" opacity=".7"/>
        </svg>
        <span style={{fontSize:28,fontWeight:900,color:K.c,letterSpacing:".4em",textShadow:"0 0 40px "+K.c,fontFamily:"'JetBrains Mono','Courier New',monospace"}}>KYMIA</span>
      </div>
      <div style={{width:380,minHeight:160}}>
        {lines.map((line,i)=>(
          <div key={i} style={{fontSize:11,color:i===lines.length-1?K.g:K.c,marginBottom:7,opacity:0,animation:"bootLine .35s ease forwards",letterSpacing:".04em"}}>
            <span style={{color:K.dim,marginRight:8}}>&gt;</span>{line}
          </div>
        ))}
        {lines.length<BOOT_STEPS.length&&<div style={{width:2,height:14,background:K.c,display:"inline-block",animation:"pu .7s ease-in-out infinite"}}/>}
      </div>
      <div style={{marginTop:32,width:320}}>
        <div style={{height:2,background:K.brd,borderRadius:1,overflow:"hidden"}}>
          <div style={{height:"100%",background:K.c,borderRadius:1,transition:"width .3s",width:(lines.length/BOOT_STEPS.length*100)+"%"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:5,fontSize:8,color:K.dim}}>
          <span>LOADING SWARM</span><span>{lines.length}/{BOOT_STEPS.length}</span>
        </div>
      </div>
    </div>
  );
}

// Kraken pair map for candle fetching
const KRAKEN_PAIRS:{[k:string]:string}={SOL:"SOLUSD",BTC:"XBTUSD",ETH:"ETHUSD",JUP:"JUPUSD",WIF:"WIFUSD",BONK:"BONKUSD",BNB:"XBTUSD",AVAX:"XBTUSD",MATIC:"XBTUSD",LINK:"LINKUSD",UNI:"XBTUSD",DOGE:"XDGUSD",PEPE:"XBTUSD",RNDR:"XBTUSD",ARB:"XBTUSD",OP:"XBTUSD",SUI:"XBTUSD",APT:"XBTUSD"};
const TF_MAP:{[k:string]:number}={"1m":1,"5m":5,"15m":15,"1h":60};

interface Candle{time:number,open:number,high:number,low:number,close:number,volume:number}

async function fetchKrakenCandles(sym:string,tf:string):Promise<Candle[]>{
  const pair=KRAKEN_PAIRS[sym]||"SOLUSD";
  const interval=TF_MAP[tf]||5;
  const res=await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`);
  const data=await res.json();
  if(data.error?.length)throw new Error(data.error[0]);
  const raw=Object.values(data.result).find((v):v is unknown[]=>Array.isArray(v)) as unknown[][];
  if(!raw)throw new Error("No data");
  return raw.slice(-120).map((c:unknown)=>{
    const arr=c as (number|string)[];
    return{time:(arr[0] as number)*1000,open:parseFloat(arr[1] as string),high:parseFloat(arr[2] as string),low:parseFloat(arr[3] as string),close:parseFloat(arr[4] as string),volume:parseFloat(arr[6] as string)};
  });
}

function calcEMAArr(data:number[],period:number):number[]{
  const k=2/(period+1);const emas=[data[0]];
  for(let i=1;i<data.length;i++)emas.push(data[i]*k+emas[i-1]*(1-k));
  return emas;
}
function calcRSIArr(data:number[],period=14):Array<number|null>{
  const out:Array<number|null>=Array(period).fill(null);
  for(let i=period;i<data.length;i++){
    let g=0,l=0;
    for(let j=i-period+1;j<=i;j++){const d=data[j]-data[j-1];d>0?g+=d:l-=d;}
    out.push(l===0?100:100-100/(1+(g/period)/(l/period)));
  }
  return out;
}

const TV_SYMBOLS:{[k:string]:string}={
  SOL:"BINANCE:SOLUSDT",BTC:"BINANCE:BTCUSDT",ETH:"BINANCE:ETHUSDT",
  JUP:"BINANCE:JUPUSDT",WIF:"BINANCE:WIFUSDT",BONK:"BINANCE:BONKUSDT",
  PYTH:"BINANCE:PYTHUSDT",RAY:"BINANCE:RAYUSDT",ORCA:"BINANCE:ORCAUSDT",
  PEPE:"BINANCE:PEPEUSDT",POPCAT:"BINANCE:POPCATUSDT",DRIFT:"BINANCE:DRIFTUSDT",
};

class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: any) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: any) {
    console.log('[ChartErrorBoundary] TradingView widget failed:', error?.message)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{padding:40,textAlign:'center',color:'#2A5070',fontFamily:'monospace',fontSize:12}}>
          ⚠ Chart temporarily unavailable
        </div>
      )
    }
    return this.props.children
  }
}

function TradingViewChart({sym,entryPrice,sl,tp,trailPrice,interval}:{sym:string,entryPrice:number,sl:number,tp:number,trailPrice:number|null,interval:string}){
  const containerRef=useRef<HTMLDivElement>(null);
  const tvSym=TV_SYMBOLS[sym]||`BINANCE:${sym}USDT`;

  // Suppress uncaught errors originating from TradingView's widget scripts
  useEffect(()=>{
    const handler=(event:ErrorEvent)=>{
      if(event.filename?.includes('tradingview')||event.filename?.includes('embed_advanced_chart')||event.filename?.includes('runtime-embed')){
        console.log('[TradingView] Suppressed external widget error:',event.message);
        event.preventDefault();
        return true;
      }
    };
    window.addEventListener('error',handler);
    return()=>window.removeEventListener('error',handler);
  },[]);

  useEffect(()=>{
    if(!containerRef.current)return;
    containerRef.current.innerHTML="";
    const script=document.createElement("script");
    script.src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type="text/javascript";
    script.async=true;
    script.onerror=(e)=>{console.log('[TradingView] Script failed to load:',e);};
    script.innerHTML=JSON.stringify({
      autosize:true,
      symbol:tvSym,
      interval,
      timezone:"Etc/UTC",
      theme:"dark",
      style:"1",
      locale:"en",
      backgroundColor:"rgba(4,6,13,1)",
      gridColor:"rgba(10,29,51,0.6)",
      hide_top_toolbar:false,
      hide_legend:false,
      save_image:false,
      withdateranges:true,
      hide_side_toolbar:false,
      allow_symbol_change:false,
      support_host:"https://www.tradingview.com",
      studies:["RSI@tv-basicstudies","MAExp@tv-basicstudies","MACD@tv-basicstudies","BB@tv-basicstudies","Volume@tv-basicstudies"],
      studies_overrides:{
        "rsi.plot.color":"#BD00FF","rsi.plot.linewidth":2,
        "rsi.upper band.color":"#FF336650","rsi.lower band.color":"#00FF8850",
        "macd.macd.color":"#00F2FE","macd.signal.color":"#FFD700",
        "macd.positive.color":"#00FF8870","macd.negative.color":"#FF336670",
        "bollinger bands.upper.color":"#00F2FE50","bollinger bands.lower.color":"#00F2FE50","bollinger bands.median.color":"#FFD70050",
        "moving average exponential.length":9,"moving average exponential.source":"close",
      },
      disabled_features:["use_localstorage_for_settings","header_symbol_search","header_compare"],
      enabled_features:["study_templates","side_toolbar_in_fullscreen_mode"],
      overrides:{
        "paneProperties.background":"#04060D","paneProperties.backgroundType":"solid",
        "paneProperties.backgroundGradientStartColor":"#04060D","paneProperties.backgroundGradientEndColor":"#04060D",
        "paneProperties.vertGridProperties.color":"#0A1D33","paneProperties.vertGridProperties.style":1,
        "paneProperties.horzGridProperties.color":"#0A1D33","paneProperties.horzGridProperties.style":1,
        "scalesProperties.textColor":"#2A5070","scalesProperties.lineColor":"#0A1D33","scalesProperties.fontSize":11,
        "mainSeriesProperties.candleStyle.upColor":"#00FF88","mainSeriesProperties.candleStyle.downColor":"#FF3366",
        "mainSeriesProperties.candleStyle.borderUpColor":"#00FF88","mainSeriesProperties.candleStyle.borderDownColor":"#FF3366",
        "mainSeriesProperties.candleStyle.wickUpColor":"#00FF8870","mainSeriesProperties.candleStyle.wickDownColor":"#FF336670",
        "mainSeriesProperties.candleStyle.barColorsOnPrevClose":false,
        "volume.volume.color.0":"#FF336640","volume.volume.color.1":"#00FF8840",
        "moving average exponential.Plot.color":"#00F2FE","moving average exponential.Plot.linewidth":2,
      },
    });
    containerRef.current.appendChild(script);
    return()=>{if(containerRef.current)containerRef.current.innerHTML="";};
  },[tvSym,interval]);

  return(
    <div style={{position:"relative",width:"100%",height:420}}>
      <div className="tradingview-widget-container" ref={containerRef} style={{width:"100%",height:"100%"}}/>
      {/* KYMIA overlay — Entry/SL/TP badges */}
      <div style={{position:"absolute",top:8,left:8,display:"flex",flexDirection:"column",gap:4,pointerEvents:"none",zIndex:10}}>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",background:"rgba(0,242,254,0.15)",border:"1px solid #00F2FE60",borderRadius:3,backdropFilter:"blur(8px)"}}>
          <div style={{width:8,height:1.5,background:"#00F2FE"}}/>
          <span style={{fontSize:10,color:"#00F2FE",fontWeight:700,fontFamily:"monospace"}}>ENTRY ${entryPrice?.toFixed(2)}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",background:"rgba(0,255,136,0.12)",border:"1px solid #00FF8850",borderRadius:3,backdropFilter:"blur(8px)"}}>
          <div style={{width:8,height:1.5,background:"#00FF88"}}/>
          <span style={{fontSize:10,color:"#00FF88",fontWeight:700,fontFamily:"monospace"}}>TP ${tp?.toFixed(2)}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",background:"rgba(255,51,102,0.12)",border:"1px solid #FF336650",borderRadius:3,backdropFilter:"blur(8px)"}}>
          <div style={{width:8,height:1.5,background:"#FF3366"}}/>
          <span style={{fontSize:10,color:"#FF3366",fontWeight:700,fontFamily:"monospace"}}>SL ${sl?.toFixed(2)}</span>
        </div>
        {trailPrice&&(
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",background:"rgba(255,215,0,0.12)",border:"1px solid #FFD70050",borderRadius:3,backdropFilter:"blur(8px)"}}>
            <div style={{width:8,height:1.5,background:"#FFD700"}}/>
            <span style={{fontSize:10,color:"#FFD700",fontWeight:700,fontFamily:"monospace"}}>TRAIL ${trailPrice?.toFixed(2)}</span>
          </div>
        )}
      </div>
      {/* Agent legend — top right */}
      <div style={{position:"absolute",top:8,right:8,display:"flex",flexDirection:"column",gap:3,pointerEvents:"none",zIndex:10}}>
        <div style={{padding:"4px 8px",background:"rgba(4,6,13,0.85)",border:"1px solid #0A1D33",borderRadius:3,backdropFilter:"blur(8px)",fontSize:9,color:"#2A5070",fontFamily:"monospace"}}>◈ INDICATORS USED BY AGENTS</div>
        {([{name:"LENS",ind:"RSI(14)",col:K.pu},{name:"RADAR",ind:"EMA 9/21",col:K.c},{name:"RAZOR",ind:"MACD 12/26",col:K.gold},{name:"SURGE",ind:"Volume",col:K.g}] as {name:string,ind:string,col:string}[]).map((a,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 7px",background:"rgba(4,6,13,0.8)",border:`1px solid ${a.col}25`,borderRadius:2,backdropFilter:"blur(4px)"}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:a.col}}/>
            <span style={{fontSize:8,color:a.col,fontWeight:700,fontFamily:"monospace"}}>{a.name}</span>
            <span style={{fontSize:8,color:"#2A5070",fontFamily:"monospace"}}>{a.ind}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MissionComplete({mission,onDismiss}:{mission:typeof MISSIONS[0],onDismiss:()=>void}){
  const next=MISSIONS.find(m=>m.id===mission.id+1);
  return(
    <div style={{position:"fixed",inset:0,zIndex:800,background:"rgba(2,4,10,0.93)",backdropFilter:"blur(16px)",display:"flex",alignItems:"center",justifyContent:"center",animation:"fi .5s ease"}} onClick={onDismiss}>
      <div style={{textAlign:"center",maxWidth:480,padding:40,background:"rgba(6,10,18,0.92)",border:`2px solid ${mission.color}60`,borderRadius:12,boxShadow:`0 0 80px ${mission.color}25,inset 0 0 60px ${mission.color}08`}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:56,marginBottom:16,filter:`drop-shadow(0 0 20px ${mission.color})`}}>{mission.icon}</div>
        <div style={{fontSize:11,color:mission.color,letterSpacing:".4em",fontWeight:700,fontFamily:"monospace",marginBottom:8,opacity:.8}}>◈ MISSION COMPLETE</div>
        <div style={{fontSize:30,fontWeight:900,color:mission.color,fontFamily:"monospace",letterSpacing:".12em",textShadow:`0 0 30px ${mission.color}`,marginBottom:12}}>{mission.name}</div>
        <div style={{fontSize:20,fontWeight:700,color:K.g,fontFamily:"monospace",marginBottom:16,textShadow:`0 0 16px ${K.g}`}}>+{mission.reward} VIRTUAL ALPHA</div>
        <div style={{fontSize:13,color:"#A8D0EC",lineHeight:1.7,fontStyle:"italic",marginBottom:24,fontFamily:"monospace"}}>"{mission.message}"</div>
        {next&&(
          <div style={{padding:"10px 16px",background:mission.color+"10",border:`1px solid ${mission.color}30`,borderRadius:4,marginBottom:16}}>
            <div style={{fontSize:9,color:"#2A5070",marginBottom:3}}>NEXT MISSION</div>
            <div style={{fontSize:12,color:mission.color,fontWeight:700}}>{next.name} → +{(next.target*100).toFixed(0)}%</div>
          </div>
        )}
        <div style={{fontSize:9,color:"#2A5070",fontFamily:"monospace"}}>Click to dismiss</div>
      </div>
    </div>
  );
}

function AgentAnalysisPanel({agentSignals,entryPrice}:{agentSignals?:AgentSignals,entryPrice:number}){
  const [revealed,setRevealed]=useState(0);
  const ag=agentSignals||{};

  const analyses=[
    {agent:"LENS",color:K.pu,icon:"◎",drawing:"RSI DIVERGENCE",
      detail:`RSI(14) = ${ag.lens?.rsi?.toFixed(1)||"—"}`,
      conclusion:ag.lens?.rsi!=null?(ag.lens.rsi<35?"→ OVERSOLD ZONE — historically reverses":ag.lens.rsi>65?"→ OVERBOUGHT — potential rejection":"→ Neutral momentum zone"):"→ No data",
      signal:ag.lens?.signal||null,lineType:"Horizontal RSI level traced at 30"},
    {agent:"RADAR",color:K.c,icon:"◈",drawing:"EMA CROSSOVER",
      detail:`EMA9 = ${ag.radar?.ema9?.toFixed(2)||"—"} | EMA21 = ${ag.radar?.ema21?.toFixed(2)||"—"}`,
      conclusion:ag.radar?.ema9!=null&&ag.radar?.ema21!=null?(ag.radar.ema9>ag.radar.ema21?"→ EMA9 ABOVE EMA21 — bullish cross confirmed":"→ EMA9 BELOW EMA21 — bearish cross"):"→ No data",
      signal:ag.radar?.signal||null,lineType:"Two EMA lines drawn on price chart"},
    {agent:"RAZOR",color:K.gold,icon:"⚡",drawing:"MACD SIGNAL",
      detail:`MACD = ${ag.razor?.macd?.toFixed(3)||"—"}`,
      conclusion:ag.razor?.macd!=null?(ag.razor.macd>0?"→ MACD positive — momentum building":"→ MACD negative — selling pressure"):"→ No data",
      signal:ag.razor?.signal||null,lineType:"MACD histogram drawn below chart"},
    {agent:"LEVIATHAN",color:K.pu,icon:"🐋",drawing:"WHALE PRESSURE",
      detail:`Buy pressure = ${ag.leviathan?.buyPressure!=null?((ag.leviathan.buyPressure)*100).toFixed(0)+"%" :"—"}`,
      conclusion:ag.leviathan?.buyPressure!=null?(ag.leviathan.buyPressure>0.62?"→ ACCUMULATION ZONE — whales buying":ag.leviathan.buyPressure<0.38?"→ DISTRIBUTION — whales selling":"→ Balanced flow"):"→ No data",
      signal:ag.leviathan?.signal||null,lineType:"Volume profile zone marked"},
    {agent:"SURGE",color:K.g,icon:"▲",drawing:"VOLUME ANALYSIS",
      detail:`24h Vol change = ${ag.surge?.volumeChange!=null?"+"+ag.surge.volumeChange.toFixed(1)+"%":"—"}`,
      conclusion:ag.surge?.volumeChange!=null?(ag.surge.volumeChange>3?"→ ABOVE AVERAGE volume — breakout likely":"→ Normal volume — no confirmation"):"→ No data",
      signal:ag.surge?.signal||null,lineType:"Volume spike highlighted"},
  ].filter(a=>a.signal!==null);

  useEffect(()=>{
    analyses.forEach((_,i)=>setTimeout(()=>setRevealed(i+1),i*550));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  if(analyses.length===0)return null;

  return(
    <div style={{background:"rgba(4,6,13,0.97)",borderBottom:"1px solid #0A1D33",padding:"10px 16px",overflow:"hidden"}}>
      <style>{`@keyframes scanH{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}`}</style>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
        <div style={{width:6,height:6,borderRadius:"50%",background:K.c,animation:"pu 1s infinite"}}/>
        <span style={{fontSize:10,color:K.c,fontWeight:700,letterSpacing:".15em",fontFamily:"monospace"}}>◈ AGENT PRE-TRADE ANALYSIS — WHAT THE AI SAW</span>
        <span style={{fontSize:9,color:"#2A5070",fontFamily:"monospace"}}>Analyzed {analyses.length} indicators before entry @${entryPrice?.toFixed(2)}</span>
      </div>
      <div style={{display:"flex",gap:8,overflowX:"auto",paddingBottom:4}}>
        {analyses.map((a,i)=>{
          const isRevealed=i<revealed;
          const sig=a.signal as string;
          const col=sig==="BUY"?K.g:sig==="SELL"?K.r:K.gold;
          const rgbFill=sig==="BUY"?"0,255,136":sig==="SELL"?"255,51,102":"255,215,0";
          return(
            <div key={a.agent} style={{
              minWidth:200,flexShrink:0,padding:"10px 12px",
              background:isRevealed?`rgba(${rgbFill},0.06)`:"rgba(6,10,18,0.8)",
              border:`1px solid ${isRevealed?col+"40":"#0A1D33"}`,
              borderRadius:4,opacity:isRevealed?1:0.3,
              transform:isRevealed?"translateY(0)":"translateY(4px)",
              transition:"all 0.4s ease",position:"relative",overflow:"hidden",
            }}>
              {isRevealed&&<div style={{position:"absolute",top:0,left:0,right:0,height:1,background:`linear-gradient(90deg,transparent,${a.color},transparent)`,animation:"scanH 1.5s ease-out forwards"}}/>}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <div style={{display:"flex",alignItems:"center",gap:5}}>
                  <span style={{fontSize:12,color:a.color}}>{a.icon}</span>
                  <span style={{fontSize:10,color:a.color,fontWeight:900,fontFamily:"monospace"}}>{a.agent}</span>
                </div>
                <span style={{padding:"1px 7px",background:col+"20",color:col,border:`1px solid ${col}40`,borderRadius:2,fontSize:9,fontWeight:700,fontFamily:"monospace"}}>{sig}</span>
              </div>
              <div style={{fontSize:9,color:a.color,opacity:.7,fontFamily:"monospace",marginBottom:3,letterSpacing:".08em"}}>✎ {a.drawing}</div>
              <div style={{fontSize:10,color:"#A8D0EC",fontFamily:"monospace",marginBottom:4,fontWeight:700}}>{a.detail}</div>
              <div style={{fontSize:9,color:"#2A5070",fontFamily:"monospace",lineHeight:1.5}}>{a.conclusion}</div>
              <div style={{marginTop:7,height:2,background:"#06090F",borderRadius:1}}>
                <div style={{height:"100%",borderRadius:1,background:col,width:sig==="BUY"?"75%":sig==="SELL"?"25%":"50%",boxShadow:`0 0 6px ${col}`,transition:"width 0.8s ease"}}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TradeModal({trade,position,agentSignals,onClose,onClosePosition}:{trade:Trade|null,position:Position|null,agentSignals?:AgentSignals,onClose:()=>void,onClosePosition?:()=>void}){
  const sym=trade?.sym||"SOL";
  const [chartInterval,setChartInterval]=useState("5");
  const entry=trade?.price||position?.avg||0;
  const sl=entry*0.975;
  const tp=entry*1.055;
  const trailPrice=position?.peak?position.peak*0.988:null;
  // For live P&L we approximate from entry; real-time updates come via pricesRef but we don't have it here — show static entry-based badge
  const curPnL:number|null=null;
  const curPct:number|null=null;

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(2,4,10,0.96)",backdropFilter:"blur(12px)",zIndex:600,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onClose}>
      <div style={{width:"90vw",maxWidth:920,background:"#04060D",border:"1px solid #0A1D33",borderRadius:8,overflow:"hidden",boxShadow:"0 24px 80px rgba(0,0,0,0.8),0 0 0 1px rgba(0,242,254,0.05)"}} onClick={e=>e.stopPropagation()}>

        {/* Header */}
        <div style={{padding:"12px 16px",borderBottom:"1px solid #0A1D33",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(6,10,18,0.8)"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:18,fontWeight:900,color:K.c,fontFamily:"monospace",letterSpacing:".1em"}}>{sym}/USD</span>
            {position&&<span style={{fontSize:10,color:K.g,fontWeight:700,padding:"2px 8px",background:K.g+"15",border:"1px solid "+K.g+"40",borderRadius:2}}>● POSITION OPEN</span>}
            {curPnL!==null&&<span style={{fontSize:16,fontWeight:900,color:0>=0?K.g:K.r,fontFamily:"monospace"}}>{fU(0)} ({fP(0)})</span>}
          </div>
          {/* Timeframe selector */}
          <div style={{display:"flex",gap:4}}>
            {(["1","5","15","60","240"] as const).map(t=>(
              <button key={t} onClick={()=>setChartInterval(t)} style={{padding:"3px 8px",background:chartInterval===t?"#001A28":"transparent",color:chartInterval===t?K.c:"#2A5070",border:chartInterval===t?"1px solid #003A55":"1px solid transparent",borderRadius:3,fontFamily:"monospace",fontSize:10,cursor:"pointer"}}>
                {t==="1"?"1m":t==="5"?"5m":t==="15"?"15m":t==="60"?"1h":"4h"}
              </button>
            ))}
          </div>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#2A5070",cursor:"pointer",fontSize:20,padding:"0 4px"}}>✕</button>
        </div>

        {/* Agent pre-trade analysis panel */}
        <AgentAnalysisPanel agentSignals={agentSignals} entryPrice={entry}/>

        {/* TradingView chart */}
        <ChartErrorBoundary>
          <TradingViewChart sym={sym} entryPrice={entry} sl={sl} tp={tp} trailPrice={trailPrice} interval={chartInterval}/>
        </ChartErrorBoundary>

        {/* Footer */}
        <div style={{padding:"10px 16px",borderTop:"1px solid #0A1D33",background:"rgba(6,10,18,0.8)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{display:"flex",gap:16,fontSize:10,fontFamily:"monospace"}}>
            {([
              {l:"ENTRY",v:entry?fPrice(entry):"—",c:K.c},
              {l:"SL",v:entry?fPrice(sl):"—",c:K.r},
              {l:"TP",v:entry?fPrice(tp):"—",c:K.g},
              ...(trailPrice?[{l:"TRAIL",v:fPrice(trailPrice),c:K.gold}]:[]),
              {l:"AGENT",v:trade?.agent||"CONSENSUS",c:"#A8D0EC"},
              {l:"OPENED",v:trade?.t||"",c:"#2A5070"},
            ] as {l:string,v:string,c:string}[]).map((r,i)=>(
              <div key={i}>
                <div style={{fontSize:8,color:"#2A5070",marginBottom:2}}>{r.l}</div>
                <div style={{color:r.c,fontWeight:700}}>{r.v}</div>
              </div>
            ))}
          </div>
          {position&&onClosePosition&&(
            <button onClick={onClosePosition} style={{padding:"10px 24px",background:K.r+"15",color:K.r,border:"2px solid "+K.r+"50",borderRadius:6,fontFamily:"monospace",fontSize:12,fontWeight:900,cursor:"pointer",letterSpacing:".1em",boxShadow:"0 0 20px "+K.r+"20",transition:"all .2s"}}>
              ⬛ CLOSE POSITION
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Confirm close modal
function ConfirmCloseModal({sym,onCancel,onConfirm}:{sym:string,onCancel:()=>void,onConfirm:()=>void}){
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.82)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={onCancel}>
      <div style={{background:"#050f1c",border:"1px solid "+K.r+"55",borderRadius:8,padding:24,width:320,textAlign:"center"}} onClick={e=>e.stopPropagation()}>
        <div style={{fontSize:13,fontFamily:"monospace",fontWeight:700,color:K.hi,marginBottom:8}}>CLOSE POSITION</div>
        <div style={{fontSize:11,fontFamily:"monospace",color:K.dim,marginBottom:20}}>Manually close <b style={{color:K.gold}}>{sym}</b>?<br/>P&L will be locked at current price.</div>
        <div style={{display:"flex",gap:10}}>
          <button onClick={onCancel} style={{flex:1,padding:"8px 0",background:"none",border:"1px solid "+K.dim+"44",borderRadius:4,color:K.dim,fontFamily:"monospace",fontSize:11,cursor:"pointer"}}>CANCEL</button>
          <button onClick={onConfirm} style={{flex:1,padding:"8px 0",background:K.r+"22",border:"1px solid "+K.r+"88",borderRadius:4,color:K.r,fontFamily:"monospace",fontSize:12,fontWeight:700,cursor:"pointer",letterSpacing:".04em"}}>CONFIRM CLOSE</button>
        </div>
      </div>
    </div>
  );
}

function Globe3D({trades,blackSwan,whaleAlert,totalPnL,tradeCount,agSt,running}:{trades:Trade[],blackSwan:boolean,whaleAlert:boolean,totalPnL:number,tradeCount:number,agSt:{[k:string]:AgentState},running:boolean}){
  const canvasRef=useRef<HTMLCanvasElement|null>(null);
  const [moneyLabels,setMoneyLabels]=useState<MoneyLabel[]>([]);
  const [activeAgentLabel,setActiveAgentLabel]=useState<{agentId:string,signal:string,conf:number,col:string}|null>(null);
  const agStGlobeRef=useRef(agSt);
  useEffect(()=>{agStGlobeRef.current=agSt;},[agSt]);
  const showAgentOnGlobe=useCallback((agentId:string,signal:string,conf:number)=>{
    const col=signal==="BUY"?K.g:signal==="SELL"?K.r:K.c;
    setActiveAgentLabel({agentId,signal,conf,col});
    setTimeout(()=>setActiveAgentLabel(null),3000);
  },[]);
  useEffect(()=>{
    if(!running)return;
    let i=0;
    const iv=setInterval(()=>{
      const cur=agStGlobeRef.current;
      const activeAgs=AGENTS.filter(a=>cur[a.id]?.on&&cur[a.id]?.sig&&cur[a.id]?.sig!=="HOLD");
      if(activeAgs.length===0)return;
      const ag=activeAgs[i%activeAgs.length];
      const state=cur[ag.id];
      if(state?.sig&&state.sig!=="HOLD")showAgentOnGlobe(ag.id,state.sig,state.conf||70);
      i++;
    },3500);
    return()=>clearInterval(iv);
  },[running,showAgentOnGlobe]);
  const W=280,H=248;
  const prevLen=useRef(0);

  // Session: which market is open by UTC hour
  const h=new Date().getUTCHours();
  const session=h<8?{name:"ASIA",col:K.gold}:h<15?{name:"EU",col:K.c}:{name:"US",col:K.g};

  // Trade fires → money label
  useEffect(()=>{
    if(trades.length>prevLen.current){
      const t=trades[0];
      if(t&&t.pnl!==0){
        const now=Date.now();
        setMoneyLabels(p=>[...p.slice(-6),{id:Math.random().toString(36).slice(2),x:60+Math.random()*160,y:60+Math.random()*120,val:t.pnl,born:now}]);
      }
      prevLen.current=trades.length;
    }
  });

  // Money label cleanup
  useEffect(()=>{
    const iv=setInterval(()=>{const now=Date.now();setMoneyLabels(p=>p.filter(m=>now-m.born<2800));},100);
    return()=>clearInterval(iv);
  },[]);

  // Canvas 2D globe — pure trig, no WebGL, no eval
  useEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d');if(!ctx)return;
    const cx=W/2,cy=H/2-8,R=92;
    const CITIES:[number,number,string][]=[
      [40.7,-74,"NYC"],[51.5,0,"LON"],[35.7,139.7,"TYO"],
      [1.3,103.8,"SGP"],[25.2,55.3,"DXB"],[22.3,114.2,"HKG"],
    ];
    const CITY_COLS=[K.g,K.c,K.gold,K.c,K.pu,K.c];
    const arcColor=blackSwan?K.r:K.c;

    // Orthographic projection: lat/lon+rotY → {x,y,z(depth)}
    const proj=(lat:number,lon:number,rotDeg:number)=>{
      const phi=(90-lat)*Math.PI/180;
      const theta=(lon-rotDeg)*Math.PI/180;
      const x3=Math.sin(phi)*Math.cos(theta);
      const y3=Math.cos(phi);
      const z3=Math.sin(phi)*Math.sin(theta);
      return {x:cx+R*x3,y:cy-R*y3,z:z3,vis:z3>=-0.08};
    };

    // Stars — fixed random positions (pre-computed once)
    const STARS=Array.from({length:120},()=>({
      x:Math.random()*W,y:Math.random()*H,
      r:Math.random()*1.1+0.3,a:Math.random()*0.6+0.1,
    }));

    interface ArcState{a:number;b:number;prog:number;op:number}
    let arcs:ArcState[]=[];
    let rotDeg=0,af:number,lastArc=0;
    // Staggered ping phases per city
    const pingT=CITIES.map((_,i)=>i/CITIES.length);

    const draw=(ts:number)=>{
      ctx.clearRect(0,0,W,H);
      rotDeg=(rotDeg+0.17)%360;

      // Stars behind globe
      STARS.forEach(s=>{
        ctx.beginPath();
        ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
        ctx.fillStyle=`rgba(255,255,255,${s.a})`;
        ctx.fill();
      });

      // Sphere body — radial gradient
      const grad=ctx.createRadialGradient(cx-R*0.28,cy-R*0.28,2,cx,cy,R);
      grad.addColorStop(0,blackSwan?'#2a0010':'#0d2a4a');
      grad.addColorStop(0.55,blackSwan?'#12000a':'#041828');
      grad.addColorStop(1,'#010408');
      ctx.beginPath();ctx.arc(cx,cy,R,0,Math.PI*2);
      ctx.fillStyle=grad;ctx.fill();

      // Atmosphere glow rings
      for(let g=0;g<4;g++){
        const alpha=blackSwan?0.04-g*0.008:0.05-g*0.01;
        if(alpha<=0)break;
        ctx.beginPath();ctx.arc(cx,cy,R+3+g*5,0,Math.PI*2);
        ctx.strokeStyle=blackSwan?`rgba(255,30,60,${alpha})`:`rgba(0,80,255,${alpha})`;
        ctx.lineWidth=4;ctx.stroke();
      }

      // Grid lines — latitude (horizontal ellipses)
      ctx.setLineDash([2,5]);ctx.lineWidth=0.4;
      for(let lat=-60;lat<=60;lat+=30){
        const phi=(90-lat)*Math.PI/180;
        const ry=R*Math.cos(phi);
        const rx=R*Math.sin(phi);
        if(rx<1)continue;
        ctx.beginPath();
        ctx.ellipse(cx,cy-ry,rx,rx*0.14,0,0,Math.PI*2);
        ctx.strokeStyle='rgba(0,120,200,0.14)';ctx.stroke();
      }
      // Grid lines — longitude (vertical great-circle segments, front hemisphere only)
      ctx.setLineDash([]);
      for(let lon=0;lon<360;lon+=30){
        const effLon=(lon-rotDeg+360)%360;
        const front=effLon<90||effLon>270;
        ctx.beginPath();
        let first=true;
        for(let lat2=-85;lat2<=85;lat2+=5){
          const p=proj(lat2,lon,rotDeg);
          if(!p.vis){first=true;continue;}
          if(first){ctx.moveTo(p.x,p.y);first=false;}
          else ctx.lineTo(p.x,p.y);
        }
        ctx.strokeStyle=front?'rgba(0,120,200,0.10)':'rgba(0,80,140,0.04)';
        ctx.lineWidth=0.4;ctx.stroke();
      }

      // Projected city positions for this frame
      const cityPos=CITIES.map((c,i)=>({...proj(c[0],c[1],rotDeg),col:CITY_COLS[i],idx:i}));

      // Spawn arc every 2s
      if(ts-lastArc>2000){
        const a=Math.floor(Math.random()*CITIES.length);
        let b=a;while(b===a)b=Math.floor(Math.random()*CITIES.length);
        arcs.push({a,b,prog:0,op:0.75});lastArc=ts;
      }

      // Draw + update arcs (great-circle interpolation in 3D, then project)
      arcs=arcs.map(arc=>{
        arc.prog=Math.min(1,arc.prog+0.014);
        if(arc.prog>=0.98)arc.op=Math.max(0,arc.op-0.035);
        return arc;
      }).filter(arc=>arc.op>0);

      arcs.forEach(arc=>{
        const ci=CITIES[arc.a],cj=CITIES[arc.b];
        const steps=Math.ceil(arc.prog*32);if(steps<2)return;
        // 3D unit vectors for both cities (with current rotation)
        const toV=(lat:number,lon:number)=>{
          const phi=(90-lat)*Math.PI/180,th=(lon-rotDeg)*Math.PI/180;
          return [Math.sin(phi)*Math.cos(th),Math.cos(phi),Math.sin(phi)*Math.sin(th)] as [number,number,number];
        };
        const va=toV(ci[0],ci[1]),vb=toV(cj[0],cj[1]);
        ctx.beginPath();let first2=true;
        for(let s=0;s<=steps;s++){
          const t=s/32;
          const ix=va[0]+(vb[0]-va[0])*t,iy=va[1]+(vb[1]-va[1])*t,iz=va[2]+(vb[2]-va[2])*t;
          const len=Math.sqrt(ix*ix+iy*iy+iz*iz)||1;
          // Lift arc slightly off surface (1.06x) for visibility
          const px=cx+R*1.06*(ix/len),py=cy-R*1.06*(iy/len),pz=iz/len;
          if(pz<-0.05){first2=true;continue;}
          if(first2){ctx.moveTo(px,py);first2=false;}else ctx.lineTo(px,py);
        }
        ctx.strokeStyle=arcColor;ctx.lineWidth=0.9;
        ctx.globalAlpha=arc.op;ctx.stroke();
        // Soft glow pass
        ctx.lineWidth=3;ctx.globalAlpha=arc.op*0.12;ctx.stroke();
        ctx.globalAlpha=1;
      });

      // City ping rings (pulsing radar)
      CITIES.forEach((_,i)=>{
        const p=cityPos[i];if(!p.vis)return;
        pingT[i]=(pingT[i]+0.004)%1;
        const rs=pingT[i]*22+1;
        const alpha=Math.max(0,0.65*(1-pingT[i]*1.45));
        if(alpha<=0)return;
        ctx.beginPath();ctx.arc(p.x,p.y,rs,0,Math.PI*2);
        ctx.strokeStyle=p.col;ctx.lineWidth=0.7;
        ctx.globalAlpha=alpha;ctx.stroke();ctx.globalAlpha=1;
      });

      // City dots (visible hemisphere only)
      cityPos.forEach(p=>{
        if(!p.vis)return;
        // Glow halo
        const hg=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,7);
        hg.addColorStop(0,p.col+'60');hg.addColorStop(1,'transparent');
        ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);
        ctx.fillStyle=hg;ctx.fill();
        // Dot
        ctx.beginPath();ctx.arc(p.x,p.y,2.5,0,Math.PI*2);
        ctx.fillStyle=p.col;ctx.globalAlpha=0.95;ctx.fill();ctx.globalAlpha=1;
      });

      af=requestAnimationFrame(draw);
    };
    af=requestAnimationFrame(draw);
    return()=>cancelAnimationFrame(af);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[blackSwan]);

  const pnl=totalPnL;
  return(
    <div style={{position:"relative",width:W,height:270}}>
      {/* Canvas globe — 2D, no WebGL */}
      <canvas ref={canvasRef} width={W} height={H} style={{position:"absolute",top:0,left:0,display:"block"}}/>

      {/* HUD overlay */}
      <svg width={W} height={H} style={{position:"absolute",top:0,left:0,pointerEvents:"none",overflow:"visible"}}>
        <text x={22} y={H/2-2} textAnchor="middle" fontSize="7" fontFamily="monospace" fill={K.dim} opacity=".5" fontWeight="700">{tradeCount}</text>
        <text x={22} y={H/2+7} textAnchor="middle" fontSize="4.5" fontFamily="monospace" fill={K.dim} opacity=".38">TRADES</text>
        <text x={W/2} y={H-14} textAnchor="middle" fontSize="6" fontFamily="monospace" fill={K.c} opacity=".6" style={{animation:"breathe 1.8s ease-in-out infinite"}}>6 AGENTS</text>
        <rect x={4} y={6} width={58} height={14} rx="2" fill={session.col} fillOpacity=".1" stroke={session.col} strokeWidth=".7" strokeOpacity=".45"/>
        <text x={33} y={16.5} textAnchor="middle" fontSize="6.5" fontFamily="monospace" fill={session.col} fontWeight="700">{session.name} OPEN</text>
      </svg>

      {/* Whale alert */}
      {whaleAlert&&(
        <>
          <div style={{position:"absolute",top:(H/2-110)+"px",left:(W/2-110)+"px",width:220,height:220,borderRadius:"50%",border:"2px solid "+K.pu,animation:"whalePulse 1.4s ease-out infinite",pointerEvents:"none"}}/>
          <div style={{position:"absolute",top:(H/2-75)+"px",left:(W/2-75)+"px",width:150,height:150,borderRadius:"50%",border:"1.4px solid "+K.pu+"99",animation:"whalePulse 1.4s ease-out .45s infinite",pointerEvents:"none"}}/>
          <div style={{position:"absolute",top:Math.round(H*.38),left:0,right:0,textAlign:"center",fontSize:10,fontFamily:"monospace",fontWeight:700,color:K.pu,animation:"pu .55s ease-in-out infinite",pointerEvents:"none",textShadow:"0 0 10px "+K.pu,letterSpacing:".12em"}}>🐋 WHALE</div>
        </>
      )}

      {/* Black swan shockwave */}
      {blackSwan&&<div style={{position:"absolute",top:(H/2-116)+"px",left:(W/2-116)+"px",width:232,height:232,borderRadius:"50%",border:"1.2px solid "+K.r,animation:"whalePulse 1.5s ease-out infinite",pointerEvents:"none"}}/>}

      {/* Floating money labels */}
      {moneyLabels.map(m=>(
        <div key={m.id} style={{position:"absolute",left:m.x,top:m.y,fontSize:10,fontFamily:"monospace",fontWeight:700,color:m.val>=0?K.g:K.r,animation:"moneyFloat 2.8s ease-out forwards",pointerEvents:"none",transform:"translateX(-50%)",whiteSpace:"nowrap",textShadow:`0 0 8px ${m.val>=0?K.g:K.r}`}}>
          {m.val>=0?"+$":"-$"}{f2(Math.abs(m.val))}
        </div>
      ))}

      {/* Agent activity label — floats above globe */}
      {activeAgentLabel&&(
        <div key={activeAgentLabel.agentId+activeAgentLabel.signal} style={{position:"absolute",top:"20%",left:"50%",transform:"translateX(-50%)",pointerEvents:"none",animation:"agentGlobeAppear 3s ease-out forwards",zIndex:10}}>
          <div style={{textAlign:"center",fontFamily:"monospace",fontSize:11,fontWeight:900,color:activeAgentLabel.col,textShadow:`0 0 12px ${activeAgentLabel.col}`,letterSpacing:".15em",marginBottom:4}}>
            {AGENTS.find(a=>a.id===activeAgentLabel.agentId)?.s||activeAgentLabel.agentId.toUpperCase()}
          </div>
          <div style={{padding:"3px 10px",background:activeAgentLabel.col+"20",border:`1px solid ${activeAgentLabel.col}60`,borderRadius:3,fontSize:10,color:activeAgentLabel.col,fontWeight:700,fontFamily:"monospace",textAlign:"center"}}>
            {activeAgentLabel.signal} {activeAgentLabel.conf}%
          </div>
          <div style={{width:1,height:24,background:`linear-gradient(${activeAgentLabel.col},transparent)`,margin:"4px auto 0"}}/>
        </div>
      )}

      {/* Bottom P&L readout */}
      <div style={{position:"absolute",bottom:0,left:0,right:0,textAlign:"center",pointerEvents:"none"}}>
        <div style={{fontSize:13,fontFamily:"monospace",fontWeight:700,color:pnl>=0?K.g:K.r,filter:`drop-shadow(0 0 6px ${pnl>=0?K.g:K.r})`}}>
          {pnl>=0?"+$":"-$"}{f2(Math.abs(pnl))}
        </div>
        <div style={{fontSize:7.5,fontFamily:"monospace",color:K.dim}}>TOTAL P&L · {tradeCount} TRADES</div>
      </div>
    </div>
  );
}


function CyberFace({cx,cy,size,col,active,conflict}:{cx:number,cy:number,size:number,col:string,active:boolean,conflict:boolean}){
  const s=size/40;
  const X=(x:number)=>cx+(x-20)*s;
  const Y=(y:number)=>cy+(y-20)*s;
  const lw=(w:number)=>Math.max(.8,w*s);
  const ao=active?1:.85;

  // ── ANATOMICALLY INFORMED SKULL — 12-vertex polygon ──
  // Wide cranium → temporal bulge → zygomatic → mandible angle → chin
  const SKULL:Array<[number,number]>=[
    [14,0],[26,0],   // flat crown bar
    [34,7],          // right parietal ridge
    [36,16],         // right temporal — widest point of skull
    [33,24],         // right zygomatic / cheekbone
    [29,31],         // right mandible angle
    [26,37],         // right anterior jaw
    [20,40],         // chin point
    [14,37],         // left anterior jaw
    [11,31],         // left mandible angle
    [7,24],          // left zygomatic / cheekbone
    [4,16],          // left temporal — widest point
    [6,7],           // left parietal ridge
  ];
  const pts=(ox:number,oy:number)=>SKULL.map(([x,y])=>`${X(x)+ox},${Y(y)+oy}`).join(" ");

  // Orbital cavities — trapezoidal (wider at top, taper to bottom)
  // Much more skull-like than diamonds
  const lOrb:Array<[number,number]>=[[8,13],[17,13],[18,17],[17,23],[8,23],[7,17]];
  const rOrb:Array<[number,number]>=[[23,13],[32,13],[33,17],[32,23],[23,23],[22,17]];
  const oPts=(arr:Array<[number,number]>)=>arr.map(([x,y])=>`${X(x)},${Y(y)}`).join(" ");

  // Nasal aperture — pear / inverted-heart shape
  const nosePts:Array<[number,number]>=[[17,24],[23,24],[24,27],[22,30],[20,31],[18,30],[16,27]];

  // Coronal suture — slight zigzag across cranium at y≈8
  const coronal=[[8,8],[11,7.3],[14,8.5],[17,7.3],[20,8],[23,7.3],[26,8.5],[29,7.3],[32,8]];

  // Teeth — 6 individual rectangles (incisors + canines)
  const TEETH:Array<[number,number,number,number]>=[
    [13,31,14.8,37],[15.2,31,17,37],[17.4,31,19.2,37],
    [20.8,31,22.6,37],[23,31,24.8,37],[25.2,31,27,37],
  ];

  return(
    <>
      {/* Breathing outer halo */}
      {active&&<polygon points={pts(0,0)} fill="none" stroke={col} strokeWidth={lw(8)} opacity=".11" style={{animation:"breathe 1.6s ease-in-out infinite"}}/>}

      {/* Solid dark cranial fill */}
      <polygon points={pts(0,0)} fill="#000C1E" opacity=".98"/>

      {/* ── SKULL OUTLINE ── */}
      <polygon points={pts(0,0)} fill="none" stroke={col} strokeWidth={lw(active?4:3)} opacity={ao}/>

      {/* ── CRANIAL SUTURES ── */}
      {/* Sagittal — center vertical seam */}
      <line x1={X(20)} y1={Y(0)} x2={X(20)} y2={Y(8)} stroke={col} strokeWidth={lw(1)} opacity={ao*.42} strokeDasharray={`${lw(2.5)} ${lw(2)}`}/>
      {/* Coronal — horizontal zigzag across cranium */}
      <polyline points={coronal.map(([x,y])=>`${X(x)},${Y(y)}`).join(" ")} fill="none" stroke={col} strokeWidth={lw(1)} opacity={ao*.38}/>

      {/* ── FRONTAL BONE — forehead internal structure ── */}
      <line x1={X(8)} y1={Y(8)} x2={X(20)} y2={Y(11)} stroke={col} strokeWidth={lw(1.5)} opacity={ao*.58}/>
      <line x1={X(32)} y1={Y(8)} x2={X(20)} y2={Y(11)} stroke={col} strokeWidth={lw(1.5)} opacity={ao*.58}/>

      {/* ── TEMPORAL FOSSAE — side wall indentation lines ── */}
      <line x1={X(6)} y1={Y(8)} x2={X(8)} y2={Y(17)} stroke={col} strokeWidth={lw(1.5)} opacity={ao*.48}/>
      <line x1={X(34)} y1={Y(8)} x2={X(32)} y2={Y(17)} stroke={col} strokeWidth={lw(1.5)} opacity={ao*.48}/>

      {/* ── SUPRAORBITAL MARGINS / BROW RIDGES ── */}
      <line x1={X(7)} y1={Y(13)} x2={X(18)} y2={Y(12)} stroke={col} strokeWidth={lw(3.5)} opacity={ao*.95}/>
      <line x1={X(33)} y1={Y(13)} x2={X(22)} y2={Y(12)} stroke={col} strokeWidth={lw(3.5)} opacity={ao*.95}/>

      {/* ── ZYGOMATIC ARCH — cheekbone structure ── */}
      <line x1={X(7)} y1={Y(24)} x2={X(9)} y2={Y(17)} stroke={col} strokeWidth={lw(3)} opacity={ao*.88}/>
      <line x1={X(33)} y1={Y(24)} x2={X(31)} y2={Y(17)} stroke={col} strokeWidth={lw(3)} opacity={ao*.88}/>
      {/* Arch base underline */}
      <line x1={X(7)} y1={Y(24)} x2={X(11)} y2={Y(26)} stroke={col} strokeWidth={lw(2)} opacity={ao*.72}/>
      <line x1={X(33)} y1={Y(24)} x2={X(29)} y2={Y(26)} stroke={col} strokeWidth={lw(2)} opacity={ao*.72}/>

      {/* ── ORBITAL CAVITIES — trapezoidal, anatomically correct ── */}
      {/* Black fill — the void of the eye socket */}
      <polygon points={oPts(lOrb)} fill="#000000" opacity=".99"/>
      <polygon points={oPts(rOrb)} fill="#000000" opacity=".99"/>
      {/* Socket outline */}
      <polygon points={oPts(lOrb)} fill={active?col+"1A":"none"} stroke={col} strokeWidth={lw(active?4:3)} opacity={ao}/>
      <polygon points={oPts(rOrb)} fill={active?col+"1A":"none"} stroke={col} strokeWidth={lw(active?4:3)} opacity={ao}/>
      {/* Infraorbital margin — reinforcing line under each socket */}
      <line x1={X(8)} y1={Y(23)} x2={X(17)} y2={Y(23)} stroke={col} strokeWidth={lw(2)} opacity={ao*.68}/>
      <line x1={X(23)} y1={Y(23)} x2={X(32)} y2={Y(23)} stroke={col} strokeWidth={lw(2)} opacity={ao*.68}/>

      {/* Eye glow — active: bright iris + pupil; inactive: dim ember */}
      {active?(
        <>
          <ellipse cx={X(12.5)} cy={Y(18)} rx={lw(5)} ry={lw(3.8)} fill={col} opacity=".3"/>
          <ellipse cx={X(27.5)} cy={Y(18)} rx={lw(5)} ry={lw(3.8)} fill={col} opacity=".3"/>
          <circle cx={X(12.5)} cy={Y(18)} r={lw(2.4)} fill={col} opacity=".75"/>
          <circle cx={X(27.5)} cy={Y(18)} r={lw(2.4)} fill={col} opacity=".75"/>
          <circle cx={X(12.5)} cy={Y(18)} r={lw(1.1)} fill="#ffffff" opacity=".95"/>
          <circle cx={X(27.5)} cy={Y(18)} r={lw(1.1)} fill="#ffffff" opacity=".95"/>
        </>
      ):(
        <>
          <circle cx={X(12.5)} cy={Y(18)} r={lw(2)} fill={col} opacity=".38"/>
          <circle cx={X(27.5)} cy={Y(18)} r={lw(2)} fill={col} opacity=".38"/>
        </>
      )}

      {/* ── NASAL APERTURE — pear-shaped opening ── */}
      <polygon points={nosePts.map(([x,y])=>`${X(x)},${Y(y)}`).join(" ")} fill="#000000" opacity=".99"/>
      <polygon points={nosePts.map(([x,y])=>`${X(x)},${Y(y)}`).join(" ")} fill={col+"0A"} stroke={col} strokeWidth={lw(2)} opacity={ao*.82}/>
      {/* Anterior nasal spine — vertical seam at base */}
      <line x1={X(20)} y1={Y(28)} x2={X(20)} y2={Y(31)} stroke={col} strokeWidth={lw(1)} opacity={ao*.48}/>

      {/* ── MAXILLA — upper jaw bar ── */}
      <line x1={X(11)} y1={Y(31)} x2={X(29)} y2={Y(31)} stroke={col} strokeWidth={lw(3)} opacity={ao*.9}/>

      {/* ── TEETH — individual rect per tooth ── */}
      {TEETH.map(([tx1,ty1,tx2,ty2],i)=>(
        <rect key={i}
          x={X(tx1)} y={Y(ty1)}
          width={Math.max(1,(tx2-tx1)*s)} height={Math.max(1,(ty2-ty1)*s)}
          fill="#000814" stroke={col} strokeWidth={lw(1.5)} opacity={ao*.88}
        />
      ))}

      {/* ── MANDIBLE LOWER ARCH — jaw angles to chin ── */}
      <line x1={X(11)} y1={Y(31)} x2={X(14)} y2={Y(37)} stroke={col} strokeWidth={lw(2.5)} opacity={ao*.88}/>
      <line x1={X(29)} y1={Y(31)} x2={X(26)} y2={Y(37)} stroke={col} strokeWidth={lw(2.5)} opacity={ao*.88}/>
      <line x1={X(14)} y1={Y(37)} x2={X(26)} y2={Y(37)} stroke={col} strokeWidth={lw(2)} opacity={ao*.7}/>
      {/* Mental protuberance — chin bump */}
      <line x1={X(18)} y1={Y(37)} x2={X(20)} y2={Y(40)} stroke={col} strokeWidth={lw(1.5)} opacity={ao*.6}/>
      <line x1={X(22)} y1={Y(37)} x2={X(20)} y2={Y(40)} stroke={col} strokeWidth={lw(1.5)} opacity={ao*.6}/>

      {/* ── SCAN LINE — sweeps full skull height ── */}
      {active&&(
        <line x1={X(4)} y1={Y(0)} x2={X(36)} y2={Y(0)} stroke={col} strokeWidth={lw(3)} opacity=".9">
          <animateTransform attributeName="transform" type="translate" from="0 0" to={`0 ${40*s}`} dur="1.1s" repeatCount="indefinite" additive="sum"/>
        </line>
      )}

      {/* ── VERTEX NODES — HUD anchors at key anatomical landmarks ── */}
      {SKULL.map(([dx,dy],i)=>(
        <circle key={i} cx={X(dx)} cy={Y(dy)} r={lw(active?2.5:1.8)} fill={col} opacity={active?.95:.65}/>
      ))}

      {/* ── CONFLICT GLITCH — red offset polygon copies ── */}
      {conflict&&(
        <>
          <polygon points={pts(4,2)} fill="none" stroke="#FF3366" strokeWidth={lw(4)} opacity=".88" style={{animation:"glitch 0.12s step-start infinite"}}/>
          <polygon points={pts(-4,-2)} fill="none" stroke="#FF3366" strokeWidth={lw(2)} opacity=".52" style={{animation:"glitch 0.18s step-start infinite"}}/>
        </>
      )}
    </>
  );
}

function ElectricArc({x1,y1,x2,y2,col,active}:{x1:number,y1:number,x2:number,y2:number,col:string,active:boolean}){
  const [flicker,setFlicker]=useState(1);
  const offsetRef=useRef((Math.random()-.5)*8);
  const durRef=useRef(`${.32+Math.random()*.35}s`);
  useEffect(()=>{
    if(!active)return;
    const iv=setInterval(()=>setFlicker(.6+Math.random()*.4),80);
    return()=>clearInterval(iv);
  },[active]);
  const mx=(x1+x2)/2,my=(y1+y2)/2;
  const off=active?offsetRef.current:0;
  const d=`M${x1},${y1} Q${mx+off},${my+off} ${x2},${y2}`;
  // Inactive: faint visible wire so the network topology reads clearly
  if(!active)return(
    <g opacity=".22">
      <path d={d} fill="none" stroke={col} strokeWidth="2.5" opacity=".25"/>
      <path d={d} fill="none" stroke={col} strokeWidth="0.8" opacity=".75"/>
    </g>
  );
  // Active debate: full electric arc — 3 layers + traveling spark
  return(
    <g opacity={flicker}>
      <path d={d} fill="none" stroke={col} strokeWidth="10" opacity=".06"/>
      <path d={d} fill="none" stroke={col} strokeWidth="4" opacity=".32"/>
      <path d={d} fill="none" stroke={col} strokeWidth="1.5" opacity=".95" filter="url(#arcglow)"/>
      <path d={d} fill="none" stroke="#ffffff" strokeWidth=".6" opacity=".85"/>
      <circle r="3" fill="white" opacity=".95" filter="url(#arcglow)">
        <animateMotion dur={durRef.current} repeatCount="indefinite" path={d}/>
      </circle>
    </g>
  );
}

function SwarmGraph({st,debate,disabled,swarmRef,flashingAgent,highConviction,convCol,isMobile,agents:agentsProp,conns:connsProp}:{st:{[k:string]:AgentState},debate:string[],disabled:Set<string>,swarmRef?:React.RefObject<HTMLDivElement|null>,flashingAgent?:string|null,highConviction?:boolean,convCol?:string,isMobile?:boolean,agents?:typeof AGENTS,conns?:typeof CONNS}){
  const agents=agentsProp??AGENTS;
  const conns=connsProp??CONNS;
  const [hov,setHov]=useState<string|null>(null);
  const nm:{[k:string]:{pos:{x:number,y:number},id:string,name:string,s:string,lv:number,ag:number}}={};
  for(const a of agents)nm[a.id]={...a,pos:gpos(a)};
  const glowCol=convCol||K.c;
  return(
    <div ref={swarmRef} style={{position:"relative",display:"inline-block",transition:"filter .5s",filter:highConviction?`drop-shadow(0 0 18px ${glowCol}60)`:undefined,maxHeight:isMobile?"38vh":undefined,overflow:isMobile?"hidden":"visible"}}>
      <svg width={isMobile?260:480} height={isMobile?254:468} viewBox="0 0 480 468" style={{display:"block",maxWidth:"100%",maxHeight:isMobile?"36vh":undefined,height:"auto"}}>
        <defs>
          <filter id="agf"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="arcglow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="faceglow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {(()=>{
          const getArcPath=(p1:{x:number,y:number},p2:{x:number,y:number})=>{
            const mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2;
            const dx=p2.x-p1.x,dy=p2.y-p1.y;
            const len=Math.sqrt(dx*dx+dy*dy)||1;
            const offset=Math.max(8,len*0.25);
            return `M${p1.x},${p1.y} Q${mx-(dy/len)*offset},${my+(dx/len)*offset} ${p2.x},${p2.y}`;
          };
          return conns.map(([a,b])=>{
            const pa=nm[a]?.pos,pb=nm[b]?.pos;if(!pa||!pb)return null;
            const isDebating=debate.includes(a)&&debate.includes(b);
            const dis2=disabled.has(a)||disabled.has(b);
            if(dis2)return<line key={a+b} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#050810" strokeWidth=".5" opacity=".07"/>;
            const aActive=st[a]?.on&&!disabled.has(a);
            const bActive=st[b]?.on&&!disabled.has(b);
            const isActive=aActive||bActive;
            const col=isDebating?K.c:aActive&&st[a]?.sig==="BUY"?K.g:aActive&&st[a]?.sig==="SELL"?K.r:K.co;
            const arcPath=getArcPath(pa,pb);
            const arcId=`arc-${a}-${b}`;
            return(
              <g key={a+b}>
                <path id={arcId} d={arcPath} fill="none" stroke={col}
                  strokeWidth={isDebating?2.5:isActive?1.2:0.4}
                  opacity={isDebating?0.95:isActive?0.35:0.08}
                  strokeDasharray={isDebating?"none":isActive?"none":"3 5"}
                  className={isDebating?"arc-debate":undefined}/>
                {isActive&&<path d={arcPath} fill="none" stroke={col}
                  strokeWidth={isDebating?6:3}
                  opacity={isDebating?0.15:0.06}
                  filter="url(#arcglow)"/>}
                {isDebating&&(
                  <circle r="2.5" fill="white" opacity="0.9" filter="url(#arcglow)">
                    <animateMotion dur="0.8s" repeatCount="indefinite">
                      <mpath href={`#${arcId}`}/>
                    </animateMotion>
                  </circle>
                )}
              </g>
            );
          });
        })()}
        {agents.map(({id,s,lv})=>{
          const n=nm[id],ag=st[id]||{on:false,conf:null,sig:null,th:""};
          const dis=disabled.has(id),isAegis=false;
          const r=id==="consensus"?34:lv===1?28:lv===2?22:17;
          const col=dis?"#101820":ag.sig==="BUY"?K.g:ag.sig==="SELL"?K.r:id==="consensus"?K.c:K.co;
          const active=ag.on&&!dis;
          const conflict=isAegis&&ag.sig==="SELL"&&!dis;
          const isFlashing=flashingAgent===id;
          const isHighConvActive=highConviction&&active;
          return(
            <g key={id} filter={active?"url(#faceglow)":undefined} opacity={dis?.18:1} style={{cursor:"pointer",animation:isFlashing?"nodeFlash 1.2s ease-out":isHighConvActive?"breathe 1.4s ease-in-out infinite":undefined}} onMouseEnter={()=>setHov(id)} onMouseLeave={()=>setHov(null)}>
              {/* Part 13: Layer ring */}
              {AGENT_LAYER_MAP[id]&&(
                <circle cx={n.pos.x} cy={n.pos.y} r={r+5} fill="none"
                  stroke={LAYER_RING_COLORS[AGENT_LAYER_MAP[id].layer]}
                  strokeWidth={1} opacity={active?0.55:0.18}
                  strokeDasharray={AGENT_LAYER_MAP[id].layer===3?"4 3":AGENT_LAYER_MAP[id].layer===2?"6 3":"none"}/>
              )}
              <CyberFace cx={n.pos.x} cy={n.pos.y} size={r*2} col={col} active={active} conflict={conflict}/>
              <text x={n.pos.x} y={n.pos.y+r+11} textAnchor="middle" fontSize={id==="consensus"?8:6} fontFamily="monospace" fill={dis?K.dim:active?col:K.tx} fontWeight="700">{s}</text>
              {ag.conf!==null&&!dis&&<text x={n.pos.x} y={n.pos.y+r+20} textAnchor="middle" fontSize="7" fontFamily="monospace" fill={col} opacity=".8">{ag.conf}%</text>}
            </g>
          );
        })}
      </svg>
      {hov&&nm[hov]&&(()=>{
        const ag=st[hov]||{on:false,conf:null,sig:null,th:""};
        const col=ag.sig==="BUY"?K.g:ag.sig==="SELL"?K.r:K.c;
        const info=agents.find(a=>a.id===hov);
        const seed=hov.split("").reduce((a,c)=>a+c.charCodeAt(0),0);
        return(
          <div style={{position:"absolute",top:8,left:8,background:"#030810",border:"1px solid "+col+"50",borderRadius:3,padding:"10px 14px",fontSize:9,color:K.hi,zIndex:20,minWidth:170,pointerEvents:"none",boxShadow:"0 4px 20px "+col+"20"}}>
            <div style={{color:col,fontWeight:700,marginBottom:5,fontSize:11,letterSpacing:".08em"}}>{info?.name}</div>
            {[["Aggression",(30+((seed*17)%60))+"/100"],["Focus",Object.keys(SYMS)[(seed*3)%5]],["Coherence",(60+((seed*7)%38))+"%"],["Signal",ag.sig||"—"]].map(([k,v])=>(
              <div key={k} style={{display:"flex",justifyContent:"space-between",gap:14,borderBottom:"1px solid #080E18",padding:"2px 0"}}>
                <span style={{color:K.dim}}>{k}</span><span style={{color:K.hi}}>{v}</span>
              </div>
            ))}
            {ag.th&&<div style={{marginTop:5,color:K.tx,fontStyle:"italic",lineHeight:1.4,fontSize:8}}>{ag.th}</div>}
          </div>
        );
      })()}
    </div>
  );
}

function DecisionZone({agSt,running,onExecute}:{agSt:{[k:string]:AgentState},running:boolean,onExecute:(sym:string,side:"BUY"|"SELL")=>void}){
  const active=AGENTS.filter(a=>a.id!=="consensus"&&agSt[a.id]?.on&&agSt[a.id]?.sig);
  const buy=active.filter(a=>agSt[a.id].sig==="BUY").length;
  const sell=active.filter(a=>agSt[a.id].sig==="SELL").length;
  const hold=active.filter(a=>agSt[a.id].sig==="HOLD").length;
  const total=buy+sell+hold||1;
  const bP=Math.round(buy/total*100);const sP=Math.round(sell/total*100);
  const dom=buy>sell&&buy>hold?"BUY":sell>buy&&sell>hold?"SELL":"HOLD";
  const col=dom==="BUY"?K.g:dom==="SELL"?K.r:K.gold;
  const highConv=bP>72||sP>72;
  const showExec=running&&dom!=="HOLD"&&(dom==="BUY"?bP:sP)>=55;
  const pulseAnim=highConv?(dom==="BUY"?"convBuyPulse":"convPulse"):"none";
  const topSym=Object.entries(agSt).filter(([id,s])=>id!=="consensus"&&s.sig===dom).sort((a,b)=>(b[1].conf||0)-(a[1].conf||0))[0];
  return(
    <div className="panel" style={{padding:"10px 14px",borderColor:col+"35",animation:highConv?`${pulseAnim} 1.8s ease-in-out infinite`:"none"}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        {/* Big vote number */}
        <div style={{textAlign:"center",minWidth:56}}>
          <div style={{fontSize:38,fontWeight:900,color:col,lineHeight:1,letterSpacing:"-.02em",textShadow:`0 0 20px ${col}80`}}>{dom==="BUY"?bP:dom==="SELL"?sP:Math.round(hold/total*100)}</div>
          <div style={{fontSize:7,color:col,letterSpacing:".12em",opacity:.8,marginTop:2}}>{dom==="BUY"?"▲":dom==="SELL"?"▼":"◆"} {dom}%</div>
        </div>
        {/* Vote bar + counters */}
        <div style={{flex:1}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
            <span style={{fontSize:7,color:K.dim,letterSpacing:".1em"}}>◈ DECISION ZONE</span>
            <div style={{display:"flex",gap:8,fontSize:8}}>
              {([["▲",K.g,buy],["▼",K.r,sell],["◆",K.gold,hold]] as Array<[string,string,number]>).map(([l,c,v])=>(
                <span key={l} style={{color:c}}>{l} {v}</span>
              ))}
              <span style={{color:K.dim}}>{active.length}/18</span>
            </div>
          </div>
          <div style={{display:"flex",gap:1,height:8,borderRadius:4,overflow:"hidden",marginBottom:5}}>
            <div style={{width:bP+"%",background:`linear-gradient(90deg,${K.g}80,${K.g})`,transition:"width .5s",boxShadow:bP>72?`0 0 8px ${K.g}60`:undefined}}/>
            <div style={{width:sP+"%",background:`linear-gradient(90deg,${K.r}80,${K.r})`,transition:"width .5s",boxShadow:sP>72?`0 0 8px ${K.r}60`:undefined}}/>
            <div style={{width:Math.round(hold/total*100)+"%",background:`linear-gradient(90deg,${K.gold}80,${K.gold})`,transition:"width .5s"}}/>
          </div>
          {highConv&&<div style={{fontSize:7,color:col,letterSpacing:".14em",animation:"glow 1.5s infinite",marginBottom:3}}>⚡ HIGH CONVICTION — {active.length} AGENTS ALIGNED</div>}
          {showExec&&(
            <div style={{display:"flex",gap:5}}>
              <button className="btn" onClick={()=>onExecute(topSym?AGENTS.find(a=>a.id===topSym[0])?.id||"SOL":"SOL",dom as "BUY"|"SELL")} style={{background:col+"20",color:col,border:"1px solid "+col+"50",padding:"3px 12px",fontSize:8,flex:1}}>⚡ EXECUTE {dom}</button>
              <button className="btn" style={{background:"#060A12",color:K.dim,border:"1px solid #0A1D33",padding:"3px 10px",fontSize:8}}>✕ REJECT</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── On-Chain Public Wallet Tab ────────────────────────────────────────────────
interface HeliusTx{signature:string;timestamp:number;type:string;description:string;fee:number;nativeTransfers?:{fromUserAccount:string;toUserAccount:string;amount:number}[];}

function OnChainTab(){
  const wallet=process.env.NEXT_PUBLIC_KYMIA_WALLET||process.env.NEXT_PUBLIC_WALLET_ADDRESS||"";
  const [txs,setTxs]=useState<HeliusTx[]>([]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [solBal,setSolBal]=useState<number|null>(null);

  const fetchWalletData=useCallback(async()=>{
    if(!wallet){setError("demo");return;}
    setLoading(true);setError(null);
    try{
      const [txRes,balRes]=await Promise.all([
        fetch(`/api/helius?wallet=${wallet}&type=txs`),
        fetch(`/api/helius?wallet=${wallet}&type=balance`),
      ]);
      if(txRes.ok){const d=await txRes.json();if(Array.isArray(d))setTxs(d.slice(0,25));}
      if(balRes.ok){const d=await balRes.json();setSolBal(typeof d.balance==="number"?d.balance:null);}
    }catch(e){setError("Failed to fetch wallet data");}
    finally{setLoading(false);}
  },[wallet]);

  useEffect(()=>{fetchWalletData();},[fetchWalletData]);

  const shortAddr=(a:string)=>a.length>10?a.slice(0,4)+"…"+a.slice(-4):a;
  const fSol=(n:number)=>(n/1e9).toFixed(4);
  const fDate=(ts:number)=>new Date(ts*1000).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

  if(error==="demo"||!wallet){
    return(
      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",padding:32}}>
        <div style={{maxWidth:440,width:"100%"}}>
          <div className="panel" style={{padding:28,borderColor:K.c+"30",background:"linear-gradient(135deg,"+K.pan+" 0%,"+K.c+"08 100%)"}}>
            <div style={{fontSize:11,color:K.c,letterSpacing:".2em",fontWeight:900,marginBottom:12}}>◈ ON-CHAIN WALLET MONITOR</div>
            <div style={{fontSize:10,color:K.hi,marginBottom:16,lineHeight:1.6}}>
              Connect a public Solana wallet to monitor on-chain activity in real-time. All transactions are fetched directly from the Solana blockchain via Helius.
            </div>
            <div style={{padding:"12px 16px",background:K.bg,border:"1px solid "+K.brd,borderRadius:2,marginBottom:16}}>
              <div style={{fontSize:9,color:K.dim,marginBottom:6,letterSpacing:".1em"}}>TO ACTIVATE</div>
              <div style={{fontSize:10,color:K.hi,lineHeight:1.8}}>
                1. Set <span style={{color:K.c}}>NEXT_PUBLIC_WALLET_ADDRESS</span> in .env.local<br/>
                2. Set <span style={{color:K.c}}>HELIUS_API_KEY</span> in .env.local<br/>
                3. Restart the development server
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <a href="https://solscan.io" target="_blank" rel="noopener noreferrer" style={{flex:1,display:"block",padding:"8px 12px",background:K.c+"15",color:K.c,border:"1px solid "+K.c+"40",borderRadius:2,fontSize:9,textAlign:"center",textDecoration:"none",letterSpacing:".08em"}}>SOLSCAN</a>
              <a href="https://birdeye.so" target="_blank" rel="noopener noreferrer" style={{flex:1,display:"block",padding:"8px 12px",background:K.gold+"15",color:K.gold,border:"1px solid "+K.gold+"40",borderRadius:2,fontSize:9,textAlign:"center",textDecoration:"none",letterSpacing:".08em"}}>BIRDEYE</a>
              <a href="https://explorer.solana.com" target="_blank" rel="noopener noreferrer" style={{flex:1,display:"block",padding:"8px 12px",background:K.pu+"15",color:K.pu,border:"1px solid "+K.pu+"40",borderRadius:2,fontSize:9,textAlign:"center",textDecoration:"none",letterSpacing:".08em"}}>EXPLORER</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return(
    <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column",padding:10,gap:10}}>
      {/* KYMIA Public Trading Wallet Header */}
      <div className="panel" style={{padding:"12px 16px",flexShrink:0,borderColor:K.c+"30",background:"linear-gradient(135deg,rgba(6,10,18,0.9) 0%,rgba(0,242,254,0.04) 100%)"}}>
        <div style={{fontSize:9,color:K.c,letterSpacing:".2em",fontWeight:900,marginBottom:8}}>◈ KYMIA PUBLIC TRADING WALLET</div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:K.g,boxShadow:"0 0 8px "+K.g,animation:"pu 1.5s infinite"}}/>
            <div>
              <div style={{fontSize:11,color:K.hi,fontFamily:"monospace",letterSpacing:".05em"}}>{wallet}</div>
              {solBal!==null&&<div style={{fontSize:9,color:K.dim,marginTop:2}}>Balance: <span style={{color:K.c,fontWeight:700}}>{solBal.toFixed(4)} SOL</span></div>}
            </div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <a href={`https://solscan.io/account/${wallet}`} target="_blank" rel="noopener noreferrer" style={{padding:"4px 10px",background:K.c+"15",color:K.c,border:"1px solid "+K.c+"40",borderRadius:2,fontSize:8,textDecoration:"none",letterSpacing:".08em"}}>SOLSCAN</a>
            <a href={`https://birdeye.so/profile/${wallet}`} target="_blank" rel="noopener noreferrer" style={{padding:"4px 10px",background:K.gold+"15",color:K.gold,border:"1px solid "+K.gold+"40",borderRadius:2,fontSize:8,textDecoration:"none",letterSpacing:".08em"}}>BIRDEYE</a>
            <a href={`https://explorer.solana.com/address/${wallet}`} target="_blank" rel="noopener noreferrer" style={{padding:"4px 10px",background:K.pu+"15",color:K.pu,border:"1px solid "+K.pu+"40",borderRadius:2,fontSize:8,textDecoration:"none",letterSpacing:".08em"}}>EXPLORER</a>
            <button className="btn" onClick={fetchWalletData} disabled={loading} style={{padding:"4px 10px",fontSize:8}}>{loading?"⟳":"↻"} REFRESH</button>
          </div>
        </div>
        <div style={{marginTop:8,fontSize:9,color:K.dim,lineHeight:1.6}}>All LIVE trades are recorded here. Verify every transaction on-chain.</div>
      </div>

      {/* Transaction Feed */}
      <div className="panel" style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
        <div style={{padding:"8px 14px",borderBottom:"1px solid "+K.brd,fontSize:9,color:K.dim,letterSpacing:".12em",flexShrink:0}}>
          RECENT TRANSACTIONS · {txs.length} LOADED
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          {loading&&txs.length===0?(
            <div style={{padding:24,textAlign:"center",color:K.dim,fontSize:10}}>⟳ Fetching blockchain data...</div>
          ):error?(
            <div style={{padding:24,textAlign:"center",color:K.r,fontSize:10}}>{error}</div>
          ):txs.length===0?(
            <div style={{padding:24,textAlign:"center",color:K.dim,fontSize:10}}>No transactions found</div>
          ):(
            txs.map((tx,i)=>{
              const isIn=tx.nativeTransfers?.some(t=>t.toUserAccount===wallet);
              const amt=tx.nativeTransfers?.reduce((s,t)=>s+(t.toUserAccount===wallet?t.amount:-t.amount),0)||0;
              const netSol=amt/1e9;
              return(
                <div key={tx.signature} className="log-entry" style={{padding:"8px 14px",borderBottom:"1px solid "+K.brd+"50",display:"flex",alignItems:"center",gap:10,animationDelay:i*30+"ms"}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:isIn?K.g:K.r,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                      <span style={{fontSize:9,color:K.c,fontWeight:700,letterSpacing:".06em"}}>{tx.type||"TRANSFER"}</span>
                      <span style={{fontSize:8,color:K.dim}}>{fDate(tx.timestamp)}</span>
                    </div>
                    <div style={{fontSize:9,color:K.hi,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tx.description||shortAddr(tx.signature)}</div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    {amt!==0&&<div style={{fontSize:10,fontWeight:700,color:netSol>0?K.g:K.r}}>{netSol>0?"+":""}{netSol.toFixed(4)} SOL</div>}
                    <div style={{fontSize:8,color:K.dim}}>{fSol(tx.fee||0)} fee</div>
                  </div>
                  <a href={`https://solscan.io/tx/${tx.signature}`} target="_blank" rel="noopener noreferrer" style={{fontSize:8,color:K.dim,textDecoration:"none",flexShrink:0}}>↗</a>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function TimeScrubber({sessionStart,trades}:{sessionStart:number,trades:Trade[]}){
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{const iv=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(iv);},[]);
  const dur=now-sessionStart;
  const fmtDur=(ms:number)=>{const s=Math.floor(ms/1000);const m=Math.floor(s/60);const h=Math.floor(m/60);return h>0?`${h}h ${m%60}m`:`${m}m ${s%60}s`;};
  const closed=trades.filter(t=>t.pnl!==0&&t.ms);
  const pct=(ms:number)=>Math.min(100,(ms-sessionStart)/dur*100);
  return(
    <div style={{position:"fixed",bottom:0,left:0,right:0,height:28,zIndex:202,background:"rgba(3,5,10,0.92)",borderTop:"1px solid #0A1D33",display:"flex",alignItems:"center",padding:"0 14px",gap:10,backdropFilter:"blur(8px)"}}>
      <span style={{fontSize:7,color:K.dim,letterSpacing:".12em",flexShrink:0}}>◈ SESSION</span>
      <span style={{fontSize:9,fontWeight:700,color:K.c,flexShrink:0,minWidth:52}}>{fmtDur(dur)}</span>
      <div style={{flex:1,position:"relative",height:4,background:"#060A14",borderRadius:2,overflow:"visible"}}>
        <div style={{position:"absolute",inset:0,background:`linear-gradient(90deg,${K.c}40,${K.c}90)`,borderRadius:2,width:"100%",opacity:.35}}/>
        {closed.map((t,i)=>{
          const p=pct(t.ms||sessionStart);
          return<div key={t.id||i} style={{position:"absolute",top:"50%",left:p+"%",transform:"translate(-50%,-50%)",width:4,height:4,borderRadius:"50%",background:t.pnl>0?K.g:K.r,boxShadow:`0 0 4px ${t.pnl>0?K.g:K.r}`,cursor:"pointer"}} title={`${t.sym} ${t.side} ${t.pnl>0?"+":""}$${t.pnl.toFixed(2)}`}/>;
        })}
      </div>
      <div style={{display:"flex",gap:8,fontSize:7,color:K.dim,flexShrink:0}}>
        <span style={{color:K.g}}>▲ {closed.filter(t=>t.pnl>0).length} WINS</span>
        <span style={{color:K.r}}>▼ {closed.filter(t=>t.pnl<0).length} LOSSES</span>
        <span style={{color:K.dim}}>{closed.length} TOTAL</span>
      </div>
    </div>
  );
}

function WinCardEl({card,onDone}:{card:WinCard,onDone:()=>void}){
  useEffect(()=>{const t=setTimeout(onDone,3500);return()=>clearTimeout(t);},[onDone]);
  const ref=useRef<HTMLDivElement>(null);
  const controls=useAnimationControls();
  const pos=card.pnl>=0,col=pos?K.g:K.r;

  useLayoutEffect(()=>{
    if(card.origin&&ref.current){
      const rect=ref.current.getBoundingClientRect();
      const dx=card.origin.x-(rect.left+rect.width/2);
      const dy=card.origin.y-(rect.top+rect.height/2);
      controls.set({x:dx,y:dy,scale:0,opacity:0,filter:"blur(8px)"});
      controls.start({x:0,y:0,scale:1,opacity:1,filter:"blur(0px)",transition:{duration:0.6,ease:[0.33,1,0.68,1]}});
    }else{
      controls.set({opacity:0,scale:0.85,x:40});
      controls.start({opacity:1,scale:1,x:0,transition:{duration:0.35,ease:[0.33,1,0.68,1]}});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  return(
    <motion.div ref={ref} animate={controls}
      style={{width:210,padding:"11px 15px",background:"linear-gradient(135deg,"+K.pan+" 0%,"+col+"0E 100%)",border:"1px solid "+col+"55",borderRadius:3,boxShadow:"0 4px 22px "+col+"30"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
        <span style={{color:col,fontSize:11,fontWeight:700}}>{pos?"▲ PROFIT":"▼ LOSS"} · {card.sym}</span>
        <span style={{fontSize:11,color:K.dim}}>{card.agent}</span>
      </div>
      <div style={{fontSize:11,color:K.dim,marginBottom:7}}>{card.t}</div>
      <div style={{fontSize:21,fontWeight:900,color:col,letterSpacing:".04em",marginBottom:3,textShadow:"0 0 14px "+col}}>
        {pos?"+$":"-$"}{f2(Math.abs(card.pnl))}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,marginBottom:6}}>
        <span style={{color:col}}>{fP(card.pct)}</span>
        <span style={{color:K.tx}}>@${f2(card.price)}</span>
      </div>
      <div style={{height:2,borderRadius:1,background:"#05090E",overflow:"hidden"}}>
        <div style={{height:"100%",background:col,width:"100%",animation:"confBar 3.6s linear forwards"}}/>
      </div>
    </motion.div>
  );
}

function ProfitTicker({trades}:{trades:Trade[]}){
  const items=trades.slice(0,20);
  if(!items.length)return<div style={{height:22,background:"#030710",borderBottom:"1px solid "+K.brd}}/>;
  return(
    <div style={{background:"#030710",borderBottom:"1px solid "+K.brd,padding:"4px 0",overflow:"hidden",height:22}}>
      <div style={{display:"flex",whiteSpace:"nowrap",animation:"tickerScroll 18s linear infinite"}}>
        {[0,1].map(pass=>(
          <span key={pass} style={{paddingRight:40,fontSize:9,fontFamily:"monospace",letterSpacing:".08em"}}>
            {items.map((t,i)=>{
              const pos=t.pnl>=0,col=pos?K.g:K.r;
              return<span key={i} style={{color:col,marginRight:22}}>{t.sym} {pos?"+$":"-$"}{f2(Math.abs(t.pnl))}</span>;
            })}
          </span>
        ))}
      </div>
    </div>
  );
}

function EdgeToastEl({toast,onDone}:{toast:EdgeToast,onDone:()=>void}){
  useEffect(()=>{const t=setTimeout(onDone,3000);return()=>clearTimeout(t);},[onDone]);
  return(
    <div style={{width:210,padding:"9px 13px",background:"linear-gradient(135deg,"+K.pan+" 0%,"+toast.col+"12 100%)",border:"1px solid "+toast.col+"50",borderRadius:3,boxShadow:"0 4px 18px "+toast.col+"25",animation:"toastIn .3s ease forwards",marginBottom:6}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
        <span style={{fontSize:13}}>{toast.icon}</span>
        <span style={{color:toast.col,fontSize:10,fontWeight:700,letterSpacing:".07em"}}>{toast.title}</span>
      </div>
      <div style={{fontSize:8.5,color:K.tx,lineHeight:1.5,whiteSpace:"pre-line"}}>{toast.body}</div>
    </div>
  );
}

function PerformanceCard({trades,totalPnL,allTimeStats,onClose}:{trades:Trade[],totalPnL:number,allTimeStats:{totalTrades:number,wins:number,totalPnl:number},onClose:()=>void}){
  const cardRef=useRef<HTMLDivElement>(null);
  const [period,setPeriod]=useState<"1H"|"3H"|"24H"|"7D"|"ALL">("24H");
  const [downloading,setDownloading]=useState(false);
  const [sharing,setSharing]=useState(false);
  const [copied,setCopied]=useState(false);
  const [xToast,setXToast]=useState(false);

  const periodMs:Record<string,number>={"1H":36e5,"3H":108e5,"24H":864e5,"7D":6048e5,"ALL":Infinity};
  const cutoff=periodMs[period];
  const now=Date.now();
  const closed=trades.filter(t=>t.pnl!==0&&(t.ms?now-t.ms<cutoff:period==="ALL"));
  const wins=closed.filter(t=>t.pnl>0);
  const losses=closed.filter(t=>t.pnl<0);
  const pct=closed.length?wins.length/closed.length*100:0;
  const bestTrade=wins.length?Math.max(...wins.map(t=>t.pnl)):0;
  const worstTrade=losses.length?Math.min(...losses.map(t=>t.pnl)):0;
  const periodPnL=closed.reduce((s,t)=>s+t.pnl,0);
  const maxAbsPnL=closed.length?Math.max(...closed.map(t=>Math.abs(t.pnl)),1):1;

  const tweetText=`My KYMIA AI swarm made ${periodPnL>=0?"+":""}$${f2(Math.abs(periodPnL))} in ${period}\nWin rate: ${f2(pct,0)}% | ${closed.length} trades\nTry free: kymia.ai\n#KYMIA #AITrading #Solana`;
  const shareText=tweetText; // keep for other uses

  const captureCard=async()=>{
    if(!cardRef.current)return null;
    const h2c=(await import("html2canvas")).default;
    return h2c(cardRef.current,{backgroundColor:"#04060D",scale:2,useCORS:true,logging:false});
  };

  const shareOnX=async()=>{
    if(sharing)return;
    setSharing(true);
    try{
      const canvas=await captureCard();
      if(canvas){
        const a=document.createElement("a");
        a.download="kymia-performance.png";
        a.href=canvas.toDataURL("image/png");
        a.click();
      }
      window.open("https://twitter.com/intent/tweet?text="+encodeURIComponent(tweetText),"_blank");
      setXToast(true);
      setTimeout(()=>setXToast(false),5000);
    }catch{}
    setSharing(false);
  };

  const downloadPNG=async()=>{
    if(!cardRef.current||downloading)return;
    setDownloading(true);
    try{
      const h2c=(await import("html2canvas")).default;
      const canvas=await h2c(cardRef.current,{backgroundColor:"#04060D",scale:2,useCORS:true,logging:false});
      const a=document.createElement("a");a.download="kymia-performance.png";a.href=canvas.toDataURL("image/png");a.click();
    }catch{}
    setDownloading(false);
  };

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(2,5,14,.92)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:600,backdropFilter:"blur(8px)"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{display:"flex",flexDirection:"column",gap:10,maxWidth:440,width:"100%",padding:"0 14px",maxHeight:"92vh",overflow:"auto"}}>
        {/* Captured card */}
        <div ref={cardRef} style={{background:"#04060D",border:"1px solid #0A1D33",borderRadius:16,padding:"20px",fontFamily:"'JetBrains Mono','Courier New',monospace"}}>
          {/* Card header */}
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <svg width="22" height="22" viewBox="0 0 30 30"><polygon points="15,1 27,8 27,22 15,29 3,22 3,8" fill="none" stroke={K.c} strokeWidth="1.5"/><ellipse cx="15" cy="15" rx="7" ry="4.2" fill="none" stroke={K.c} strokeWidth="1" opacity=".8"/><circle cx="15" cy="15" r="2.8" fill={K.c}/><circle cx="15" cy="15" r="1.1" fill="#000" opacity=".7"/></svg>
              <span style={{fontSize:15,fontWeight:900,color:K.c,letterSpacing:".2em"}}>KYMIA</span>
            </div>
            <span style={{fontSize:7,color:K.dim,padding:"2px 7px",border:"1px solid #0A1D33",borderRadius:4,letterSpacing:".06em"}}>PAPER TRADING · DEMO</span>
          </div>
          {/* Period tabs */}
          <div style={{display:"flex",gap:4,marginBottom:14}}>
            {(["1H","3H","24H","7D","ALL"] as const).map(p=>(
              <button key={p} onClick={()=>setPeriod(p)} style={{flex:1,background:period===p?K.c+"20":"none",border:"1px solid "+(period===p?K.c+"50":"#0A1D33"),borderRadius:4,padding:"4px 0",fontSize:8,color:period===p?K.c:K.dim,cursor:"pointer",fontFamily:"inherit",letterSpacing:".05em"}}>{p}</button>
            ))}
          </div>
          {/* Stats grid */}
          {(()=>{
            // For the ALL period, use DB-aggregated all-time stats (not limited 20-trade array)
            const displayTotal=period==="ALL"?allTimeStats.totalTrades:closed.length;
            const displayWins=period==="ALL"?allTimeStats.wins:wins.length;
            const displayLosses=period==="ALL"?allTimeStats.totalTrades-allTimeStats.wins:losses.length;
            const displayWinRate=displayTotal?displayWins/displayTotal*100:0;
            return(
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:14}}>
            {([
              {l:"TOTAL TRADES",v:String(displayTotal),c:K.c},
              {l:"WINS",v:String(displayWins),c:K.g},
              {l:"LOSSES",v:String(displayLosses),c:K.r},
              {l:"WIN RATE",v:f2(displayWinRate,0)+"%",c:K.gold},
              {l:"BEST TRADE",v:bestTrade>0?"+$"+f2(bestTrade):"—",c:K.g},
              {l:"WORST TRADE",v:worstTrade<0?"-$"+f2(Math.abs(worstTrade)):"—",c:K.r},
            ] as Array<{l:string,v:string,c:string}>).map((s,i)=>(
              <div key={i} style={{background:"#060A12",border:"1px solid #0A1D33",borderRadius:8,padding:"7px 9px"}}>
                <div style={{fontSize:6,color:K.dim,marginBottom:2,letterSpacing:".07em"}}>{s.l}</div>
                <div style={{fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div>
              </div>
            ))}
          </div>
          );})()}
          {/* P&L banner */}
          <div style={{padding:"10px 14px",background:(periodPnL>=0?K.g:K.r)+"10",border:"1px solid "+(periodPnL>=0?K.g:K.r)+"30",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div><div style={{fontSize:7,color:K.dim,marginBottom:2}}>TOTAL P&L ({period})</div><div style={{fontSize:7,color:K.dim}}>{closed.length} closed trades</div></div>
            <span style={{fontSize:22,fontWeight:900,color:periodPnL>=0?K.g:K.r,textShadow:"0 0 12px "+(periodPnL>=0?K.g:K.r)}}>{periodPnL>=0?"+":""}${f2(Math.abs(periodPnL))}</span>
          </div>
          {/* Mini bar chart */}
          {closed.length>0&&(
            <div style={{marginBottom:14}}>
              <div style={{fontSize:7,color:K.dim,marginBottom:5,letterSpacing:".08em"}}>TRADE HISTORY · LAST {Math.min(30,closed.length)}</div>
              <div style={{display:"flex",alignItems:"center",gap:2,height:44,background:"#060A12",borderRadius:6,padding:"6px 8px",boxSizing:"border-box"}}>
                {closed.slice(0,30).reverse().map((t,i)=>{
                  const h=Math.max(3,Math.abs(t.pnl)/maxAbsPnL*32);
                  return<div key={i} title={t.sym+" "+fU(t.pnl)} style={{flex:1,height:h,background:t.pnl>=0?K.g:K.r,borderRadius:2,opacity:.82,alignSelf:"center"}}/>;
                })}
              </div>
            </div>
          )}
          {/* Recent executions */}
          {closed.slice(0,3).length>0&&(
            <div style={{marginBottom:12}}>
              <div style={{fontSize:7,color:K.dim,marginBottom:6,letterSpacing:".08em"}}>RECENT EXECUTIONS</div>
              {closed.slice(0,3).map((t,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:i<2?"1px solid #060A12":"none"}}>
                  <div style={{display:"flex",alignItems:"center",gap:7}}>
                    <span style={{fontSize:12,color:t.pnl>=0?K.g:K.r}}>{t.pnl>=0?"▲":"▼"}</span>
                    <div>
                      <div style={{fontSize:9,fontWeight:700,color:K.hi}}>{t.sym} <span style={{fontSize:7,color:K.dim,fontWeight:400}}>via {t.agent||"ALGO"}</span></div>
                      <div style={{fontSize:7,color:K.dim}}>{t.t} · {t.reason||"Exit"}</div>
                    </div>
                  </div>
                  <span style={{fontSize:11,fontWeight:700,color:t.pnl>=0?K.g:K.r}}>{t.pnl>=0?"+":""}${f2(Math.abs(t.pnl))}</span>
                </div>
              ))}
            </div>
          )}
          {/* Card footer */}
          <div style={{borderTop:"1px solid #0A1D33",paddingTop:9,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:7,color:K.dim}}>18 AGENTS · SOLANA · kymia.ai</span>
            <span style={{fontSize:7,color:K.c,opacity:.5}}>kymia.ai</span>
          </div>
        </div>
        {/* Instruction toast */}
        {xToast&&(
          <div style={{background:"#0A1A0A",border:"1px solid "+K.g+"60",borderRadius:8,padding:"10px 14px",display:"flex",alignItems:"center",gap:8,animation:"toastIn .3s ease forwards"}}>
            <span style={{fontSize:14}}>📎</span>
            <div>
              <div style={{fontSize:9,color:K.g,fontWeight:700,marginBottom:1}}>Image downloaded!</div>
              <div style={{fontSize:8,color:K.tx}}>Attach kymia-performance.png to your tweet for the viral card</div>
            </div>
          </div>
        )}
        {/* Action buttons */}
        <div style={{display:"flex",gap:7}}>
          <button onClick={downloadPNG} disabled={downloading} style={{flex:1,padding:"9px 4px",background:"#060A12",border:"1px solid "+K.c+"40",color:K.c,fontSize:8,fontFamily:"inherit",cursor:"pointer",borderRadius:6,letterSpacing:".08em"}}>{downloading?"⟳ CAPTURING...":"⬇ PNG"}</button>
          <button onClick={shareOnX} disabled={sharing} style={{flex:2,padding:"9px 4px",background:sharing?"#060A12":"#060e18",border:"1px solid #1d9bf0",color:"#1d9bf0",fontSize:8,fontFamily:"inherit",cursor:"pointer",borderRadius:6,letterSpacing:".08em"}}>{sharing?"⟳ CAPTURING...":"𝕏 SHARE ON X"}</button>
          <button onClick={()=>{navigator.clipboard?.writeText("https://kymia.ai?ref=share");setCopied(true);setTimeout(()=>setCopied(false),1800);}} style={{flex:1,padding:"9px 4px",background:"#060A12",border:"1px solid "+(copied?K.g:K.dim),color:copied?K.g:K.dim,fontSize:8,fontFamily:"inherit",cursor:"pointer",borderRadius:6,letterSpacing:".08em"}}>{copied?"✓ COPIED":"🔗 LINK"}</button>
        </div>
      </div>
    </div>
  );
}

const TransparencyModal = ({onClose}:{onClose:()=>void}) => (
  <div style={{position:'fixed',inset:0,zIndex:900,background:'rgba(2,4,10,0.96)',backdropFilter:'blur(16px)',display:'flex',alignItems:'center',justifyContent:'center'}} onClick={onClose}>
    <div style={{maxWidth:560,width:'90%',background:'#060A12',border:'1px solid rgba(0,242,254,0.2)',borderRadius:12,padding:36}} onClick={e=>e.stopPropagation()}>
      <div style={{fontSize:11,color:'#00F2FE',letterSpacing:'.3em',marginBottom:16}}>◈ HOW KYMIA ACTUALLY WORKS</div>
      <p style={{fontSize:13,color:'#A8D0EC',lineHeight:1.9,marginBottom:20}}>
        KYMIA is not a mysterious AI black box. It is <strong style={{color:'white'}}>18 mathematical functions</strong> running in parallel on real market data.
      </p>
      {[
        {agent:'LENS',code:`fetch Kraken candles\ncalcRSI(14)\nif RSI < 40 → BUY\nif RSI > 65 → SELL`,col:'#BD00FF'},
        {agent:'LEVIATHAN',code:`fetch DexScreener flow\nbuyRatio = buys/(buys+sells)\nif ratio > 0.62 → BUY`,col:'#BD00FF'},
        {agent:'CONSENSUS',code:`count all 17 votes\nif 60%+ agree → execute\nelse → wait`,col:'#00F2FE'},
      ].map((a,i)=>(
        <div key={i} style={{marginBottom:12,padding:'10px 14px',background:'rgba(4,6,13,0.8)',border:`1px solid ${a.col}20`,borderRadius:6}}>
          <div style={{fontSize:9,color:a.col,fontWeight:700,marginBottom:6,fontFamily:'monospace'}}>{a.agent} AGENT</div>
          <pre style={{fontSize:10,color:'#2A5070',fontFamily:'monospace',margin:0,lineHeight:1.7,whiteSpace:'pre'}}>{a.code}</pre>
        </div>
      ))}
      <div style={{padding:'12px 16px',marginTop:8,background:'rgba(0,255,136,0.05)',border:'1px solid rgba(0,255,136,0.15)',borderRadius:6}}>
        <div style={{fontSize:11,color:'#00FF88',marginBottom:6,fontWeight:700}}>3 GUARANTEES</div>
        {[
          '✓ Full source code on GitHub — readable by anyone',
          '✓ Non-custodial — your keys, your funds, always',
          '✓ Every live trade on Solana blockchain — verifiable',
        ].map((g,i)=>(
          <div key={i} style={{fontSize:11,color:'#2A5070',marginBottom:4}}>{g}</div>
        ))}
      </div>
      <div style={{display:'flex',gap:10,marginTop:20}}>
        <a href="https://github.com/cbompemo-byte/Nexus-V2" target="_blank" rel="noopener" style={{flex:1,padding:'10px',background:'rgba(168,208,236,0.06)',border:'1px solid rgba(168,208,236,0.2)',borderRadius:6,textAlign:'center',color:'#A8D0EC',textDecoration:'none',fontSize:11,fontFamily:'monospace',fontWeight:700}}>READ THE CODE →</a>
        <button onClick={onClose} style={{flex:1,padding:'10px',background:'rgba(0,242,254,0.08)',border:'1px solid rgba(0,242,254,0.2)',borderRadius:6,cursor:'pointer',color:'#00F2FE',fontSize:11,fontFamily:'monospace',fontWeight:700}}>UNDERSTOOD ✓</button>
      </div>
    </div>
  </div>
);

// ── Part 3: Opportunity Score Card ──────────────────────────────────
const OpportunityScoreCard=({score,sym}:{score:OpportunityScore,sym:string})=>{
  const gc=score.grade==='A'?'#00FF88':score.grade==='B'?'#FFD700':'#FF3366';
  return(
    <div style={{padding:'12px 14px',background:'rgba(6,10,18,0.9)',border:`1px solid ${score.grade==='A'?'rgba(0,255,136,0.3)':score.grade==='B'?'rgba(255,215,0,0.25)':'rgba(255,51,102,0.2)'}`,borderRadius:8}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
        <div><div style={{fontSize:11,color:K.dim,fontFamily:'monospace'}}>OPPORTUNITY SCORE</div><div style={{fontSize:9,color:K.dim,fontFamily:'monospace'}}>{sym}/USD</div></div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:36,fontWeight:900,color:gc,fontFamily:'monospace',lineHeight:1,textShadow:`0 0 20px ${gc}`}}>{score.total}</div>
          <div style={{fontSize:10,fontWeight:700,color:gc,fontFamily:'monospace'}}>GRADE {score.grade}</div>
        </div>
      </div>
      {Object.entries(score.breakdown).map(([k,v])=>(
        <div key={k} style={{marginBottom:5}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
            <span style={{fontSize:8,color:K.dim,fontFamily:'monospace',textTransform:'uppercase'}}>{k}</span>
            <span style={{fontSize:8,color:K.hi,fontFamily:'monospace'}}>{v}</span>
          </div>
          <div style={{height:3,background:'#06090F',borderRadius:2}}>
            <div style={{height:'100%',width:`${v}%`,background:v>=80?'#00FF88':v>=60?'#FFD700':'#FF3366',borderRadius:2,transition:'width .3s'}}/>
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Part 4: Why This Trade Panel ────────────────────────────────────
const WhyThisTrade=({explanation,sym}:{explanation:TradeExplanation,sym:string})=>(
  <div style={{padding:'12px 14px',background:'rgba(6,10,18,0.9)',border:`1px solid ${explanation.decision==='EXECUTE'?'rgba(0,255,136,0.2)':'rgba(255,51,102,0.15)'}`,borderRadius:8}}>
    <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:10,fontFamily:'monospace'}}>{explanation.decision==='EXECUTE'?'◈ WHY THIS TRADE':'◈ WHY NO TRADE'} — {sym}</div>
    {explanation.passed.map((p,i)=>(
      <div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
        <span style={{color:'#00FF88',fontSize:11}}>✓</span>
        <span style={{fontSize:10,color:K.hi,fontFamily:'monospace'}}>{p.signal}</span>
        <span style={{fontSize:9,color:K.dim,fontFamily:'monospace',marginLeft:'auto'}}>{p.detail}</span>
      </div>
    ))}
    {explanation.failed.map((f,i)=>(
      <div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:5}}>
        <span style={{color:'#FF3366',fontSize:11}}>✗</span>
        <span style={{fontSize:10,color:K.dim,fontFamily:'monospace'}}>{f.signal}</span>
        <span style={{fontSize:9,color:'#FF3366',fontFamily:'monospace',marginLeft:'auto'}}>{f.detail}</span>
      </div>
    ))}
    <div style={{marginTop:10,padding:'6px 10px',background:`${explanation.decision==='EXECUTE'?'rgba(0,255,136,0.08)':'rgba(255,51,102,0.06)'}`,borderRadius:4,fontSize:10,color:explanation.decision==='EXECUTE'?'#00FF88':'#FF3366',fontFamily:'monospace',fontWeight:700}}>
      {explanation.decision}: {explanation.reason}
    </div>
  </div>
);

// ── Part 6: Signal Decay Badge ───────────────────────────────────────
const SignalDecayBadge=({signal}:{signal:SignalWithDecay})=>{
  const mins=Math.floor(signal.ageSeconds/60),secs=signal.ageSeconds%60;
  const urg=signal.currentConf>80?'#00FF88':signal.currentConf>65?'#FFD700':'#FF3366';
  return(
    <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',background:`${urg}08`,border:`1px solid ${urg}25`,borderRadius:5}}>
      <div style={{flex:1}}>
        <div style={{fontSize:11,fontWeight:700,color:urg,fontFamily:'monospace'}}>{signal.sym} {signal.signal}</div>
        <div style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>Age: {mins}m {secs}s · Decay: -{signal.decayPct.toFixed(0)}%</div>
      </div>
      <div style={{textAlign:'right'}}>
        <div style={{fontSize:18,fontWeight:900,color:urg,fontFamily:'monospace'}}>{signal.currentConf.toFixed(0)}%</div>
        <div style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>was {signal.initialConf}%</div>
      </div>
      <div style={{position:'relative',width:3,height:40,background:'#06090F',borderRadius:2}}>
        <div style={{position:'absolute',bottom:0,width:'100%',height:`${(signal.currentConf/signal.initialConf)*100}%`,background:urg,borderRadius:2}}/>
      </div>
    </div>
  );
};

const AuthModal=({onClose}:{onClose:()=>void})=>(
  <div style={{position:'fixed',inset:0,zIndex:9998,background:'rgba(2,4,10,0.97)',backdropFilter:'blur(20px)',display:'flex',alignItems:'center',justifyContent:'center'}}>
    <div style={{background:'#060A12',border:'1px solid rgba(0,242,254,0.15)',borderRadius:16,padding:36,width:380,textAlign:'center'}}>
      <div style={{fontSize:32,marginBottom:8}}>◈</div>
      <h2 style={{fontSize:22,fontWeight:900,color:'white',marginBottom:8,fontFamily:"'JetBrains Mono','Courier New',monospace"}}>Save your progress</h2>
      <p style={{fontSize:13,color:'#2A5070',lineHeight:1.7,marginBottom:28,fontFamily:"'JetBrains Mono','Courier New',monospace"}}>Sign in to keep your trading performance, DNA card, and session history across devices.</p>
      <button onClick={async()=>{await supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:window.location.origin+'/nexus'}});}} style={{width:'100%',padding:'13px',background:'rgba(255,255,255,0.08)',border:'1px solid rgba(255,255,255,0.15)',borderRadius:8,color:'white',fontSize:13,fontWeight:700,cursor:'pointer',marginBottom:10,display:'flex',alignItems:'center',justifyContent:'center',gap:10,fontFamily:'monospace'}}>
        <span style={{fontSize:18}}>G</span>Continue with Google
      </button>
      <button onClick={async()=>{await supabase.auth.signInWithOAuth({provider:'github',options:{redirectTo:window.location.origin+'/nexus'}});}} style={{width:'100%',padding:'13px',background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:8,color:'white',fontSize:13,fontWeight:700,cursor:'pointer',marginBottom:20,display:'flex',alignItems:'center',justifyContent:'center',gap:10,fontFamily:'monospace'}}>
        <span style={{fontSize:18}}>⌥</span>Continue with GitHub
      </button>
      <button onClick={onClose} style={{background:'none',border:'none',color:'#2A5070',cursor:'pointer',fontSize:12,fontFamily:'monospace'}}>Skip — continue without saving</button>
    </div>
  </div>
);

function ActivateScreen({onActivate,swarmConfig,user}:{onActivate:()=>void,swarmConfig:{profile:string,leverage:number}|null,user:any}){
  const [pulse,setPulse]=useState(false);
  useEffect(()=>{const iv=setInterval(()=>setPulse(p=>!p),1200);return()=>clearInterval(iv);},[]);
  return(
    <div style={{position:'absolute',inset:0,background:'rgba(4,6,13,0.92)',backdropFilter:'blur(4px)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',zIndex:20,gap:0}}>
      {user&&(
        <div style={{marginBottom:24,padding:'8px 20px',background:'rgba(0,242,254,0.08)',border:'1px solid rgba(0,242,254,0.2)',borderRadius:20,fontSize:12,color:'#00F2FE',fontFamily:'monospace'}}>
          ◈ Welcome back {user.email?.split('@')[0]} — session restored
        </div>
      )}
      <div style={{textAlign:'center',marginBottom:40}}>
        <div style={{fontSize:52,color:'#00F2FE',marginBottom:12,textShadow:'0 0 40px rgba(0,242,254,0.5)',fontFamily:'monospace',fontWeight:900,letterSpacing:'0.2em'}}>◈ KYMIA</div>
        <div style={{fontSize:13,color:'#2A5070',fontFamily:'monospace',letterSpacing:'0.4em'}}>AUTONOMOUS QUANT INTELLIGENCE</div>
      </div>
      <div style={{display:'flex',gap:10,marginBottom:40,flexWrap:'wrap',justifyContent:'center',padding:'0 20px'}}>
        {([{icon:'◈',text:'18 AI Agents',col:'#00F2FE'},{icon:'▲',text:'Real Solana Prices',col:'#00FF88'},{icon:'⚡',text:'$10K Virtual Capital',col:'#FFD700'}] as const).map((f,i)=>(
          <div key={i} style={{padding:'8px 16px',background:`${f.col}10`,border:`1px solid ${f.col}30`,borderRadius:20,display:'flex',alignItems:'center',gap:7,fontSize:12,color:f.col,fontFamily:'monospace',fontWeight:700}}>
            <span>{f.icon}</span><span>{f.text}</span>
          </div>
        ))}
      </div>
      <div style={{display:'flex',gap:20,marginBottom:48,padding:'0 40px',flexWrap:'wrap',justifyContent:'center'}}>
        {[{n:'01',title:'Agents Analyze',desc:'18 specialized AI agents scan RSI, EMA, Volume, Whale flows and Fear & Greed in real time'},{n:'02',title:'Swarm Debates',desc:'Agents vote. When 68%+ agree on a signal with high confidence, consensus is reached'},{n:'03',title:'Trade Executes',desc:'AEGIS validates risk. Position opens on real Solana market prices. You watch it unfold'}].map((step,i)=>(
          <div key={i} style={{width:200,padding:'18px 20px',background:'rgba(6,10,18,0.8)',border:'1px solid rgba(0,242,254,0.08)',borderRadius:10}}>
            <div style={{fontSize:11,color:'#00F2FE',fontFamily:'monospace',fontWeight:700,marginBottom:8,opacity:0.5}}>{step.n}</div>
            <div style={{fontSize:13,color:'white',fontWeight:700,marginBottom:8}}>{step.title}</div>
            <div style={{fontSize:11,color:'#2A5070',lineHeight:1.7}}>{step.desc}</div>
          </div>
        ))}
      </div>
      <button onClick={onActivate} style={{padding:'18px 60px',background:'rgba(0,242,254,0.12)',border:`2px solid ${pulse?'rgba(0,242,254,0.8)':'rgba(0,242,254,0.4)'}`,borderRadius:10,color:'#00F2FE',fontFamily:'monospace',fontSize:18,fontWeight:900,cursor:'pointer',letterSpacing:'0.15em',boxShadow:pulse?'0 0 40px rgba(0,242,254,0.25),0 0 80px rgba(0,242,254,0.1)':'0 0 20px rgba(0,242,254,0.1)',transition:'all 0.3s ease',marginBottom:16}}>
        ▶ ACTIVATE SWARM
      </button>
      <div style={{fontSize:11,color:'#2A5070',fontFamily:'monospace',textAlign:'center'}}>Real market data · Virtual $10,000 · No risk</div>
      {swarmConfig&&(
        <div style={{marginTop:16,fontSize:10,color:'#2A5070',fontFamily:'monospace'}}>
          Profile: {swarmConfig.profile?.toUpperCase()} · {swarmConfig.leverage}x leverage
        </div>
      )}
    </div>
  );
}

// ── Cinematic chart on trade open ─────────────────────────────────────────────
const TV_SYMS:Record<string,string>={SOL:'BINANCE:SOLUSDT',BTC:'BINANCE:BTCUSDT',ETH:'BINANCE:ETHUSDT',JUP:'BINANCE:JUPUSDT',RAY:'BINANCE:RAYUSDT',BONK:'BINANCE:BONKUSDT',WIF:'BINANCE:WIFUSDT'};
type CinPhase='entering'|'analyzing'|'drawing'|'holding'|'exiting';

function CinematicChart({trade,onComplete}:{trade:{sym:string,pos:any},onComplete:()=>void}){
  const [phase,setPhase]=useState<CinPhase>('entering');
  const [countdown,setCountdown]=useState(18);
  const [lines,setLines]=useState({entry:false,tp:false,sl:false,ema:false});
  const [chartReady,setChartReady]=useState(false);
  const chartRef=useRef<HTMLDivElement>(null);
  const {sym,pos}=trade;
  const isLong=pos.side!=='SHORT';
  const col=isLong?'#00FF88':'#FF3366';
  const entry:number=pos.avg||0;
  const sl:number=pos.sl||(isLong?entry*0.982:entry*1.018);
  const tp:number=pos.tp||(isLong?entry*1.055:entry*0.945);
  const rr=entry!==sl?Math.abs((tp-entry)/(entry-sl)):0;

  useEffect(()=>{
    const seq:[number,()=>void][]=[
      [0,()=>setPhase('entering')],
      [600,()=>setPhase('analyzing')],
      [1800,()=>setPhase('drawing')],
      [2200,()=>setLines(l=>({...l,ema:true}))],
      [2800,()=>setLines(l=>({...l,entry:true}))],
      [3400,()=>setLines(l=>({...l,tp:true}))],
      [4000,()=>setLines(l=>({...l,sl:true}))],
      [4600,()=>setPhase('holding')],
      [18000,()=>setPhase('exiting')],
      [18800,onComplete],
    ];
    const ts=seq.map(([d,fn])=>setTimeout(fn,d));
    return()=>ts.forEach(clearTimeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  useEffect(()=>{
    if(phase!=='holding')return;
    const iv=setInterval(()=>setCountdown(c=>{if(c<=1){clearInterval(iv);return 0;}return c-1;}),1000);
    return()=>clearInterval(iv);
  },[phase]);

  useEffect(()=>{
    if(!chartRef.current)return;
    chartRef.current.innerHTML='';
    const s=document.createElement('script');
    s.src='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async=true;
    s.innerHTML=JSON.stringify({
      autosize:true,
      symbol:TV_SYMS[sym]||`BINANCE:${sym}USDT`,
      interval:'5',timezone:'Etc/UTC',theme:'dark',style:'1',locale:'en',
      backgroundColor:'rgba(4,6,13,1)',gridColor:'rgba(10,29,51,0.4)',
      hide_top_toolbar:false,withdateranges:false,
      studies:['RSI@tv-basicstudies','BB@tv-basicstudies','MAExp@tv-basicstudies','Volume@tv-basicstudies'],
      overrides:{
        "paneProperties.background":"#04060D","paneProperties.backgroundType":"solid",
        "paneProperties.vertGridProperties.color":"#081422","paneProperties.horzGridProperties.color":"#081422",
        "scalesProperties.textColor":"#4A7090","scalesProperties.backgroundColor":"#04060D",
        "mainSeriesProperties.candleStyle.upColor":"#00FF88","mainSeriesProperties.candleStyle.downColor":"#FF3366",
        "mainSeriesProperties.candleStyle.borderUpColor":"#00FF88","mainSeriesProperties.candleStyle.borderDownColor":"#FF3366",
        "mainSeriesProperties.candleStyle.wickUpColor":"#00FF8850","mainSeriesProperties.candleStyle.wickDownColor":"#FF336650",
      },
      studies_overrides:{
        "bollinger bands.upper.color":"#00F2FE","bollinger bands.lower.color":"#00F2FE",
        "bollinger bands.median.color":"#FFD70060","relative strength index.plot.color":"#BD00FF",
        "moving average exponential.Plot.color":"#00F2FE",
      },
      disabled_features:["use_localstorage_for_settings","header_symbol_search"],
    });
    chartRef.current.appendChild(s);
    const t=setTimeout(()=>setChartReady(true),2500);
    return()=>clearTimeout(t);
  },[sym]);

  const animStyle=(delay=0):React.CSSProperties=>({animation:`cinematicFadeIn 0.6s ${delay}ms cubic-bezier(0.16,1,0.3,1) both`});

  return(
    <div style={{position:'fixed',inset:0,zIndex:9999,background:'#04060D',display:'flex',flexDirection:'column',
      animation:phase==='entering'?'cinematicIn 0.6s cubic-bezier(0.16,1,0.3,1) forwards':phase==='exiting'?'cinematicOut 0.8s ease-in forwards':'none'}}>
      <style>{`
        @keyframes cinematicIn{from{opacity:0;transform:scale(1.02)}to{opacity:1;transform:scale(1)}}
        @keyframes cinematicOut{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(0.98)}}
        @keyframes cinematicFadeIn{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
        @keyframes cinDrawLine{from{width:0;opacity:0}to{width:100%;opacity:1}}
        @keyframes cinPulse{0%,100%{opacity:1}50%{opacity:0.4}}
      `}</style>

      {/* HEADER */}
      <div style={{padding:'12px 20px',flexShrink:0,background:'rgba(4,6,13,0.98)',borderBottom:'1px solid rgba(0,242,254,0.1)',display:'flex',alignItems:'center',gap:12,zIndex:10}}>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:col,boxShadow:`0 0 12px ${col}`,animation:'cinPulse 1s infinite'}}/>
          <span style={{fontSize:22,fontWeight:900,color:'white',fontFamily:'monospace'}}>{sym}/USD</span>
          <div style={{padding:'3px 12px',background:`${col}20`,border:`1px solid ${col}50`,borderRadius:4,fontSize:11,fontWeight:900,color:col,fontFamily:'monospace'}}>{isLong?'▲ LONG':'▼ SHORT'}</div>
        </div>
        <div style={{fontSize:10,color:'#2A5070',fontFamily:'monospace',flex:1}}>
          {phase==='analyzing'&&<span style={{animation:'cinPulse 0.8s infinite'}}>◈ Agents analyzing chart patterns...</span>}
          {phase==='drawing'&&'◈ Drawing technical levels...'}
          {phase==='holding'&&'◈ Position active — monitoring'}
        </div>
        <div style={{fontSize:9,color:'#2A5070',fontFamily:'monospace'}}>Opened by {pos.signal||'BOLLINGER'}</div>
        {phase==='holding'&&(
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'5px 14px',background:'rgba(0,242,254,0.06)',border:'1px solid rgba(0,242,254,0.2)',borderRadius:20}}>
            <svg width="22" height="22">
              <circle cx="11" cy="11" r="9" fill="none" stroke="#0A1D33" strokeWidth="2"/>
              <circle cx="11" cy="11" r="9" fill="none" stroke="#00F2FE" strokeWidth="2"
                strokeDasharray={`${(countdown/18)*56.5} 56.5`} strokeLinecap="round"
                transform="rotate(-90 11 11)" style={{transition:'stroke-dasharray 1s linear'}}/>
            </svg>
            <span style={{fontSize:13,color:'#00F2FE',fontFamily:'monospace',fontWeight:900}}>{countdown}s</span>
          </div>
        )}
        <button onClick={onComplete} style={{background:'none',border:'none',color:'#2A5070',cursor:'pointer',fontSize:20,padding:'0 4px',lineHeight:1}}>✕</button>
      </div>

      {/* CHART */}
      <div style={{flex:1,position:'relative',overflow:'hidden'}}>
        <div ref={chartRef} className="tradingview-widget-container" style={{width:'100%',height:'100%',background:'#04060D'}}/>

        {/* Loading */}
        {!chartReady&&(
          <div style={{position:'absolute',inset:0,background:'#04060D',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:16,zIndex:5}}>
            <div style={{fontSize:32,color:'#00F2FE',animation:'cinPulse 1s infinite'}}>◈</div>
            <div style={{fontSize:12,color:'#2A5070',fontFamily:'monospace',letterSpacing:'.2em'}}>LOADING CHART...</div>
          </div>
        )}

        {/* OVERLAYS */}
        {chartReady&&(
          <div style={{position:'absolute',inset:0,pointerEvents:'none',zIndex:10}}>
            {/* Entry line */}
            {lines.entry&&(
              <div style={{position:'absolute',top:'48%',left:0,right:120,display:'flex',alignItems:'center',...animStyle()}}>
                <div style={{flex:1,height:1,background:'rgba(0,242,254,0.6)',boxShadow:'0 0 8px rgba(0,242,254,0.4)'}}/>
                <div style={{padding:'3px 10px',background:'#00F2FE',borderRadius:'0 4px 4px 0',fontSize:10,color:'#04060D',fontWeight:900,fontFamily:'monospace',whiteSpace:'nowrap'}}>ENTRY ${entry.toFixed(2)}</div>
              </div>
            )}
            {/* TP line */}
            {lines.tp&&(
              <div style={{position:'absolute',top:'28%',left:0,right:120,display:'flex',alignItems:'center',...animStyle(200)}}>
                <div style={{flex:1,height:1,background:'rgba(0,255,136,0.7)',boxShadow:'0 0 8px rgba(0,255,136,0.4)'}}/>
                <div style={{padding:'3px 10px',background:'#00FF88',borderRadius:'0 4px 4px 0',fontSize:10,color:'#04060D',fontWeight:900,fontFamily:'monospace',whiteSpace:'nowrap'}}>TP ${tp.toFixed(2)}</div>
              </div>
            )}
            {/* SL line */}
            {lines.sl&&(
              <div style={{position:'absolute',top:'68%',left:0,right:120,display:'flex',alignItems:'center',...animStyle(400)}}>
                <div style={{flex:1,height:1,background:'rgba(255,51,102,0.7)',boxShadow:'0 0 8px rgba(255,51,102,0.4)'}}/>
                <div style={{padding:'3px 10px',background:'#FF3366',borderRadius:'0 4px 4px 0',fontSize:10,color:'white',fontWeight:900,fontFamily:'monospace',whiteSpace:'nowrap'}}>SL ${sl.toFixed(2)}</div>
              </div>
            )}

            {/* Agent panel — top right */}
            {lines.entry&&(
              <div style={{position:'absolute',top:12,right:12,display:'flex',flexDirection:'column',gap:4,...animStyle()}}>
                <div style={{padding:'5px 10px',background:'rgba(4,6,13,0.95)',border:'1px solid rgba(0,242,254,0.15)',borderRadius:4,marginBottom:4,fontSize:8,color:'#2A5070',fontFamily:'monospace',letterSpacing:'.15em'}}>◈ AGENT ANALYSIS</div>
                {([
                  {n:'BOLLINGER',i:'BB bands',c:'#00F2FE',v:isLong?'Oversold':'Overbought'},
                  {n:'LENS',i:'RSI(14)',c:'#BD00FF',v:isLong?'< 35':'> 65'},
                  {n:'SURGE',i:'Volume',c:'#00FF88',v:'1.5x avg'},
                  {n:'AEGIS',i:'Risk',c:'#FF3366',v:'APPROVED'},
                ] as {n:string,i:string,c:string,v:string}[]).map((a,i)=>(
                  <div key={i} style={{display:'flex',alignItems:'center',gap:8,padding:'4px 10px',background:'rgba(4,6,13,0.92)',border:`1px solid ${a.c}20`,borderRadius:4}}>
                    <div style={{width:6,height:6,borderRadius:'50%',background:a.c}}/>
                    <span style={{fontSize:9,color:a.c,fontWeight:700,fontFamily:'monospace'}}>{a.n}</span>
                    <span style={{fontSize:8,color:'#2A5070',fontFamily:'monospace'}}>{a.i}</span>
                    <span style={{fontSize:9,color:'white',fontFamily:'monospace',marginLeft:'auto',fontWeight:700}}>{a.v}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Position summary — bottom left */}
            {lines.sl&&(
              <div style={{position:'absolute',bottom:20,left:16,padding:'12px 16px',background:'rgba(4,6,13,0.95)',border:`1px solid ${col}30`,borderRadius:8,...animStyle(),boxShadow:`0 0 20px ${col}10`}}>
                <div style={{fontSize:9,color:'#2A5070',fontFamily:'monospace',marginBottom:8,letterSpacing:'.2em'}}>◈ POSITION OPENED</div>
                <div style={{display:'flex',gap:16,fontSize:11,fontFamily:'monospace'}}>
                  {([
                    {l:'CAPITAL',v:`$${pos.size?.toFixed(0)||'—'}`},
                    {l:'RISK/REWARD',v:rr>0?`1:${rr.toFixed(1)}`:'—',col},
                    {l:'CONFIDENCE',v:`${pos.conf||'—'}%`,col:'#FFD700'},
                  ] as {l:string,v:string,col?:string}[]).map((x,i)=>(
                    <div key={i}>
                      <div style={{color:'#2A5070',fontSize:8,marginBottom:2}}>{x.l}</div>
                      <div style={{color:x.col||'white',fontWeight:700}}>{x.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <style>{`.tradingview-widget-container,.tradingview-widget-container>div,.tradingview-widget-container iframe{background:#04060D!important;height:100%!important;}`}</style>
    </div>
  );
}

export default function KYMIA({isLive=false}:{isLive?:boolean}){
  const prices=usePrices();
  const pricesRef=useRef(prices);
  useEffect(()=>{pricesRef.current=prices;},[prices]);

  const [booting,setBooting]=useState(true);
  const [walletConnected,setWalletConnected]=useState(false);
  const [walletAddress,setWalletAddress]=useState<string|null>(null);
  const [port,setPort]=useState({cash:CAP,pos:{} as {[k:string]:Position},equity:CAP,peak:CAP});
  const portRef=useRef(port);
  useEffect(()=>{portRef.current=port;},[port]);

  const [trades,setTrades]=useState<Trade[]>([]);
  const tradesRef=useRef<Trade[]>([]);
  useEffect(()=>{tradesRef.current=trades;},[trades]);
  const sessionId=useRef(Date.now().toString()).current;
  const [agSt,setAgSt]=useState<{[k:string]:AgentState}>(()=>Object.fromEntries(AGENTS.map(a=>[a.id,{on:false,conf:null,sig:null,th:""}])));
  const agStRef=useRef(agSt);
  useEffect(()=>{agStRef.current=agSt;},[agSt]);

  const [debate,setDebate]=useState<string[]>([]);
  const [logs,setLogs]=useState<LogEntry[]>([{t:ts(),ag:"SYSTEM",msg:"◈ KYMIA v2.0 — 18 agents online",col:K.c}]);
  const [aiData,setAiData]=useState<{[k:string]:unknown}|null>(null);
  const [dnaData,setDnaData]=useState<{[k:string]:unknown}|null>(null);
  const [analyzing,setAnalyzing]=useState(false);
  const [dnaLoading,setDnaLoading]=useState(false);
  const [showTransparency,setShowTransparency]=useState(false);
  const [running,setRunning]=useState(false);
  const [swarmConfig,setSwarmConfig]=useState<{profile:string,leverage:number}|null>(null);
  const [showOnboarding,setShowOnboarding]=useState(false);
  const [hasShownOnboarding,setHasShownOnboarding]=useState(false);
  const [user,setUser]=useState<any>(null);
  const [showAuthModal,setShowAuthModal]=useState(false);
  const [liveUsers,setLiveUsers]=useState(()=>847+Math.floor(Math.random()*200));
  const [circuit,setCircuit]=useState(false);
  const [blackSwan,setBlackSwan]=useState(false);
  const [tab,setTab]=useState("terminal");
  const [mktTab,setMktTab]=useState<"MOVERS"|"RADAR"|"ALL">("ALL");
  const [histFilter,setHistFilter]=useState<"1H"|"3H"|"24H"|"7D"|"ALL">("ALL");
  const [histSort,setHistSort]=useState<"time"|"pnl">("time");
  const [disabled,setDisabled]=useState<Set<string>>(new Set());
  const [showKill,setShowKill]=useState(false);
  const [modal,setModal]=useState<string|null>(null);
  const [entropy,setEntropy]=useState(42);
  const [winCards,setWinCards]=useState<WinCard[]>([]);
  const [edgeToasts,setEdgeToasts]=useState<EdgeToast[]>([]);
  const [whaleAlert,setWhaleAlert]=useState(false);
  const [beatChoice,setBeatChoice]=useState<{sym:string,side:string}|null>(null);
  const [beatResult,setBeatResult]=useState<string|null>(null);
  const [newTokens,setNewTokens]=useState<NewToken[]>([]);
  const [scannerLoading,setScannerLoading]=useState(false);
  const [dataStatus,setDataStatus]=useState<DataStatus>({jupiter:"loading",binance:"loading",coingecko:"loading",lastUpdate:0});
  const [chartTrade,setChartTrade]=useState<{trade:Trade|null,position:Position|null,agentSignals?:AgentSignals}|null>(null);
  const [confirmClose,setConfirmClose]=useState<string|null>(null);
  const [focusMode,setFocusMode]=useState(false);
  const isMobile=useIsMobile();
  const [flashingAgent,setFlashingAgent]=useState<string|null>(null);
  const [cinematicTrade,setCinematicTrade]=useState<{sym:string,pos:any}|null>(null);
  const prevPositionSyms=useRef<Set<string>>(new Set());
  const cinematicShown=useRef<Set<string>>(new Set());
  const [completedMissions,setCompletedMissions]=useState<number[]>([]);
  const [missionCelebration,setMissionCelebration]=useState<typeof MISSIONS[0]|null>(null);
  const [signalCount,setSignalCount]=useState(0);
  const [traderConsecLosses,setTraderConsecLosses]=useState(0);
  const [traderIsPaused,setTraderIsPaused]=useState(false);
  const [traderScaleMode,setTraderScaleMode]=useState(false);
  const traderPauseTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null);
  const agentLastActiveRef=useRef<{[id:string]:number}>({});
  const completedMissionsRef=useRef<number[]>([]);
  const prevAgStRef=useRef<{[k:string]:AgentState}>({});
  const sessionStartRef=useRef(Date.now());
  const sessionStartEquityRef=useRef(CAP);
  const lastTradeTimeRef=useRef<number>(Date.now());
  const demoFirstTradeRef=useRef(false);
  const sessionLoadedRef=useRef(false);
  const tradesThisCycleRef=useRef(0);
  const signalsEvaluatedRef=useRef(0);
  const tradeOpenedSinceLastStatusRef=useRef(false);
  const logRef=useRef<HTMLDivElement>(null);
  const swarmRef=useRef<HTMLDivElement>(null);
  // Symbol-level loss tracker — blacklists symbols after 2 losses
  const symLossRef=useRef<Record<string,number>>({});
  // Prevents duplicate close attempts while a live tx is in-flight (async gap)
  const pendingCloseRef=useRef<Set<string>>(new Set());
  // Pullback entry system — pending entries waiting for price pullback
  const pendingEntriesRef=useRef<Record<string,{signal:string,target:number,expiry:number,agent:string,reason:string,originalPrice:number,conf:number,leveragedSize:number,baseAlloc:number,lev:number,conviction?:string}>>({});
  const [pendingEntries,setPendingEntries]=useState<Record<string,{signal:string,target:number,expiry:number}>>({});
  // Scale-in timers — cleared on unmount
  const scaleInTimersRef=useRef<ReturnType<typeof setInterval>[]>([]);
  // Session quality — updates every minute
  const [sessionQuality,setSessionQuality]=useState(getSessionQuality());
  // Performance fee state (live mode only)
  const [feePercent,setFeePercent]=useState(10);
  const [totalFeesPaid,setTotalFeesPaid]=useState(0);
  const [allTimeStats,setAllTimeStats]=useState<{totalTrades:number,wins:number,totalPnl:number}>({totalTrades:0,wins:0,totalPnl:0});
  const [highWaterMark,setHighWaterMark]=useState(CAP);
  const entropyRef=useRef(entropy);
  useEffect(()=>{entropyRef.current=entropy;},[entropy]);

  // ── Real agent feed from server (public route, 60s refresh) ─────────
  const [agentFeed,setAgentFeed]=useState<{by_symbol:Record<string,AgentFeedVerdict[]>}|null>(null);
  const lastLoggedCycleRef=useRef<string>("");
  useEffect(()=>{
    const load=async()=>{try{const r=await fetch('/api/public/dashboard/agents');if(r.ok)setAgentFeed(await r.json())}catch{}};
    load();const iv=setInterval(load,60_000);return()=>clearInterval(iv);
  },[]);

  // ── Real decisions feed (HISTORY + REJECTED tabs, 60s refresh) ───────
  interface DecisionRow{timestamp:string;symbol:string;decision:string;reason:string|null;pnl_pct:number|null;price_usd:number|null;regime:string|null;score_total:number|null;episode_virtual:boolean}
  const [decisionsFeed,setDecisionsFeed]=useState<DecisionRow[]|null>(null);
  useEffect(()=>{
    const load=async()=>{try{const r=await fetch('/api/public/dashboard/decisions');if(r.ok){const j=await r.json();setDecisionsFeed(j.decisions??[])}}catch{}};
    load();const iv=setInterval(load,60_000);return()=>clearInterval(iv);
  },[]);

  // ── Real benchmark feed (RISK panel + session stats, 60s refresh) ────
  interface BenchmarkRow{symbol:string;hold_pct:number;agent_pct:number;alpha:number;exposure_pct:number;agent_max_dd_pct:number}
  const [benchmarkFeed,setBenchmarkFeed]=useState<BenchmarkRow[]|null>(null);
  useEffect(()=>{
    const load=async()=>{try{const r=await fetch('/api/public/dashboard/benchmark');if(r.ok){const j=await r.json();setBenchmarkFeed(j.stats??[])}}catch{}};
    load();const iv=setInterval(load,60_000);return()=>clearInterval(iv);
  },[]);

  // ── Real positions feed (POSITIONS panel, 60s refresh) ───────────────
  interface PositionRowPublic{symbol:string;entry_price:number;opened_at:string;mode:'OBSERVATION'|'LIVE'}
  const [positionsFeed,setPositionsFeed]=useState<PositionRowPublic[]|null>(null);
  useEffect(()=>{
    const load=async()=>{try{const r=await fetch('/api/public/dashboard/positions');if(r.ok){const j=await r.json();setPositionsFeed(j.positions??[])}}catch{}};
    load();const iv=setInterval(load,60_000);return()=>clearInterval(iv);
  },[]);

  // ── V2.1 State ───────────────────────────────────────────────────────
  const [regimeState,setRegimeState]=useState<RegimeState|null>(null);
  const regimeRef=useRef<RegimeState|null>(null);
  useEffect(()=>{regimeRef.current=regimeState;},[regimeState]);
  const [rejectedTrades,setRejectedTrades]=useState<RejectedTrade[]>([]);
  const [rejectionStats,setRejectionStats]=useState({executed:0,rejected:0,capitalProtected:0});
  const [activeSignals,setActiveSignals]=useState<SignalWithDecay[]>([]);
  const [tokenWatchlist,setTokenWatchlist]=useState<WatchlistedToken[]>([]);
  const [missedOpps,setMissedOpps]=useState<MissedOpportunity[]>([]);
  const [layer3Aggressive,setLayer3Aggressive]=useState(false);

  // ── Scanning messages ─────────────────────────────────────────────────
  const SCANNING_MESSAGES=[
    '◈ Scanning SOL/USD orderbook depth...',
    '◈ Monitoring BTC whale wallets...',
    '◈ Checking EMA9/21/50 alignment...',
    '◈ Evaluating liquidity vectors...',
    '◈ Analyzing funding rates on Deribit...',
    '◈ Watching for institutional momentum...',
    '◈ Scanning top 50 for breakouts...',
    '◈ Checking Fear & Greed index...',
    '◈ Monitoring new Solana listings...',
    '◈ Calculating portfolio heat...',
    '◈ Verifying BTC correlation...',
    '◈ LEVIATHAN scanning whale movements...',
    '◈ AEGIS running risk matrix...',
    '◈ ORACLE seeking alpha opportunities...',
    '◈ Checking liquidation cascades...',
    '◈ Evaluating EMA trend strength...',
    '◈ Monitoring smart money flows...',
  ];
  const [scanMsg,setScanMsg]=useState(SCANNING_MESSAGES[0]);
  const scanIdx=useRef(0);
  useEffect(()=>{
    if(!running)return;
    const iv=setInterval(()=>{
      scanIdx.current=(scanIdx.current+1)%SCANNING_MESSAGES.length;
      setScanMsg(SCANNING_MESSAGES[scanIdx.current]);
    },2500);
    return()=>clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running]);

  // ── Market pressure gauge — real regime verdicts from server ──────────
  const [pressureScore,setPressureScore]=useState(50);
  const [pressureDir,setPressureDir]=useState<'BULL'|'BEAR'|'NEUTRAL'>('NEUTRAL');
  useEffect(()=>{
    if(!agentFeed)return;
    const regimeVerdicts=Object.values(agentFeed.by_symbol).flat().filter(v=>v.agent==='regime');
    // Keep latest verdict per symbol
    const bySymbol:Record<string,AgentFeedVerdict>={};
    regimeVerdicts.forEach(v=>{const ex=bySymbol[v.symbol];if(!ex||v.cycle_ts>ex.cycle_ts)bySymbol[v.symbol]=v;});
    const all=Object.values(bySymbol);
    if(!all.length)return;
    const bulls=all.filter(v=>v.vote==='APPROVE').length;
    const score=Math.round(bulls/all.length*100);
    const clamped=Math.max(0,Math.min(100,score));
    setPressureScore(clamped);
    setPressureDir(clamped>60?'BULL':clamped<40?'BEAR':'NEUTRAL');
  },[agentFeed]);

  // Keep completedMissions ref in sync for use inside effects
  useEffect(()=>{completedMissionsRef.current=completedMissions;},[completedMissions]);

  // Mission check on equity change
  useEffect(()=>{
    const pct=(port.equity-CAP)/CAP;
    for(const mission of MISSIONS){
      if(pct>=mission.target&&!completedMissionsRef.current.includes(mission.id)){
        setCompletedMissions(prev=>{const n=[...prev,mission.id];completedMissionsRef.current=n;return n;});
        setMissionCelebration(mission);
        setTimeout(()=>setMissionCelebration(null),8000);
        break;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[port.equity]);

  // Node Flash — detect signal changes between render cycles
  useEffect(()=>{
    const prev=prevAgStRef.current;
    for(const id of Object.keys(agSt)){
      const prevSig=prev[id]?.sig;const curSig=agSt[id]?.sig;
      if(prevSig&&curSig&&prevSig!==curSig){setFlashingAgent(id);setTimeout(()=>setFlashingAgent(f=>f===id?null:f),1200);break;}
    }
    prevAgStRef.current={...agSt};
  },[agSt]);

  const log=useCallback((ag:string,msg:string,col=K.hi)=>setLogs(l=>[...l.slice(-150),{t:ts(),ag,msg,col}]),[]);

  // ── Inject real agent verdicts into reasoning log ─────────────────────
  useEffect(()=>{
    if(!agentFeed)return;
    const all:AgentFeedVerdict[]=Object.values(agentFeed.by_symbol).flat();
    const fresh=all.filter(v=>v.cycle_ts>lastLoggedCycleRef.current).sort((a,b)=>a.cycle_ts>b.cycle_ts?1:-1);
    if(!fresh.length)return;
    lastLoggedCycleRef.current=all.reduce((mx,v)=>v.cycle_ts>mx?v.cycle_ts:mx,"");
    fresh.slice(0,8).forEach(v=>{
      const col=v.vote==='APPROVE'?K.g:v.vote==='REJECT'?K.r:K.tx;
      log((v.agent??'').toUpperCase().slice(0,5),`[${v.symbol??''}] ${v.reason??''}`.slice(0,90),col);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[agentFeed]);

  // ── Supabase auth ─────────────────────────────────────────────────────
  const loadUserSession=async(userId:string)=>{
    if(sessionLoadedRef.current)return; // only load once per page — prevents SIGNED_IN firing on every token refresh
    sessionLoadedRef.current=true;
    const {data}=await supabase.from('kymia_sessions').select('*').eq('user_id',userId).single();
    if(data){
      // Restore swarmConfig so returning users skip onboarding
      if(data.swarm_config){
        setSwarmConfig(data.swarm_config);
        setHasShownOnboarding(true); // has config → skip onboarding on next ACTIVATE
      }
      // Portfolio state (pos/cash/equity) is loaded exclusively from kymia_agent_state below.
      // kymia_sessions is only used to restore swarm_config for onboarding skip.
      log('KYMIA',`◈ Welcome back! Session restored · ${data.total_trades||0} trades on record`,K.c);
    }
    // NEVER call setRunning(false) here — don't kill agents on token refresh
    // NEVER set hasShownOnboarding to false here — once shown, stays shown until logout
  };

  const getDynamicPositionSize=useCallback((conf:number,equity:number,profile:string,leverage:number):{leveragedSize:number,baseAlloc:number,conviction:string}=>{
    const BASE:Record<string,number>={safe:0.04,balanced:0.06,aggressive:0.08};
    const base=BASE[profile]??0.06;
    let multiplier=1.0;
    if(conf>=93)multiplier=4.0;
    else if(conf>=86)multiplier=3.0;
    else if(conf>=79)multiplier=2.0;
    else if(conf>=71)multiplier=1.5;
    const sized=equity*base*multiplier*leverage;
    const maxSize=equity*0.25;
    const leveragedSize=Math.min(sized,maxSize);
    const baseAlloc=leveragedSize/Math.max(leverage,1);
    const conviction=conf>=93?'🔥 MAXIMUM CONVICTION':conf>=86?'⚡ HIGH CONVICTION':conf>=79?'◈ STRONG SIGNAL':conf>=71?'◉ GOOD SIGNAL':'· STANDARD';
    log('AEGIS',`◈ Position size: ${(leveragedSize/equity*100).toFixed(1)}% | Conf ${conf}% × ${multiplier}x mult × ${leverage}x lev`,K.gold);
    return{leveragedSize,baseAlloc,conviction};
  },[log]);

  const saveSession=useCallback(async()=>{
    if(!user)return;
    const closed=tradesRef.current.filter((t:Trade)=>t.pnl!==0);
    const wins=closed.filter((t:Trade)=>t.pnl>0);
    await supabase.from('kymia_sessions').upsert({
      user_id:user.id,
      profile:swarmConfig?.profile||'balanced',
      leverage:swarmConfig?.leverage||3,
      total_trades:closed.length,
      winning_trades:wins.length,
      total_pnl:closed.reduce((s:number,t:Trade)=>s+t.pnl,0),
      best_trade:Math.max(0,...closed.map((t:Trade)=>t.pnl)),
      swarm_config:swarmConfig,
      last_session:new Date().toISOString()
    },{onConflict:'user_id'});
  },[user,swarmConfig]);

  // saveTrade removed — trades written exclusively by /api/agents/cycle (server-side)

  // saveOpenPositions removed — positions/equity/cash owned exclusively by kymia_agent_state

  useEffect(()=>{
    // Guard: skip all auth calls if real Supabase credentials are absent.
    // NEXT_PUBLIC_SUPABASE_ANON_KEY is embedded at build time — if it resolves
    // to the placeholder value, auth requests would fail against a non-existent host.
    const hasRealCreds=!!(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY&&process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!=='placeholder-anon-key');
    if(!hasRealCreds)return;   // anonymous session — page renders normally, no DB calls

    // handle OAuth redirect — Supabase puts access_token in URL hash
    const hash=window.location.hash;
    if(hash&&hash.includes('access_token')){
      supabase.auth.getSession().then(({data:{session}})=>{
        if(session?.user){
          setUser(session.user);
          loadUserSession(session.user.id);
          window.history.replaceState({},'','/nexus');
        }
      });
    }else{
      supabase.auth.getSession().then(({data:{session}})=>{
        setUser(session?.user||null);
        if(session?.user)loadUserSession(session.user.id);
      });
    }
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      setUser(session?.user||null);
      if(event==='SIGNED_IN'&&session?.user){
        loadUserSession(session.user.id);
        log('KYMIA',`◈ Welcome ${session.user.email?.split('@')[0]}! Session restored.`,K.c);
      }
    });
    return()=>subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Save trade stats to kymia_sessions every 60s while running ──────────
  useEffect(()=>{
    if(!user||!running)return;
    const iv=setInterval(()=>{saveSession();},60000);
    return()=>clearInterval(iv);
  },[user,running,saveSession]);

  // ── Server-side agent state: initial load from kymia_agent_state ────────
  useEffect(()=>{
    if(!user)return;
    const loadState=async()=>{
      const{data}=await supabase.from('kymia_agent_state').select('*').eq('user_id',user.id).single();
      if(data){
        const existingPositions=data.positions||{};
        // Mark ALL existing positions as already seen so cinematic doesn't fire on reload
        Object.keys(existingPositions).forEach(sym=>{
          prevPositionSyms.current.add(sym);
          cinematicShown.current.add(sym);
        });
        setPort({equity:data.equity||CAP,cash:data.cash||CAP,pos:existingPositions,peak:Math.max(data.equity||CAP,CAP)});
        setRunning(data.running||false);
        if(data.swarm_config){setSwarmConfig(data.swarm_config);setHasShownOnboarding(true);}
      }
      const{data:tradesData}=await supabase.from('kymia_trades').select('*').eq('user_id',user.id).order('closed_at',{ascending:false}).limit(20);
      if(tradesData)setTrades(tradesData.map((t:any)=>({
        id:t.id,sym:t.sym,side:t.side||'LONG',qty:t.qty||0,
        entry:t.entry||0,price:t.exit||t.entry||0,pnl:t.pnl||0,pct:t.pct||0,conf:80,
        t:t.closed_at?new Date(t.closed_at).toLocaleTimeString('en-US',{hour12:false}):ts(),
        ms:t.closed_at?new Date(t.closed_at).getTime():Date.now(),
        agent:t.agent||'KYMIA',
      })));
      // Fetch all-time aggregate stats via SQL — avoids loading every row into state
      const{data:statsData}=await supabase.rpc('get_trade_stats',{p_user_id:user.id});
      if(statsData)setAllTimeStats({totalTrades:statsData.total_trades||0,wins:statsData.wins||0,totalPnl:statsData.total_pnl||0});
    };
    loadState();
  },[user]);

  // ── Supabase realtime: mirror server agent state to UI ───────────────────
  useEffect(()=>{
    if(!user)return;
    const stateChannel=supabase.channel('agent-state')
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'kymia_agent_state',filter:`user_id=eq.${user.id}`},payload=>{
        const s=payload.new as any;
        setPort({equity:s.equity,cash:s.cash,pos:s.positions||{},peak:Math.max(s.equity,CAP)});
        setRunning(s.running);
      })
      .subscribe();
    const signalChannel=supabase.channel('agent-signals')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'kymia_signals',filter:`user_id=eq.${user.id}`},payload=>{
        const s=payload.new as any;
        setAgSt(prev=>({...prev,[s.agent_id]:{...prev[s.agent_id],sig:s.signal,conf:s.confidence,th:s.reasoning,on:true,real:true}}));
        log((s.agent_id??'').toUpperCase(),s.reasoning??'',s.signal==='BUY'?K.g:s.signal==='SELL'?K.r:K.dim);
      })
      .subscribe();
    const tradeChannel=supabase.channel('agent-trades')
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'kymia_trades',filter:`user_id=eq.${user.id}`},payload=>{
        const raw=payload.new as any;
        const trade:Trade={
          id:raw.id,sym:raw.sym,side:raw.side||'LONG',qty:raw.qty||0,
          entry:raw.entry||0,price:raw.exit||raw.entry||0,pnl:raw.pnl||0,pct:raw.pct||0,conf:80,
          t:raw.closed_at?new Date(raw.closed_at).toLocaleTimeString('en-US',{hour12:false}):ts(),
          ms:raw.closed_at?new Date(raw.closed_at).getTime():Date.now(),
          agent:raw.agent||'KYMIA',
        };
        setTrades(prev=>[trade,...prev.slice(0,99)]);
        // Refresh all-time stats so TOTAL TRADES / WIN RATE stay accurate after each close
        supabase.rpc('get_trade_stats',{p_user_id:user.id}).then(({data})=>{
          if(data)setAllTimeStats({totalTrades:data.total_trades||0,wins:data.wins||0,totalPnl:data.total_pnl||0});
        });
        // Show win/loss popup card
        const card:WinCard={id:Math.random().toString(36).slice(2),sym:trade.sym,pnl:trade.pnl,pct:trade.pct||0,price:trade.price,agent:trade.agent||'KYMIA',t:trade.t};
        setWinCards(prev=>[...prev.slice(-1),card]);
        log('AEGIS',`${trade.pnl>=0?'▲ PROFIT':'▼ LOSS'}: ${trade.sym} ${trade.pnl>=0?'+':''}$${f2(trade.pnl)}`,trade.pnl>=0?K.g:K.r);
      })
      .subscribe();
    return()=>{stateChannel.unsubscribe();signalChannel.unsubscribe();tradeChannel.unsubscribe();};
  },[user,log]);

  // ── Client-side agent polling (Hobby plan — no Vercel Cron) ─────────────────
  useEffect(()=>{
    if(!user||!running)return;
    const runCycle=async()=>{
      try{await fetch('/api/agents/cycle');}
      catch(e){console.log('Cycle error:',e);}
    };
    runCycle();
    const CYCLE_INTERVAL = 45000 // 45 seconds
    const iv=setInterval(runCycle,CYCLE_INTERVAL);
    return()=>clearInterval(iv);
  },[user,running]);

  // ── Cinematic chart: detect new positions from server ────────────────────────
  useEffect(()=>{
    const currentSyms=Object.keys(port.pos);
    // Trigger cinematic for genuinely new positions only
    currentSyms.forEach(sym=>{
      if(
        !prevPositionSyms.current.has(sym)&&
        !cinematicShown.current.has(sym)&&
        (port.pos[sym] as any)?.avg>0
      ){
        cinematicShown.current.add(sym);
        setTimeout(()=>{
          setCinematicTrade({sym,pos:port.pos[sym]});
        },500);
      }
    });
    // Add current syms to prev tracker (never remove during session)
    currentSyms.forEach(sym=>prevPositionSyms.current.add(sym));
    // Clear cinematic cache when position closes so re-entry on same sym works
    prevPositionSyms.current.forEach(sym=>{
      if(!currentSyms.includes(sym)){
        prevPositionSyms.current.delete(sym);
        cinematicShown.current.delete(sym);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[port.pos]);

  // ── Part 12: Demo/live scan intervals ────────────────────────────────
  const isDemoMode=!isLive;
  const SCAN_INTERVALS={
    regime:isDemoMode?300000:1800000,
    top50:isDemoMode?300000:1800000,
    newTokens:isDemoMode?120000:300000,
    core:15000,
    signals:15000,
  };

  // ── Part 11: Layer 3 config ──────────────────────────────────────────
  const LAYER3_CONFIG=layer3Aggressive?{minSafety:55,minMomentum:50,maxAlloc:0.06,watchlistTime:300000,label:'AGGRESSIVE',col:'#FF3366'}:{minSafety:70,minMomentum:65,maxAlloc:0.03,watchlistTime:900000,label:'CONSERVATIVE',col:'#00FF88'};

  // ── Part 2: Regime detection interval ────────────────────────────────
  useEffect(()=>{
    if(!running)return;
    const run=()=>detectRegime(log).then(s=>{setRegimeState(s);regimeRef.current=s;});
    run();
    const iv=setInterval(run,SCAN_INTERVALS.regime);
    return()=>clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running]);

  // ── Part 6: Confidence decay every 30s ──────────────────────────────
  useEffect(()=>{
    const iv=setInterval(()=>{
      setActiveSignals(prev=>prev.map(sig=>{
        const ageMin=(Date.now()-sig.createdAt)/60000;
        const decayPct=ageMin*DECAY_RATE;
        const currentConf=Math.max(0,sig.initialConf-decayPct);
        return{...sig,currentConf,ageSeconds:Math.round((Date.now()-sig.createdAt)/1000),decayPct,expired:currentConf<50||(Date.now()-sig.createdAt)>SIGNAL_EXPIRY};
      }).filter(s=>!s.expired));
    },30000);
    return()=>clearInterval(iv);
  },[]);

  // ── Part 5: logRejection helper ──────────────────────────────────────
  const logRejection=useCallback((sym:string,conf:number,reasons:string[])=>{
    const estimatedLoss=portRef.current.equity*0.025;
    setRejectedTrades(prev=>[{sym,confidence:conf,reasons,timestamp:new Date().toLocaleTimeString(),capitalProtected:estimatedLoss},...prev].slice(0,10));
    setRejectionStats(prev=>({...prev,rejected:prev.rejected+1,capitalProtected:prev.capitalProtected+estimatedLoss}));
    log('AEGIS',`⛔ REJECTED: ${sym} (${conf}%) — ${reasons[0]}`,K.r);
  },[log]);

  // ── Part 8: trackMissed helper ───────────────────────────────────────
  const trackMissed=useCallback((sym:string,signal:string,reason:string)=>{
    const entryPrice=pricesRef.current[sym]?.price||0;
    setTimeout(()=>{
      const currentPrice=pricesRef.current[sym]?.price||entryPrice;
      const move=signal==='BUY'?(currentPrice-entryPrice)/entryPrice*100:(entryPrice-currentPrice)/entryPrice*100;
      const wasRightToSkip=move<=0;
      setMissedOpps(prev=>[{sym,move:parseFloat(move.toFixed(1)),reason,timestamp:new Date().toLocaleTimeString(),wasRightToSkip},...prev].slice(0,5));
      log('WATCH',`${wasRightToSkip?'✓ Good skip':'⚠ Missed'}: ${sym} moved ${move>0?'+':''}${move.toFixed(1)}% after rejection`,wasRightToSkip?K.g:K.gold);
    },1800000);
  },[log]);

  // Live user counter fluctuation
  useEffect(()=>{
    const iv=setInterval(()=>setLiveUsers(u=>u+(Math.random()<.5?1:-1)*Math.ceil(Math.random()*3)),8000);
    return()=>clearInterval(iv);
  },[]);

  // Black swan user spike
  useEffect(()=>{if(blackSwan)setLiveUsers(u=>u+340);},[blackSwan]);

  // Conviction pulse log banner
  const prevConvRef=useRef(false);
  useEffect(()=>{
    const active=AGENTS.filter(a=>a.id!=="consensus"&&agSt[a.id]?.on&&agSt[a.id]?.sig);
    const buy=active.filter(a=>agSt[a.id].sig==="BUY").length;
    const sell=active.filter(a=>agSt[a.id].sig==="SELL").length;
    const total=active.length||1;
    const bP=Math.round(buy/total*100),sP=Math.round(sell/total*100);
    const isHigh=bP>72||sP>72;
    if(isHigh&&!prevConvRef.current){
      const dom=bP>sP?"BUY":"SELL";const col=dom==="BUY"?K.g:K.r;
      log("CONV",`⚡ HIGH CONVICTION — ${active.length} agents ${dom} ${Math.max(bP,sP)}%`,col);
    }
    prevConvRef.current=isHigh;
  },[agSt,log]);

  // ── Real agent data fetch (30s cycle) ────────────────────────────────
  const calcEMA=(prices:number[],period:number):number=>{
    if(prices.length<period)return prices[prices.length-1]||0;
    const k=2/(period+1);let ema=prices[0];
    for(let i=1;i<prices.length;i++)ema=prices[i]*k+ema*(1-k);
    return ema;
  };
  const runRealAgents=useCallback(async()=>{
    const updates:{[k:string]:Partial<AgentState>}={};
    // Track latencies for WATCH agent
    const lat:{name:string,ms:number}[]=[];
    const tf=async(name:string,url:string)=>{const t=performance.now();const r=await fetch(url);lat.push({name,ms:Math.round(performance.now()-t)});return r;};
    console.group("[KYMIA] runRealAgents — "+new Date().toISOString());

    // ── 7 existing agents ─────────────────────────────────────────────────────
    // LEVIATHAN: DexScreener whale buy pressure
    try{
      const r=await tf("DEX-LVTH","/api/dexscreener?type=whale&pair=So11111111111111111111111111111111111111112");
      const d=await r.json();
      const bp:number=d.buyPressure??0.5;
      // Tightened: 0.65 (was 0.62) — only strong whale conviction
      const sig=bp>0.65?"BUY":bp<0.35?"SELL":"HOLD";
      const conf=Math.round(60+bp*40);
      console.log("[LEVIATHAN] buyPressure="+bp.toFixed(3)+" → SIG:"+sig+" CONF:"+conf);
      updates["leviathan"]={sig,conf,real:true,th:`DEX buy pressure: ${(bp*100).toFixed(0)}%\nVol 24h: $${(d.volume24h/1e6).toFixed(2)}M\n${bp>0.65?"Whale accumulation":"Whale distribution"}`};
      setDataStatus(s=>({...s,lastUpdate:Date.now()}));
    }catch(e){console.error("[LEVIATHAN] FAILED",e);updates["leviathan"]={real:false};}

    // LENS: Kraken RSI(14) 1m
    try{
      const r=await tf("Kraken-RSI","/api/market?type=rsi");
      const d=await r.json();
      const closes:number[]=(d.data||[]).map((c:unknown[])=>parseFloat(String(c[4])));
      const rsi=calcRSI(closes,14);
      // Tightened: RSI<35 BUY (was <40), RSI>68 SELL (was >65) — extreme zones only
      const sig=rsi<35?"BUY":rsi>68?"SELL":"HOLD";
      const conf=Math.round(50+Math.abs(rsi-50)*0.9);
      console.log("[LENS] RSI(14)="+rsi.toFixed(2)+" candles="+closes.length+" → SIG:"+sig+" CONF:"+conf);
      updates["lens"]={sig,conf,real:true,th:`Kraken RSI(14): ${rsi.toFixed(1)}\n${rsi<35?"Extreme oversold — BUY":rsi>68?"Extreme overbought — SELL":"Neutral zone (35–68)"}\n1m candles: ${closes.length}`};
      setDataStatus(s=>({...s,binance:"ok",lastUpdate:Date.now()}));
    }catch(e){console.error("[LENS] FAILED",e);updates["lens"]={real:false};setDataStatus(s=>({...s,binance:"err"}));}

    // SURGE: CoinGecko 24h volume/price
    try{
      const r=await tf("CGK-Vol","/api/market?type=volume");
      const d=await r.json();
      const change=parseFloat(d.data?.priceChangePercent||"0");
      const vol=parseFloat(d.data?.volume||"0");
      // Tightened: >5% change (was >3%) — only strong volume breakouts
      const sig=change>5&&vol>1e6?"BUY":change<-5?"SELL":"HOLD";
      const conf=Math.round(55+Math.min(Math.abs(change)*3,40));
      console.log("[SURGE] change="+change.toFixed(2)+"% vol="+vol.toFixed(0)+" → SIG:"+sig+" CONF:"+conf);
      updates["surge"]={sig,conf,real:true,th:`24h change: ${change>0?"+":""}${change.toFixed(2)}%\nVolume: ${(vol/1e3).toFixed(0)}K SOL\nHigh: $${parseFloat(d.data?.highPrice||"0").toFixed(2)}`};
    }catch(e){console.error("[SURGE] FAILED",e);updates["surge"]={real:false};}

    // ATLAS: CoinGecko BTC dominance
    try{
      const r=await tf("CGK-Dom","/api/market?type=dominance");
      const d=await r.json();
      const dom:number=d.btcDom??50;
      const sig=dom>58?"SELL":dom<48?"BUY":"HOLD";
      const conf=Math.round(50+Math.abs(dom-53)*1.2);
      console.log("[ATLAS] btcDom="+dom.toFixed(2)+"% → SIG:"+sig+" CONF:"+conf);
      updates["atlas"]={sig,conf,real:true,th:`BTC dominance: ${dom.toFixed(1)}%\n${dom>58?"Alt risk-off — reduce exposure":dom<48?"Alt season — risk-on":"Neutral macro regime"}`};
      setDataStatus(s=>({...s,coingecko:"ok",lastUpdate:Date.now()}));
    }catch(e){console.error("[ATLAS] FAILED",e);updates["atlas"]={real:false};setDataStatus(s=>({...s,coingecko:"err"}));}

    // ECHO: Fear & Greed
    try{
      const r=await tf("F&G","/api/market?type=fear");
      const d=await r.json();
      const fng:number=d.value??50;
      // Tightened: extreme fear <25 BUY (was <30), extreme greed >80 SELL (was >75)
      const sig=fng<25?"BUY":fng>80?"SELL":"HOLD";
      const conf=Math.round(45+Math.abs(fng-50)*0.8);
      console.log("[ECHO] F&G="+fng+" ("+d.label+") → SIG:"+sig+" CONF:"+conf);
      updates["echo"]={sig,conf,real:true,th:`Fear & Greed: ${fng} (${d.label||"Neutral"})\n${fng<30?"Extreme Fear — contrarian BUY":fng>75?"Extreme Greed — reduce exposure":"Sentiment neutral"}`};
    }catch(e){console.error("[ECHO] FAILED",e);updates["echo"]={real:false};}

    // RADAR: Kraken EMA 9/21 5m crossover
    try{
      const r=await tf("Kraken-EMA","/api/market?type=ema");
      const d=await r.json();
      const closes5m:number[]=(d.data||[]).map((c:unknown[])=>parseFloat(String(c[4])));
      const ema9=calcEMA(closes5m,9),ema21=calcEMA(closes5m,21);
      // Only signal if EMA gap ≥0.3% — filters out choppy micro-crossovers
      const emaGap=Math.abs(ema9-ema21)/ema21*100;
      const cross=emaGap>=0.3?(ema9>ema21?"BUY":ema9<ema21?"SELL":"HOLD"):"HOLD";
      const conf=Math.round(60+Math.abs(ema9-ema21)/ema21*5000);
      console.log("[RADAR] EMA9="+ema9.toFixed(4)+" EMA21="+ema21.toFixed(4)+" → SIG:"+cross+" CONF:"+conf);
      updates["radar"]={sig:cross,conf,real:true,th:`EMA9: $${ema9.toFixed(2)} | EMA21: $${ema21.toFixed(2)}\n${ema9>ema21?"Bullish crossover ▲":"Bearish crossover ▼"}\n5m candles: ${closes5m.length}`};
    }catch(e){console.error("[RADAR] FAILED",e);updates["radar"]={real:false};}

    // SHIELD: DexScreener order book proxy
    try{
      const r=await tf("DEX-Depth","/api/market?type=depth");
      const d=await r.json();
      const bids:(string[])[]=(d.data?.bids||[]).slice(0,10);
      const asks:(string[])[]=(d.data?.asks||[]).slice(0,10);
      const bidVol=bids.reduce((s:number,b:string[])=>s+parseFloat(b[1])*parseFloat(b[0]),0);
      const askVol=asks.reduce((s:number,a:string[])=>s+parseFloat(a[1])*parseFloat(a[0]),0);
      const ratio=bidVol/(bidVol+askVol||1);
      const sig=ratio>0.6?"BUY":ratio<0.4?"SELL":"HOLD";
      const conf=Math.round(50+Math.abs(ratio-0.5)*80);
      console.log("[SHIELD] bidVol=$"+bidVol.toFixed(0)+" askVol=$"+askVol.toFixed(0)+" ratio="+ratio.toFixed(3)+" → SIG:"+sig+" CONF:"+conf);
      updates["shield"]={sig,conf,real:true,th:`Bid wall: $${(bidVol/1e3).toFixed(0)}K\nAsk wall: $${(askVol/1e3).toFixed(0)}K\nImbalance: ${(ratio*100).toFixed(0)}% bids`};
    }catch(e){console.error("[SHIELD] FAILED",e);updates["shield"]={real:false};}

    // ── 10 new agents ─────────────────────────────────────────────────────────
    // ORACLE: Kraken recent trades — real order flow
    try{
      const r=await tf("Kraken-Flow","/api/market?type=orderflow");
      const d=await r.json();
      const bp:number=d.buyPressure??0.5;
      const sig=bp>0.58?"BUY":bp<0.42?"SELL":"HOLD";
      const conf=Math.round(50+Math.abs(bp-0.5)*100);
      console.log("[ORACLE] buyPressure="+bp.toFixed(3)+" ("+d.tradeCount+" trades) → SIG:"+sig+" CONF:"+conf);
      updates["oracle"]={sig,conf,real:true,th:`Order flow (${d.tradeCount} trades)\nBuy vol: ${(d.buyVol||0).toFixed(2)} SOL\nSell vol: ${(d.sellVol||0).toFixed(2)} SOL\nFlow bias: ${(bp*100).toFixed(0)}% buy`};
    }catch(e){console.error("[ORACLE] FAILED",e);updates["oracle"]={real:false};}

    // PHANTOM: Deribit futures — OI + funding rate
    try{
      const r=await tf("Deribit","/api/market?type=options");
      const d=await r.json();
      const fr:number=d.fundingRate??0;
      const oi:number=d.openInterest??0;
      // Positive funding = longs paying = crowded longs = SELL risk
      // Negative funding = shorts paying = crowded shorts = BUY opportunity
      const sig=fr<-0.0003?"BUY":fr>0.0003?"SELL":"HOLD";
      const conf=Math.round(50+Math.min(Math.abs(fr)*100000,40));
      console.log("[PHANTOM] fundingRate="+fr.toFixed(6)+" OI="+oi.toFixed(0)+" → SIG:"+sig+" CONF:"+conf);
      updates["phantom"]={sig,conf,real:true,th:`Deribit index: $${(d.indexPrice||0).toFixed(2)}\nOpen interest: ${(oi/1e6).toFixed(2)}M\nFunding 8h: ${(fr*100).toFixed(4)}%\n${fr<0?"Shorts paying — squeeze risk":"Longs paying — cascade risk"}`};
    }catch(e){console.error("[PHANTOM] FAILED",e);updates["phantom"]={real:false};}

    // TITAN: SMA50 vs SMA200 market regime
    try{
      const r=await tf("Kraken-SMA","/api/market?type=sma");
      const d=await r.json();
      const regime:string=d.regime??"neutral";
      const sig=regime==="bull"?"BUY":regime==="bear"?"SELL":"HOLD";
      const dist=Math.abs(((d.sma50||0)-(d.sma200||1))/(d.sma200||1)*100);
      const conf=Math.round(60+Math.min(dist*3,35));
      console.log("[TITAN] regime="+regime+" SMA50="+d.sma50?.toFixed(2)+" SMA200="+d.sma200?.toFixed(2)+" → SIG:"+sig+" CONF:"+conf);
      updates["titan"]={sig,conf,real:true,th:`Macro regime: ${regime.toUpperCase()}\nSMA50: $${(d.sma50||0).toFixed(2)}\nSMA200: $${(d.sma200||0).toFixed(2)}\n${regime==="bull"?"Golden cross — bull market":"Death cross — bear market"}`};
    }catch(e){console.error("[TITAN] FAILED",e);updates["titan"]={real:false};}

    // HYDRA: liquidation pressure (CoinGlass → Deribit proxy fallback)
    try{
      const r=await tf("Liq","/api/market?type=liquidations");
      const d=await r.json();
      const ratio:number=d.ratio??0.5;
      // ratio > 0.5 = more long liquidations = bearish pressure
      const sig=ratio>0.65?"SELL":ratio<0.35?"BUY":"HOLD";
      const conf=Math.round(50+Math.abs(ratio-0.5)*80);
      console.log("[HYDRA] liquidationRatio="+ratio.toFixed(3)+" source="+d.source+" → SIG:"+sig+" CONF:"+conf);
      updates["hydra"]={sig,conf,real:true,th:`Source: ${d.source||"deribit-proxy"}\nLong liqs: $${((d.longLiqs||0)/1e3).toFixed(1)}K\nShort liqs: $${((d.shortLiqs||0)/1e3).toFixed(1)}K\n${ratio>0.5?"Long cascade risk":"Short squeeze risk"}`};
    }catch(e){console.error("[HYDRA] FAILED",e);updates["hydra"]={real:false};}

    // DELTA: Jupiter vs Raydium arbitrage spread
    try{
      const r=await tf("Arb","/api/market?type=arb");
      const d=await r.json();
      const spread:number=d.spreadPct??0;
      // spread > 0 = Raydium more expensive than Jupiter → sell on Raydium, buy on Jupiter
      const sig=spread>0.3?"BUY":spread<-0.3?"SELL":"HOLD";
      const conf=Math.round(50+Math.min(Math.abs(spread)*50,45));
      console.log("[DELTA] kraken=$"+d.krakenPrice?.toFixed(4)+" ray=$"+d.raydiumPrice?.toFixed(4)+" spread="+spread.toFixed(4)+"% → SIG:"+sig+" CONF:"+conf);
      updates["delta"]={sig,conf,real:true,th:`Kraken (CEX): $${(d.krakenPrice||0).toFixed(4)}\nRaydium (DEX): $${(d.raydiumPrice||0).toFixed(4)}\nSpread: ${spread>0?"+":""}${spread.toFixed(4)}%\n${Math.abs(spread)>0.3?"CEX/DEX arb opportunity":"Prices converged"}`};
    }catch(e){console.error("[DELTA] FAILED",e);updates["delta"]={real:false};}

    // RAZOR: 1m RSI + MACD scalping signal
    try{
      const r=await tf("Kraken-MACD","/api/market?type=macd");
      const d=await r.json();
      const rsi:number=d.rsi??50;
      const hist:number=d.histogram??0;
      const cross:string=d.macdCross??"none";
      // BUY: RSI recovering (<55) + MACD bullish cross
      // SELL: RSI elevated (>55) + MACD bearish cross
      const sig=rsi<55&&(cross==="bullish"||hist>0)&&rsi>30?"BUY":rsi>55&&(cross==="bearish"||hist<0)?"SELL":"HOLD";
      const conf=Math.round(55+Math.min(Math.abs(hist)*500,35));
      console.log("[RAZOR] RSI="+rsi.toFixed(1)+" MACD="+d.macd?.toFixed(4)+" hist="+hist.toFixed(4)+" cross="+cross+" → SIG:"+sig+" CONF:"+conf);
      updates["razor"]={sig,conf,real:true,th:`RSI(14): ${rsi.toFixed(1)} | MACD cross: ${cross}\nMACD: ${(d.macd||0).toFixed(4)}\nSignal: ${(d.signal||0).toFixed(4)}\nHistogram: ${hist>0?"+":""}${hist.toFixed(4)}`};
    }catch(e){console.error("[RAZOR] FAILED",e);updates["razor"]={real:false};}

    // VECTOR: ADX trend strength
    try{
      const r=await tf("Kraken-ADX","/api/market?type=adx");
      const d=await r.json();
      const adx:number=d.adx??25;
      const trendDir:string=d.trendDir??"up";
      const strength:string=d.trendStrength??"WEAK";
      // Strong trend (ADX>25) + direction gives signal; weak trend = HOLD
      const sig=adx>25&&trendDir==="up"?"BUY":adx>25&&trendDir==="down"?"SELL":"HOLD";
      const conf=Math.round(50+Math.min(adx,50));
      console.log("[VECTOR] ADX="+adx.toFixed(1)+" +DI="+d.plusDI?.toFixed(1)+" -DI="+d.minusDI?.toFixed(1)+" → SIG:"+sig+" CONF:"+conf);
      updates["vector"]={sig,conf,real:true,th:`ADX(14): ${adx.toFixed(1)} — ${strength}\n+DI: ${(d.plusDI||0).toFixed(1)} | -DI: ${(d.minusDI||0).toFixed(1)}\nTrend: ${trendDir.toUpperCase()} | SMA20: $${(d.sma20||0).toFixed(2)}\n${adx>25?"Trend confirmed":"Choppy — no clear trend"}`};
    }catch(e){console.error("[VECTOR] FAILED",e);updates["vector"]={real:false};}

    // NEURAL: client-side win/loss pattern from session trades
    try{
      const closed=tradesRef.current.filter((t:Trade)=>t.pnl!==0);
      const last50=closed.slice(-50);
      const last10=closed.slice(-10);
      const wr10=last10.length>0?last10.filter((t:Trade)=>t.pnl>0).length/last10.length*100:50;
      const wins=last50.filter((t:Trade)=>t.pnl>0);
      const losses=last50.filter((t:Trade)=>t.pnl<0);
      const avgWin=wins.length>0?wins.reduce((s:number,t:Trade)=>s+t.pnl,0)/wins.length:0;
      const avgLoss=losses.length>0?Math.abs(losses.reduce((s:number,t:Trade)=>s+t.pnl,0)/losses.length):1;
      const pf=avgWin/avgLoss;
      let streak=0;
      if(closed.length>0){
        const lastWin=closed[closed.length-1].pnl>0;
        for(let i=closed.length-1;i>=0;i--){
          if((closed[i].pnl>0)===lastWin)streak++;else break;
        }
      }
      const sig=wr10>60&&pf>1.2?"BUY":wr10<40||pf<0.8?"SELL":"HOLD";
      const conf=Math.round(50+Math.abs(wr10-50)*0.6);
      console.log("[NEURAL] WR10="+wr10.toFixed(0)+"% PF="+pf.toFixed(2)+"x streak="+streak+" → SIG:"+sig+" CONF:"+conf);
      updates["neural"]={sig,conf,real:true,th:`Rolling WR(10): ${wr10.toFixed(0)}%\nProfit factor: ${pf.toFixed(2)}x\n${last10.length>0?(closed[closed.length-1]?.pnl>0?"Win":"Loss")+" streak: "+streak:"Awaiting trades..."}`};
    }catch(e){console.error("[NEURAL] FAILED",e);updates["neural"]={real:false};}

    // WATCH: real latency monitor from actual API calls this cycle
    try{
      const avgMs=lat.reduce((s,l)=>s+l.ms,0)/(lat.length||1);
      const maxMs=lat.length>0?Math.max(...lat.map(l=>l.ms)):0;
      const slowest=lat.length>0?[...lat].sort((a,b)=>b.ms-a.ms)[0]:{name:"—",ms:0};
      const ok=lat.filter(l=>l.ms<800).length;
      const sig=maxMs<800?"BUY":maxMs>2000?"SELL":"HOLD"; // BUY = all systems nominal
      const conf=Math.round(Math.max(40,90-avgMs/20));
      console.log("[WATCH] avg="+Math.round(avgMs)+"ms max="+maxMs+"ms slowest="+slowest.name+" → SIG:"+sig+" CONF:"+conf);
      updates["watch"]={sig,conf,real:true,th:`${ok}/${lat.length} endpoints <800ms\nAvg: ${Math.round(avgMs)}ms | Max: ${maxMs}ms\nSlowest: ${slowest.name} ${slowest.ms}ms\n${maxMs<800?"All systems nominal":"Latency degraded"}`};
    }catch(e){console.error("[WATCH] FAILED",e);updates["watch"]={real:false};}

    // CONSENSUS: weighted aggregation of all 17 non-consensus agents
    try{
      // Merge updates with current agSt for agents not updated this cycle
      const merged:{[k:string]:Partial<AgentState>}={};
      for(const a of AGENTS){if(a.id!=="consensus")merged[a.id]={...agStRef.current[a.id],...(updates[a.id]||{})};}
      const active=Object.values(merged).filter(ag=>ag.sig&&ag.sig!==null);
      let buyW=0,sellW=0,totalW=0;
      for(const ag of active){
        const w=(ag.conf??50)/100;totalW+=w;
        if(ag.sig==="BUY")buyW+=w;else if(ag.sig==="SELL")sellW+=w;
      }
      const buyPct=totalW>0?buyW/totalW:0;
      const sellPct=totalW>0?sellW/totalW:0;
      const dir=buyPct>=sellPct?"BUY":"SELL";
      const agreePct=dir==="BUY"?buyPct:sellPct;
      // Raised consensus threshold: 75% (was 60%) — only high-conviction entries
      const sig=agreePct>=0.75?dir:"HOLD";
      const conf=Math.round(agreePct*100);
      console.log("[CONSENSUS] active="+active.length+" BUY="+Math.round(buyPct*100)+"% SELL="+Math.round(sellPct*100)+"% agree="+Math.round(agreePct*100)+"% → SIG:"+sig+" CONF:"+conf);
      updates["consensus"]={sig,conf,real:true,on:true,th:`${active.length}/17 agents reporting\nBUY weight: ${Math.round(buyPct*100)}% | SELL: ${Math.round(sellPct*100)}%\nAgreement: ${Math.round(agreePct*100)}%\n${sig==="HOLD"?"No consensus (need 75%+)":dir+" consensus confirmed"}`};
    }catch(e){console.error("[CONSENSUS] FAILED",e);updates["consensus"]={real:false};}

    // Apply all updates + track last-active timestamps
    const now=Date.now();
    for(const id of Object.keys(updates)){agentLastActiveRef.current[id]=now;}
    console.log("[KYMIA] All agents:",Object.fromEntries(Object.entries(updates).map(([k,v])=>[k,{sig:v.sig,conf:v.conf,real:v.real}])));
    console.groupEnd();
    setAgSt(prev=>{
      const n={...prev};
      for(const[id,u] of Object.entries(updates)){
        if(n[id])n[id]={...n[id],...u};
      }
      return n;
    });
    setSignalCount(n=>n+Object.keys(updates).length);
  },[]);

  useEffect(()=>{
    let active=true;
    const continuousLoop=async()=>{
      while(active){
        try{
          await runRealAgents();
          await new Promise(r=>setTimeout(r,15000));
        }catch(e){
          console.error("[KYMIA] Agent loop error:",e);
          await new Promise(r=>setTimeout(r,5000));
        }
      }
    };
    continuousLoop();
    return()=>{active=false;};
  },[runRealAgents]);

  // ── New token scanner (60s cycle) ─────────────────────────────────────
  const scanNewTokens=useCallback(async()=>{
    setScannerLoading(true);
    try{
      const r=await fetch("/api/dexscreener?type=new-tokens");
      const d=await r.json();
      if(d.pairs)setNewTokens(d.pairs);
    }catch{}finally{setScannerLoading(false);}
  },[]);

  useEffect(()=>{
    scanNewTokens();
    const iv=setInterval(scanNewTokens,60000);
    return()=>clearInterval(iv);
  },[scanNewTokens]);


  useEffect(()=>{
    setPort(p=>{
      let eq=p.cash;
      for(const[s,pos]of Object.entries(p.pos)){
        const cur=prices[s]?.price||pos.avg;
        if(pos.side==="SHORT"){
          // SHORT: collateral (avg*qty) + unrealised P&L
          eq+=pos.avg*pos.qty+(pos.avg-cur)*pos.qty;
        }else{
          eq+=pos.qty*cur;
        }
      }
      return{...p,equity:eq,peak:Math.max(p.peak,eq)};
    });
  },[prices]);

  useEffect(()=>{setBlackSwan(Object.values(prices).filter((d)=>Math.abs((d as PriceData).change)>8).length>=2);},[prices]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTo({top:logRef.current.scrollHeight,behavior:"smooth"});},[logs]);

  // SL/TP/trailing now handled server-side by /api/agents/cycle (Vercel Cron)

  // ── Live close via Jupiter + performance fee ─────────────────────────────────
  // Returns true if the on-chain tx succeeded; false → caller should apply demo fallback.
  // SHORT positions are SPOT-only — no live shorts, so this only handles LONGs.
  // Requires @solana/web3.js to be installed for VersionedTransaction deserialization.
  // Without it, closeLiveTrade falls back to passing the raw Buffer to signTransaction;
  // Phantom v2+ accepts Uint8Array but behaviour may vary — install the package for prod.
  const performLiveClose=useCallback(async(
    sym:string,pos:{avg:number,qty:number,leverage?:number},
    exitPrice:number,
  ):Promise<boolean>=>{
    if(!isLive||!walletAddress)return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ph=(window as any).phantom?.solana;
    if(!ph)return false;
    const mint=(SYMS as Record<string,{mint:string}>)[sym]?.mint;
    if(!mint){log("KYMIA","⚠ No mint for "+sym+" — skipping live close",K.r);return false;}
    const decimals=TOKEN_DECIMALS[sym]??6;
    const rawAmt=Math.round(pos.qty*Math.pow(10,decimals));
    const entryUsd=pos.avg*pos.qty;
    const exitUsd=exitPrice*pos.qty;
    try{
      const {PublicKey:PK}=await import("@solana/web3.js");
      const result=await closeLiveTrade({
        wallet:new PK(walletAddress),
        inputMint:mint,
        outputMint:USDC_MINT,
        amount:rawAmt,
        entryValueUsd:entryUsd,
        exitValueUsd:exitUsd,
        feePercent,
        log:(msg:string)=>log("KYMIA",msg,K.gold),
        signTransaction:async(tx)=>{
          // Phantom's signTransaction accepts VersionedTransaction directly
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return ph.signTransaction(tx) as Promise<typeof tx>;
        },
        sendAndConfirm:async(signedTx)=>{
          // Serialize → base64 → Solana JSON-RPC sendTransaction
          const raw=signedTx.serialize();
          const b64=Buffer.from(raw).toString("base64");
          const sendRes=await fetch("https://api.mainnet-beta.solana.com",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({jsonrpc:"2.0",id:1,method:"sendTransaction",
              params:[b64,{encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed"}]}),
          });
          const sendData=await sendRes.json() as {result?:string,error?:{message:string}};
          if(sendData.error)throw new Error(sendData.error.message);
          const sig=sendData.result!;
          // Poll getSignatureStatuses until confirmed or 60s timeout
          for(let i=0;i<30;i++){
            await new Promise(r=>setTimeout(r,2000));
            const pollRes=await fetch("https://api.mainnet-beta.solana.com",{
              method:"POST",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSignatureStatuses",
                params:[[sig],{searchTransactionHistory:true}]}),
            });
            const pollData=await pollRes.json() as {result?:{value?:Array<{confirmationStatus?:string,err?:unknown}>}};
            const st=pollData?.result?.value?.[0];
            if(st&&(st.confirmationStatus==="confirmed"||st.confirmationStatus==="finalized"))return sig;
            if(st?.err)throw new Error("tx failed: "+JSON.stringify(st.err));
          }
          throw new Error("confirmation timeout (60s)");
        },
      });
      setTotalFeesPaid(p=>p+result.feeAmountUsd);
      if(result.feeAmountUsd>0)setHighWaterMark(hm=>Math.max(hm,exitUsd));
      setPort(prev=>{const p2={...prev.pos};delete p2[sym];return{...prev,cash:prev.cash+exitUsd,pos:p2};});
      log("KYMIA","◈ "+sym+" closed on-chain · tx: "+result.txSignature.slice(0,8)+"...",K.g);
      return true;
    }catch(e:unknown){
      const msg=e instanceof Error?e.message:String(e);
      log("KYMIA","⚠ Live close failed ("+sym+"): "+msg+" — applying demo fallback",K.r);
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[isLive,walletAddress,feePercent,log]);

  // Live OPEN path — mirrors performLiveClose.
  // Returns {actualQty, avgPrice} on success, false on demo/error.
  // actualQty comes from Jupiter's quote.outAmount (real slippage), not a theoretical calc.
  const performLiveOpen=useCallback(async(
    sym:string,
    usdcToSpend:number,
    conf:number,
  ):Promise<{actualQty:number,avgPrice:number}|false>=>{
    if(!isLive||!walletAddress)return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ph=(window as any).phantom?.solana;
    if(!ph)return false;
    const mint=(SYMS as Record<string,{mint:string}>)[sym]?.mint;
    if(!mint){log("KYMIA","⚠ No mint for "+sym+" — skipping live open",K.r);return false;}
    const decimals=TOKEN_DECIMALS[sym]??6;
    try{
      const {PublicKey:PK}=await import("@solana/web3.js");
      const result=await openLiveTrade({
        wallet:new PK(walletAddress),
        outputMint:mint,
        usdcToSpend,
        slippageBps:50,
        log:(msg:string)=>log("KYMIA",msg,K.gold),
        signTransaction:async(tx)=>{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return ph.signTransaction(tx) as Promise<typeof tx>;
        },
        sendAndConfirm:async(signedTx)=>{
          const raw=signedTx.serialize();
          const b64=Buffer.from(raw).toString("base64");
          const sendRes=await fetch("https://api.mainnet-beta.solana.com",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({jsonrpc:"2.0",id:1,method:"sendTransaction",
              params:[b64,{encoding:"base64",skipPreflight:false,preflightCommitment:"confirmed"}]}),
          });
          const sendData=await sendRes.json() as {result?:string,error?:{message:string}};
          if(sendData.error)throw new Error(sendData.error.message);
          const sig=sendData.result!;
          for(let i=0;i<30;i++){
            await new Promise(r=>setTimeout(r,2000));
            const pollRes=await fetch("https://api.mainnet-beta.solana.com",{
              method:"POST",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSignatureStatuses",
                params:[[sig],{searchTransactionHistory:true}]}),
            });
            const pollData=await pollRes.json() as {result?:{value?:Array<{confirmationStatus?:string,err?:unknown}>}};
            const st=pollData?.result?.value?.[0];
            if(st&&(st.confirmationStatus==="confirmed"||st.confirmationStatus==="finalized"))return sig;
            if(st?.err)throw new Error("tx failed: "+JSON.stringify(st.err));
          }
          throw new Error("confirmation timeout (60s)");
        },
      });
      const actualQty=result.rawOutAmount/Math.pow(10,decimals);
      const avgPrice=usdcToSpend/actualQty;
      log("KYMIA","◈ "+sym+" opened on-chain · "+f2(actualQty,6)+" units @ "+fPrice(avgPrice)+" · tx: "+result.txSignature.slice(0,8)+"...",K.g);
      void conf; // conf used in trade log by caller
      return{actualQty,avgPrice};
    }catch(e:unknown){
      const msg=e instanceof Error?e.message:String(e);
      log("KYMIA","⚠ Live open failed ("+sym+"): "+msg+" — applying demo fallback",K.r);
      return false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[isLive,walletAddress,log]);

  // closeLongPosition + addWinCard removed — positions closed exclusively by /api/agents/cycle server-side
  // Win cards are triggered by the kymia_trades realtime INSERT subscription above

  // Real-data agents — NEVER overwritten by simulation (only AEGIS remains sim)
  const REAL_AGENT_IDS=new Set(["leviathan","lens","surge","atlas","echo","radar","shield","oracle","phantom","titan","hydra","neural","watch","delta","razor","vector","consensus"]);

  // Agent cycle — simulation only for non-real agents
  useEffect(()=>{
    const ids=AGENTS.map(a=>a.id).filter(id=>!disabled.has(id));
    // Sim agents only (exclude real-data agents)
    const simIds=ids.filter(id=>!REAL_AGENT_IDS.has(id));
    const iv=setInterval(()=>{
      const act=new Set(Array.from({length:4+Math.floor(Math.random()*7)},()=>simIds[Math.floor(Math.random()*simIds.length)]));
      setDebate([simIds[Math.floor(Math.random()*simIds.length)],simIds[Math.floor(Math.random()*simIds.length)]]);
      setEntropy(e=>Math.max(10,Math.min(90,e+(Math.random()-.5)*12)));
      setAgSt(prev=>{
        const next={...prev};
        for(const a of AGENTS){
          // ── Real-data agents: preserve signal/conf/th from runRealAgents ──
          if(REAL_AGENT_IDS.has(a.id)){
            // Only update `on` state; never touch sig/conf/th/real
            next[a.id]={...prev[a.id],on:!disabled.has(a.id)&&prev[a.id]?.sig!=null};
            continue;
          }
          // ── Sim agents: random cycle as before ──
          const isOn=act.has(a.id)&&!disabled.has(a.id);
          const tl=TH[a.id]||["Monitoring..."];
          const sig=Math.random()>.55?"BUY":Math.random()>.5?"SELL":"HOLD";
          next[a.id]={on:isOn,conf:isOn?55+Math.floor(Math.random()*42):prev[a.id]?.conf??null,sig:isOn?sig:prev[a.id]?.sig??null,th:isOn?tl[Math.floor(Math.random()*tl.length)]:prev[a.id]?.th??"",real:false};
        }
        return next;
      });
      // Log line: only sim agents, use their static TH copy (no new random signal)
      if(running&&Math.random()>.4&&simIds.length>0){
        const id=simIds[Math.floor(Math.random()*simIds.length)];
        const ag=AGENTS.find(a=>a.id===id);
        const tl=TH[id]||["Monitoring..."];
        const curSig=agStRef.current[id]?.sig||"HOLD";
        log(ag?.s||id.slice(0,5).toUpperCase(),tl[Math.floor(Math.random()*tl.length)],curSig==="BUY"?K.g:curSig==="SELL"?K.r:K.tx);
      }
    },3000);
    return()=>clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running,disabled,log]);

  // Session quality ticker — updates every 60s
  useEffect(()=>{
    const iv=setInterval(()=>setSessionQuality(getSessionQuality()),60000);
    return()=>clearInterval(iv);
  },[]);

  // Pending pullback entries — display only, execution handled server-side
  useEffect(()=>{
    if(!running)return;
    const iv=setInterval(()=>{
      const now=Date.now();
      const uiSnap:Record<string,{signal:string,target:number,expiry:number}>={};
      for(const [sym,entry] of Object.entries(pendingEntriesRef.current)){
        if(now>entry.expiry){delete pendingEntriesRef.current[sym];log("WATCH","⏱ "+sym+" entry expired",K.dim);continue;}
        uiSnap[sym]={signal:entry.signal,target:entry.target,expiry:entry.expiry};
      }
      setPendingEntries(uiSnap);
    },5000);
    return()=>clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running,log]);


  // Trade execution and first-trade guarantee removed — handled server-side by /api/agents/cycle

  // ── Session summary every 30 minutes ─────────────────────────────────────────
  useEffect(()=>{
    if(!running)return;
    const iv=setInterval(()=>{
      const cl=tradesRef.current.filter((t:Trade)=>t.pnl!==0);
      const wins=cl.filter((t:Trade)=>t.pnl>0);
      const losses=cl.filter((t:Trade)=>t.pnl<0);
      const totalPnL=cl.reduce((s:number,t:Trade)=>s+t.pnl,0);
      const wr=cl.length?Math.round(wins.length/cl.length*100):0;
      const best=wins.length?Math.max(...wins.map((t:Trade)=>t.pnl)):0;
      const worst=losses.length?Math.min(...losses.map((t:Trade)=>t.pnl)):0;
      const prt=portRef.current;
      const nextM=MISSIONS.find(m=>(prt.equity-CAP)/CAP<m.target);
      log("SYS","── 30m SESSION SUMMARY ──────────────────────",K.dim);
      log("STAT","Trades: "+cl.length+" | Wins: "+wins.length+" | Losses: "+losses.length,K.tx);
      log("STAT","P&L: "+fU(totalPnL)+" | Win rate: "+wr+"%",totalPnL>=0?K.g:K.r);
      if(best>0)log("STAT","Best: +$"+f2(best)+" | Worst: "+fU(worst),K.tx);
      if(nextM)log("STAT","Next mission: "+nextM.name+" ("+f2((nextM.target*CAP+CAP-prt.equity),0)+" to go)",K.gold);
      else log("STAT","All missions complete — NEXUS ELITE achieved",K.gold);
      log("SYS","─────────────────────────────────────────────",K.dim);
    },30*60*1000);
    return()=>clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running,log]);

  // Edge events
  useEffect(()=>{
    if(!running)return;
    const iv=setInterval(()=>{
      const ev=EDGE_EVENTS[Math.floor(Math.random()*EDGE_EVENTS.length)];
      const toast:EdgeToast={id:Math.random().toString(36).slice(2),...ev};
      setEdgeToasts(p=>[...p.slice(-1),toast]);
      if(ev.type==="WHALE"){setWhaleAlert(true);setTimeout(()=>setWhaleAlert(false),4000);}
      log(ev.type==="WHALE"?"LVTH":"RADR",ev.title+": "+ev.body.replace("\n"," "),ev.col);
    },14000);
    return()=>clearInterval(iv);
  },[running,log]);

  // forceTrade, openShort, selectBestShort removed — all trading handled server-side by /api/agents/cycle


  const runAI=useCallback(async()=>{
    if(analyzing)return;
    setAnalyzing(true);
    log("CLAUDE","⚡ Multi-agent debate protocol...",K.c);
    const snap=Object.entries(pricesRef.current).map(([k,v])=>`${k}:$${f2((v as PriceData).price)}(${fP((v as PriceData).change)}) RSI:${f2((v as PriceData).rsi)}`).join("|");
    const prt=portRef.current;
    const posStr=Object.entries(prt.pos).map(([k,p])=>`${k}:${(p as Position).qty.toFixed(3)}@$${f2((p as Position).avg)}`).join(",")||"none";
    try{
      const res=await fetch("/api/debate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:`KYMIA AI. JSON strict only.
MARKET: ${snap} | POSITIONS: ${posStr} | CASH: $${f2(prt.cash)} | ENTROPY: ${entropyRef.current}
{"regime":"TRENDING_BULL|TRENDING_BEAR|SIDEWAYS|VOLATILE","regimeConf":0-100,"entropy":0-100,"groupthinkWarning":true,"debate":[{"agent":"CODENAME","thesis":"argument max 40 chars","signal":"BUY|SELL|HOLD","conf":0-100}],"consensus":{"signal":"BUY|SELL|HOLD","symbol":"SOL|BTC|ETH|JUP|BONK","confidence":0-100,"rationale":"reason","tp":0,"sl":0},"riskWarning":"text or null","marketSummary":"2 sentences"}`}]})});
      const data=await res.json();
      const raw=data.content?.map((b:{text?:string})=>b.text||"").join("").replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(raw);
      setAiData(parsed);
      setEntropy(parsed.entropy||entropyRef.current);
      log("REGIME","◈ "+(parsed.regime||"")+" ("+(parsed.regimeConf||0)+"%) — "+(parsed.marketSummary||""),K.c);
      for(const d of(parsed.debate||[])){log(String(d.agent||"").toUpperCase().slice(0,7),"["+d.signal+"] "+d.thesis+" ("+d.conf+"%)",d.signal==="BUY"?K.g:d.signal==="SELL"?K.r:K.tx);}
      const cs=parsed.consensus||{};
      log("CNSNS","⟹ "+cs.signal+" "+cs.symbol+" | "+cs.confidence+"% TP:$"+f2(cs.tp||0)+" SL:$"+f2(cs.sl||0),K.c);
      if(parsed.riskWarning)log("RISK","⚠ "+parsed.riskWarning,K.r);
      if(parsed.groupthinkWarning)log("SABOT","⚡ GROUPTHINK — Saboteur activated",K.pu);
      setModal("debate");
    }catch(e){
      log("ERROR","Debate API unavailable — "+String(e),K.r);
    }
    setAnalyzing(false);
  },[analyzing,log]);

  const runDNA=useCallback(async()=>{
    if(dnaLoading)return;
    setDnaLoading(true);
    const cl=trades.filter(t=>t.pnl!==0);
    const wr=cl.length?cl.filter(t=>t.pnl>0).length/cl.length*100:50;
    const pnl=port.equity-CAP;
    try{
      const res=await fetch("/api/debate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:`KYMIA AI. JSON strict only.
Stats: $${CAP} → $${f2(port.equity)}, P&L: ${fU(pnl)}, Trades: ${trades.length}, WinRate: ${f2(wr)}%
{"traderTitle":"epic title","tradingDNA":["trait1","trait2","trait3"],"strengths":["s1","s2"],"weakness":"main weakness","aiVerdict":"1 powerful sentence","score":0-100,"tier":"BRONZE|SILVER|GOLD|PLATINUM|KYMIA_ELITE"}`}]})});
      const data=await res.json();
      const raw=data.content?.map((b:{text?:string})=>b.text||"").join("").replace(/```json|```/g,"").trim();
      setDnaData(JSON.parse(raw));
    }catch(e){
      log("ERROR","DNA API unavailable — "+String(e),K.r);
    }
    setDnaLoading(false);
  },[dnaLoading,trades,port]);


  // ── Derive realAgSt from agentFeed (6 real agents + confluence center) ─
  const realAgSt=(()=>{
    const empty=Object.fromEntries(REAL_AGENTS.map(a=>[a.id,{on:false,conf:null as number|null,sig:null as string|null,th:""}]));
    if(!agentFeed)return empty;
    const allV:AgentFeedVerdict[]=Object.values(agentFeed.by_symbol).flat();
    const latestByAgent:Record<string,AgentFeedVerdict>={};
    allV.forEach(v=>{const ex=latestByAgent[v.agent];if(!ex||v.cycle_ts>ex.cycle_ts)latestByAgent[v.agent]=v;});
    const latestV=allV.sort((a,b)=>b.cycle_ts>a.cycle_ts?1:-1)[0];
    const confScore=latestV?.score_total!=null?Math.round(latestV.score_total):null;
    return Object.fromEntries(REAL_AGENTS.map(a=>{
      if(a.id==='confluence')return [a.id,{on:confScore!=null,conf:confScore,sig:confScore!=null?(confScore>=60?'BUY':confScore>=40?'HOLD':'SELL'):null,th:confScore!=null?`Score agrégé : ${confScore}/100`:""}];
      const v=latestByAgent[a.id];
      if(!v)return [a.id,{on:false,conf:null,sig:null,th:""}];
      const sig=v.vote==='APPROVE'?'BUY':v.vote==='REJECT'?'SELL':'HOLD';
      return [a.id,{on:true,conf:v.confidence,sig,th:v.reason}];
    }));
  })();

  const totalPnL=port.equity-CAP,pct=(totalPnL/CAP)*100;
  const dd=((port.peak-port.equity)/port.peak)*100;
  const cl=trades.filter(t=>t.pnl!==0);
  const wr=cl.length?cl.filter(t=>t.pnl>0).length/cl.length*100:0;
  const rc=(aiData?.regime as string||"").includes("BULL")?K.g:(aiData?.regime as string||"").includes("BEAR")?K.r:K.gold;
  const entropyCol=entropy<30?K.r:entropy>70?K.g:K.gold;

  const handleStart=async()=>{
    if(running){
      await fetch('/api/agents/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user?.id})});
      setRunning(false);
      log("SYS","⏹ SYSTEM HALTED — server agents stopped",K.r);
      return;
    }
    if(!hasShownOnboarding){
      setShowOnboarding(true);
      setHasShownOnboarding(true);
      return;
    }
    await fetch('/api/agents/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user?.id,swarmConfig})});
    setRunning(true);
    log("SYS","▶ KYMIA ACTIVATED — server agents running 24/7",K.g);
  };

  const beatStart=(sym:string,side:string)=>{
    setBeatChoice({sym,side});setBeatResult(null);
    setTimeout(()=>{
      const p0=pricesRef.current[sym]?.price||1;
      setTimeout(()=>{
        const p1=pricesRef.current[sym]?.price||1;
        const moved=p1>p0;
        const win=(side==="LONG"&&moved)||(side==="SHORT"&&!moved);
        setBeatResult(win?"✓ YOU WIN":"✗ KYMIA WINS");
      },30000);
    },100);
  };

  return(
    <div style={{fontFamily:"'JetBrains Mono','Courier New',monospace",background:blackSwan?"#0C0304":K.bg,color:K.hi,minHeight:"100vh",display:"flex",flexDirection:"column",overflow:isMobile?"visible":"hidden",fontSize:12,transition:"background 1s",paddingBottom:28}}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#020508}::-webkit-scrollbar-thumb{background:#0A1D33;border-radius:2px}
        @keyframes pu{0%,100%{opacity:1}50%{opacity:.15}}
        @keyframes breathe{0%,100%{opacity:.65}50%{opacity:1}}
        @keyframes glow{0%,100%{text-shadow:0 0 8px currentColor}50%{text-shadow:0 0 22px currentColor}}
        @keyframes fi{from{opacity:0;transform:translateX(-5px)}to{opacity:1;transform:translateX(0)}}
        @keyframes bootLine{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        @keyframes laserSweep{from{transform:translateX(-100%)}to{transform:translateX(200%)}}
        @keyframes arcFlow{0%{stroke-dashoffset:200}100%{stroke-dashoffset:0}}
        @keyframes moneyFloat{0%{opacity:0;transform:translateY(0)}20%{opacity:1}100%{opacity:0;transform:translateY(-22px)}}
        @keyframes winCardIn{from{transform:translateX(230px);opacity:0}to{transform:translateX(0);opacity:1}}
        @keyframes toastIn{from{transform:translateX(230px);opacity:0}to{transform:translateX(0);opacity:1}}
        @keyframes confBar{from{width:100%}to{width:0%}}
        @keyframes tickerScroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}
        @keyframes shockwave{0%{r:60;opacity:.5}100%{r:108;opacity:0}}
        @keyframes whalePulse{0%{transform:scale(0);opacity:.72}100%{transform:scale(1);opacity:0}}
        @keyframes agentPulse{0%,100%{opacity:1}50%{opacity:.15}}
        @keyframes swan{0%,100%{box-shadow:0 0 0 rgba(255,51,102,.2)}50%{box-shadow:0 0 24px rgba(255,51,102,.5)}}
        @keyframes odometerRoll{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}
        @keyframes glitch{0%{transform:translateX(0)}25%{transform:translateX(-2px) skewX(2deg)}75%{transform:translateX(2px) skewX(-2deg)}100%{transform:translateX(0)}}
        @keyframes scan{0%{transform:translateY(4px)}100%{transform:translateY(36px)}}
        @keyframes logSlideIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        .log-entry{animation:logSlideIn .3s ease forwards}
        @keyframes convPulse{0%,100%{box-shadow:0 0 0 rgba(0,242,254,0);border-color:rgba(0,242,254,.15)}50%{box-shadow:0 0 28px rgba(0,242,254,.25),inset 0 0 18px rgba(0,242,254,.07);border-color:rgba(0,242,254,.55)}}
        @keyframes convBuyPulse{0%,100%{box-shadow:0 0 0 rgba(0,255,136,0);border-color:rgba(0,255,136,.15)}50%{box-shadow:0 0 28px rgba(0,255,136,.25),inset 0 0 18px rgba(0,255,136,.07);border-color:rgba(0,255,136,.55)}}
        @keyframes nodeFlash{0%{filter:brightness(1)}25%{filter:brightness(3) saturate(2)}75%{filter:brightness(2)}100%{filter:brightness(1)}}
        @keyframes arcFlicker{0%,100%{opacity:0.95}50%{opacity:0.55}}
        .arc-debate{animation:arcFlicker 0.12s infinite}
        @keyframes agentGlobeAppear{0%{opacity:0;transform:translateX(-50%) translateY(-8px)}15%{opacity:1;transform:translateX(-50%) translateY(0)}75%{opacity:1}100%{opacity:0;transform:translateX(-50%) translateY(-12px)}}
        .tab{background:none;border:none;cursor:pointer;font-family:inherit;font-size:12px;letter-spacing:.1em;padding:7px 14px;color:#1E3A55;transition:all .2s;text-transform:uppercase;border-bottom:2px solid transparent}
        .tab:hover{color:${K.c}}.tab.on{color:${K.c};border-bottom-color:${K.c}}
        .tr:hover{background:#060B14}
        .panel{background:rgba(6,10,18,0.75);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid #0A1D33;border-radius:2px;box-shadow:0 4px 24px rgba(0,0,0,.45),inset 0 1px 0 rgba(0,242,254,.04)}
        .panel:hover{border-color:#0F2840;box-shadow:0 4px 28px rgba(0,0,0,.55),inset 0 1px 0 rgba(0,242,254,.07)}
        .btn{font-family:inherit;font-size:9px;letter-spacing:.1em;cursor:pointer;border-radius:2px;text-transform:uppercase;border:none;transition:all .2s;padding:5px 11px}
        .btn:hover{filter:brightness(1.2)}
      `}</style>

      {/* Vignette overlay */}
      <div style={{position:"fixed",inset:0,zIndex:201,pointerEvents:"none",background:"radial-gradient(ellipse at center, transparent 55%, rgba(2,4,10,0.72) 100%)"}}/>

      {/* ── LIVE MODE — Phantom connection gate ── */}
      {isLive&&!walletConnected&&(
        <div style={{position:"fixed",inset:0,background:"rgba(2,4,10,0.97)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:20,zIndex:500,fontFamily:"'JetBrains Mono','Courier New',monospace"}}>
          <div style={{fontSize:48,color:K.c,textShadow:"0 0 30px "+K.c}}>◈</div>
          <div style={{fontSize:20,fontWeight:900,color:K.c,letterSpacing:".2em"}}>KYMIA LIVE MODE</div>
          <div style={{fontSize:12,color:K.dim,textAlign:"center",lineHeight:2}}>
            Connect your Phantom wallet to start<br/>autonomous AI trading on Solana
          </div>
          <button onClick={async()=>{
            const ph=(window as unknown as {phantom?:{solana?:{connect:()=>Promise<{publicKey:{toString:()=>string}}>,isPhantom?:boolean}}}).phantom?.solana;
            if(!ph?.isPhantom){window.open("https://phantom.app/","_blank");return;}
            try{
              const r=await ph.connect();
              const addr=r.publicKey.toString();
              setWalletAddress(addr);setWalletConnected(true);
              log("SYS","⚡ LIVE MODE — Phantom connected: "+addr.slice(0,8)+"...",K.g);
              // Load per-wallet fee state from localStorage
              const stored=localStorage.getItem("kymia_fee_"+addr);
              if(stored){const fs=JSON.parse(stored);setTotalFeesPaid(fs.totalFeesPaid||0);setFeePercent(fs.feePercent||10);setHighWaterMark(fs.highWaterMark||CAP);}
            }
            catch{log("SYS","Phantom connection rejected",K.r);}
          }} style={{background:"rgba(0,242,254,0.15)",border:"2px solid rgba(0,242,254,0.5)",color:K.c,fontFamily:"inherit",fontSize:13,borderRadius:6,padding:"12px 36px",cursor:"pointer",letterSpacing:".1em",transition:"all .2s"}}>
            ⚡ CONNECT PHANTOM
          </button>
          <div style={{padding:"10px 24px",maxWidth:380,background:"rgba(255,215,0,0.06)",border:"1px solid rgba(255,215,0,0.2)",borderRadius:4,fontSize:10,color:K.gold,textAlign:"center",lineHeight:1.8}}>
            ⚠ Real funds will be used for trading.<br/>KYMIA never holds your funds.<br/>Non-custodial · You keep your keys.
          </div>
          {/* ── Performance fee transparency ── */}
          <div style={{maxWidth:400,padding:"14px 18px",background:"rgba(255,215,0,0.05)",border:"1px solid rgba(255,215,0,0.2)",borderRadius:6,fontFamily:"'JetBrains Mono','Courier New',monospace"}}>
            <div style={{fontSize:11,color:K.gold,fontWeight:700,marginBottom:10,letterSpacing:".1em"}}>◈ HOW THE PERFORMANCE FEE WORKS</div>
            <div style={{fontSize:10,color:"#A8D0EC",lineHeight:2}}>
              • KYMIA takes {feePercent}% <em>only</em> on winning trades<br/>
              • Fee is included in the same transaction you sign to close<br/>
              • Your funds never leave your wallet without your signature<br/>
              • Losing trades: zero fee, zero cost<br/>
              • High-water mark: we never charge twice on the same gains
            </div>
            <div style={{marginTop:12,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:9,color:K.dim}}>FEE TIER:</span>
              {[5,10,15].map(pct=>(
                <button key={pct} onClick={()=>setFeePercent(pct)} style={{padding:"3px 10px",fontSize:10,fontFamily:"inherit",cursor:"pointer",borderRadius:3,background:feePercent===pct?K.gold+"25":"transparent",color:feePercent===pct?K.gold:K.dim,border:"1px solid "+(feePercent===pct?K.gold+"60":"#1A3050")}}>
                  {pct}%
                </button>
              ))}
            </div>
          </div>
          <a href="/" style={{fontSize:10,color:K.dim,textDecoration:"none",marginTop:4}}>← Back to DEMO mode</a>
        </div>
      )}

      {showAuthModal&&<AuthModal onClose={()=>setShowAuthModal(false)}/>}
      {showOnboarding&&(
        <div style={{position:'fixed',inset:0,background:'rgba(2,4,10,0.97)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:20,fontFamily:"'JetBrains Mono','Courier New',monospace"}}>
          <div style={{fontSize:11,color:K.c,letterSpacing:'.3em',marginBottom:4}}>◈ CONFIGURE YOUR SWARM</div>
          <div style={{fontSize:24,fontWeight:900,color:'white',marginBottom:8}}>Choose your risk profile</div>
          <div style={{display:'flex',gap:12}}>
            {([{id:'safe',label:'SAFE',lev:2,desc:'4% max · Tight SL',col:'#00FF88'},{id:'balanced',label:'BALANCED',lev:3,desc:'7% max · Standard',col:'#00F2FE'},{id:'aggressive',label:'AGGRESSIVE',lev:4,desc:'12% max · Wide TP',col:'#FF3366'}] as const).map(p=>(
              <button key={p.id} onClick={async()=>{const cfg={profile:p.id,leverage:p.lev};setSwarmConfig(cfg);setShowOnboarding(false);setHasShownOnboarding(true);await fetch('/api/agents/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user?.id,swarmConfig:cfg})});setRunning(true);log('KYMIA',`◈ Swarm configured: ${p.id.toUpperCase()} | ${p.lev}x leverage`,K.c);saveSession();}} style={{padding:'20px 28px',background:`${p.col}12`,border:`2px solid ${p.col}50`,borderRadius:8,cursor:'pointer',fontFamily:'inherit',minWidth:160}}>
                <div style={{fontSize:13,fontWeight:900,color:p.col,marginBottom:6,letterSpacing:'.1em'}}>{p.label}</div>
                <div style={{fontSize:11,color:K.c,marginBottom:4}}>{p.lev}x leverage</div>
                <div style={{fontSize:9,color:K.dim}}>{p.desc}</div>
              </button>
            ))}
          </div>
          <button onClick={async()=>{const cfg={profile:'balanced',leverage:3};setSwarmConfig(cfg);setShowOnboarding(false);setHasShownOnboarding(true);await fetch('/api/agents/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:user?.id,swarmConfig:cfg})});setRunning(true);log('KYMIA','◈ Using defaults: BALANCED | 3x leverage',K.dim);}} style={{marginTop:8,background:'none',border:'none',color:K.dim,cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>Skip — use defaults</button>
        </div>
      )}
      {booting&&<BootSequence onDone={()=>{setBooting(false);}}/>}

      {blackSwan&&(
        <div style={{background:K.r+"18",borderBottom:"1px solid "+K.r,padding:"4px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",animation:"swan 2s infinite"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:K.r,animation:"pu 1s infinite"}}/>
            <span style={{color:K.r,fontSize:10,fontWeight:700,letterSpacing:".12em"}}>⚠ BLACK SWAN — EXTREME VOLATILITY DETECTED</span>
          </div>
          <button className="btn" onClick={()=>{setCircuit(true);log("CIRCUIT","⚡ BLACK SWAN — Execution LOCKED",K.r);}} style={{background:K.r+"20",color:K.r,border:"1px solid "+K.r+"50"}}>AUTO LOCK</button>
        </div>
      )}

      <header style={{background:blackSwan?"#090203":"#040810",borderBottom:"1px solid "+(blackSwan?K.r+"40":K.brd),padding:"4px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100,maxWidth:"100vw",overflowX:"hidden"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:1,minWidth:0,overflow:"hidden"}}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <svg width="30" height="30" viewBox="0 0 30 30" style={{flexShrink:0,filter:"drop-shadow(0 0 6px "+(blackSwan?K.r:K.c)+")"}}>
              <polygon points="15,1 27,8 27,22 15,29 3,22 3,8" fill="none" stroke={blackSwan?K.r:K.c} strokeWidth="1.5"/>
              <ellipse cx="15" cy="15" rx="7" ry="4.2" fill="none" stroke={blackSwan?K.r:K.c} strokeWidth="1" opacity=".8"/>
              <circle cx="15" cy="15" r="2.8" fill={blackSwan?K.r:K.c} opacity=".9"/>
              <circle cx="15" cy="15" r="1.1" fill="#000" opacity=".7"/>
              <line x1="8" y1="15" x2="22" y2="15" stroke={blackSwan?K.r:K.c} strokeWidth=".6" opacity=".35"/>
            </svg>
            <span style={{fontSize:17,fontWeight:900,color:blackSwan?K.r:K.c,letterSpacing:".25em",textShadow:"0 0 20px "+(blackSwan?K.r:K.c),animation:"glow 2.5s ease-in-out infinite",fontFamily:"'JetBrains Mono','Courier New',monospace"}}>KYMIA</span>
          </div>
          {!isMobile&&<>
          <span style={{fontSize:9,color:"#102030",letterSpacing:".1em"}}>QUANT AI · v2.0</span>
          {!isLive?(
            <div style={{padding:"3px 10px",background:"rgba(0,255,136,0.12)",border:"1px solid rgba(0,255,136,0.3)",borderRadius:3,fontSize:9,color:K.g,letterSpacing:".1em"}}>◈ DEMO · $10K VIRTUAL</div>
          ):(
            <div style={{padding:"3px 10px",background:"rgba(255,51,102,0.12)",border:"1px solid rgba(255,51,102,0.4)",borderRadius:3,fontSize:9,color:K.r,letterSpacing:".1em",animation:"pu 1s infinite"}}>⚡ LIVE · REAL FUNDS</div>
          )}
          <a href={isLive?"/nexus?mode=demo":"/nexus?mode=live"} style={{padding:"3px 9px",fontSize:9,background:"transparent",color:K.dim,border:"1px solid #0A1D33",borderRadius:2,textDecoration:"none",cursor:"pointer",letterSpacing:".06em"}}>
            {isLive?"→ DEMO":"→ LIVE"}
          </a>
          <div style={{display:"flex",alignItems:"center",gap:4,padding:"2px 7px",background:K.c+"10",border:"1px solid "+K.c+"25",borderRadius:2}}>
            <span style={{fontSize:9,fontWeight:700,color:K.c}}>{SYM_COUNT}</span>
            <span style={{fontSize:7,color:K.dim,letterSpacing:".08em"}}>MARKETS</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:running?K.g:K.r,boxShadow:"0 0 8px "+(running?K.g:K.r),animation:"pu 1.5s infinite"}}/>
            <span style={{fontSize:9,color:running?K.g:K.r}}>{running?"LIVE · AUTO":"STANDBY"}</span>
          </div>
          {running&&<div style={{display:"flex",alignItems:"center",gap:4,padding:"2px 7px",background:K.g+"10",border:"1px solid "+K.g+"25",borderRadius:2}}><div style={{width:5,height:5,borderRadius:"50%",background:K.g,animation:"pu 1s infinite"}}/><span style={{fontSize:7,color:K.g,letterSpacing:".1em"}}>24/7</span></div>}
          {/* Part 2: Regime badge */}
          {regimeState&&(
            <div style={{display:'flex',alignItems:'center',gap:6,padding:'4px 10px',background:`${REGIME_CONFIG[regimeState.regime].col}10`,border:`1px solid ${REGIME_CONFIG[regimeState.regime].col}30`,borderRadius:4}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:REGIME_CONFIG[regimeState.regime].col,boxShadow:`0 0 8px ${REGIME_CONFIG[regimeState.regime].col}`}}/>
              <div>
                <div style={{fontSize:10,fontWeight:900,color:REGIME_CONFIG[regimeState.regime].col,fontFamily:'monospace'}}>{regimeState.regime}</div>
                <div style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>{regimeState.confidence.toFixed(0)}% · {regimeState.direction} · ADX {regimeState.adx?.toFixed(0)}</div>
              </div>
              <div style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>Dom: {regimeState.dominantAgents.join('·')}</div>
            </div>
          )}
          {/* Part 11: Layer 3 badge */}
          <div style={{padding:'3px 8px',background:`${LAYER3_CONFIG.col}12`,border:`1px solid ${LAYER3_CONFIG.col}30`,borderRadius:3,fontSize:8,color:LAYER3_CONFIG.col,fontFamily:'monospace'}}>
            L3 {LAYER3_CONFIG.label} · {(LAYER3_CONFIG.maxAlloc*100).toFixed(0)}% MAX
          </div>
          {/* Part 12: Demo speed badge */}
          {isDemoMode&&(
            <div style={{padding:'2px 7px',background:'rgba(0,255,136,0.1)',border:'1px solid rgba(0,255,136,0.25)',borderRadius:3,fontSize:8,color:'#00FF88',fontFamily:'monospace'}}>⚡ DEMO SPEED</div>
          )}
          </>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
          {!isMobile&&([{l:"EQUITY",v:"$"+f2(port.equity),col:totalPnL>=0?K.g:K.r},{l:"P&L",v:fU(totalPnL)+" ("+fP(pct)+")",col:totalPnL>=0?K.g:K.r},{l:"DD",v:"-"+f2(dd)+"%",col:dd>5?K.r:K.gold}]).map((x,i)=>(
            <div key={i} style={{textAlign:"right"}}>
              <div style={{fontSize:8,color:"#102030"}}>{x.l}</div>
              <div style={{fontSize:12,fontWeight:600,display:"flex",justifyContent:"flex-end"}}>
                <Odometer value={x.v} col={x.col} style={{textShadow:i<2?`0 0 8px ${x.col}60`:undefined}}/>
              </div>
            </div>
          ))}
          {!isMobile&&<div style={{display:"flex",alignItems:"center",gap:5,padding:"2px 8px",background:"#060A12",border:"1px solid #0A1D33",borderRadius:2}}>
            <span style={{fontSize:9,fontWeight:700,color:K.gold}}>{trades.filter(t=>t.pnl!==0).length}</span>
            <span style={{fontSize:7,color:K.dim,letterSpacing:".06em"}}>TRADES</span>
          </div>}
          {!isMobile&&(!user?(
            <button onClick={()=>setShowAuthModal(true)} style={{padding:'5px 12px',background:'rgba(0,242,254,0.08)',border:'1px solid rgba(0,242,254,0.2)',borderRadius:4,color:'#00F2FE',fontFamily:'monospace',fontSize:10,cursor:'pointer',fontWeight:700}}>◈ SAVE PROGRESS</button>
          ):(
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:6,height:6,borderRadius:'50%',background:'#00FF88'}}/>
              <span style={{fontSize:10,color:'#00FF88',fontFamily:'monospace'}}>{user.email?.split('@')[0]||'Connected'}</span>
              <span style={{fontSize:8,color:'#00FF88',fontFamily:'monospace',padding:'2px 5px',border:'1px solid #00FF8840',borderRadius:3,animation:'pulse 2s ease-in-out infinite',opacity:.8}}>SESSION SAVED</span>
              <button onClick={()=>{setSwarmConfig(null);setRunning(false);setShowOnboarding(true);}} style={{background:'none',border:'none',color:'#2A5070',cursor:'pointer',fontSize:9,fontFamily:'monospace',textDecoration:'underline'}}>⚙ Reconfigure</button>
            </div>
          ))}
          {!isMobile&&<button onClick={async()=>{if(user){await supabase.from('kymia_sessions').update({swarm_config:null}).eq('user_id',user.id);}setSwarmConfig(null);setRunning(false);setShowOnboarding(true);}} style={{padding:'3px 8px',background:'rgba(255,215,0,0.15)',border:'1px solid rgba(255,215,0,0.4)',borderRadius:3,color:'#FFD700',fontSize:9,cursor:'pointer',fontFamily:'monospace'}}>⚙ RESET ONBOARDING (TEST)</button>}
          <div style={{display:"flex",gap:5}}>
            {!isMobile&&<button className="btn" onClick={()=>setShowTransparency(true)} style={{background:"rgba(0,242,254,0.06)",color:"#00F2FE",border:"1px solid rgba(0,242,254,0.2)"}}>ℹ HOW IT WORKS</button>}
            {!isMobile&&<button className="btn" onClick={()=>setModal("share")} style={{background:"#0A1428",color:K.gold,border:"1px solid "+K.gold+"50"}}>◈ SHARE</button>}
            {!isMobile&&<button className="btn" onClick={()=>setFocusMode(f=>!f)} style={{background:focusMode?K.c+"20":"#040810",color:focusMode?K.c:K.dim,border:"1px solid "+(focusMode?K.c+"50":K.brd)}}>{focusMode?"◈ EXIT FOCUS":"◈ FOCUS"}</button>}
            {!isMobile&&<button className="btn" onClick={runAI} disabled={analyzing} style={{background:analyzing?"#06111E":"#001428",color:analyzing?"#1A4A6A":K.c,border:"1px solid "+(analyzing?"#0A2040":K.c+"60")}}>{analyzing?"⟳":"⚡ DEBATE"}</button>}
            {!isMobile&&<button className="btn" onClick={()=>setModal("beat")} style={{background:"#001820",color:K.gold,border:"1px solid "+K.gold+"50"}}>🎮 BEAT AI</button>}
            {!isMobile&&<button className="btn" onClick={()=>setShowKill(s=>!s)} style={{background:"#000F28",color:K.co,border:"1px solid "+K.co+"50"}}>⚙ AGENTS</button>}
            <button className="btn" onClick={handleStart} style={{background:running?"#180610":"#001808",color:running?K.r:K.g,border:"1px solid "+(running?K.r+"40":K.g+"40")}}>{running?"⏹ HALT":"▶ START"}</button>
            <button className="btn" onClick={()=>{setCircuit(c=>!c);log("CIRCUIT",circuit?"Released":"⚡ LOCKED",K.gold);}} style={{background:circuit?"#180A00":"#080808",color:circuit?K.gold:K.tx,border:"1px solid "+(circuit?K.gold+"40":K.brd)}}>{circuit?"🔓":"⚡"}</button>
          </div>
        </div>
      </header>

      <ProfitTicker trades={trades.filter(t=>t.pnl!==0)}/>

      {showKill&&(
        <div style={{background:"#030710",borderBottom:"1px solid "+K.brd,padding:"7px 16px"}}>
          <div style={{fontSize:8,color:K.dim,letterSpacing:".12em",marginBottom:5}}>◉ KILL SWITCH — DISABLE AGENTS · WATCH SWARM ADAPT</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
            {AGENTS.map(a=>{
              const dis=disabled.has(a.id),ag=agSt[a.id]||{};
              const col=dis?"#1A2535":ag.sig==="BUY"?K.g:ag.sig==="SELL"?K.r:K.co;
              return<button key={a.id} className="btn" onClick={()=>{setDisabled(prev=>{const n=new Set(prev);n.has(a.id)?n.delete(a.id):n.add(a.id);return n;});}} style={{background:dis?"#030608":col+"12",color:dis?K.dim:col,border:"1px solid "+(dis?"#080E18":col+"40"),opacity:dis?.45:1,textDecoration:dis?"line-through":"none",padding:"2px 8px"}}>{a.s}</button>;
            })}
            {disabled.size>0&&<button className="btn" onClick={()=>setDisabled(new Set())} style={{background:K.g+"10",color:K.g,border:"1px solid "+K.g+"30"}}>ENABLE ALL</button>}
          </div>
        </div>
      )}

      <div style={{background:"#030710",borderBottom:"1px solid #060B14",padding:"0 16px",display:"flex",gap:2}}>
        {[["terminal","◈ COMMAND"],["alpha","⚡ ALPHA RADAR"],["hunter","🔍 HUNTER"],["rejected","⛔ REJECTED"],["trades","◎ HISTORY"],["scanner","⊕ SCANNER"],["onchain","⛓ ON-CHAIN"]].map(([v,l])=>(
          <button key={v} className={`tab${tab===v?" on":""}`} onClick={()=>setTab(v)}>{l}</button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:12,fontSize:8,color:"#0A1D2A"}}>
          <span>WIN {f2(wr,0)}% · {trades.length} TRADES</span>
          <div style={{display:"flex",gap:6}}>
            {([["● JUP",dataStatus.jupiter],["● BNB",dataStatus.binance],["● CGK",dataStatus.coingecko]] as [string,"ok"|"err"|"loading"][]).map(([lbl,st])=>(
              <span key={lbl} style={{color:st==="ok"?K.g:st==="err"?K.r:K.dim,fontSize:7,letterSpacing:".04em"}}>{lbl}</span>
            ))}
            {dataStatus.lastUpdate>0&&<span style={{color:"#0D1E30",fontSize:7}}>{Math.round((Date.now()-dataStatus.lastUpdate)/1000)}s ago</span>}
          </div>
          <div style={{padding:"2px 8px",background:sessionQuality.col+"15",border:"1px solid "+sessionQuality.col+"40",borderRadius:2,fontSize:8,color:sessionQuality.col,fontFamily:"monospace",letterSpacing:".06em"}}>{sessionQuality.label} · {sessionQuality.quality}</div>
          <span style={{padding:"2px 8px",background:K.c+"10",border:"1px solid "+K.c+"20",color:K.c,borderRadius:2,fontSize:8,letterSpacing:".06em"}}>◈ DEMO · REAL PRICES · VIRTUAL $10K</span>
        </div>
      </div>

      {tab==="terminal"&&(()=>{
        const activeAgents=AGENTS.filter(a=>a.id!=="consensus"&&agSt[a.id]?.on&&agSt[a.id]?.sig);
        const buyVotes=activeAgents.filter(a=>agSt[a.id].sig==="BUY").length;
        const sellVotes=activeAgents.filter(a=>agSt[a.id].sig==="SELL").length;
        const totalVotes=activeAgents.length||1;
        const swarmBP=Math.round(buyVotes/totalVotes*100);const swarmSP=Math.round(sellVotes/totalVotes*100);
        // Real agent conviction for swarm graph glow
        const realActive=REAL_AGENTS.filter(a=>a.id!=="confluence"&&realAgSt[a.id]?.on&&realAgSt[a.id]?.sig);
        const realBuy=realActive.filter(a=>realAgSt[a.id].sig==="BUY").length;
        const realSell=realActive.filter(a=>realAgSt[a.id].sig==="SELL").length;
        const realTotal=realActive.length||1;
        const realBP=Math.round(realBuy/realTotal*100);const realSP=Math.round(realSell/realTotal*100);
        const highConviction=realBP>72||realSP>72;
        const convDom=realBP>realSP?"BUY":"SELL";
        const convCol=convDom==="BUY"?K.g:K.r;
        return(
        <div style={{flex:1,display:"grid",gridTemplateColumns:isMobile?"1fr":focusMode?"0px 1fr 0px":"220px 1fr 260px",gridTemplateRows:isMobile?"auto auto auto":"1fr 240px",gap:isMobile?8:focusMode?0:6,padding:isMobile?4:8,overflowY:isMobile?"auto":"hidden",height:isMobile?"auto":undefined,minHeight:0,transition:"grid-template-columns .4s ease"}}>
          {/* LEFT */}
          <div style={{gridRow:isMobile?"3":"1/3",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
            <div className="panel" style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"8px 4px 6px"}}>
              <div style={{fontSize:8,color:K.dim,letterSpacing:".12em",marginBottom:4,alignSelf:"flex-start",paddingLeft:6}}>◉ GLOBAL MACRO SPHERE</div>
              <Globe3D trades={trades} blackSwan={blackSwan} whaleAlert={whaleAlert} totalPnL={totalPnL} tradeCount={trades.length} agSt={agSt} running={running}/>
            </div>
            <div className="panel" style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
              <div style={{padding:"4px 8px 0",borderBottom:"1px solid #060A14",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:7,color:K.dim,letterSpacing:".12em"}}>◉ MARKETS</span>
                {(["MOVERS","RADAR","ALL"] as const).map(t=>(
                  <button key={t} onClick={()=>setMktTab(t)} style={{background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:7,letterSpacing:".1em",padding:"4px 6px 3px",color:mktTab===t?K.c:K.dim,borderBottom:"1px solid "+(mktTab===t?K.c:"transparent")}}>
                    {t}
                  </button>
                ))}
                <span style={{marginLeft:"auto",fontSize:7,color:K.dim}}>{SYM_COUNT} MKT</span>
              </div>
              <div style={{overflow:"auto",flex:1}}>
                {(()=>{
                  const entries=Object.entries(prices);
                  let display=entries;
                  if(mktTab==="MOVERS"){
                    display=[...entries].sort((a,b)=>Math.abs(b[1].change)-Math.abs(a[1].change)).slice(0,10);
                  }else if(mktTab==="RADAR"){
                    display=entries.filter(([sym,d])=>!STABLE_SYMS.has(sym)&&Math.abs(d.change)>2&&d.rsi<65).sort((a,b)=>Math.abs(b[1].change)-Math.abs(a[1].change)).slice(0,8);
                  }else{
                    // ALL: top 10 by absolute change (compact list)
                    display=[...entries].filter(([sym])=>!STABLE_SYMS.has(sym)).sort((a,b)=>Math.abs(b[1].change)-Math.abs(a[1].change)).slice(0,10);
                  }
                  return display.map(([sym,d])=>{
                    const up=d.trend==="up",pos=port.pos[sym];
                    const rsi=d.rsi;
                    const rsiCol=rsi>70?K.r:rsi<30?K.g:K.gold;
                    const isShortPos=pos?.side==="SHORT";
                    return(
                      <div key={sym} className="tr" style={{display:"grid",gridTemplateColumns:"8px 36px 1fr 38px 26px",alignItems:"center",gap:4,padding:"0 8px",height:32,borderBottom:"1px solid #050810",borderLeft:"2px solid "+(pos?(isShortPos?K.r:K.c):mktTab==="RADAR"?K.gold+"60":"transparent"),cursor:"pointer"}} onClick={()=>{if(pos)setChartTrade({trade:{sym,side:pos.side==='SHORT'?'SELL':'BUY',price:pos.avg||0,pnl:0,conf:0,t:'',ms:Date.now(),qty:0,id:'',agent:'HYBRID'} as any,position:pos,agentSignals:undefined});}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:up?K.g:K.r,flexShrink:0,boxShadow:"0 0 4px "+(up?K.g:K.r)}}/>
                        <div style={{fontSize:9,fontWeight:700,color:K.hi,letterSpacing:".03em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sym}</div>
                        <div style={{minWidth:0}}>
                          <div style={{fontSize:9,color:up?K.g:K.r}}>{fPrice(d.price)}</div>
                          {d.source&&<div style={{fontSize:6,color:K.dim,letterSpacing:".06em"}}>{d.source}</div>}
                        </div>
                        <div style={{fontSize:8,color:up?K.g:K.r,textAlign:"right",whiteSpace:"nowrap"}}>{up?"+":""}{d.change.toFixed(1)}%</div>
                        <div style={{fontSize:7,textAlign:"center",padding:"1px 3px",borderRadius:2,background:rsiCol+"18",color:rsiCol}}>{Math.round(rsi)}</div>
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
            <div className="panel" style={{padding:9}}>
              <div style={{fontSize:8,color:K.dim,marginBottom:6,letterSpacing:".12em"}}>◉ RISK</div>
              {(()=>{
                const maxDd=benchmarkFeed&&benchmarkFeed.length>0?Math.max(...benchmarkFeed.map(r=>r.agent_max_dd_pct??0)):null;
                const ddVal=maxDd!=null?maxDd:null;
                const ddCol=ddVal!=null?(ddVal>10?K.r:ddVal>5?K.gold:K.g):K.dim;
                return(
                  <div style={{marginBottom:5}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:2,fontSize:8}}>
                      <span style={{color:K.tx}}>DRAWDOWN</span>
                      <span style={{color:ddCol}}>{ddVal!=null?`-${f2(ddVal,1)}%`:"—"}</span>
                    </div>
                    <div style={{height:3,background:"#050810",borderRadius:1}}>
                      <div style={{height:"100%",borderRadius:1,background:ddCol,width:(ddVal!=null?Math.min(100,ddVal*2):0)+"%",transition:"width .5s"}}/>
                    </div>
                    {benchmarkFeed===null&&<div style={{fontSize:7,color:K.dim,marginTop:3}}>Loading…</div>}
                  </div>
                );
              })()}
            </div>
            {/* Portfolio Health + Mission Progress */}
            <div className="panel" style={{padding:"8px 10px"}}>
              {(()=>{
                const pnl=port.equity-CAP;const pct=(pnl/CAP)*100;
                const cl=trades.filter(t=>t.pnl!==0);
                const wr=cl.length?cl.filter(t=>t.pnl>0).length/cl.length*100:0;
                const nextM=MISSIONS.find(m=>!completedMissions.includes(m.id));
                const pnlCol=pnl>=0?K.g:K.r;
                const mp=nextM?Math.min(100,pct/(nextM.target*100)*100):100;
                return(<>
                  <div style={{fontSize:19,fontWeight:900,color:pnlCol,textShadow:`0 0 12px ${pnlCol}`,marginBottom:2,fontFamily:"monospace"}}>{pnl>=0?"+":""}{fU(pnl)}</div>
                  <div style={{fontSize:8,color:"#2A5070",marginBottom:4}}>{fP(pct)} since start · WR {f2(wr,0)}% · {signalCount} signals</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:isLive?4:8}}>
                    <span style={{fontSize:7,padding:"1px 6px",background:"#BD00FF15",border:"1px solid #BD00FF40",borderRadius:2,color:"#BD00FF",fontWeight:700}}>x{SWARM_CONFIG.leverage} LEV</span>
                    <span style={{fontSize:7,color:"#2A5070"}}>{SWARM_CONFIG.profile.toUpperCase()}</span>
                  </div>
                  {isLive&&(
                    <div style={{marginBottom:8,padding:"6px 8px",background:K.gold+"08",border:"1px solid "+K.gold+"25",borderRadius:3}}>
                      <div style={{fontSize:7,color:K.dim,marginBottom:2,letterSpacing:".08em"}}>KYMIA EARNED (this session)</div>
                      <div style={{fontSize:16,fontWeight:700,color:K.gold,fontFamily:"monospace"}}>${f2(totalFeesPaid)}</div>
                      <div style={{fontSize:7,color:K.dim,marginTop:1}}>{feePercent}% of profits · paid on-chain · HWM ${f2(highWaterMark)}</div>
                    </div>
                  )}
                  {nextM&&(<>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:8,marginBottom:3}}>
                      <span style={{color:nextM.color}}>{nextM.icon} {nextM.name}</span>
                      <span style={{color:"#2A5070"}}>{mp.toFixed(0)}%</span>
                    </div>
                    <div style={{height:4,background:"#06090F",borderRadius:2,marginBottom:3}}>
                      <div style={{height:"100%",borderRadius:2,background:nextM.color,width:mp+"%",transition:"width .5s",boxShadow:`0 0 8px ${nextM.color}`}}/>
                    </div>
                    <div style={{fontSize:7,color:"#2A5070",marginBottom:6}}>Target: +{(nextM.target*100).toFixed(0)}% (+{f2(CAP*nextM.target)} virtual)</div>
                  </>)}
                  {completedMissions.length>0&&(
                    <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                      {completedMissions.map(id=>{const m=MISSIONS.find(x=>x.id===id)!;return(<div key={id} style={{padding:"1px 5px",fontSize:7,background:m.color+"15",color:m.color,border:`1px solid ${m.color}30`,borderRadius:2}}>{m.icon} {m.name}</div>);})}
                    </div>
                  )}
                </>);
              })()}
            </div>
            {/* Agent Activity Monitor — 6 real server agents */}
            <div className="panel" style={{padding:"6px 9px"}}>
              <div style={{fontSize:7,color:K.dim,letterSpacing:".12em",marginBottom:5}}>◉ AGENT ACTIVITY</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"2px 6px"}}>
                {REAL_AGENTS.filter(a=>a.id!=="confluence").map(a=>{
                  const verdicts=agentFeed?Object.values(agentFeed.by_symbol).flat().filter(v=>v.agent===a.id):[];
                  const latestV=verdicts.sort((x,y)=>y.cycle_ts>x.cycle_ts?1:-1)[0];
                  const minAgo=latestV?(Date.now()-new Date(latestV.cycle_ts).getTime())/60000:999;
                  const status=minAgo<10?"ACTIVE":minAgo<60?"SCAN":"IDLE";
                  const col=status==="ACTIVE"?K.g:status==="SCAN"?K.gold:K.dim;
                  return(<div key={a.id} style={{display:"flex",justifyContent:"space-between",fontSize:7,padding:"1px 0"}}>
                    <span style={{color:K.tx}}>{a.s}</span>
                    <span style={{color:col,letterSpacing:".06em"}}>{status}</span>
                  </div>);
                })}
              </div>
              <div style={{marginTop:5,fontSize:7,color:"#2A5070"}}>⚡ {agentFeed?Object.values(agentFeed.by_symbol).flat().length:0} verdicts loaded</div>
            </div>
          </div>

          {/* CENTER */}
          <div style={{gridRow:isMobile?"1":"1/2",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
            <div className="panel" style={{flex:isMobile?"none":1,height:isMobile?"50vh":undefined,display:"flex",flexDirection:"column",overflow:"hidden",position:"relative"}}>
              {/* Neural grid background */}
              <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:.09,pointerEvents:"none"}} aria-hidden>
                <defs>
                  <pattern id="hexgrid" x="0" y="0" width="40" height="46" patternUnits="userSpaceOnUse">
                    <polygon points="20,2 38,12 38,34 20,44 2,34 2,12" fill="none" stroke={K.c} strokeWidth="0.5"/>
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#hexgrid)"/>
              </svg>
              {/* Radial depth gradient */}
              <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at center, #0A1628 0%, #04060D 65%, #030508 100%)",pointerEvents:"none"}}/>
              {/* Scan lines */}
              <div style={{position:"absolute",inset:0,background:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)",pointerEvents:"none"}}/>
              {/* Header */}
              <div style={{padding:"5px 12px 4px",borderBottom:"1px solid #060A14",display:"flex",justifyContent:"space-between",alignItems:"center",position:"relative",zIndex:1}}>
                <div style={{fontSize:8,color:K.dim,letterSpacing:".12em"}}>◈ NEURAL SWARM — 6 COGNITIVE AGENTS</div>
                <div style={{display:"flex",gap:8,fontSize:8}}>
                  {([["APPROVE",K.g],["REJECT",K.r],["ACTIVE",K.c]] as Array<[string,string]>).map(([l,c])=><span key={l} style={{color:c}}>● {l}</span>)}
                </div>
              </div>
              <div style={{flex:1,display:"flex",flexDirection:"column",justifyContent:"center",alignItems:"center",padding:4,position:"relative",zIndex:1,boxShadow:"inset 0 0 60px rgba(0,0,0,0.55)",overflow:isMobile?"auto":"visible"}}>
                {!running&&<ActivateScreen onActivate={handleStart} swarmConfig={swarmConfig} user={user}/>}
                <SwarmGraph st={realAgSt} debate={[]} disabled={new Set<string>()} swarmRef={swarmRef} flashingAgent={null} highConviction={highConviction} convCol={convCol} isMobile={isMobile} agents={REAL_AGENTS} conns={REAL_CONNS}/>
                {/* Agent legend */}
                <div style={{display:'flex',gap:10,justifyContent:'center',marginTop:6,flexWrap:'wrap'}}>
                  {REAL_AGENTS.filter(a=>a.id!=='confluence').map(a=>{
                    const v=realAgSt[a.id];
                    const c=v?.sig==='BUY'?K.g:v?.sig==='SELL'?K.r:K.dim;
                    return(<div key={a.id} style={{display:'flex',alignItems:'center',gap:3}}>
                      <div style={{width:5,height:5,borderRadius:'50%',background:c,boxShadow:`0 0 4px ${c}`}}/>
                      <span style={{fontSize:6,color:c,fontFamily:'monospace'}}>{a.s}</span>
                    </div>);
                  })}
                </div>
                {/* Focus mode: Globe overlay in top-left */}
                {focusMode&&<div style={{position:"absolute",top:8,left:8,zIndex:10,opacity:.85,borderRadius:4,overflow:"hidden",border:"1px solid "+K.c+"30"}}><Globe3D trades={trades} blackSwan={blackSwan} whaleAlert={whaleAlert} totalPnL={totalPnL} tradeCount={trades.length} agSt={agSt} running={running}/></div>}
              </div>
            </div>
          </div>

          {/* RIGHT */}
          <div style={{gridRow:isMobile?"2":"1/3",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
            <div className="panel" style={{overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:190}}>
              <div style={{fontSize:11,color:K.dim,padding:"6px 10px 4px",borderBottom:"1px solid #060A14",letterSpacing:".12em"}}>◉ SIGNAL STREAM</div>
              <div style={{overflow:"auto",flex:1}}>
                {REAL_AGENTS.filter(a=>a.id!=="confluence").map(({id,s})=>{
                  const ag=realAgSt[id]||{on:false,conf:null,sig:null,th:""};
                  const col=ag.sig==="BUY"?K.g:ag.sig==="SELL"?K.r:K.tx;
                  const conf=ag.conf||0;
                  const circ=2*Math.PI*10;
                  return(
                    <div key={id} className="fi" style={{padding:"5px 10px",borderBottom:"1px solid #040910",display:"flex",gap:7,alignItems:"center",borderLeft:"2px solid "+col+"40",opacity:ag.on?1:0.4}}>
                      <svg width="24" height="24" style={{flexShrink:0}}>
                        <circle cx="12" cy="12" r="10" fill="none" stroke={K.brd} strokeWidth="2"/>
                        <circle cx="12" cy="12" r="10" fill="none" stroke={col} strokeWidth="2" strokeDasharray={`${conf/100*circ} ${circ}`} strokeLinecap="round" transform="rotate(-90 12 12)" opacity=".8"/>
                        <text x="12" y="15" textAnchor="middle" fontSize="8" fontFamily="monospace" fill={col}>{conf||"—"}</text>
                      </svg>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",gap:5,alignItems:"center",marginBottom:1}}>
                          <span style={{padding:"1px 5px",background:col+"15",color:col,border:"1px solid "+col+"30",fontSize:11,borderRadius:1}}>{ag.sig==="BUY"?"▲":ag.sig==="SELL"?"▼":"◆"} {s}</span>
                          {ag.on&&<span style={{padding:"1px 4px",background:K.g+"20",color:K.g,border:"1px solid "+K.g+"40",fontSize:6,borderRadius:1,letterSpacing:".06em"}}>LIVE</span>}
                        </div>
                        <div style={{fontSize:11,color:K.tx,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:150}}>{ag.th||"Waiting for data…"}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {Object.keys(pendingEntries).length>0&&(
              <div style={{padding:"7px 9px",background:K.gold+"06",border:"1px solid "+K.gold+"20",borderRadius:3,marginBottom:0}}>
                <div style={{fontSize:7,color:K.gold,marginBottom:4,letterSpacing:".12em"}}>⏳ PENDING ENTRIES</div>
                {Object.entries(pendingEntries).map(([sym,e])=>(
                  <div key={sym} style={{display:"flex",justifyContent:"space-between",fontSize:8,color:K.dim,fontFamily:"monospace",marginBottom:1}}>
                    <span style={{color:K.tx}}>{sym} {e.signal}</span>
                    <span>→ {fPrice(e.target)}</span>
                    <span style={{color:K.dim,fontSize:7}}>{Math.max(0,Math.round((e.expiry-Date.now())/1000))}s</span>
                  </div>
                ))}
              </div>
            )}
            <div className="panel" style={{padding:9,flex:1,overflow:"auto"}}>
              {/* Session stats bar — real engine decisions */}
              {(()=>{
                const CLOSED_CODES=['EPISODE_CLOSED','EPISODE_CLOSED_SL','EPISODE_CLOSED_TP'];
                const closed=(decisionsFeed??[]).filter(d=>CLOSED_CODES.includes(d.decision)&&!d.reason?.includes('[BACKFILLED_SL'));
                const wins=closed.filter(d=>(d.pnl_pct??0)>0);
                const wr=closed.length>0?(wins.length/closed.length*100).toFixed(0):'—';
                const netPnl=closed.reduce((s,d)=>s+(d.pnl_pct??0),0);
                const netCol=netPnl>=0?K.g:K.r;
                return(
                  <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,padding:'8px 12px',background:'rgba(4,6,13,0.9)',border:'1px solid #0A1D33',borderRadius:6,marginBottom:12}}>
                    {([{l:'EPISODES',v:decisionsFeed===null?'…':closed.length,c:K.c},{l:'WIN RATE',v:decisionsFeed===null?'…':`${wr}%`,c:K.g},{l:'NET P&L',v:decisionsFeed===null?'…':`${netPnl>=0?'+':''}${netPnl.toFixed(1)}%`,c:netCol}] as {l:string,v:string|number,c:string}[]).map((s,i)=>(
                      <div key={i} style={{textAlign:'center'}}>
                        <div style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>{s.l}</div>
                        <div style={{fontSize:13,fontWeight:700,color:s.c,fontFamily:'monospace',marginTop:2}}>{s.v}</div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              {(()=>{
                const pCol=pressureDir==='BULL'?K.g:pressureDir==='BEAR'?K.r:K.dim;
                const regimeTotal=agentFeed?Object.values(agentFeed.by_symbol).flat().filter(v=>v.agent==='regime').length:0;
                return(
                  <div style={{marginBottom:10,padding:'8px 12px',background:'rgba(4,6,13,0.9)',border:'1px solid #0A1D33',borderRadius:6}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                      <span style={{fontSize:8,color:K.dim,fontFamily:'monospace',letterSpacing:'.12em'}}>◈ MARKET PRESSURE</span>
                      <span style={{fontSize:9,color:pCol,fontFamily:'monospace',fontWeight:700}}>{pressureDir} {pressureScore}%{regimeTotal?` · ${regimeTotal}s`:""}</span>
                    </div>
                    <div style={{height:4,background:'rgba(255,255,255,0.05)',borderRadius:2,overflow:'hidden'}}>
                      <div style={{height:'100%',width:`${pressureScore}%`,background:`linear-gradient(90deg,${K.r},${K.dim} 40%,${K.g})`,borderRadius:2,transition:'width 0.8s ease'}}/>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',marginTop:4}}>
                      <span style={{fontSize:7,color:K.r,fontFamily:'monospace'}}>BEAR</span>
                      <span style={{fontSize:7,color:K.dim,fontFamily:'monospace'}}>NEUTRAL</span>
                      <span style={{fontSize:7,color:K.g,fontFamily:'monospace'}}>BULL</span>
                    </div>
                  </div>
                );
              })()}
              <div style={{fontSize:8,color:K.dim,marginBottom:6,letterSpacing:".12em"}}>◉ POSITIONS</div>
              {positionsFeed===null
                ?<div style={{textAlign:"center",color:K.dim,padding:"12px 0",fontSize:9}}>Loading…</div>
                :positionsFeed.length===0
                  ?<div style={{textAlign:"center",color:"#0A1E30",padding:"12px 0",fontSize:9}}>No open positions</div>
                  :positionsFeed.map((pos)=>{
                    const priceEntry=prices[pos.symbol];
                    const hasRealPrice=!!priceEntry?.isRealPrice;
                    const cur=hasRealPrice?priceEntry!.price:null;
                    const pct2=cur!=null?((cur-pos.entry_price)/pos.entry_price*100):null;
                    const col=pct2!=null?(pct2>=0?K.g:K.r):K.c;
                    const openedAgo=Math.round((Date.now()-new Date(pos.opened_at).getTime())/60000);
                    return(
                      <div key={pos.symbol} style={{padding:'10px 12px',background:'rgba(6,10,18,0.9)',border:`1px solid ${col}30`,borderLeft:`3px solid ${col}`,borderRadius:8,marginBottom:8}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                          <div style={{display:'flex',gap:8,alignItems:'center'}}>
                            <span style={{fontSize:15,fontWeight:900,color:col,fontFamily:'monospace'}}>{pos.symbol}</span>
                            <span style={{padding:'1px 6px',background:'#00F2FE15',border:'1px solid #00F2FE30',borderRadius:3,fontSize:8,color:K.c,fontWeight:700}}>{pos.mode}</span>
                          </div>
                          <div style={{textAlign:'right'}}>
                            {pct2!=null
                              ?<div style={{fontSize:14,fontWeight:900,color:col,fontFamily:'monospace'}}>{pct2>=0?'+':''}{pct2.toFixed(2)}%</div>
                              :<div style={{fontSize:11,color:K.dim,fontFamily:'monospace'}}>—</div>
                            }
                          </div>
                        </div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                          <div style={{padding:'5px 7px',background:'rgba(4,6,13,0.8)',borderRadius:4}}>
                            <div style={{fontSize:7,color:K.dim,fontFamily:'monospace'}}>ENTRY</div>
                            <div style={{fontSize:10,color:K.c,fontWeight:700,fontFamily:'monospace',marginTop:1}}>{fPrice(pos.entry_price)}</div>
                          </div>
                          <div style={{padding:'5px 7px',background:'rgba(4,6,13,0.8)',borderRadius:4}}>
                            <div style={{fontSize:7,color:K.dim,fontFamily:'monospace'}}>CURRENT</div>
                            <div style={{fontSize:10,color:hasRealPrice?'white':K.dim,fontWeight:700,fontFamily:'monospace',marginTop:1}}>{cur!=null?fPrice(cur):'—'}</div>
                          </div>
                        </div>
                        <div style={{fontSize:8,color:'#1A3050',fontFamily:'monospace',marginTop:5}}>{openedAgo}m ago · {new Date(pos.opened_at).toLocaleTimeString("en-US",{hour12:false})}</div>
                      </div>
                    );
                  })}
            </div>
            {(()=>{
              const closed=trades.filter(t=>t.pnl!==0);
              const last10=closed.slice(0,10);
              const wins=last10.filter(t=>t.pnl>0);
              const losses10=last10.filter(t=>t.pnl<0);
              const wr10=last10.length?wins.length/last10.length*100:0;
              const avgWin=wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length:0;
              const avgLoss=losses10.length?Math.abs(losses10.reduce((s,t)=>s+t.pnl,0)/losses10.length):0;
              const totalG=closed.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
              const totalL=Math.abs(closed.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
              const pf=totalL>0?totalG/totalL:totalG>0?9.99:0;
              const edge=Math.min(100,Math.round(wr10*.45+(Math.min(pf,5)*8)+(last10.length>=5?15:last10.length*3)));
              const edgeCol=edge>=70?K.g:edge>=45?K.gold:K.r;
              return(
                <div className="panel" style={{padding:9}}>
                  <div style={{fontSize:8,color:K.dim,marginBottom:6,letterSpacing:".12em"}}>◉ ALGO PERFORMANCE</div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:6}}>
                    <div>
                      <div style={{fontSize:6,color:K.dim,marginBottom:1}}>EDGE SCORE</div>
                      <div style={{fontSize:20,fontWeight:900,color:edgeCol,textShadow:"0 0 10px "+edgeCol}}>{edge}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:6,color:K.dim}}>10-TRADE WIN RATE</div>
                      <div style={{fontSize:14,fontWeight:700,color:wr10>=50?K.g:K.r}}>{f2(wr10,0)}%</div>
                    </div>
                  </div>
                  <div style={{height:3,background:"#050810",borderRadius:1,marginBottom:6}}>
                    <div style={{height:"100%",borderRadius:1,background:edgeCol,width:edge+"%",transition:"width .5s"}}/>
                  </div>
                  {([
                    {l:"AVG WIN",v:avgWin>0?"+$"+f2(avgWin):"—",c:K.g},
                    {l:"AVG LOSS",v:avgLoss>0?"-$"+f2(avgLoss):"—",c:K.r},
                    {l:"PROFIT FACTOR",v:pf>0?f2(Math.min(pf,9.99))+"x":"—",c:pf>=2?K.g:pf>=1?K.gold:K.r},
                    {l:"TRADES (10)",v:last10.length+"/10",c:K.tx},
                  ] as Array<{l:string,v:string,c:string}>).map((r,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:i<3?"1px solid #040910":"none",fontSize:8}}>
                      <span style={{color:K.dim}}>{r.l}</span><span style={{color:r.c,fontWeight:600}}>{r.v}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
            <div className="panel" style={{padding:9}}>
              <div style={{fontSize:8,color:K.dim,marginBottom:5,letterSpacing:".12em"}}>◉ STATUS</div>
              {(()=>{
                const btcChg=prices["BTC"]?.change??0;
                const macroStr=btcChg<=-TRADER_RULES.macroBtcThreshold?"BEARISH":btcChg>=TRADER_RULES.macroBtcThreshold?"BULLISH":"NEUTRAL";
                const macroCol=btcChg<=-TRADER_RULES.macroBtcThreshold?K.r:btcChg>=TRADER_RULES.macroBtcThreshold?K.g:K.tx;
                const peakStr=isPeakHour()?"NY/EU OPEN":"OFF-PEAK";
                const peakCol=isPeakHour()?K.g:K.dim;
                const lossStreakStr=traderConsecLosses===0?"CLEAN":traderConsecLosses+"x STREAK";
                const lossStreakCol=traderConsecLosses>=3?K.r:traderConsecLosses>=2?K.gold:K.g;
                const scaleModeStr=traderScaleMode?"ACTIVE":"INIT 7%";
                const scaleModeCol=traderScaleMode?K.c:K.tx;
                return([
                  {l:"Execution",v:circuit?"LOCKED":traderIsPaused?"PAUSED":"ACTIVE",c:circuit?K.r:traderIsPaused?K.gold:K.g},
                  {l:"SL/TP",v:"Tiered Trail",c:K.tx},
                  {l:"Agents",v:(()=>{if(!agentFeed)return"…/6";const allV=Object.values(agentFeed.by_symbol).flat();const latestC=allV.reduce((mx,v)=>v.cycle_ts>mx?v.cycle_ts:mx,"");const n=new Set(allV.filter(v=>v.cycle_ts===latestC).map(v=>v.agent)).size;return`${n}/6`;})(),c:K.g},
                  {l:"Positions",v:Object.keys(port.pos).length+"/"+getMaxPositions(port.equity||port.cash),c:K.tx},
                  {l:"PEAK HOURS",v:peakStr,c:peakCol},
                  {l:"MACRO TREND",v:"BTC "+macroStr,c:macroCol},
                  {l:"LOSS STREAK",v:lossStreakStr,c:lossStreakCol},
                  {l:"SCALE MODE",v:scaleModeStr,c:scaleModeCol},
                ] as Array<{l:string,v:string,c:string}>).map((r,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:i<8?"1px solid #040910":"none",fontSize:10}}>
                    <span style={{color:i>=5?K.dim+"CC":K.dim,fontSize:i>=5?8:10}}>{r.l}</span>
                    <span style={{color:r.c,fontWeight:600,fontSize:i>=5?9:13}}>{r.v}</span>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* BOTTOM CENTER — Decision Zone + Log, always visible */}
          <div style={{gridColumn:isMobile?"1":"2/3",overflow:"hidden",display:"flex",flexDirection:"column",gap:4,maxHeight:isMobile?"45vh":undefined}}>
            {/* Decision Zone */}
            <div style={{flexShrink:0}}>
              <DecisionZone agSt={agSt} running={running} onExecute={()=>{}}/>
            </div>
            {/* Log — fills remaining space, always visible */}
            <div className="panel" style={{flex:isMobile?"none":1,overflow:"hidden",display:"flex",flexDirection:"column",minHeight:0,maxHeight:isMobile?"28vh":undefined}}>
              <div style={{padding:"3px 10px",borderBottom:"1px solid #060A14",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  {running&&<div style={{width:4,height:4,borderRadius:"50%",background:K.c,animation:"pu 1s infinite"}}/>}
                  <div style={{fontSize:8,color:K.dim,letterSpacing:".12em"}}>◉ LIVE REASONING</div>
                </div>
                <button className="btn" onClick={()=>setLogs([{t:ts(),ag:"SYS",msg:"Log cleared",col:K.tx}])} style={{background:"#040810",color:K.dim,border:"1px solid "+K.brd,padding:"2px 8px",fontSize:8}}>CLR</button>
              </div>
              <div ref={logRef} style={{flex:1,overflowY:"auto",padding:"2px 0",scrollBehavior:"smooth"}}>
                {(isMobile?logs.slice(-5):logs).map((e,i)=>(
                  <div key={i} className="log-entry" style={{display:"flex",gap:7,padding:"2px 10px",borderBottom:"1px solid #030810"}}>
                    <span style={{color:K.dim,minWidth:46,fontSize:11,whiteSpace:"nowrap"}}>{e.t}</span>
                    <span style={{color:"#0D1E30",minWidth:52,fontSize:11,fontWeight:600}}>[{e.ag}]</span>
                    <span style={{color:e.col,fontSize:11}}>{e.msg}</span>
                  </div>
                ))}
                {analyzing&&<div style={{display:"flex",gap:7,padding:"2px 10px"}}>
                  <span style={{color:K.dim,minWidth:46,fontSize:11}}>{ts()}</span>
                  <span style={{color:"#0D1E30",minWidth:52,fontSize:11}}>[CLAUDE]</span>
                  <span style={{color:K.c,fontSize:11,animation:"pu 1s infinite"}}>⟳ Debate running...</span>
                </div>}
              </div>
            </div>
          </div>
        </div>
        );
      })()}

      {tab==="trades"&&(()=>{
        const CLOSED_CODES=['EPISODE_CLOSED','EPISODE_CLOSED_SL','EPISODE_CLOSED_TP'];
        const now2=Date.now();
        const periodMs2:Record<string,number>={"1H":36e5,"3H":108e5,"24H":864e5,"7D":6048e5,"ALL":Infinity};
        const cutoff2=periodMs2[histFilter];
        const allClosed=(decisionsFeed??[]).filter(d=>CLOSED_CODES.includes(d.decision)&&!d.reason?.includes('[BACKFILLED_SL'));
        const filtered2=allClosed.filter(d=>cutoff2===Infinity||now2-new Date(d.timestamp).getTime()<cutoff2);
        const sorted2=histSort==="pnl"?[...filtered2].sort((a,b)=>(b.pnl_pct??0)-(a.pnl_pct??0)):[...filtered2];
        const periodPnL2=filtered2.reduce((s,d)=>s+(d.pnl_pct??0),0);
        const wins2=filtered2.filter(d=>(d.pnl_pct??0)>0);
        const wr2=filtered2.length?wins2.length/filtered2.length*100:0;
        return(
          <div style={{flex:1,padding:10,overflow:"auto",display:"flex",flexDirection:"column",gap:8}}>
            {/* Toolbar */}
            <div className="panel" style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
              <div style={{display:"flex",gap:4}}>
                {(["1H","3H","24H","7D","ALL"] as const).map(f=>(
                  <button key={f} onClick={()=>setHistFilter(f)} className="btn" style={{padding:"3px 9px",background:histFilter===f?K.c+"20":"#040810",color:histFilter===f?K.c:K.dim,border:"1px solid "+(histFilter===f?K.c+"50":K.brd)}}>{f}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:4}}>
                {(["time","pnl"] as const).map(s=>(
                  <button key={s} onClick={()=>setHistSort(s)} className="btn" style={{padding:"3px 9px",background:histSort===s?K.gold+"15":"#040810",color:histSort===s?K.gold:K.dim,border:"1px solid "+(histSort===s?K.gold+"40":K.brd)}}>SORT: {s.toUpperCase()}</button>
                ))}
              </div>
              <div style={{marginLeft:"auto",display:"flex",gap:16,fontSize:10}}>
                <div style={{textAlign:"right"}}><div style={{fontSize:7,color:K.dim}}>NET P&L</div><div style={{color:periodPnL2>=0?K.g:K.r,fontWeight:700}}>{periodPnL2>=0?"+":""}{periodPnL2.toFixed(1)}%</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:7,color:K.dim}}>WIN RATE</div><div style={{color:wr2>=50?K.g:K.r,fontWeight:700}}>{filtered2.length?f2(wr2,0)+"%" :"—"}</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:7,color:K.dim}}>EPISODES</div><div style={{color:K.c,fontWeight:700}}>{decisionsFeed===null?"…":filtered2.length}</div></div>
              </div>
            </div>
            {/* Episode list */}
            <div className="panel" style={{overflow:"auto",flex:1}}>
              {decisionsFeed===null
                ?<div style={{padding:50,textAlign:"center",color:K.dim,fontSize:10}}>Loading…</div>
                :sorted2.length===0
                  ?<div style={{padding:50,textAlign:"center",color:"#0A1E30",fontSize:10}}>No closed episodes in this period</div>
                  :sorted2.map((d,i)=>{
                    const pnl=d.pnl_pct??0;
                    const col=pnl>=0?K.g:K.r;
                    const isSL=d.decision==="EPISODE_CLOSED_SL";
                    const label=isSL?"SL":d.decision==="EPISODE_CLOSED_TP"?"TP":"CLOSE";
                    return(
                      <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',borderBottom:'1px solid #06090F',borderLeft:`2px solid ${col}`}}>
                        <div>
                          <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:3}}>
                            <span style={{fontSize:12,fontWeight:700,color:col,fontFamily:'monospace'}}>{d.symbol}</span>
                            <span style={{fontSize:8,padding:'1px 5px',background:col+'18',border:`1px solid ${col}30`,borderRadius:2,color:col}}>{label}</span>
                            {d.regime&&<span style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>{d.regime}</span>}
                          </div>
                          {d.price_usd!=null&&<div style={{fontSize:9,color:K.dim,fontFamily:'monospace'}}>{fPrice(d.price_usd)}</div>}
                          <div style={{fontSize:8,color:'#1A3050',fontFamily:'monospace',marginTop:2}}>KYMIA · {new Date(d.timestamp).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})}</div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <div style={{fontSize:16,fontWeight:900,color:col,fontFamily:'monospace',textShadow:`0 0 8px ${col}`}}>{pnl>=0?'+':''}{pnl.toFixed(2)}%</div>
                          {d.score_total!=null&&<div style={{fontSize:8,color:K.dim,fontFamily:'monospace',marginTop:2}}>score {Math.round(d.score_total)}</div>}
                        </div>
                      </div>
                    );
                  })}
            </div>
          </div>
        );
      })()}

      {tab==="scanner"&&(
        <div style={{flex:1,padding:10,overflow:"auto",display:"flex",flexDirection:"column",gap:8}}>
          <div className="panel" style={{padding:"8px 12px",display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:9,color:K.c,letterSpacing:".1em"}}>⊕ NEW TOKEN SCANNER</span>
            <span style={{fontSize:8,color:K.dim}}>DexScreener · Solana · auto-refresh 60s</span>
            <button className="btn" onClick={scanNewTokens} disabled={scannerLoading} style={{marginLeft:"auto",padding:"2px 10px",background:K.c+"10",color:K.c,border:"1px solid "+K.c+"30"}}>{scannerLoading?"⟳ SCANNING...":"↻ REFRESH"}</button>
          </div>
          {newTokens.length===0
            ?<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:K.dim,fontSize:11}}>{scannerLoading?"Scanning DexScreener...":"No tokens loaded yet"}</div>
            :<div className="panel" style={{overflow:"auto",flex:1}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{fontSize:8,color:K.dim,borderBottom:"1px solid #060A14",position:"sticky",top:0,background:K.pan}}>
                  {["TOKEN","PRICE","1H%","VOL 24H","LIQUIDITY","BUY/SELL","RUG SCORE"].map(h=><th key={h} style={{padding:"6px 10px",textAlign:"left",fontWeight:400,letterSpacing:".06em"}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {newTokens.map((t,i)=>{
                    const rs=t.rugScore;
                    const rCol=rs<30?K.g:rs<60?K.gold:K.r;
                    const chCol=t.change1h>=0?K.g:K.r;
                    return(
                      <tr key={i} className="tr" style={{borderBottom:"1px solid #040910",borderLeft:"2px solid "+rCol+"30"}}>
                        <td style={{padding:"5px 10px",color:K.c,fontWeight:700,fontSize:10}}>{t.name}</td>
                        <td style={{padding:"5px 10px",color:K.hi,fontSize:9}}>${parseFloat(t.price||"0").toPrecision(4)}</td>
                        <td style={{padding:"5px 10px",color:chCol,fontSize:9,fontWeight:700}}>{t.change1h>=0?"+":""}{t.change1h.toFixed(1)}%</td>
                        <td style={{padding:"5px 10px",color:K.tx,fontSize:9}}>${t.volume24h>=1e6?(t.volume24h/1e6).toFixed(1)+"M":t.volume24h>=1e3?(t.volume24h/1e3).toFixed(0)+"K":t.volume24h.toFixed(0)}</td>
                        <td style={{padding:"5px 10px",color:K.tx,fontSize:9}}>${t.liquidity>=1e6?(t.liquidity/1e6).toFixed(1)+"M":t.liquidity>=1e3?(t.liquidity/1e3).toFixed(0)+"K":t.liquidity.toFixed(0)}</td>
                        <td style={{padding:"5px 10px",fontSize:9}}>
                          <span style={{color:K.g}}>{t.buys}▲</span><span style={{color:K.dim}}>/</span><span style={{color:K.r}}>{t.sells}▼</span>
                        </td>
                        <td style={{padding:"5px 10px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:5}}>
                            <div style={{width:36,height:4,background:"#040910",borderRadius:2}}>
                              <div style={{width:rs+"%",height:"100%",background:rCol,borderRadius:2}}/>
                            </div>
                            <span style={{fontSize:9,color:rCol,fontWeight:700}}>{rs}</span>
                            <span style={{fontSize:7,color:rCol}}>{rs<30?"SAFE":rs<60?"WARN":"RISK"}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>}
        </div>
      )}



      {tab==="onchain"&&<OnChainTab/>}

      {/* ── Part 14: ALPHA RADAR TAB ── */}
      {tab==="alpha"&&(
        <div style={{padding:16,display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,overflow:'auto'}}>
          {/* Alpha Radar — top opportunities */}
          <div className="panel" style={{padding:0,overflow:'hidden'}}>
            <div style={{padding:'8px 10px',fontSize:8,color:'#00F2FE',letterSpacing:'.2em',fontFamily:'monospace',borderBottom:'1px solid #0A1D33'}}>◈ ALPHA RADAR — TOP OPPORTUNITIES</div>
            {(()=>{
              const watchSyms=['SOL','BTC','ETH','JUP','WIF','BONK','JTO','PYTH','RAY','ORCA','RENDER','POPCAT'];
              const scored=watchSyms
                .filter(sym=>prices[sym])
                .map(sym=>({sym,score:calcOpportunityScore(sym,prices,agSt,regimeState)}))
                .sort((a,b)=>b.score.total-a.score.total)
                .slice(0,8);
              return scored.map((opp,i)=>{
                const col=opp.score.grade==='A'?'#00FF88':opp.score.grade==='B'?'#FFD700':'#2A5070';
                return(
                  <div key={opp.sym} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',borderBottom:'1px solid #06090F',background:i===0?'rgba(0,255,136,0.03)':'transparent'}}>
                    <span style={{fontSize:9,color:K.dim,fontFamily:'monospace',minWidth:14}}>{i+1}</span>
                    <span style={{fontSize:11,fontWeight:700,color:col,fontFamily:'monospace',flex:1}}>{opp.sym}</span>
                    <div style={{width:50,height:4,background:'#06090F',borderRadius:2}}>
                      <div style={{height:'100%',borderRadius:2,width:`${opp.score.total}%`,background:col}}/>
                    </div>
                    <span style={{fontSize:10,fontWeight:700,color:col,fontFamily:'monospace',minWidth:28,textAlign:'right'}}>{opp.score.total}</span>
                    <span style={{fontSize:9,color:col,fontFamily:'monospace'}}>{opp.score.grade}</span>
                  </div>
                );
              });
            })()}
          </div>
          {/* Regime + Capital Allocation */}
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            {regimeState&&(
              <div className="panel" style={{padding:'12px 14px'}}>
                <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:10,fontFamily:'monospace'}}>◈ MARKET REGIME</div>
                <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                  <div style={{width:10,height:10,borderRadius:'50%',background:REGIME_CONFIG[regimeState.regime].col,boxShadow:`0 0 12px ${REGIME_CONFIG[regimeState.regime].col}`}}/>
                  <div style={{fontSize:20,fontWeight:900,color:REGIME_CONFIG[regimeState.regime].col,fontFamily:'monospace'}}>{regimeState.regime}</div>
                  <div style={{marginLeft:'auto',fontSize:14,fontWeight:700,color:regimeState.direction==='BULL'?K.g:regimeState.direction==='BEAR'?K.r:K.gold,fontFamily:'monospace'}}>{regimeState.direction}</div>
                </div>
                <div style={{fontSize:9,color:K.dim,fontFamily:'monospace',marginBottom:6}}>{regimeState.description}</div>
                {[{l:'Confidence',v:`${regimeState.confidence.toFixed(0)}%`,c:REGIME_CONFIG[regimeState.regime].col},{l:'ADX',v:regimeState.adx.toFixed(1),c:K.hi},{l:'Max Exposure',v:`${(REGIME_CONFIG[regimeState.regime].maxExposure*100).toFixed(0)}%`,c:K.gold}].map((r,i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:9,fontFamily:'monospace',padding:'2px 0'}}>
                    <span style={{color:K.dim}}>{r.l}</span><span style={{color:r.c,fontWeight:700}}>{r.v}</span>
                  </div>
                ))}
                <div style={{marginTop:8,fontSize:8,color:K.dim,fontFamily:'monospace'}}>Dominant: {regimeState.dominantAgents.join(' · ')}</div>
              </div>
            )}
            {/* Capital Allocation Map (Part 10) */}
            <div className="panel" style={{padding:'12px 14px'}}>
              <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:12,fontFamily:'monospace'}}>◈ PORTFOLIO ALLOCATION</div>
              {(()=>{
                const totalEquity=port.equity;
                const coreSyms=['SOL','BTC','ETH','JUP'];
                const coreExp=Object.entries(port.pos).filter(([s])=>coreSyms.includes(s)).reduce((sum,[s,pos])=>sum+(pos.qty*(prices[s]?.price||pos.avg)),0);
                const oppExp=Object.entries(port.pos).filter(([s])=>!coreSyms.includes(s)).reduce((sum,[s,pos])=>sum+(pos.qty*(prices[s]?.price||pos.avg)),0);
                const cash2=Math.max(0,totalEquity-coreExp-oppExp);
                const allocs=[{l:'CORE ASSETS',v:coreExp,col:'#00F2FE'},{l:'OPPORTUNITIES',v:oppExp,col:'#BD00FF'},{l:'CASH',v:cash2,col:'#2A5070'}];
                return(<>
                  <div style={{height:8,borderRadius:4,overflow:'hidden',display:'flex',marginBottom:12}}>
                    {allocs.map((a,i)=>{const pct=totalEquity>0?(a.v/totalEquity)*100:0;return pct>0?<div key={i} style={{width:`${pct}%`,height:'100%',background:a.col,transition:'width .5s'}}/>:null;})}
                  </div>
                  {allocs.map((a,i)=>{
                    const pct=totalEquity>0?(a.v/totalEquity*100).toFixed(0):0;
                    return(<div key={i} style={{display:'flex',justifyContent:'space-between',marginBottom:5}}>
                      <div style={{display:'flex',alignItems:'center',gap:6}}><div style={{width:6,height:6,borderRadius:1,background:a.col}}/><span style={{fontSize:9,color:K.dim,fontFamily:'monospace'}}>{a.l}</span></div>
                      <div style={{display:'flex',gap:8}}><span style={{fontSize:9,color:a.col,fontFamily:'monospace',fontWeight:700}}>{pct}%</span><span style={{fontSize:9,color:'#1A3050',fontFamily:'monospace'}}>${a.v.toFixed(0)}</span></div>
                    </div>);
                  })}
                  <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid #06090F',display:'flex',justifyContent:'space-between',fontSize:9,fontFamily:'monospace'}}>
                    <span style={{color:K.dim}}>TOTAL EQUITY</span><span style={{color:'white',fontWeight:700}}>${totalEquity.toFixed(2)}</span>
                  </div>
                </>);
              })()}
            </div>
          </div>
          {/* Active signals with decay (Part 6) */}
          {activeSignals.length>0&&(
            <div className="panel" style={{padding:'10px',gridColumn:'1/-1'}}>
              <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:8,fontFamily:'monospace'}}>◈ ACTIVE SIGNALS — CONFIDENCE DECAY</div>
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                {activeSignals.map(s=><SignalDecayBadge key={s.id} signal={s}/>)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Part 14: HUNTER TAB ── */}
      {tab==="hunter"&&(
        <div style={{padding:16,display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,overflow:'auto'}}>
          {/* Token Watchlist (Part 9) */}
          <div className="panel" style={{padding:0,overflow:'hidden'}}>
            <div style={{padding:'6px 10px',fontSize:8,color:K.gold,letterSpacing:'.2em',fontFamily:'monospace',borderBottom:'1px solid #0A1D33'}}>◈ NEW TOKEN WATCHLIST</div>
            {tokenWatchlist.length===0?(
              <div style={{padding:'20px 10px',fontSize:9,color:'#0A1D33',fontFamily:'monospace',textAlign:'center'}}>Scanning DexScreener...</div>
            ):tokenWatchlist.map((t,i)=>{
              const sc=t.status==='ENTRY_CANDIDATE'?'#00FF88':t.status==='CONFIRMING'?K.gold:t.status==='REJECTED'?'#FF3366':'#00F2FE';
              return(
                <div key={i} style={{padding:'8px 10px',borderBottom:'1px solid #06090F',borderLeft:`2px solid ${sc}60`,opacity:t.status==='REJECTED'?0.4:1}}>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                    <div>
                      <span style={{fontSize:11,fontWeight:700,color:sc,fontFamily:'monospace'}}>{t.sym}</span>
                      <span style={{fontSize:8,color:sc,marginLeft:6,padding:'1px 5px',background:`${sc}15`,border:`1px solid ${sc}30`,borderRadius:3,fontFamily:'monospace'}}>{t.status.replace('_',' ')}</span>
                    </div>
                    <div style={{fontSize:9,color:'#00FF88',fontFamily:'monospace'}}>+{t.priceChange1h?.toFixed(0)||0}% 1H</div>
                  </div>
                  <div style={{display:'flex',gap:12,fontSize:9,color:K.dim,fontFamily:'monospace',marginBottom:5}}>
                    <span>Safety {t.safetyScore}</span><span>Liq ${(t.liquidity/1000).toFixed(0)}K</span><span>Vol ${(t.volume1h/1000).toFixed(0)}K</span>
                  </div>
                  {t.status!=='REJECTED'&&(
                    <div>
                      <div style={{height:2,background:'#06090F',borderRadius:1}}>
                        <div style={{height:'100%',width:`${t.confirmationProgress}%`,background:sc,borderRadius:1,transition:'width .5s'}}/>
                      </div>
                      <div style={{fontSize:7,color:K.dim,fontFamily:'monospace',marginTop:2}}>Monitoring: {t.confirmationProgress.toFixed(0)}% of 15min</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* Layer 3 Aggressive Toggle (Part 11) */}
          <div style={{display:'flex',flexDirection:'column',gap:12}}>
            <div className="panel" style={{padding:'12px 14px'}}>
              <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:12,fontFamily:'monospace'}}>◈ LAYER 3 MODE</div>
              <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 10px',background:'rgba(6,10,18,0.8)',border:`1px solid ${layer3Aggressive?'rgba(255,51,102,0.3)':'rgba(0,242,254,0.15)'}`,borderRadius:6}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:9,fontWeight:700,color:LAYER3_CONFIG.col,fontFamily:'monospace'}}>LAYER 3 — {LAYER3_CONFIG.label}</div>
                  <div style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>{layer3Aggressive?'⚡ 6% max · 5min monitoring · Lower filters':'🛡 3% max · 15min monitoring · Strict filters'}</div>
                </div>
                <button onClick={()=>setLayer3Aggressive(!layer3Aggressive)} style={{padding:'6px 12px',background:layer3Aggressive?'rgba(255,51,102,0.15)':'rgba(0,242,254,0.1)',border:`1px solid ${layer3Aggressive?'rgba(255,51,102,0.4)':'rgba(0,242,254,0.3)'}`,borderRadius:4,cursor:'pointer',color:LAYER3_CONFIG.col,fontFamily:'monospace',fontSize:10,fontWeight:700}}>
                  {layer3Aggressive?'ON ▶':'OFF ◼'}
                </button>
              </div>
              <div style={{marginTop:12,display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
                {[{l:'Min Safety',v:LAYER3_CONFIG.minSafety},{l:'Min Momentum',v:LAYER3_CONFIG.minMomentum},{l:'Max Alloc',v:`${(LAYER3_CONFIG.maxAlloc*100).toFixed(0)}%`},{l:'Watch Time',v:`${LAYER3_CONFIG.watchlistTime/60000}min`}].map((r,i)=>(
                  <div key={i} style={{padding:'6px 8px',background:'rgba(4,6,13,0.8)',border:'1px solid #0A1D33',borderRadius:3}}>
                    <div style={{fontSize:7,color:K.dim,fontFamily:'monospace',marginBottom:2}}>{r.l}</div>
                    <div style={{fontSize:11,color:LAYER3_CONFIG.col,fontFamily:'monospace',fontWeight:700}}>{r.v}</div>
                  </div>
                ))}
              </div>
            </div>
            {/* Swarm layer legend (Part 13) */}
            <div className="panel" style={{padding:'12px 14px'}}>
              <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:12,fontFamily:'monospace'}}>◈ SWARM LAYER MAP</div>
              {[{l:'LAYER 1 — CORE TRADING',col:LAYER_RING_COLORS[1],agents:['TITAN','ATLAS'],desc:'SOL, BTC, ETH, JUP'},{l:'LAYER 2 — TOP 50',col:LAYER_RING_COLORS[2],agents:['RADAR'],desc:'Top 50 opportunities'},{l:'LAYER 3 — NEW TOKENS',col:LAYER_RING_COLORS[3],agents:['LEVIATHAN','AEGIS'],desc:'New token hunter'}].map((ly,i)=>(
                <div key={i} style={{marginBottom:10,padding:'8px 10px',background:'rgba(4,6,13,0.8)',border:`1px solid ${ly.col}20`,borderRadius:4}}>
                  <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>
                    <div style={{width:8,height:8,borderRadius:'50%',background:ly.col,boxShadow:`0 0 6px ${ly.col}`}}/>
                    <span style={{fontSize:9,color:ly.col,fontFamily:'monospace',fontWeight:700}}>{ly.l}</span>
                  </div>
                  <div style={{fontSize:8,color:K.dim,fontFamily:'monospace',marginBottom:3}}>{ly.desc}</div>
                  <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                    {ly.agents.map(a=><span key={a} style={{padding:'1px 6px',background:`${ly.col}15`,color:ly.col,border:`1px solid ${ly.col}30`,borderRadius:2,fontSize:8,fontFamily:'monospace'}}>{a}</span>)}
                  </div>
                </div>
              ))}
              <div style={{display:'flex',gap:10,justifyContent:'center',marginTop:8}}>
                {Object.entries(AGENT_LAYER_MAP).map(([id,info])=>(
                  <div key={id} style={{textAlign:'center'}}>
                    <div style={{width:10,height:10,borderRadius:'50%',background:LAYER_RING_COLORS[info.layer],margin:'0 auto 3px',boxShadow:`0 0 6px ${LAYER_RING_COLORS[info.layer]}`}}/>
                    <div style={{fontSize:7,color:LAYER_RING_COLORS[info.layer],fontFamily:'monospace'}}>{id.toUpperCase()}</div>
                    <div style={{fontSize:6,color:K.dim,fontFamily:'monospace'}}>{info.role}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Part 14: REJECTED TAB ── */}
      {tab==="rejected"&&(()=>{
        const REJECT_CODES=['BEAR_REGIME_SKIP','GUARD_REFUSED','NO_SIGNAL','REJECTED_LOW_SCORE','CANDLES_UNAVAILABLE','NOT_IN_WHITELIST','EDGE_INSUFFICIENT','SIZE_ZERO'];
        const rejected=(decisionsFeed??[]).filter(d=>REJECT_CODES.includes(d.decision));
        // Breakdown by decision code
        const byCode:Record<string,number>={};
        rejected.forEach(d=>{byCode[d.decision]=(byCode[d.decision]||0)+1;});
        const maxCount=Math.max(1,...Object.values(byCode));
        return(
        <div style={{padding:16,display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,overflow:'auto'}}>
          {/* Rejection Feed */}
          <div className="panel" style={{padding:0,overflow:'hidden'}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,padding:'8px 10px',borderBottom:'1px solid #0A1D33',background:'rgba(4,6,13,0.9)'}}>
              {[{l:'REJECTED',v:decisionsFeed===null?'…':rejected.length,c:K.r},{l:'DISTINCT SYMBOLS',v:decisionsFeed===null?'…':new Set(rejected.map(d=>d.symbol)).size,c:K.gold}].map((s,i)=>(
                <div key={i} style={{textAlign:'center'}}>
                  <div style={{fontSize:7,color:K.dim,fontFamily:'monospace'}}>{s.l}</div>
                  <div style={{fontSize:13,fontWeight:700,color:s.c,fontFamily:'monospace'}}>{s.v}</div>
                </div>
              ))}
            </div>
            {decisionsFeed===null?(
              <div style={{padding:'20px 10px',fontSize:9,color:K.dim,fontFamily:'monospace',textAlign:'center'}}>Loading…</div>
            ):rejected.length===0?(
              <div style={{padding:'20px 10px',fontSize:9,color:'#0A1D33',fontFamily:'monospace',textAlign:'center'}}>No rejections in the last 500 decisions</div>
            ):rejected.map((d,i)=>(
              <div key={i} style={{padding:'8px 10px',borderBottom:'1px solid #06090F',borderLeft:'2px solid #FF336640'}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:11,fontWeight:700,color:K.hi,fontFamily:'monospace'}}>{d.symbol}</span>
                  <span style={{fontSize:8,padding:'1px 5px',background:'#FF336618',border:'1px solid #FF336640',borderRadius:2,color:K.r,fontFamily:'monospace'}}>{d.decision.replace(/_/g,' ')}</span>
                </div>
                {d.reason&&<div style={{fontSize:9,color:'#1A3050',fontFamily:'monospace'}}>· {d.reason.slice(0,80)}{d.reason.length>80?'…':''}</div>}
                <div style={{fontSize:8,color:K.dim,fontFamily:'monospace',marginTop:2}}>{new Date(d.timestamp).toLocaleString("en-US",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false})}{d.regime?` · ${d.regime}`:''}</div>
              </div>
            ))}
          </div>
          {/* Rejection breakdown by code */}
          <div className="panel" style={{padding:0,overflow:'hidden'}}>
            <div style={{padding:'6px 10px',fontSize:8,color:K.dim,letterSpacing:'.2em',fontFamily:'monospace',borderBottom:'1px solid #0A1D33'}}>◈ REJECTION BREAKDOWN</div>
            {decisionsFeed===null?(
              <div style={{padding:'20px 10px',fontSize:9,color:K.dim,fontFamily:'monospace',textAlign:'center'}}>Loading…</div>
            ):Object.keys(byCode).length===0?(
              <div style={{padding:'20px 10px',fontSize:9,color:'#0A1D33',fontFamily:'monospace',textAlign:'center'}}>No rejections yet</div>
            ):(
              <div style={{padding:'8px 10px',display:'flex',flexDirection:'column',gap:6}}>
                {Object.entries(byCode).sort((a,b)=>b[1]-a[1]).map(([code,count])=>(
                  <div key={code}>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:2,fontSize:8}}>
                      <span style={{color:K.tx,fontFamily:'monospace'}}>{code.replace(/_/g,' ')}</span>
                      <span style={{color:K.r,fontFamily:'monospace',fontWeight:700}}>{count}</span>
                    </div>
                    <div style={{height:3,background:'#050810',borderRadius:1}}>
                      <div style={{height:'100%',borderRadius:1,background:K.r,width:(count/maxCount*100)+'%',transition:'width .5s'}}/>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        );
      })()}

      {/* Performance Card Modal */}
      {modal==="share"&&<PerformanceCard trades={trades} totalPnL={totalPnL} allTimeStats={allTimeStats} onClose={()=>setModal(null)}/>}

      {/* Trade Chart Modal */}
      {missionCelebration&&<MissionComplete mission={missionCelebration} onDismiss={()=>setMissionCelebration(null)}/>}

      {chartTrade&&<TradeModal
        trade={chartTrade.trade}
        position={chartTrade.position}
        agentSignals={chartTrade.agentSignals}
        onClose={()=>setChartTrade(null)}
        onClosePosition={chartTrade.position?()=>{
          const sym=chartTrade.trade?.sym||"";
          setChartTrade(null);
          setConfirmClose(sym);
        }:undefined}
      />}

      {/* Confirm Close Modal */}
      {confirmClose&&<ConfirmCloseModal
        sym={confirmClose}
        onCancel={()=>setConfirmClose(null)}
        onConfirm={async()=>{
          const symToClose=confirmClose;
          setConfirmClose(null);
          try{
            const res=await fetch('/api/agents/manual-close',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({userId:user?.id,sym:symToClose})
            });
            const result=await res.json();
            if(result.ok){
              log('KYMIA',`◈ ${symToClose} manually closed @ $${result.exitPrice} | PnL: ${result.pnl>=0?'+':''}$${result.pnl} (${result.pct}%)`,result.pnl>=0?K.g:K.r);
            }else{
              log('KYMIA',`⚠ Failed to close ${symToClose}: ${result.error}`,K.r);
            }
          }catch(e){
            log('KYMIA',`⚠ Error closing position`,K.r);
          }
        }}
      />}

      {/* Cinematic chart on new trade */}
      {cinematicTrade&&<CinematicChart trade={cinematicTrade} onComplete={()=>setCinematicTrade(null)}/>}

      {/* Win Cards */}
      <div style={{position:"fixed",bottom:60,right:16,zIndex:200,display:"flex",flexDirection:"column",gap:8,pointerEvents:"none"}}>
        {winCards.map(card=><WinCardEl key={card.id} card={card} onDone={()=>setWinCards(p=>p.filter(c=>c.id!==card.id))}/>)}
      </div>

      {/* Edge Toasts */}
      <div style={{position:"fixed",top:90,right:16,zIndex:200,display:"flex",flexDirection:"column",gap:0,pointerEvents:"none"}}>
        {edgeToasts.map(t=><EdgeToastEl key={t.id} toast={t} onDone={()=>setEdgeToasts(p=>p.filter(c=>c.id!==t.id))}/>)}
      </div>

      {/* Debate Theater Modal — real agent deliberation */}
      {modal==="debate"&&(
        <div style={{position:"fixed",inset:0,background:"rgba(2,4,10,.94)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(6px)"}} onClick={()=>setModal(null)}>
          <div style={{background:"#040810",border:"1px solid "+K.brd,borderRadius:4,padding:"22px 26px",width:640,maxHeight:"80vh",overflow:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,color:K.c,letterSpacing:".2em",fontWeight:900}}>◈ AGENT DELIBERATION</div>
              <button onClick={()=>setModal(null)} style={{background:"none",border:"none",color:K.tx,cursor:"pointer",fontSize:16}}>✕</button>
            </div>
            {/* Real deliberation — latest cycle, all 6 agents */}
            {agentFeed&&(()=>{
              const allV=Object.values(agentFeed.by_symbol).flat();
              const latestCycle=allV.reduce((mx,v)=>v.cycle_ts>mx?v.cycle_ts:mx,"");
              // Find symbol with most recent verdict
              const latestSym=allV.find(v=>v.cycle_ts===latestCycle)?.symbol||"";
              const byAgent:Record<string,AgentFeedVerdict>={};
              allV.filter(v=>v.symbol===latestSym).forEach(v=>{const ex=byAgent[v.agent];if(!ex||v.cycle_ts>ex.cycle_ts)byAgent[v.agent]=v;});
              const verdicts=REAL_AGENTS.filter(a=>a.id!=="confluence").map(a=>byAgent[a.id]).filter(Boolean);
              const latestV=allV.find(v=>v.cycle_ts===latestCycle);
              const confScore=latestV?.score_total!=null?Math.round(latestV.score_total):null;
              const decision=latestV?.decision||null;
              return(<>
                <div style={{fontSize:9,color:K.dim,marginBottom:10,letterSpacing:".08em"}}>
                  {latestSym} · {new Date(latestCycle).toLocaleTimeString("en-US",{hour12:false})} · cycle score: {confScore!=null?confScore:"—"}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
                  {verdicts.map((d,i)=>{
                    const col=d.vote==="APPROVE"?K.g:d.vote==="REJECT"?K.r:K.tx;
                    const agentLabel=(d.agent??'').toUpperCase();
                    return(
                      <div key={d.agent??i} style={{display:"flex",gap:10,flexDirection:i%2===0?"row":"row-reverse",animation:"fi .4s ease forwards",opacity:0,animationDelay:(i*.12)+"s"}}>
                        <div style={{width:48,height:48,borderRadius:3,background:col+"14",border:"1.5px solid "+col+"40",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                          <div style={{fontSize:8,color:col,fontWeight:700}}>{agentLabel.slice(0,5)}</div>
                          <div style={{fontSize:8,color:K.dim}}>{d.confidence}%</div>
                        </div>
                        <div style={{flex:1,background:"#060C16",border:"1px solid "+col+"22",borderRadius:3,padding:"8px 12px"}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                            <span style={{fontSize:9,color:K.dim}}>{agentLabel}</span>
                            <span style={{padding:"1px 6px",background:col+"20",color:col,fontSize:8,borderRadius:1}}>{d.vote} {d.confidence}%</span>
                          </div>
                          <p style={{fontSize:11,color:K.hi,lineHeight:1.5}}>{d.reason}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {confScore!=null&&(()=>{
                  const col=decision==="WOULD_EXECUTE"?K.g:decision?.startsWith("EPISODE_CLOSED")?K.gold:K.r;
                  return(
                    <div style={{background:col+"0E",border:"1.5px solid "+col+"40",borderRadius:3,padding:"13px 17px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <span style={{fontSize:12,color:col,fontWeight:900}}>⟹ CONFLUENCE</span>
                        <span style={{fontSize:15,fontWeight:700,color:col}}>SCORE {confScore}/100</span>
                      </div>
                      <p style={{fontSize:11,color:K.tx,lineHeight:1.55}}>{decision?.replace(/_/g," ")||"—"}</p>
                    </div>
                  );
                })()}
              </>);
            })()}
            {/* No data state */}
            {!agentFeed&&(
              <div style={{textAlign:"center",padding:"32px 0",color:K.dim,fontSize:11,fontFamily:"monospace"}}>
                <div style={{fontSize:20,marginBottom:8,opacity:.4}}>◈</div>
                <div style={{letterSpacing:".1em"}}>No deliberation data yet</div>
                <div style={{fontSize:9,marginTop:6,color:"#0A1E30"}}>Agent verdicts appear here after the first cycle</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* DNA Modal */}
      {modal==="dna"&&dnaData&&(
        <div style={{position:"fixed",inset:0,background:"rgba(2,4,10,.94)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(6px)"}} onClick={()=>setModal(null)}>
          <div style={{background:"#040810",border:"1px solid "+K.pu+"50",borderRadius:4,padding:"24px 28px",width:440}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,color:K.pu,letterSpacing:".2em",fontWeight:900}}>◈ KYMIA PERFORMANCE DNA</div>
              <button onClick={()=>setModal(null)} style={{background:"none",border:"none",color:K.tx,cursor:"pointer",fontSize:16}}>✕</button>
            </div>
            <div style={{marginBottom:10}}><span style={{padding:"3px 10px",background:K.gold+"20",color:K.gold,border:"1px solid "+K.gold+"40",fontSize:11,borderRadius:2,fontWeight:700}}>{String(dnaData.tier)} TIER · {String(dnaData.score)}/100</span></div>
            <div style={{fontSize:17,color:K.hi,fontWeight:900,marginBottom:8}}>&quot;{String(dnaData.traderTitle)}&quot;</div>
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>{((dnaData.tradingDNA as string[])||[]).map((t,i)=><span key={i} style={{padding:"2px 8px",background:K.c+"15",color:K.c,border:"1px solid "+K.c+"30",fontSize:8,borderRadius:1}}>{t}</span>)}</div>
            <div style={{marginBottom:8}}><div style={{fontSize:8,color:K.dim,marginBottom:3}}>STRENGTHS</div>{((dnaData.strengths as string[])||[]).map((s,i)=><div key={i} style={{color:K.g,fontSize:10,marginBottom:1}}>✓ {s}</div>)}</div>
            <div style={{marginBottom:10}}><div style={{fontSize:8,color:K.dim,marginBottom:3}}>WEAKNESS</div><div style={{color:K.r,fontSize:10}}>⚠ {String(dnaData.weakness)}</div></div>
            <div style={{padding:"10px 13px",background:K.pu+"10",border:"1px solid "+K.pu+"30",borderRadius:2,marginBottom:14}}>
              <p style={{fontSize:11,color:K.hi,lineHeight:1.5,fontStyle:"italic"}}>&quot;{String(dnaData.aiVerdict)}&quot;</p>
            </div>
            <button className="btn" onClick={()=>setModal(null)} style={{width:"100%",background:K.pu+"15",color:K.pu,border:"1px solid "+K.pu+"40",padding:"9px 0",fontSize:10}}>[ CLOSE ]</button>
          </div>
        </div>
      )}

      {/* Beat the AI Modal */}
      {modal==="beat"&&(
        <div style={{position:"fixed",inset:0,background:"rgba(2,4,10,.94)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(6px)"}} onClick={()=>setModal(null)}>
          <div style={{background:"#040810",border:"1px solid "+K.gold+"50",borderRadius:4,padding:"24px 28px",width:440}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,color:K.gold,letterSpacing:".2em",fontWeight:900}}>🎮 BEAT THE AI</div>
              <button onClick={()=>setModal(null)} style={{background:"none",border:"none",color:K.tx,cursor:"pointer",fontSize:16}}>✕</button>
            </div>
            <p style={{fontSize:10,color:K.tx,marginBottom:14,lineHeight:1.5}}>Pick an asset + direction. Race KYMIA over 30 seconds. Whoever calls the next move correctly wins.</p>
            <div style={{fontSize:8,color:K.dim,marginBottom:6,letterSpacing:".1em"}}>SELECT ASSET</div>
            <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
              {Object.entries(SYMS).map(([sym,sv])=>(
                <button key={sym} className="btn" onClick={()=>setBeatChoice(prev=>prev?{...prev,sym}:{sym,side:"LONG"})} style={{background:beatChoice?.sym===sym?sv.col+"20":K.pan,color:beatChoice?.sym===sym?sv.col:K.tx,border:"1px solid "+(beatChoice?.sym===sym?sv.col+"60":K.brd),padding:"5px 12px"}}>
                  {sv.icon} {sym}
                </button>
              ))}
            </div>
            {beatChoice?.sym&&(
              <>
                <div style={{fontSize:8,color:K.dim,marginBottom:6,letterSpacing:".1em"}}>YOUR DIRECTION</div>
                <div style={{display:"flex",gap:6,marginBottom:14}}>
                  {(["LONG","SHORT"] as const).map(side=>(
                    <button key={side} className="btn" onClick={()=>setBeatChoice(prev=>prev?{...prev,side}:null)} style={{flex:1,background:beatChoice?.side===side?(side==="LONG"?K.g:K.r)+"20":K.pan,color:beatChoice?.side===side?(side==="LONG"?K.g:K.r):K.tx,border:"1px solid "+(beatChoice?.side===side?(side==="LONG"?K.g:K.r)+"50":K.brd),padding:"8px 0",fontSize:11}}>
                      {side==="LONG"?"▲ LONG":"▼ SHORT"}
                    </button>
                  ))}
                </div>
                {beatResult
                  ?<div style={{padding:"14px",textAlign:"center",fontSize:16,fontWeight:900,color:beatResult.includes("WIN")&&!beatResult.includes("KYMIA")?K.g:K.r,background:(beatResult.includes("WIN")&&!beatResult.includes("KYMIA")?K.g:K.r)+"10",border:"1px solid "+(beatResult.includes("WIN")&&!beatResult.includes("KYMIA")?K.g:K.r)+"40",borderRadius:3}}>{beatResult}</div>
                  :<button className="btn" onClick={()=>{beatStart(beatChoice.sym,beatChoice.side);}} style={{width:"100%",background:K.gold+"15",color:K.gold,border:"1px solid "+K.gold+"40",padding:"10px 0",fontSize:11,letterSpacing:".1em"}}>⚡ START 30s RACE</button>
                }
              </>
            )}
          </div>
        </div>
      )}

      <div style={{background:"#020608",borderTop:"1px solid #050A12",padding:"3px 16px",display:"flex",justifyContent:"space-between",fontSize:8,color:"#081525",letterSpacing:".1em",paddingBottom:31}}>
        {isLive
          ?<span>◈ KYMIA v2.0 — <span style={{color:K.r+"80"}}>LIVE MODE</span> · REAL FUNDS · NON-CUSTODIAL · YOU KEEP YOUR KEYS</span>
          :<span>◈ KYMIA v2.0 — PAPER TRADING · $10,000 SANDBOX CAPITAL · NO REAL FUNDS AT RISK</span>
        }
        <span>Claude Sonnet · 18 Agents · {walletAddress?walletAddress.slice(0,8)+"...":"DEMO"}</span>
      </div>

      <TimeScrubber sessionStart={sessionStartRef.current} trades={trades}/>

      {showTransparency&&<TransparencyModal onClose={()=>setShowTransparency(false)}/>}
    </div>
  );
}
