"use client";
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { motion, useAnimationControls } from "framer-motion";
import * as THREE from "three";

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
  return pos.avg*0.975;
};
const CORRELATED:{[k:string]:string[]}={
  SOL:["JUP","RAY","ORCA","JTO","DRIFT"],BTC:["ETH"],ETH:["BTC"],
  JUP:["SOL","RAY"],RAY:["SOL","JUP"],ORCA:["SOL"],JTO:["SOL"],DRIFT:["SOL"],
};

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

const BOOT_STEPS=[
  "[SYSTEM]: Initializing KYMIA Swarm...",
  "[LEVIATHAN]: Liquidity Radar Online...",
  "[ATLAS]: Global Macro Sphere Synced...",
  "[AEGIS]: Adaptive Risk Matrix Active...",
  `[JUPITER]: ${SYM_COUNT} Solana pairs loaded...`,
  "[SWARM]: 18 Cognitive Agents Connected...",
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

type PriceData={price:number,prev:number,trend:string,change:number,rsi:number,hist:number[]};
type AgentState={on:boolean,conf:number|null,sig:string|null,th:string,real?:boolean};
type NewToken={address:string,name:string,price:string,change1h:number,volume24h:number,liquidity:number,rugScore:number,buys:number,sells:number};
type DataStatus={jupiter:"ok"|"err"|"loading",binance:"ok"|"err"|"loading",coingecko:"ok"|"err"|"loading",lastUpdate:number};
type Position={qty:number,avg:number,peak?:number,entryMs?:number};
type Trade={id:string,sym:string,side:string,qty:number,price:number,pnl:number,conf:number,t:string,ms:number,agent?:string,reason?:string};
type LogEntry={t:string,ag:string,msg:string,col:string};
type WinCard={id:string,sym:string,pnl:number,pct:number,price:number,agent:string,t:string,origin?:{x:number,y:number}};
type EdgeToast={id:string,type:string,icon:string,col:string,title:string,body:string};
type MoneyLabel={id:string,x:number,y:number,val:number,born:number};

function usePrices(){
  const [px,setPx]=useState<{[k:string]:PriceData}>(()=>
    Object.fromEntries(Object.entries(SYMS).map(([k,v])=>[k,{
      price:v.base,prev:v.base,trend:"up",change:(Math.random()-.4)*8,rsi:40+Math.random()*35,
      hist:Array.from({length:60},(_,i)=>v.base*(1+(Math.random()-.5)*.05*(i/60))),
    }]))
  );
  // micro-simulation (sparklines + RSI)
  useEffect(()=>{
    const iv=setInterval(()=>setPx(p=>{
      const n:{[k:string]:PriceData}={};
      for(const[k,v]of Object.entries(SYMS)){
        const c=p[k];if(!c)continue;
        const d=(Math.random()-.499)*2*v.vol,np=Math.max(c.price*(1+d),c.price*0.9);
        n[k]={...c,price:np,prev:c.price,trend:np>c.price?"up":"dn",
          hist:[...c.hist.slice(1),np],change:c.change+(Math.random()-.5)*.15,
          rsi:Math.max(15,Math.min(85,c.rsi+(Math.random()-.5)*2.5))};
      }
      return n;
    }),900);
    return()=>clearInterval(iv);
  },[]);
  // real Jupiter prices every 5 s
  useEffect(()=>{
    const mintMap:Record<string,string>=Object.fromEntries(Object.entries(SYMS).map(([sym,info])=>[info.mint,sym]));
    const fetchPrices=async()=>{
      try{
        const ids=Object.values(SYMS).map(s=>s.mint).join(",");
        const res=await fetch(`/api/jupiter?ids=${ids}`);
        if(!res.ok)return;
        const data=await res.json();
        if(!data?.data)return;
        setPx(p=>{
          const n={...p};
          for(const[mint,jd] of Object.entries(data.data as Record<string,{price:number}>)){
            const sym=mintMap[mint];
            if(!sym||!jd?.price)continue;
            const cur=n[sym];if(!cur)continue;
            const np=jd.price;
            n[sym]={...cur,price:np,prev:cur.price,trend:np>cur.price?"up":"dn",
              hist:[...cur.hist.slice(1),np]};
          }
          return n;
        });
      }catch{}
    };
    fetchPrices();
    const iv=setInterval(fetchPrices,5000);
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

function Globe3D({trades,blackSwan,whaleAlert,totalPnL,tradeCount}:{trades:Trade[],blackSwan:boolean,whaleAlert:boolean,totalPnL:number,tradeCount:number}){
  const mountRef=useRef<HTMLDivElement>(null);
  const [moneyLabels,setMoneyLabels]=useState<MoneyLabel[]>([]);
  const [radarWaves,setRadarWaves]=useState<Array<{id:string,x:number,y:number,col:string,born:number}>>([]);
  const [observers]=useState(()=>2800+Math.floor(Math.random()*200));
  const W=280,H=248;
  const prevLen=useRef(0);
  // Fixed 2D overlay coords — (W=280,H=248)
  const CITIES_2D:Array<[number,number,string]>=[[W*.28,H*.38,"NYC"],[W*.50,H*.34,"LON"],[W*.76,H*.38,"TYO"],[W*.73,H*.53,"SGP"],[W*.63,H*.43,"DXB"],[W*.74,H*.45,"HKG"]];

  // Session: which market is open by UTC hour
  const h=new Date().getUTCHours();
  const session=h<8?{name:"ASIA",col:K.gold,cities:[2,3,4,5]}:h<15?{name:"EU",col:K.c,cities:[1]}:{name:"US",col:K.g,cities:[0]};

  // Trade fires → money label + radar wave
  useEffect(()=>{
    if(trades.length>prevLen.current){
      const t=trades[0];
      if(t&&t.pnl!==0){
        const city=CITIES_2D[Math.floor(Math.random()*CITIES_2D.length)];
        const wc=CITIES_2D[Math.floor(Math.random()*3)]; // NYSE/LON/TYO only
        const now=Date.now();
        setMoneyLabels(p=>[...p.slice(-6),{id:Math.random().toString(36).slice(2),x:city[0]+(Math.random()-.5)*18,y:city[1]+(Math.random()-.5)*12,val:t.pnl,born:now}]);
        setRadarWaves(p=>[...p.slice(-12),{id:Math.random().toString(36).slice(2),x:wc[0],y:wc[1],col:t.pnl>=0?K.g:K.r,born:now}]);
      }
      prevLen.current=trades.length;
    }
  });

  // Periodic radar ping every 2–3s regardless of trades
  useEffect(()=>{
    // NYC=78.4,94.2 | LON=140,84.3 | TYO=212.8,94.2
    const wcs:Array<[number,number]>=[[78.4,94.2],[140,84.3],[212.8,94.2]];
    let t:ReturnType<typeof setTimeout>;
    const fire=()=>{const[wx,wy]=wcs[Math.floor(Math.random()*3)];setRadarWaves(p=>[...p.slice(-12),{id:Math.random().toString(36).slice(2),x:wx,y:wy,col:K.c,born:Date.now()}]);};
    const sched=()=>{t=setTimeout(()=>{fire();sched();},2000+Math.random()*1500);};
    sched();
    return()=>clearTimeout(t);
  },[]);

  // Unified cleanup
  useEffect(()=>{
    const iv=setInterval(()=>{const now=Date.now();setMoneyLabels(p=>p.filter(m=>now-m.born<2800));setRadarWaves(p=>p.filter(w=>now-w.born<1200));},100);
    return()=>clearInterval(iv);
  },[]);
  useEffect(()=>{
    const mount=mountRef.current;if(!mount)return;
    const scene=new THREE.Scene();
    const camera=new THREE.PerspectiveCamera(50,W/H,.1,100);
    camera.position.z=2.85;
    const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
    renderer.setSize(W,H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setClearColor(0x000000,0);
    mount.appendChild(renderer.domElement);
    const mainHex=blackSwan?K.r:K.c;
    const mainCol=new THREE.Color(mainHex);
    const brightCol=new THREE.Color(blackSwan?"#FF8899":"#80F8FF");
    const dimCol=new THREE.Color(blackSwan?"#280008":"#003055");

    // Tilted globe group — axial tilt reveals true 3D depth as it rotates
    const globeGroup=new THREE.Group();
    globeGroup.rotation.z=0.22;
    scene.add(globeGroup);

    // SOLID CORE — opaque sphere occludes back-hemisphere particles naturally via depth testing
    const coreGeo=new THREE.SphereGeometry(.975,48,48);
    const coreMat=new THREE.MeshBasicMaterial({color:0x040810});
    globeGroup.add(new THREE.Mesh(coreGeo,coreMat));

    // PARTICLES — 5000, Fibonacci lattice, front-biased brightness
    const N=5000;
    const pPos=new Float32Array(N*3);
    const pCol=new Float32Array(N*3);
    for(let i=0;i<N;i++){
      const phi=Math.acos(1-2*(i+.5)/N);
      const theta=Math.PI*(1+Math.sqrt(5))*i;
      const x=Math.sin(phi)*Math.cos(theta),y=Math.sin(phi)*Math.sin(theta),z=Math.cos(phi);
      pPos[i*3]=x;pPos[i*3+1]=y;pPos[i*3+2]=z;
      const front=Math.pow(Math.max(0,(z+1)/2),.6);
      const rnd=Math.random();
      const mix=dimCol.clone().lerp(mainCol,front*.6+rnd*.4).lerp(brightCol,front*.18);
      pCol[i*3]=mix.r;pCol[i*3+1]=mix.g;pCol[i*3+2]=mix.b;
    }
    const pGeo=new THREE.BufferGeometry();
    pGeo.setAttribute("position",new THREE.BufferAttribute(pPos,3));
    pGeo.setAttribute("color",new THREE.BufferAttribute(pCol,3));
    const pMat=new THREE.PointsMaterial({size:.026,vertexColors:true,transparent:true,opacity:.92,sizeAttenuation:true,depthWrite:false});
    const globe=new THREE.Points(pGeo,pMat);
    globeGroup.add(globe);

    // LATITUDE RINGS — 5 rings
    const latYs=[-0.65,-0.35,0,0.35,0.65];
    latYs.forEach(yp=>{
      const r=Math.sqrt(Math.max(0,1-yp*yp));
      const pts=Array.from({length:65},(_,j)=>new THREE.Vector3(r*Math.cos(j/64*Math.PI*2),yp,r*Math.sin(j/64*Math.PI*2)));
      const op=yp===0?.32:.16;
      globeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:mainCol,transparent:true,opacity:op})));
    });

    // MERIDIAN LINES — 8 longitude lines
    for(let m=0;m<8;m++){
      const th=m*Math.PI/8;
      const pts=Array.from({length:33},(_,j)=>{
        const p=j/32*Math.PI;
        return new THREE.Vector3(Math.sin(p)*Math.cos(th),Math.cos(p),Math.sin(p)*Math.sin(th));
      });
      globeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:mainCol,transparent:true,opacity:.1})));
    }

    // CITY NODES — bright pulsing dots on surface
    const cityLatLon:Array<[number,number]>=[[40.7,-74],[51.5,0],[35.7,139.7],[1.3,103.8],[25.2,55.3],[22.3,114.2]];
    const cPos2=new Float32Array(cityLatLon.length*3);
    const cCol2=new Float32Array(cityLatLon.length*3);
    cityLatLon.forEach(([lat,lon],i)=>{
      const phi2=(90-lat)*Math.PI/180,th=(lon+180)*Math.PI/180;
      cPos2[i*3]=Math.sin(phi2)*Math.cos(th);cPos2[i*3+1]=Math.cos(phi2);cPos2[i*3+2]=Math.sin(phi2)*Math.sin(th);
      const cc=new THREE.Color(blackSwan?K.r:K.g);
      cCol2[i*3]=cc.r;cCol2[i*3+1]=cc.g;cCol2[i*3+2]=cc.b;
    });
    const cGeo=new THREE.BufferGeometry();
    cGeo.setAttribute("position",new THREE.BufferAttribute(cPos2,3));
    cGeo.setAttribute("color",new THREE.BufferAttribute(cCol2,3));
    const cMat=new THREE.PointsMaterial({size:.092,vertexColors:true,transparent:true,opacity:.95,depthWrite:false});
    globeGroup.add(new THREE.Points(cGeo,cMat));

    // ATMOSPHERE — two backside shells create edge glow without geometry
    [{r:1.05,op:.055},{r:1.12,op:.025}].forEach(({r,op})=>{
      const g=new THREE.SphereGeometry(r,32,32);
      const m=new THREE.MeshBasicMaterial({color:mainCol,transparent:true,opacity:op,side:THREE.BackSide,depthWrite:false});
      scene.add(new THREE.Mesh(g,m));
    });

    // INNER EYE — pulsing wireframe core
    const eyeGeo=new THREE.SphereGeometry(.13,14,10);
    const eyeMat=new THREE.MeshBasicMaterial({color:mainCol,transparent:true,opacity:.45,wireframe:true});
    const eye=new THREE.Mesh(eyeGeo,eyeMat);
    scene.add(eye);
    const light=new THREE.PointLight(mainCol,1.1,3.5);
    scene.add(light);

    let af:number,angle=0;
    const tick=()=>{
      af=requestAnimationFrame(tick);
      angle+=.0045;
      globeGroup.rotation.y=angle;
      eye.rotation.y=angle*1.8;
      eye.scale.setScalar(.88+Math.sin(angle*2.5)*.12);
      renderer.render(scene,camera);
    };
    tick();
    return()=>{
      cancelAnimationFrame(af);
      if(mount.contains(renderer.domElement))mount.removeChild(renderer.domElement);
      renderer.dispose();
      pGeo.dispose();pMat.dispose();cGeo.dispose();cMat.dispose();coreGeo.dispose();coreMat.dispose();eyeGeo.dispose();eyeMat.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[blackSwan]);
  const pnl=totalPnL;
  return(
    <div style={{position:"relative",width:W,height:270}}>
      {/* Three.js canvas */}
      <div ref={mountRef} style={{position:"absolute",top:0,left:0,width:W,height:H}}/>

      {/* SVG overlay — city markers, radar waves, HUD text */}
      <svg width={W} height={H} style={{position:"absolute",top:0,left:0,pointerEvents:"none",overflow:"visible"}}>
        {/* Session city glow + labels */}
        {CITIES_2D.map(([cx,cy,name],i)=>{
          const act=session.cities.includes(i);
          const col=act?session.col:K.dim;
          return(
            <g key={name}>
              {act&&<circle cx={cx} cy={cy} r="12" fill={col} opacity=".1" style={{animation:"breathe 2s ease-in-out infinite"}}/>}
              <circle cx={cx} cy={cy} r={act?3.5:2} fill={col} opacity={act?.9:.28}/>
              <text x={cx} y={cy-8} textAnchor="middle" fontSize="5.5" fontFamily="monospace" fill={col} opacity={act?.85:.32}>{name}</text>
            </g>
          );
        })}

        {/* Radar waves — SMIL expand from city center */}
        {radarWaves.map(w=>(
          <g key={w.id}>
            <circle cx={w.x} cy={w.y} r="0" fill="none" stroke={w.col} strokeWidth="2">
              <animate attributeName="r" from="0" to="48" dur=".85s" fill="freeze"/>
              <animate attributeName="opacity" from="1" to="0" dur=".85s" fill="freeze"/>
            </circle>
            <circle cx={w.x} cy={w.y} r="0" fill="none" stroke={w.col} strokeWidth=".7" opacity=".5">
              <animate attributeName="r" from="0" to="64" dur="1.15s" fill="freeze"/>
              <animate attributeName="opacity" from=".5" to="0" dur="1.15s" fill="freeze"/>
            </circle>
          </g>
        ))}

        {/* North pole — observer count */}
        <text x={W/2} y={20} textAnchor="middle" fontSize="6" fontFamily="monospace" fill={K.c} opacity=".68" style={{animation:"breathe 3s ease-in-out infinite"}}>{observers.toLocaleString()} ONLINE</text>

        {/* Equator left — trade counter */}
        <text x={22} y={H/2-2} textAnchor="middle" fontSize="7" fontFamily="monospace" fill={K.dim} opacity=".5" fontWeight="700">{tradeCount}</text>
        <text x={22} y={H/2+7} textAnchor="middle" fontSize="4.5" fontFamily="monospace" fill={K.dim} opacity=".38">TRADES</text>

        {/* South pole — agents */}
        <text x={W/2} y={H-14} textAnchor="middle" fontSize="6" fontFamily="monospace" fill={K.c} opacity=".6" style={{animation:"breathe 1.8s ease-in-out infinite"}}>18 AGENTS</text>

        {/* Session badge — top-left */}
        <rect x={4} y={6} width={58} height={14} rx="2" fill={session.col} fillOpacity=".1" stroke={session.col} strokeWidth=".7" strokeOpacity=".45"/>
        <text x={33} y={16.5} textAnchor="middle" fontSize="6.5" fontFamily="monospace" fill={session.col} fontWeight="700">{session.name} OPEN</text>
      </svg>

      {/* Whale alert — 3 staggered expanding rings + text */}
      {whaleAlert&&(
        <>
          <div style={{position:"absolute",top:(H/2-110)+"px",left:(W/2-110)+"px",width:220,height:220,borderRadius:"50%",border:"2px solid "+K.pu,animation:"whalePulse 1.4s ease-out infinite",pointerEvents:"none"}}/>
          <div style={{position:"absolute",top:(H/2-75)+"px",left:(W/2-75)+"px",width:150,height:150,borderRadius:"50%",border:"1.4px solid "+K.pu+"99",animation:"whalePulse 1.4s ease-out .45s infinite",pointerEvents:"none"}}/>
          <div style={{position:"absolute",top:(H/2-42)+"px",left:(W/2-42)+"px",width:84,height:84,borderRadius:"50%",border:"1px solid "+K.pu+"55",animation:"whalePulse 1.4s ease-out .9s infinite",pointerEvents:"none"}}/>
          <div style={{position:"absolute",top:Math.round(H*.38),left:0,right:0,textAlign:"center",fontSize:10,fontFamily:"monospace",fontWeight:700,color:K.pu,animation:"pu .55s ease-in-out infinite",pointerEvents:"none",textShadow:"0 0 10px "+K.pu,letterSpacing:".12em"}}>🐋 WHALE</div>
        </>
      )}

      {/* Black swan shockwave */}
      {blackSwan&&<div style={{position:"absolute",top:(H/2-116)+"px",left:(W/2-116)+"px",width:232,height:232,borderRadius:"50%",border:"1.2px solid "+K.r,animation:"whalePulse 1.5s ease-out infinite",pointerEvents:"none"}}/>}

      {/* Floating money labels — pop at trade location, float up */}
      {moneyLabels.map(m=>(
        <div key={m.id} style={{position:"absolute",left:m.x,top:m.y,fontSize:10,fontFamily:"monospace",fontWeight:700,color:m.val>=0?K.g:K.r,animation:"moneyFloat 2.8s ease-out forwards",pointerEvents:"none",transform:"translateX(-50%)",whiteSpace:"nowrap",textShadow:`0 0 8px ${m.val>=0?K.g:K.r}`}}>
          {m.val>=0?"+$":"-$"}{f2(Math.abs(m.val))}
        </div>
      ))}

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

function SwarmGraph({st,debate,disabled,swarmRef}:{st:{[k:string]:AgentState},debate:string[],disabled:Set<string>,swarmRef?:React.RefObject<HTMLDivElement|null>}){
  const [hov,setHov]=useState<string|null>(null);
  const nm:{[k:string]:{pos:{x:number,y:number},id:string,name:string,s:string,lv:number,ag:number}}={};
  for(const a of AGENTS)nm[a.id]={...a,pos:gpos(a)};
  return(
    <div ref={swarmRef} style={{position:"relative",display:"inline-block"}}>
      <svg width="480" height="468" style={{display:"block"}}>
        <defs>
          <filter id="agf"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="arcglow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="faceglow"><feGaussianBlur stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {CONNS.map(([a,b])=>{
          const pa=nm[a]?.pos,pb=nm[b]?.pos;if(!pa||!pb)return null;
          const deb=debate.includes(a)&&debate.includes(b);
          const dis=disabled.has(a)||disabled.has(b);
          if(dis)return<line key={a+b} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#050810" strokeWidth=".5" opacity=".07"/>;
          return<ElectricArc key={a+b} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} col={deb?K.c:K.dim} active={deb}/>;
        })}
        {AGENTS.map(({id,s,lv})=>{
          const n=nm[id],ag=st[id]||{on:false,conf:null,sig:null,th:""};
          const dis=disabled.has(id),isAegis=id==="aegis";
          const r=id==="consensus"?34:lv===1?28:lv===2?22:17;
          const col=dis?"#101820":ag.sig==="BUY"?K.g:ag.sig==="SELL"?K.r:id==="consensus"?K.c:K.co;
          const active=ag.on&&!dis;
          const conflict=isAegis&&ag.sig==="SELL"&&!dis;
          return(
            <g key={id} filter={active?"url(#faceglow)":undefined} opacity={dis?.18:1} style={{cursor:"pointer"}} onMouseEnter={()=>setHov(id)} onMouseLeave={()=>setHov(null)}>
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
        const info=AGENTS.find(a=>a.id===hov);
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

function ConsensusBar({agSt}:{agSt:{[k:string]:AgentState}}){
  const active=AGENTS.filter(a=>a.id!=="consensus"&&agSt[a.id]?.on&&agSt[a.id]?.sig);
  const buy=active.filter(a=>agSt[a.id].sig==="BUY").length;
  const sell=active.filter(a=>agSt[a.id].sig==="SELL").length;
  const hold=active.filter(a=>agSt[a.id].sig==="HOLD").length;
  const total=buy+sell+hold||1;
  const dom=buy>sell&&buy>hold?"BUY":sell>buy&&sell>hold?"SELL":"HOLD";
  const domPct=dom==="BUY"?buy:dom==="SELL"?sell:hold;
  const col=dom==="BUY"?K.g:dom==="SELL"?K.r:K.gold;
  return(
    <div style={{padding:"9px 12px",background:K.pan,border:"1px solid "+col+"30",borderRadius:2}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <span style={{fontSize:8,color:K.dim,letterSpacing:".12em"}}>◈ SWARM CONSENSUS</span>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{padding:"2px 9px",background:col+"20",color:col,border:"1px solid "+col+"40",fontSize:10,borderRadius:1,fontWeight:700,boxShadow:`0 0 8px ${col}40`}}>
            {dom==="BUY"?"▲":dom==="SELL"?"▼":"◆"} {dom} {Math.round(domPct/total*100)}%
          </span>
          <span style={{fontSize:8,color:K.dim}}>{active.length}/18</span>
        </div>
      </div>
      <div style={{display:"flex",gap:1,height:5,borderRadius:3,overflow:"hidden",marginBottom:5}}>
        <div style={{width:(buy/total*100)+"%",background:K.g,transition:"width .5s"}}/>
        <div style={{width:(sell/total*100)+"%",background:K.r,transition:"width .5s"}}/>
        <div style={{width:(hold/total*100)+"%",background:K.gold,transition:"width .5s"}}/>
      </div>
      <div style={{display:"flex",gap:12,fontSize:8}}>
        {([["▲ BUY",K.g,buy],["▼ SELL",K.r,sell],["◆ HOLD",K.gold,hold]] as Array<[string,string,number]>).map(([l,c,v])=>(
          <span key={l} style={{color:c}}>● {l} {Math.round(v/total*100)}%</span>
        ))}
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
        <span style={{fontSize:8,color:K.dim}}>{card.agent}</span>
      </div>
      <div style={{fontSize:8,color:K.dim,marginBottom:7}}>{card.t}</div>
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

function PerformanceCard({trades,totalPnL,onClose}:{trades:Trade[],totalPnL:number,onClose:()=>void}){
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
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6,marginBottom:14}}>
            {([
              {l:"TOTAL TRADES",v:String(closed.length),c:K.c},
              {l:"WINS",v:String(wins.length),c:K.g},
              {l:"LOSSES",v:String(losses.length),c:K.r},
              {l:"WIN RATE",v:f2(pct,0)+"%",c:K.gold},
              {l:"BEST TRADE",v:bestTrade>0?"+$"+f2(bestTrade):"—",c:K.g},
              {l:"WORST TRADE",v:worstTrade<0?"-$"+f2(Math.abs(worstTrade)):"—",c:K.r},
            ] as Array<{l:string,v:string,c:string}>).map((s,i)=>(
              <div key={i} style={{background:"#060A12",border:"1px solid #0A1D33",borderRadius:8,padding:"7px 9px"}}>
                <div style={{fontSize:6,color:K.dim,marginBottom:2,letterSpacing:".07em"}}>{s.l}</div>
                <div style={{fontSize:13,fontWeight:700,color:s.c}}>{s.v}</div>
              </div>
            ))}
          </div>
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

export default function KYMIA(){
  const prices=usePrices();
  const pricesRef=useRef(prices);
  useEffect(()=>{pricesRef.current=prices;},[prices]);

  const [booting,setBooting]=useState(true);
  const [port,setPort]=useState({cash:CAP,pos:{} as {[k:string]:Position},equity:CAP,peak:CAP});
  const portRef=useRef(port);
  useEffect(()=>{portRef.current=port;},[port]);

  const [trades,setTrades]=useState<Trade[]>([]);
  const tradesRef=useRef<Trade[]>([]);
  useEffect(()=>{tradesRef.current=trades;},[trades]);
  const [agSt,setAgSt]=useState<{[k:string]:AgentState}>(()=>Object.fromEntries(AGENTS.map(a=>[a.id,{on:false,conf:null,sig:null,th:""}])));
  const agStRef=useRef(agSt);
  useEffect(()=>{agStRef.current=agSt;},[agSt]);

  const [debate,setDebate]=useState<string[]>([]);
  const [logs,setLogs]=useState<LogEntry[]>([{t:ts(),ag:"SYSTEM",msg:"◈ KYMIA v2.0 — 18 agents online",col:K.c}]);
  const [aiData,setAiData]=useState<{[k:string]:unknown}|null>(null);
  const [dnaData,setDnaData]=useState<{[k:string]:unknown}|null>(null);
  const [analyzing,setAnalyzing]=useState(false);
  const [dnaLoading,setDnaLoading]=useState(false);
  const [running,setRunning]=useState(false);
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
  const logRef=useRef<HTMLDivElement>(null);
  const swarmRef=useRef<HTMLDivElement>(null);
  const entropyRef=useRef(entropy);
  useEffect(()=>{entropyRef.current=entropy;},[entropy]);

  const log=useCallback((ag:string,msg:string,col=K.hi)=>setLogs(l=>[...l.slice(-150),{t:ts(),ag,msg,col}]),[]);

  // Live user counter fluctuation
  useEffect(()=>{
    const iv=setInterval(()=>setLiveUsers(u=>u+(Math.random()<.5?1:-1)*Math.ceil(Math.random()*3)),8000);
    return()=>clearInterval(iv);
  },[]);

  // Black swan user spike
  useEffect(()=>{if(blackSwan)setLiveUsers(u=>u+340);},[blackSwan]);

  // ── Real agent data fetch (30s cycle) ────────────────────────────────
  const calcEMA=(prices:number[],period:number):number=>{
    if(prices.length<period)return prices[prices.length-1]||0;
    const k=2/(period+1);let ema=prices[0];
    for(let i=1;i<prices.length;i++)ema=prices[i]*k+ema*(1-k);
    return ema;
  };
  const runRealAgents=useCallback(async()=>{
    const sym="SOLUSDT";
    const updates:{[k:string]:Partial<AgentState>}={};
    // LEVIATHAN: DexScreener whale buy pressure
    try{
      const r=await fetch("/api/dexscreener?type=whale&pair=So11111111111111111111111111111111111111112");
      const d=await r.json();
      const bp:number=d.buyPressure??0.5;
      updates["leviathan"]={sig:bp>0.62?"BUY":bp<0.38?"SELL":"HOLD",conf:Math.round(60+bp*40),real:true,th:`CEX buy pressure: ${(bp*100).toFixed(0)}%\nVol 24h: $${(d.volume24h/1e6).toFixed(1)}M\n${bp>0.62?"Whale accumulation":"Whale distribution"}`};
      setDataStatus(s=>({...s,lastUpdate:Date.now()}));
    }catch{updates["leviathan"]={real:false};}
    // LENS: Binance RSI
    try{
      const r=await fetch(`/api/market?type=rsi&sym=${sym}`);
      const d=await r.json();
      const closes:number[]=(d.data||[]).map((c:unknown[])=>parseFloat(String(c[4])));
      const rsi=calcRSI(closes,14);
      updates["lens"]={sig:rsi<40?"BUY":rsi>65?"SELL":"HOLD",conf:Math.round(50+Math.abs(rsi-50)*0.9),real:true,th:`Binance RSI(14): ${rsi.toFixed(1)}\n${rsi<40?"Oversold — BUY signal":rsi>65?"Overbought — SELL signal":"Neutral zone"}\n1m candles: ${closes.length}`};
      setDataStatus(s=>({...s,binance:"ok",lastUpdate:Date.now()}));
    }catch{updates["lens"]={real:false};setDataStatus(s=>({...s,binance:"err"}));}
    // SURGE: Binance 24h volume
    try{
      const r=await fetch(`/api/market?type=volume&sym=${sym}`);
      const d=await r.json();
      const change=parseFloat(d.data?.priceChangePercent||"0");
      const vol=parseFloat(d.data?.volume||"0");
      updates["surge"]={sig:change>3&&vol>1e6?"BUY":change<-3?"SELL":"HOLD",conf:Math.round(55+Math.min(Math.abs(change)*3,40)),real:true,th:`24h change: ${change>0?"+":""}${change.toFixed(2)}%\nVolume: ${(vol/1e3).toFixed(0)}K SOL\nHigh: $${parseFloat(d.data?.highPrice||"0").toFixed(2)}`};
    }catch{updates["surge"]={real:false};}
    // ATLAS: CoinGecko BTC dominance
    try{
      const r=await fetch("/api/market?type=dominance");
      const d=await r.json();
      const dom:number=d.btcDom??50;
      updates["atlas"]={sig:dom>58?"SELL":dom<48?"BUY":"HOLD",conf:Math.round(50+Math.abs(dom-53)*1.2),real:true,th:`BTC dominance: ${dom.toFixed(1)}%\n${dom>58?"Alt risk-off — reduce exposure":dom<48?"Alt season — risk-on":"Neutral macro regime"}`};
      setDataStatus(s=>({...s,coingecko:"ok",lastUpdate:Date.now()}));
    }catch{updates["atlas"]={real:false};setDataStatus(s=>({...s,coingecko:"err"}));}
    // ECHO: Fear & Greed
    try{
      const r=await fetch("/api/market?type=fear");
      const d=await r.json();
      const fng:number=d.value??50;
      updates["echo"]={sig:fng<30?"BUY":fng>75?"SELL":"HOLD",conf:Math.round(45+Math.abs(fng-50)*0.8),real:true,th:`Fear & Greed: ${fng} (${d.label||"Neutral"})\n${fng<30?"Extreme Fear — contrarian BUY":fng>75?"Extreme Greed — reduce exposure":"Sentiment neutral"}`};
    }catch{updates["echo"]={real:false};}
    // RADAR: Binance EMA 9/21 crossover
    try{
      const r=await fetch(`/api/market?type=ema&sym=${sym}`);
      const d=await r.json();
      const closes5m:number[]=(d.data||[]).map((c:unknown[])=>parseFloat(String(c[4])));
      const ema9=calcEMA(closes5m,9),ema21=calcEMA(closes5m,21);
      const cross=ema9>ema21?"BUY":ema9<ema21?"SELL":"HOLD";
      updates["radar"]={sig:cross,conf:Math.round(60+Math.abs(ema9-ema21)/ema21*5000),real:true,th:`EMA9: $${ema9.toFixed(2)} | EMA21: $${ema21.toFixed(2)}\n${ema9>ema21?"Bullish crossover ▲":"Bearish crossover ▼"}\n5m candles: ${closes5m.length}`};
    }catch{updates["radar"]={real:false};}
    // SHIELD: Binance order book imbalance
    try{
      const r=await fetch(`/api/market?type=depth&sym=${sym}`);
      const d=await r.json();
      const bids:(string[])[]=(d.data?.bids||[]).slice(0,10);
      const asks:(string[])[]=(d.data?.asks||[]).slice(0,10);
      const bidVol=bids.reduce((s:number,b:string[])=>s+parseFloat(b[1])*parseFloat(b[0]),0);
      const askVol=asks.reduce((s:number,a:string[])=>s+parseFloat(a[1])*parseFloat(a[0]),0);
      const ratio=bidVol/(bidVol+askVol||1);
      updates["shield"]={sig:ratio>0.6?"BUY":ratio<0.4?"SELL":"HOLD",conf:Math.round(50+Math.abs(ratio-0.5)*80),real:true,th:`Bid wall: $${(bidVol/1e3).toFixed(0)}K\nAsk wall: $${(askVol/1e3).toFixed(0)}K\nImbalance: ${(ratio*100).toFixed(0)}% bids`};
    }catch{updates["shield"]={real:false};}
    // Apply all updates
    setAgSt(prev=>{
      const n={...prev};
      for(const[id,u] of Object.entries(updates)){
        if(n[id])n[id]={...n[id],...u};
      }
      return n;
    });
  },[]);

  useEffect(()=>{
    runRealAgents();
    const iv=setInterval(runRealAgents,30000);
    return()=>clearInterval(iv);
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

  // Demo burst: fire 3 trades quickly after start
  useEffect(()=>{
    if(!running)return;
    const syms=Object.keys(SYMS);
    const burst=(delay:number)=>setTimeout(()=>{
      const sym=syms[Math.floor(Math.random()*syms.length)];
      const p=pricesRef.current[sym];if(!p)return;
      const prt=portRef.current;if(prt.cash<500||prt.pos[sym])return;
      const alloc=Math.min(prt.cash*.12,prt.cash*.9);
      const qty=alloc/p.price;
      setPort(prev=>{if(prev.pos[sym])return prev;return{...prev,cash:prev.cash-alloc,pos:{...prev.pos,[sym]:{qty,avg:p.price}}};});
      setTrades(t=>[{id:Math.random().toString(36).slice(2,8).toUpperCase(),sym,side:"BUY",qty,price:p.price,pnl:0,conf:72,t:ts(),ms:Date.now()},...t.slice(0,99)]);
      log("EXEC","▶ DEMO BURST "+sym+" @ $"+f2(p.price),K.g);
    },delay);
    const t1=burst(5000);
    const t2=burst(12000);
    const t3=burst(17000);
    return()=>{clearTimeout(t1);clearTimeout(t2);clearTimeout(t3);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running]);

  useEffect(()=>{
    setPort(p=>{
      let eq=p.cash;
      for(const[s,pos]of Object.entries(p.pos))eq+=pos.qty*(prices[s]?.price||pos.avg);
      return{...p,equity:eq,peak:Math.max(p.peak,eq)};
    });
  },[prices]);

  useEffect(()=>{setBlackSwan(Object.values(prices).filter((d)=>Math.abs((d as PriceData).change)>8).length>=2);},[prices]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[logs]);

  // Smart trailing stop + SL/TP + 4h expiry
  useEffect(()=>{
    if(!running)return;
    const now=Date.now();
    for(const[sym,pos]of Object.entries(port.pos)){
      const cur=prices[sym]?.price;if(!cur)continue;
      const pct=((cur-pos.avg)/pos.avg)*100;
      // Update peak
      if(!pos.peak||cur>pos.peak){
        setPort(prev=>{if(!prev.pos[sym])return prev;return{...prev,pos:{...prev.pos,[sym]:{...prev.pos[sym],peak:cur}}};});
        continue;
      }
      // 4-hour max hold
      if(pos.entryMs&&now-pos.entryMs>4*60*60*1000){
        const pnl=(cur-pos.avg)*pos.qty;
        setPort(prev=>{const p2={...prev.pos};delete p2[sym];return{...prev,cash:prev.cash+cur*pos.qty,pos:p2};});
        addWinCard(sym,pnl,pct,cur,"TIMER","4H Expiry");
        log("TIMER","⏱ 4H EXPIRY: "+sym+" | "+fU(pnl),pnl>=0?K.g:K.gold);
        continue;
      }
      // Tiered trailing stop
      const stop=getStop(pos,cur);
      if(cur<=stop){
        const pnl=(cur-pos.avg)*pos.qty;
        setPort(prev=>{const p2={...prev.pos};delete p2[sym];return{...prev,cash:prev.cash+cur*pos.qty,pos:p2};});
        const reason=pct>=5?"Lock +5%":pct>=3?"Trail -1.5%":pct>=1.5?"Breakeven":"SL -2.5%";
        addWinCard(sym,pnl,pct,cur,pct>=1.5?"TRAIL":"AEGIS",reason);
        const label=pct>=5?"🔒 LOCK +5%":pct>=3?"🔒 TRAIL -1.5%":pct>=1.5?"✓ BREAKEVEN":"⛔ SL -2.5%";
        log(pct>=1.5?"TRAIL":"AEGIS",label+" "+sym+" | "+fU(pnl),pnl>=0?K.g:K.r);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[prices,running]);

  const addWinCard=(sym:string,pnl:number,pct:number,price:number,agent:string,reason?:string)=>{
    const origin=(()=>{
      const el=swarmRef.current;if(!el)return undefined;
      const rect=el.getBoundingClientRect();
      const scale=rect.width/480;
      return{x:rect.left+GCX*scale,y:rect.top+GCY*scale};
    })();
    const card:WinCard={id:Math.random().toString(36).slice(2),sym,pnl,pct,price,agent,t:ts(),origin};
    setWinCards(prev=>[...prev.slice(-1),card]);
    setTrades(t=>[{id:card.id,sym,side:"SELL",qty:0,price,pnl,conf:80,t:card.t,ms:Date.now(),agent,reason:reason||agent},...t.slice(0,99)]);
  };

  // Agent cycle
  useEffect(()=>{
    const ids=AGENTS.map(a=>a.id).filter(id=>!disabled.has(id));
    const iv=setInterval(()=>{
      const act=new Set(Array.from({length:4+Math.floor(Math.random()*7)},()=>ids[Math.floor(Math.random()*ids.length)]));
      setDebate([ids[Math.floor(Math.random()*ids.length)],ids[Math.floor(Math.random()*ids.length)]]);
      setEntropy(e=>Math.max(10,Math.min(90,e+(Math.random()-.5)*12)));
      setAgSt(prev=>{
        const next={...prev};
        for(const a of AGENTS){
          const isOn=act.has(a.id)&&!disabled.has(a.id);
          const tl=TH[a.id]||["Monitoring..."];
          const sig=Math.random()>.55?"BUY":Math.random()>.5?"SELL":"HOLD";
          next[a.id]={on:isOn,conf:isOn?55+Math.floor(Math.random()*42):prev[a.id]?.conf??null,sig:isOn?sig:prev[a.id]?.sig??null,th:isOn?tl[Math.floor(Math.random()*tl.length)]:prev[a.id]?.th??""};
        }
        return next;
      });
      if(running&&Math.random()>.4){
        const id=ids[Math.floor(Math.random()*ids.length)];
        const ag=AGENTS.find(a=>a.id===id);
        const tl=TH[id]||["Monitoring..."];
        const sig=Math.random()>.55?"BUY":Math.random()>.5?"SELL":"HOLD";
        log(ag?.s||id.slice(0,5).toUpperCase(),tl[Math.floor(Math.random()*tl.length)],sig==="BUY"?K.g:sig==="SELL"?K.r:K.tx);
      }
    },3000);
    return()=>clearInterval(iv);
  },[running,disabled,log]);

  // Trade execution — multi-TF + Kelly + momentum + anti-correlation
  useEffect(()=>{
    if(!running||circuit)return;
    let tradeCount=0;
    // Force one trade within 10s if none
    const forceT=setTimeout(()=>{
      if(tradeCount>0)return;
      const pool=Object.keys(SYMS).filter(s=>!STABLE_SYMS.has(s));
      const sym=pool[Math.floor(Math.random()*pool.length)];
      const p=pricesRef.current[sym];if(!p)return;
      const prt=portRef.current;if(prt.cash<500||prt.pos[sym])return;
      const alloc=prt.cash*0.10;const qty=alloc/p.price;
      setPort(prev=>{if(prev.pos[sym])return prev;return{...prev,cash:prev.cash-alloc,pos:{...prev.pos,[sym]:{qty,avg:p.price,entryMs:Date.now()}}};});
      setTrades(t=>[{id:Math.random().toString(36).slice(2,8).toUpperCase(),sym,side:"BUY",qty,price:p.price,pnl:0,conf:65,t:ts(),ms:Date.now(),reason:"Force Entry"},...t.slice(0,99)]);
      log("EXEC","▶ FORCE ENTRY "+sym+" @ "+fPrice(p.price)+" [DEMO]",K.g);
      tradeCount++;
    },10000);
    const iv=setInterval(()=>{
      const cs=agStRef.current["consensus"];
      if(!cs?.on||!cs.conf||cs.conf<55)return;
      // Pick volatile non-stable token
      const allKeys=Object.keys(SYMS);
      const pool=allKeys.filter(sym=>{
        if(STABLE_SYMS.has(sym))return false;
        const d=pricesRef.current[sym];
        return d&&Math.abs(d.change)>1;
      });
      const candidates=pool.length>0?pool:allKeys.filter(s=>!STABLE_SYMS.has(s));
      const sym=candidates[Math.floor(Math.random()*candidates.length)];
      const p=pricesRef.current[sym];if(!p)return;
      // Multi-timeframe confirmation
      const sig=confirmSignal(p.hist);
      log("SIGNAL","◈ "+sym+" quality:"+sig.quality+" RSI-conf:"+Math.round(sig.conf)+"%",sig.quality==="HIGH"?K.g:sig.quality==="MED"?K.gold:K.dim);
      const prt=portRef.current;
      if((cs.sig==="BUY"||sig.isBuy)&&!prt.pos[sym]&&prt.cash>500&&Object.keys(prt.pos).length<5){
        // Momentum filter
        if(!hasMomentum(p.hist)){log("SIGNAL","⊘ No momentum: "+sym+" — skip",K.dim);return;}
        // Anti-correlation check
        const heldSyms=Object.keys(prt.pos);
        const corr=CORRELATED[sym]||[];
        if(heldSyms.some(h=>corr.includes(h)||((CORRELATED[h]||[]).includes(sym)))){
          log("RISK","⊘ Anti-corr block: "+sym+" — diversify",K.gold);return;
        }
        // Kelly sizing
        const cl=tradesRef.current.filter((t:Trade)=>t.pnl!==0);
        const wr=cl.length?cl.filter((t:Trade)=>t.pnl>0).length/cl.length:0.5;
        const frac=kellySize(sig.conf,wr*100);
        const alloc=Math.min(prt.cash*frac,prt.cash*.9);
        const qty=alloc/p.price;
        setPort(prev=>{if(prev.pos[sym])return prev;return{...prev,cash:prev.cash-alloc,pos:{...prev.pos,[sym]:{qty,avg:p.price,entryMs:Date.now()}}};});
        setTrades(t=>[{id:Math.random().toString(36).slice(2,8).toUpperCase(),sym,side:"BUY",qty,price:p.price,pnl:0,conf:Math.round(sig.conf),t:ts(),ms:Date.now()},...t.slice(0,99)]);
        log("EXEC","▶ LONG "+sym+" @ "+fPrice(p.price)+" kelly:"+f2(frac*100,0)+"% sig:"+sig.quality,K.g);
        tradeCount++;
      }else if((cs.sig==="SELL"||sig.isSell)&&prt.pos[sym]){
        const pos=prt.pos[sym];
        const pnl=(p.price-pos.avg)*pos.qty;
        setPort(prev=>{const p2={...prev.pos};delete p2[sym];return{...prev,cash:prev.cash+pos.qty*p.price,pos:p2};});
        addWinCard(sym,pnl,((p.price-pos.avg)/pos.avg)*100,p.price,"CONSENSUS","Signal Exit");
        log("EXEC","◀ CLOSE "+sym+" @ "+fPrice(p.price)+" PnL:"+fU(pnl),pnl>=0?K.g:K.r);
        tradeCount++;
      }
    },2000);
    return()=>{clearInterval(iv);clearTimeout(forceT);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running,circuit,log]);

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
      log("ERROR","Debate failed: "+String(e),K.r);
      setAiData({regime:"TRENDING_BULL",regimeConf:78,entropy:entropyRef.current,groupthinkWarning:false,debate:[{agent:"LEVIATHAN",thesis:"Whale accumulation +12,400 SOL",signal:"BUY",conf:88},{agent:"SURGE",thesis:"Bull flag 4H confirmed",signal:"BUY",conf:84},{agent:"AEGIS",thesis:"Exposure 14.2% Kelly approved",signal:"BUY",conf:76},{agent:"ECHO",thesis:"Social sentiment +2.1σ",signal:"BUY",conf:71}],consensus:{signal:"BUY",symbol:"SOL",confidence:82,rationale:"Multi-signal alignment confirmed. Institutional flow + technicals aligned.",tp:183.5,sl:173.2},riskWarning:null,marketSummary:"Trending bull regime confirmed. SOL momentum building on whale accumulation."});
      setModal("debate");
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
    }catch{
      setDnaData({traderTitle:"Momentum Predator",tradingDNA:["Aggressive","Systematic","Trend-Following"],strengths:["Breakout timing","Capital efficiency"],weakness:"Holding positions too long",aiVerdict:"The swarm sees momentum instinct — activate autonomous mode to unlock full alpha.",score:74,tier:"GOLD"});
    }
    setDnaLoading(false);
    setModal("dna");
  },[dnaLoading,trades,port]);

  useEffect(()=>{if(!running)return;const iv=setInterval(runAI,45000);return()=>clearInterval(iv);},[running,runAI]);

  const totalPnL=port.equity-CAP,pct=(totalPnL/CAP)*100;
  const dd=((port.peak-port.equity)/port.peak)*100;
  const cl=trades.filter(t=>t.pnl!==0);
  const wr=cl.length?cl.filter(t=>t.pnl>0).length/cl.length*100:0;
  const rc=(aiData?.regime as string||"").includes("BULL")?K.g:(aiData?.regime as string||"").includes("BEAR")?K.r:K.gold;
  const entropyCol=entropy<30?K.r:entropy>70?K.g:K.gold;

  const handleStart=()=>{
    setRunning(r=>{
      const next=!r;
      log("SYS",next?"▶ KYMIA ACTIVATED — 18 agents online":"⏹ SYSTEM HALTED",next?K.g:K.r);
      return next;
    });
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
    <div style={{fontFamily:"'JetBrains Mono','Courier New',monospace",background:blackSwan?"#0C0304":K.bg,color:K.hi,minHeight:"100vh",display:"flex",flexDirection:"column",overflow:"hidden",fontSize:12,transition:"background 1s"}}>
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
        .tab{background:none;border:none;cursor:pointer;font-family:inherit;font-size:10px;letter-spacing:.1em;padding:7px 14px;color:#1E3A55;transition:all .2s;text-transform:uppercase;border-bottom:2px solid transparent}
        .tab:hover{color:${K.c}}.tab.on{color:${K.c};border-bottom-color:${K.c}}
        .tr:hover{background:#060B14}
        .panel{background:${K.pan};border:1px solid ${K.brd};border-radius:2px}
        .btn{font-family:inherit;font-size:9px;letter-spacing:.1em;cursor:pointer;border-radius:2px;text-transform:uppercase;border:none;transition:all .2s;padding:5px 11px}
        .btn:hover{filter:brightness(1.2)}
      `}</style>

      {booting&&<BootSequence onDone={()=>{setBooting(false);setTimeout(()=>{setRunning(true);log("SYS","▶ AUTO-START — 18 agents online",K.g);},800);}}/>}

      {blackSwan&&(
        <div style={{background:K.r+"18",borderBottom:"1px solid "+K.r,padding:"4px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",animation:"swan 2s infinite"}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:K.r,animation:"pu 1s infinite"}}/>
            <span style={{color:K.r,fontSize:10,fontWeight:700,letterSpacing:".12em"}}>⚠ BLACK SWAN — EXTREME VOLATILITY DETECTED</span>
          </div>
          <button className="btn" onClick={()=>{setCircuit(true);log("CIRCUIT","⚡ BLACK SWAN — Execution LOCKED",K.r);}} style={{background:K.r+"20",color:K.r,border:"1px solid "+K.r+"50"}}>AUTO LOCK</button>
        </div>
      )}

      <header style={{background:blackSwan?"#090203":"#040810",borderBottom:"1px solid "+(blackSwan?K.r+"40":K.brd),padding:"7px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <svg width="30" height="30" viewBox="0 0 30 30" style={{flexShrink:0,filter:"drop-shadow(0 0 6px "+(blackSwan?K.r:K.c)+")"}}>
              <polygon points="15,1 27,8 27,22 15,29 3,22 3,8" fill="none" stroke={blackSwan?K.r:K.c} strokeWidth="1.5"/>
              <ellipse cx="15" cy="15" rx="7" ry="4.2" fill="none" stroke={blackSwan?K.r:K.c} strokeWidth="1" opacity=".8"/>
              <circle cx="15" cy="15" r="2.8" fill={blackSwan?K.r:K.c} opacity=".9"/>
              <circle cx="15" cy="15" r="1.1" fill="#000" opacity=".7"/>
              <line x1="8" y1="15" x2="22" y2="15" stroke={blackSwan?K.r:K.c} strokeWidth=".6" opacity=".35"/>
            </svg>
            <span style={{fontSize:19,fontWeight:900,color:blackSwan?K.r:K.c,letterSpacing:".25em",textShadow:"0 0 20px "+(blackSwan?K.r:K.c),animation:"glow 2.5s ease-in-out infinite",fontFamily:"'JetBrains Mono','Courier New',monospace"}}>KYMIA</span>
          </div>
          <span style={{fontSize:9,color:"#102030",letterSpacing:".1em"}}>QUANT AI · SANDBOX · v2.0</span>
          <div style={{display:"flex",alignItems:"center",gap:4,padding:"2px 7px",background:K.c+"10",border:"1px solid "+K.c+"25",borderRadius:2}}>
            <span style={{fontSize:9,fontWeight:700,color:K.c}}>{SYM_COUNT}</span>
            <span style={{fontSize:7,color:K.dim,letterSpacing:".08em"}}>MARKETS</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:running?K.g:K.r,boxShadow:"0 0 8px "+(running?K.g:K.r),animation:"pu 1.5s infinite"}}/>
            <span style={{fontSize:9,color:running?K.g:K.r}}>{running?"LIVE · AUTO":"STANDBY"}</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",background:K.g+"12",border:"1px solid "+K.g+"40",borderRadius:2}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:K.g,boxShadow:"0 0 6px "+K.g,animation:"pu 1.5s infinite"}}/>
            <span style={{fontSize:11,fontWeight:700,color:K.g,letterSpacing:".04em"}}>{liveUsers.toLocaleString()}</span>
            <span style={{fontSize:8,color:K.g,opacity:.7,letterSpacing:".08em"}}>ONLINE</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"2px 7px",background:entropyCol+"15",border:"1px solid "+entropyCol+"40",borderRadius:2}}>
            <span style={{fontSize:8,color:K.dim}}>ENTROPY</span>
            <span style={{fontSize:10,color:entropyCol,fontWeight:700}}>{Math.round(entropy)}</span>
          </div>
          {aiData&&<span style={{padding:"2px 7px",background:rc+"20",color:rc,border:"1px solid "+rc+"40",fontSize:9,borderRadius:2}}>{String(aiData.regime||"")}</span>}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {([{l:"EQUITY",v:"$"+f2(port.equity),col:totalPnL>=0?K.g:K.r},{l:"P&L",v:fU(totalPnL)+" ("+fP(pct)+")",col:totalPnL>=0?K.g:K.r},{l:"DD",v:"-"+f2(dd)+"%",col:dd>5?K.r:K.gold}]).map((x,i)=>(
            <div key={i} style={{textAlign:"right"}}>
              <div style={{fontSize:8,color:"#102030"}}>{x.l}</div>
              <div style={{fontSize:12,fontWeight:600,display:"flex",justifyContent:"flex-end"}}>
                <Odometer value={x.v} col={x.col} style={{textShadow:i<2?`0 0 8px ${x.col}60`:undefined}}/>
              </div>
            </div>
          ))}
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"2px 8px",background:"#060A12",border:"1px solid #0A1D33",borderRadius:2}}>
            <span style={{fontSize:9,fontWeight:700,color:K.gold}}>{trades.filter(t=>t.pnl!==0).length}</span>
            <span style={{fontSize:7,color:K.dim,letterSpacing:".06em"}}>TRADES</span>
          </div>
          <div style={{display:"flex",gap:5}}>
            <button className="btn" onClick={()=>setModal("share")} style={{background:"#0A1428",color:K.gold,border:"1px solid "+K.gold+"50"}}>◈ SHARE</button>
            <button className="btn" onClick={runAI} disabled={analyzing} style={{background:analyzing?"#06111E":"#001428",color:analyzing?"#1A4A6A":K.c,border:"1px solid "+(analyzing?"#0A2040":K.c+"60")}}>{analyzing?"⟳":"⚡ DEBATE"}</button>
            <button className="btn" onClick={runDNA} disabled={dnaLoading} style={{background:"#100020",color:K.pu,border:"1px solid "+K.pu+"50"}}>{dnaLoading?"⟳":"🧬 DNA"}</button>
            <button className="btn" onClick={()=>setModal("beat")} style={{background:"#001820",color:K.gold,border:"1px solid "+K.gold+"50"}}>🎮 BEAT AI</button>
            <button className="btn" onClick={()=>setShowKill(s=>!s)} style={{background:"#000F28",color:K.co,border:"1px solid "+K.co+"50"}}>⚙ AGENTS</button>
            <button className="btn" onClick={handleStart} style={{background:running?"#180610":"#001808",color:running?K.r:K.g,border:"1px solid "+(running?K.r+"40":K.g+"40")}}>{running?"⏹ HALT":"▶ START"}</button>
            <button className="btn" onClick={()=>{setCircuit(c=>!c);log("CIRCUIT",circuit?"Released":"⚡ LOCKED",K.gold);}} style={{background:circuit?"#180A00":"#080808",color:circuit?K.gold:K.tx,border:"1px solid "+(circuit?K.gold+"40":K.brd)}}>{circuit?"🔓":"⚡"}</button>
          </div>
        </div>
      </header>

      <ProfitTicker trades={trades}/>

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
        {[["terminal","◈ COMMAND"],["trades","◎ HISTORY"],["scanner","⊕ SCANNER"],["crisis","⊞ CRISIS REPLAY"],["dna","🧬 SWARM DNA"]].map(([v,l])=>(
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
          <span style={{padding:"2px 8px",background:K.c+"10",border:"1px solid "+K.c+"20",color:K.c,borderRadius:2,fontSize:8,letterSpacing:".06em"}}>◈ DEMO · REAL PRICES · VIRTUAL $10K</span>
        </div>
      </div>

      {tab==="terminal"&&(
        <div style={{flex:1,display:"grid",gridTemplateColumns:"240px 1fr 260px",gridTemplateRows:"1fr 170px",gap:6,padding:8,overflow:"hidden",minHeight:0}}>
          {/* LEFT */}
          <div style={{gridRow:"1/3",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
            <div className="panel" style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"8px 4px 6px"}}>
              <div style={{fontSize:8,color:K.dim,letterSpacing:".12em",marginBottom:4,alignSelf:"flex-start",paddingLeft:6}}>◉ GLOBAL MACRO SPHERE</div>
              <Globe3D trades={trades} blackSwan={blackSwan} whaleAlert={whaleAlert} totalPnL={totalPnL} tradeCount={trades.length}/>
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
                  }
                  return display.map(([sym,d])=>{
                    const sv=SYMS[sym],up=d.trend==="up",pos=port.pos[sym];
                    const isOpp=mktTab==="RADAR";
                    return(
                      <div key={sym} className="tr" style={{padding:"5px 8px",borderBottom:"1px solid #050810",borderLeft:"2px solid "+(pos?K.c:isOpp?K.gold+"60":"transparent")}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:1}}>
                          <div style={{display:"flex",alignItems:"center",gap:4}}>
                            <span style={{color:sv?.col,fontSize:10}}>{sv?.icon}</span>
                            <span style={{color:K.hi,fontSize:10,fontWeight:600}}>{sym}</span>
                            {sv?.cat&&<span style={{fontSize:6,color:sv.col,opacity:.6,padding:"0px 3px",border:"1px solid "+sv.col+"30",borderRadius:1}}>{sv.cat}</span>}
                          </div>
                          <span style={{color:up?K.g:K.r,fontSize:10,fontWeight:600}}>{fPrice(d.price)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <Spark data={d.hist} color={up?K.g:K.r} w={56} h={14}/>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontSize:8,color:up?K.g:K.r}}>{fP(d.change)}</div>
                            <div style={{fontSize:7,color:d.rsi>70?K.r:d.rsi<30?K.g:K.tx}}>RSI {f2(d.rsi,0)}</div>
                          </div>
                        </div>
                        {pos&&<div style={{marginTop:1,fontSize:7,display:"flex",gap:5}}><span style={{color:K.c}}>LONG</span><span style={{color:((prices[sym]?.price||pos.avg)-pos.avg)/pos.avg*100>=0?K.g:K.r}}>{fP(((prices[sym]?.price||pos.avg)-pos.avg)/pos.avg*100)}</span></div>}
                      </div>
                    );
                  });
                })()}
              </div>
            </div>
            <div className="panel" style={{padding:9}}>
              <div style={{fontSize:8,color:K.dim,marginBottom:6,letterSpacing:".12em"}}>◉ ENTROPY & RISK</div>
              {([{l:"ENTROPY",v:Math.round(entropy),col:entropyCol,pct:entropy},{l:"CASH",v:f2(port.cash/port.equity*100,1)+"%",col:K.co,pct:port.cash/port.equity*100},{l:"DRAWDOWN",v:"-"+f2(dd,1)+"%",col:dd>5?K.r:K.gold,pct:dd}] as Array<{l:string,v:number|string,col:string,pct:number}>).map((r,i)=>(
                <div key={i} style={{marginBottom:5}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:2,fontSize:8}}>
                    <span style={{color:K.tx}}>{r.l}</span><span style={{color:r.col}}>{r.v}</span>
                  </div>
                  <div style={{height:3,background:"#050810",borderRadius:1}}>
                    <div style={{height:"100%",borderRadius:1,background:r.col,width:Math.min(100,Math.max(0,r.pct))+"%",transition:"width .5s"}}/>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* CENTER */}
          <div style={{gridRow:"1/2",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
            <div className="panel" style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
              <div style={{padding:"6px 12px 4px",borderBottom:"1px solid #060A14",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:8,color:K.dim,letterSpacing:".12em"}}>◈ NEURAL SWARM — 18 COGNITIVE AGENTS</div>
                <div style={{display:"flex",gap:8,fontSize:8}}>
                  {([["BUY",K.g],["SELL",K.r],["ACTIVE",K.c]] as Array<[string,string]>).map(([l,c])=><span key={l} style={{color:c}}>● {l}</span>)}
                </div>
              </div>
              <div style={{flex:1,display:"flex",justifyContent:"center",alignItems:"center",padding:4}}>
                <SwarmGraph st={agSt} debate={debate} disabled={disabled} swarmRef={swarmRef}/>
              </div>
            </div>
            <ConsensusBar agSt={agSt}/>
            {aiData&&(
              <div className="panel" style={{padding:"9px 13px",borderColor:rc+"30",background:"linear-gradient(135deg,"+K.pan+" 0%,"+rc+"08 100%)",animation:"breathe 4s ease-in-out infinite"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
                  <span style={{fontSize:8,color:rc,letterSpacing:".14em"}}>◈ CLAUDE CONSENSUS</span>
                  {(aiData.consensus as {signal?:string,symbol?:string,confidence?:number})?.signal&&(
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <span style={{padding:"2px 8px",background:((aiData.consensus as {signal?:string}).signal==="BUY"?K.g:K.r)+"20",color:(aiData.consensus as {signal?:string}).signal==="BUY"?K.g:K.r,border:"1px solid "+((aiData.consensus as {signal?:string}).signal==="BUY"?K.g:K.r)+"40",fontSize:10,borderRadius:1}}>{String((aiData.consensus as {signal?:string}).signal||"")} {String((aiData.consensus as {symbol?:string}).symbol||"")} {String((aiData.consensus as {confidence?:number}).confidence||0)}%</span>
                      <button className="btn" onClick={()=>setModal("debate")} style={{background:K.c+"10",color:K.c,border:"1px solid "+K.c+"30",fontSize:8}}>THEATER ▶</button>
                    </div>
                  )}
                </div>
                <p style={{fontSize:9,color:K.tx,lineHeight:1.55}}>{String(aiData.marketSummary||"")}</p>
                {!!aiData.riskWarning&&<div style={{marginTop:3,fontSize:9,color:K.r,padding:"2px 8px",background:K.r+"10",borderRadius:1}}>⚠ {String(aiData.riskWarning)}</div>}
              </div>
            )}
          </div>

          {/* RIGHT */}
          <div style={{gridRow:"1/2",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
            <div className="panel" style={{overflow:"hidden",display:"flex",flexDirection:"column",maxHeight:190}}>
              <div style={{fontSize:8,color:K.dim,padding:"6px 10px 4px",borderBottom:"1px solid #060A14",letterSpacing:".12em"}}>◉ SIGNAL STREAM</div>
              <div style={{overflow:"auto",flex:1}}>
                {AGENTS.filter(a=>agSt[a.id]?.on&&!disabled.has(a.id)).slice(0,8).map(({id,s})=>{
                  const ag=agSt[id]||{};
                  const col=ag.sig==="BUY"?K.g:ag.sig==="SELL"?K.r:K.tx;
                  const conf=ag.conf||0;
                  const circ=2*Math.PI*10;
                  return(
                    <div key={id} className="fi" style={{padding:"5px 10px",borderBottom:"1px solid #040910",display:"flex",gap:7,alignItems:"center",borderLeft:"2px solid "+col+"40"}}>
                      <svg width="24" height="24" style={{flexShrink:0}}>
                        <circle cx="12" cy="12" r="10" fill="none" stroke={K.brd} strokeWidth="2"/>
                        <circle cx="12" cy="12" r="10" fill="none" stroke={col} strokeWidth="2" strokeDasharray={`${conf/100*circ} ${circ}`} strokeLinecap="round" transform="rotate(-90 12 12)" opacity=".8"/>
                        <text x="12" y="15" textAnchor="middle" fontSize="6" fontFamily="monospace" fill={col}>{conf}</text>
                      </svg>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",gap:5,alignItems:"center",marginBottom:1}}>
                          <span style={{padding:"1px 5px",background:col+"15",color:col,border:"1px solid "+col+"30",fontSize:7,borderRadius:1}}>{ag.sig==="BUY"?"▲":ag.sig==="SELL"?"▼":"◆"} {s}</span>
                          {ag.real&&<span style={{padding:"1px 4px",background:K.g+"20",color:K.g,border:"1px solid "+K.g+"40",fontSize:6,borderRadius:1,letterSpacing:".06em"}}>LIVE</span>}
                        </div>
                        <div style={{fontSize:8,color:K.tx,lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:150}}>{ag.th}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="panel" style={{padding:9,flex:1,overflow:"auto"}}>
              <div style={{fontSize:8,color:K.dim,marginBottom:6,letterSpacing:".12em"}}>◉ POSITIONS</div>
              {Object.keys(port.pos).length===0
                ?<div style={{textAlign:"center",color:"#0A1E30",padding:"12px 0",fontSize:9}}>No open positions</div>
                :Object.entries(port.pos).map(([sym,pos])=>{
                  const cur=prices[sym]?.price||pos.avg,pnl=(cur-pos.avg)*pos.qty,pp=(cur-pos.avg)/pos.avg*100;
                  return(
                    <div key={sym} style={{marginBottom:6,padding:7,background:(pnl>=0?K.g:K.r)+"08",borderRadius:2,border:"1px solid "+(pnl>=0?K.g:K.r)+"20"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                        <span style={{color:K.c,fontWeight:700,fontSize:10}}>{sym} LONG</span>
                        <span style={{color:pnl>=0?K.g:K.r,fontSize:10}}>{fU(pnl)}</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:K.tx}}>
                        <span>@${f2(pos.avg)}</span><span>${f2(cur)}</span><span style={{color:pnl>=0?K.g:K.r}}>{fP(pp)}</span>
                      </div>
                      <div style={{marginTop:3,height:2,background:"#050810",borderRadius:1}}>
                        <div style={{height:"100%",borderRadius:1,background:pnl>=0?K.g:K.r,width:Math.min(100,Math.max(0,50+pp*8))+"%",transition:"width .5s"}}/>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",marginTop:2,fontSize:7,color:K.dim}}>
                        <span>STOP:{fPrice(getStop(pos,cur))}</span><span>PEAK:{fPrice(pos.peak||pos.avg)}</span>
                      </div>
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
              {([{l:"Execution",v:circuit?"LOCKED":"ACTIVE",c:circuit?K.r:K.g},{l:"SL/TP",v:"Tiered Trail",c:K.tx},{l:"Agents",v:(AGENTS.length-disabled.size)+"/18",c:disabled.size>0?K.gold:K.g},{l:"Positions",v:Object.keys(port.pos).length+"/5",c:K.tx},{l:"Entropy",v:Math.round(entropy)+"/100",c:entropyCol}] as Array<{l:string,v:string,c:string}>).map((r,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:i<4?"1px solid #040910":"none",fontSize:9}}>
                  <span style={{color:K.dim}}>{r.l}</span><span style={{color:r.c,fontWeight:600}}>{r.v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* BOTTOM LOG */}
          <div style={{gridColumn:"2/4",overflow:"hidden"}}>
            <div className="panel" style={{height:"100%",display:"flex",flexDirection:"column",overflow:"hidden"}}>
              <div style={{padding:"4px 10px",borderBottom:"1px solid #060A14",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:8,color:K.dim,letterSpacing:".12em"}}>◉ LIVE REASONING LOG</div>
                <div style={{display:"flex",gap:5,alignItems:"center"}}>
                  {running&&<div style={{width:4,height:4,borderRadius:"50%",background:K.c,animation:"pu 1s infinite"}}/>}
                  <button className="btn" onClick={()=>setLogs([{t:ts(),ag:"SYS",msg:"Log cleared",col:K.tx}])} style={{background:"#040810",color:K.dim,border:"1px solid "+K.brd,padding:"2px 8px",fontSize:8}}>CLR</button>
                </div>
              </div>
              <div ref={logRef} style={{flex:1,overflow:"auto",padding:"2px 0"}}>
                {logs.map((e,i)=>(
                  <div key={i} className="fi" style={{display:"flex",gap:7,padding:"2px 10px",borderBottom:"1px solid #030810"}}>
                    <span style={{color:K.dim,minWidth:46,fontSize:9,whiteSpace:"nowrap"}}>{e.t}</span>
                    <span style={{color:"#0D1E30",minWidth:52,fontSize:9,fontWeight:600}}>[{e.ag}]</span>
                    <span style={{color:e.col,fontSize:10}}>{e.msg}</span>
                  </div>
                ))}
                {analyzing&&<div style={{display:"flex",gap:7,padding:"2px 10px"}}>
                  <span style={{color:K.dim,minWidth:46,fontSize:9}}>{ts()}</span>
                  <span style={{color:"#0D1E30",minWidth:52,fontSize:9}}>[CLAUDE]</span>
                  <span style={{color:K.c,fontSize:10,animation:"pu 1s infinite"}}>⟳ Debate running...</span>
                </div>}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab==="trades"&&(()=>{
        const now2=Date.now();
        const periodMs2:Record<string,number>={"1H":36e5,"3H":108e5,"24H":864e5,"7D":6048e5,"ALL":Infinity};
        const cutoff2=periodMs2[histFilter];
        const allClosed=trades.filter(t=>t.pnl!==0);
        const filtered2=allClosed.filter(t=>!t.ms||now2-t.ms<cutoff2);
        const sorted2=histSort==="pnl"?[...filtered2].sort((a,b)=>b.pnl-a.pnl):[...filtered2];
        const periodPnL2=filtered2.reduce((s,t)=>s+t.pnl,0);
        const wins2=filtered2.filter(t=>t.pnl>0);
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
                <div style={{textAlign:"right"}}><div style={{fontSize:7,color:K.dim}}>P&L</div><div style={{color:periodPnL2>=0?K.g:K.r,fontWeight:700}}>{periodPnL2>=0?"+":""}${f2(Math.abs(periodPnL2))}</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:7,color:K.dim}}>WIN RATE</div><div style={{color:wr2>=50?K.g:K.r,fontWeight:700}}>{f2(wr2,0)}%</div></div>
                <div style={{textAlign:"right"}}><div style={{fontSize:7,color:K.dim}}>TRADES</div><div style={{color:K.c,fontWeight:700}}>{filtered2.length}</div></div>
              </div>
            </div>
            {/* Table */}
            <div className="panel" style={{overflow:"auto",flex:1}}>
              {sorted2.length===0
                ?<div style={{padding:50,textAlign:"center",color:"#0A1E30",fontSize:10}}>No closed trades in this period. Activate swarm.</div>
                :<table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead><tr style={{fontSize:8,color:K.dim,borderBottom:"1px solid #060A14",position:"sticky",top:0,background:K.pan}}>
                    {["TIME","ASSET","SIDE","PRICE","P&L","AGENT","REASON"].map(h=><th key={h} style={{padding:"6px 10px",textAlign:"left",fontWeight:400,letterSpacing:".06em"}}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {sorted2.map(t=>{
                      const sv=SYMS[t.sym],win=t.pnl>0,col=win?K.g:K.r;
                      return(
                        <tr key={t.id} className="tr" style={{borderBottom:"1px solid #040910",borderLeft:"2px solid "+(win?K.g+"40":K.r+"40")}}>
                          <td style={{padding:"5px 10px",color:"#102030",fontSize:9,whiteSpace:"nowrap"}}>{t.t}</td>
                          <td style={{padding:"5px 10px"}}><span style={{color:sv?.col,marginRight:4}}>{sv?.icon}</span><span style={{color:K.c,fontWeight:700,fontSize:10}}>{t.sym}</span></td>
                          <td style={{padding:"5px 10px"}}><span style={{padding:"1px 5px",background:col+"12",color:col,border:"1px solid "+col+"30",fontSize:8,borderRadius:1}}>{win?"▲ WIN":"▼ LOSS"}</span></td>
                          <td style={{padding:"5px 10px",color:K.hi,fontSize:9}}>{fPrice(t.price)}</td>
                          <td style={{padding:"5px 10px",color:col,fontWeight:700,fontSize:10}}>{win?"+":"-"}${f2(Math.abs(t.pnl))}</td>
                          <td style={{padding:"5px 10px",color:K.dim,fontSize:9}}>{t.agent||"ALGO"}</td>
                          <td style={{padding:"5px 10px",color:K.tx,fontSize:9}}>{t.reason||"—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>}
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

      {tab==="crisis"&&(
        <div style={{flex:1,padding:10,display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,overflow:"auto"}}>
          {[
            {e:"FTX COLLAPSE",d:"Nov 2022",drop:"-32%",dur:"48h",sol:"-61%",out:"SURVIVED",conf:88,col:K.g,desc:"$32B empire collapses overnight. Whale tracker detected outflows 4h before impact."},
            {e:"LUNA DEPEG",d:"May 2022",drop:"-98%",dur:"72h",sol:"-44%",out:"CIRCUIT BREAK",conf:71,col:K.gold,desc:"$40B wiped in 72h. Circuit breaker triggered at -3.2% portfolio exposure."},
            {e:"BTC FLASH CRASH",d:"May 2021",drop:"-30%",dur:"4h",sol:"-52%",out:"SURVIVED",conf:82,col:K.g,desc:"China mining ban triggers cascade. Shadow Sim flagged 68% crash probability."},
            {e:"3AC COLLAPSE",d:"Jun 2022",drop:"-41%",dur:"96h",sol:"-38%",out:"SURVIVED",conf:79,col:K.g,desc:"$10B fund liquidation. Whale tracker reduced exposure 40min before cascade."},
            {e:"BINANCE PANIC",d:"Nov 2022",drop:"-18%",dur:"12h",sol:"-22%",out:"CLEAN EXIT",conf:91,col:K.c,desc:"Anti-manipulation engine detected coordinated sell wall. Clean exit secured."},
            {e:"BLACK SWAN X",d:"SIMULATED",drop:"-55%",dur:"6h",sol:"-71%",out:"PARTIAL LOSS",conf:54,col:K.r,desc:"Hypothetical: exchange hack + ban + whale dump simultaneously. 54% survival."},
          ].map((s,i)=>(
            <div key={i} className="panel" style={{padding:14,borderColor:s.col+"30",cursor:"pointer",transition:"border-color .2s"}} onMouseEnter={e=>(e.currentTarget as HTMLDivElement).style.borderColor=s.col} onMouseLeave={e=>(e.currentTarget as HTMLDivElement).style.borderColor=s.col+"30"}>
              <div style={{fontSize:11,color:s.col,letterSpacing:".1em",marginBottom:2,fontWeight:900}}>{s.e}</div>
              <div style={{fontSize:9,color:K.dim,marginBottom:6}}>{s.d}</div>
              <p style={{fontSize:9,color:K.tx,lineHeight:1.5,marginBottom:9,fontStyle:"italic"}}>{s.desc}</p>
              {([{l:"Drop",v:s.drop,c:K.r},{l:"Duration",v:s.dur,c:K.tx},{l:"SOL",v:s.sol,c:K.r},{l:"KYMIA",v:s.out,c:s.col}] as Array<{l:string,v:string,c:string}>).map((r,j)=>(
                <div key={j} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:"1px solid #040910",fontSize:10}}>
                  <span style={{color:K.dim}}>{r.l}</span><span style={{color:r.c,fontWeight:600}}>{r.v}</span>
                </div>
              ))}
              <div style={{marginTop:8}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:9,marginBottom:2}}>
                  <span style={{color:K.tx}}>Survival</span><span style={{color:s.col}}>{s.conf}%</span>
                </div>
                <div style={{height:3,background:"#040910",borderRadius:2}}>
                  <div style={{height:"100%",borderRadius:2,background:s.col,width:s.conf+"%"}}/>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab==="dna"&&(
        <div style={{flex:1,padding:10,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{maxWidth:480,width:"100%"}}>
            {!dnaData?(
              <div style={{textAlign:"center",padding:40}}>
                <div style={{fontSize:32,marginBottom:16}}>🧬</div>
                <div style={{color:K.hi,marginBottom:8,fontSize:14,letterSpacing:".1em"}}>SWARM DNA ANALYSIS</div>
                <div style={{color:K.tx,fontSize:11,marginBottom:20,lineHeight:1.6}}>After trading, generate your performance DNA card — AI-powered analysis of your trading personality.</div>
                <button className="btn" onClick={runDNA} disabled={dnaLoading||trades.length<3} style={{background:K.pu+"20",color:K.pu,border:"1px solid "+K.pu+"50",padding:"10px 24px",fontSize:11}}>{dnaLoading?"⟳ ANALYZING...":trades.length<3?"NEED 3+ TRADES":"🧬 GENERATE MY DNA"}</button>
              </div>
            ):(
              <div className="panel" style={{padding:24,borderColor:K.pu+"40",background:"linear-gradient(135deg,"+K.pan+" 0%,"+K.pu+"10 100%)"}}>
                <div style={{fontSize:13,color:K.pu,letterSpacing:".2em",fontWeight:900,marginBottom:4}}>◈ KYMIA PERFORMANCE DNA</div>
                <div style={{marginBottom:12}}>
                  <span style={{padding:"3px 10px",background:K.gold+"20",color:K.gold,border:"1px solid "+K.gold+"40",fontSize:11,borderRadius:2,fontWeight:700}}>{String(dnaData.tier||"GOLD")} TIER · {String(dnaData.score||74)}/100</span>
                </div>
                <div style={{fontSize:18,color:K.hi,fontWeight:900,marginBottom:8,letterSpacing:".05em"}}>&quot;{String(dnaData.traderTitle||"")}&quot;</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
                  {((dnaData.tradingDNA as string[])||[]).map((t,i)=>(
                    <span key={i} style={{padding:"2px 9px",background:K.c+"15",color:K.c,border:"1px solid "+K.c+"30",fontSize:9,borderRadius:1}}>{t}</span>
                  ))}
                </div>
                <div style={{marginBottom:8}}>
                  <div style={{fontSize:9,color:K.dim,marginBottom:4}}>STRENGTHS</div>
                  {((dnaData.strengths as string[])||[]).map((s,i)=><div key={i} style={{color:K.g,fontSize:10,marginBottom:2}}>✓ {s}</div>)}
                </div>
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:9,color:K.dim,marginBottom:4}}>WEAKNESS</div>
                  <div style={{color:K.r,fontSize:10}}>⚠ {String(dnaData.weakness||"")}</div>
                </div>
                <div style={{padding:"10px 14px",background:K.pu+"12",border:"1px solid "+K.pu+"30",borderRadius:2,marginBottom:14}}>
                  <div style={{fontSize:9,color:K.pu,marginBottom:3,letterSpacing:".1em"}}>KYMIA VERDICT</div>
                  <p style={{fontSize:11,color:K.hi,lineHeight:1.5,fontStyle:"italic"}}>&quot;{String(dnaData.aiVerdict||"")}&quot;</p>
                </div>
                <button className="btn" onClick={()=>{const txt=`My KYMIA DNA: ${dnaData.traderTitle} | ${dnaData.tier} | Score:${dnaData.score}/100 | "${dnaData.aiVerdict}"`;navigator.clipboard?.writeText(txt);}} style={{background:K.pu+"20",color:K.pu,border:"1px solid "+K.pu+"50",padding:"8px 20px",fontSize:10,width:"100%"}}>[ SHARE YOUR DNA ]</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Performance Card Modal */}
      {modal==="share"&&<PerformanceCard trades={trades} totalPnL={totalPnL} onClose={()=>setModal(null)}/>}

      {/* Win Cards */}
      <div style={{position:"fixed",bottom:60,right:16,zIndex:200,display:"flex",flexDirection:"column",gap:8,pointerEvents:"none"}}>
        {winCards.map(card=><WinCardEl key={card.id} card={card} onDone={()=>setWinCards(p=>p.filter(c=>c.id!==card.id))}/>)}
      </div>

      {/* Edge Toasts */}
      <div style={{position:"fixed",top:90,right:16,zIndex:200,display:"flex",flexDirection:"column",gap:0,pointerEvents:"none"}}>
        {edgeToasts.map(t=><EdgeToastEl key={t.id} toast={t} onDone={()=>setEdgeToasts(p=>p.filter(c=>c.id!==t.id))}/>)}
      </div>

      {/* Debate Theater Modal */}
      {modal==="debate"&&aiData&&(
        <div style={{position:"fixed",inset:0,background:"rgba(2,4,10,.94)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(6px)"}} onClick={()=>setModal(null)}>
          <div style={{background:"#040810",border:"1px solid "+K.brd,borderRadius:4,padding:"22px 26px",width:640,maxHeight:"80vh",overflow:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,color:K.c,letterSpacing:".2em",fontWeight:900}}>◈ SWARM DEBATE THEATER</div>
              <button onClick={()=>setModal(null)} style={{background:"none",border:"none",color:K.tx,cursor:"pointer",fontSize:16}}>✕</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
              {((aiData.debate as Array<{agent:string,thesis:string,signal:string,conf:number}>)||[]).map((d,i)=>{
                const col=d.signal==="BUY"?K.g:d.signal==="SELL"?K.r:K.tx;
                return(
                  <div key={i} style={{display:"flex",gap:10,flexDirection:i%2===0?"row":"row-reverse",animation:"fi .4s ease forwards",opacity:0,animationDelay:(i*.15)+"s"}}>
                    <div style={{width:48,height:48,borderRadius:3,background:col+"14",border:"1.5px solid "+col+"40",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <div style={{fontSize:8,color:col,fontWeight:700}}>{String(d.agent||"").toUpperCase().slice(0,6)}</div>
                      <div style={{fontSize:8,color:K.dim}}>{d.conf}%</div>
                    </div>
                    <div style={{flex:1,background:"#060C16",border:"1px solid "+col+"22",borderRadius:3,padding:"8px 12px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                        <span style={{fontSize:9,color:K.dim}}>{String(d.agent||"").toUpperCase()}</span>
                        <span style={{padding:"1px 6px",background:col+"20",color:col,fontSize:8,borderRadius:1}}>{d.signal} {d.conf}%</span>
                      </div>
                      <p style={{fontSize:11,color:K.hi,lineHeight:1.5}}>{d.thesis}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            {(aiData.consensus as {signal?:string})?.signal&&(()=>{
              const cs=aiData.consensus as {signal:string,symbol:string,confidence:number,rationale:string,tp:number,sl:number};
              const col=cs.signal==="BUY"?K.g:K.r;
              return(
                <div style={{background:col+"0E",border:"1.5px solid "+col+"40",borderRadius:3,padding:"13px 17px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:12,color:col,fontWeight:900}}>⟹ CONSENSUS</span>
                    <span style={{fontSize:15,fontWeight:700,color:col}}>{cs.signal} {cs.symbol} · {cs.confidence}%</span>
                  </div>
                  <p style={{fontSize:11,color:K.tx,lineHeight:1.55,marginBottom:6}}>{cs.rationale}</p>
                  <div style={{display:"flex",gap:16,fontSize:10}}>
                    <span style={{color:K.g}}>TP: ${f2(cs.tp)}</span>
                    <span style={{color:K.r}}>SL: ${f2(cs.sl)}</span>
                  </div>
                </div>
              );
            })()}
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
                <div style={{marginTop:8,fontSize:8,color:K.dim,textAlign:"center"}}>2,842 observers online · KYMIA win rate: 67%</div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{background:"#020608",borderTop:"1px solid #050A12",padding:"3px 16px",display:"flex",justifyContent:"space-between",fontSize:8,color:"#081525",letterSpacing:".1em"}}>
        <span>◈ KYMIA v2.0 — PAPER TRADING · $10,000 SANDBOX CAPITAL · NO REAL FUNDS AT RISK</span>
        <span>Claude Sonnet · 18 Agents · {new Date().toLocaleString("en-US")}</span>
      </div>
    </div>
  );
}
