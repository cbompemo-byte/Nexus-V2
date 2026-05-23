"use client";
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { motion, useAnimationControls } from "framer-motion";

const K={c:"#00F2FE",r:"#FF3366",g:"#00FF88",gold:"#FFD700",pu:"#BD00FF",co:"#0044EE",bg:"#04060D",pan:"#060A12",brd:"#0A1D33",dim:"#2A5070",hi:"#A8D0EC",tx:"#4A7090"};
const CAP=10000;
const f2=(n:number,d=2)=>Number(n).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fP=(n:number)=>`${n>=0?"+":""}${f2(n)}%`;
const fU=(n:number)=>`${n>=0?"+":"-"}$${f2(Math.abs(n))}`;
const ts=()=>new Date().toLocaleTimeString("en-US",{hour12:false});

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

const SYMS:{[k:string]:{base:number,vol:number,col:string,icon:string}}={
  SOL:{base:178.4,vol:.0028,col:K.c,icon:"◎"},
  BTC:{base:67420,vol:.0012,col:K.gold,icon:"₿"},
  ETH:{base:3540,vol:.0016,col:"#627EEA",icon:"Ξ"},
  JUP:{base:1.24,vol:.0045,col:K.g,icon:"◆"},
  BONK:{base:.0000242,vol:.006,col:"#FF6B00",icon:"⚡"},
};

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
const GCX=240,GCY=220;
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
  "[SYSTEM]: Initializing NEXUS Swarm...",
  "[LEVIATHAN]: Liquidity Radar Online...",
  "[ATLAS]: Global Macro Sphere Synced...",
  "[AEGIS]: Adaptive Risk Matrix Active...",
  "[SWARM]: 18 Cognitive Agents Connected...",
  "[NEXUS]: ◈ System ready.",
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
  lens:["Order book: bid wall $2.4M","VWAP cross confirmed ↑","Tick flow: 73% buy","Spread: LIQUID"],
  atlas:["DXY -0.3% crypto tailwind","BTC dom -0.4% alt rotation","USDT.D declining: RISK-ON","Global macro: BULLISH"],
  echo:["Fear & Greed: 68 (Greed)","Reddit volume +220%","Sentiment Z-score: +2.1σ","SOL mentions +840%"],
  leviathan:["CEX outflow +12,400 SOL","Smart money BTC LONG 3.2x","Whale cluster @$66,800","Accumulation 14d HIGH"],
  razor:["1m RSI bounce from 38","Scalp LONG @178.40","Micro-reversal confirmed","Scalp PnL +0.8% 4min"],
  surge:["Bull flag 4H confirmed","Breakout imminent","ATH retest prob: 61%","Volume dry: ABORT"],
  vector:["Primary trend: BULLISH","EMA 21/55 cross ↑","ADX 38: strong trend","Higher highs + lows"],
  delta:["Shadow: Bull 68% prob","Survival prob: 91.4%","E[R]: μ=+2.1% σ=0.8%","Black swan: 0.6%"],
  radar:["Pre-move signal: SOL","Smart money entering","Edge score: 87/100","Breakout in 4h window"],
  consensus:["VOTE: BUY SOL 14/18","Consensus: 82%","Debate: LONG wins","EXECUTE LONG SOL"],
};

type PriceData={price:number,prev:number,trend:string,change:number,rsi:number,hist:number[]};
type AgentState={on:boolean,conf:number|null,sig:string|null,th:string};
type Position={qty:number,avg:number};
type Trade={id:string,sym:string,side:string,qty:number,price:number,pnl:number,conf:number,t:string};
type LogEntry={t:string,ag:string,msg:string,col:string};
type WinCard={id:string,sym:string,pnl:number,pct:number,price:number,agent:string,t:string,origin?:{x:number,y:number}};
type EdgeToast={id:string,type:string,icon:string,col:string,title:string,body:string};
type MoneyLabel={id:string,x:number,y:number,val:number,born:number};

function usePrices(){
  const [px,setPx]=useState<{[k:string]:PriceData}>(()=>
    Object.fromEntries(Object.entries(SYMS).map(([k,v])=>[k,{
      price:v.base,prev:v.base,trend:"up",change:(Math.random()-.4)*12,rsi:45+Math.random()*25,
      hist:Array.from({length:60},(_,i)=>v.base*(1+(Math.random()-.5)*.05*(i/60))),
    }]))
  );
  useEffect(()=>{
    const iv=setInterval(()=>setPx(p=>{
      const n:{[k:string]:PriceData}={};
      for(const[k,v]of Object.entries(SYMS)){
        const c=p[k],d=(Math.random()-.499)*2*v.vol,np=c.price*(1+d);
        n[k]={...c,price:np,prev:c.price,trend:np>c.price?"up":"dn",
          hist:[...c.hist.slice(1),np],change:c.change+(Math.random()-.5)*.2,
          rsi:Math.max(20,Math.min(82,c.rsi+(Math.random()-.5)*2.5))};
      }
      return n;
    }),900);
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
      <div style={{marginBottom:36,fontSize:28,fontWeight:900,color:K.c,letterSpacing:".4em",textShadow:"0 0 40px "+K.c,animation:"breathe 2s ease-in-out infinite"}}>◈ NEXUS</div>
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

function Globe({trades,blackSwan,whaleAlert,totalPnL,tradeCount}:{trades:Trade[],blackSwan:boolean,whaleAlert:boolean,totalPnL:number,tradeCount:number}){
  const [moneyLabels,setMoneyLabels]=useState<MoneyLabel[]>([]);
  const [rot,setRot]=useState(0);
  const W=280,H=270,R=108,CX=W/2,CY=H/2-8;
  const CITIES:Array<[number,number,string]>=[[W*.28,H*.38,"NYC"],[W*.50,H*.34,"LON"],[W*.76,H*.38,"TYO"],[W*.73,H*.53,"SGP"],[W*.63,H*.43,"DXB"],[W*.74,H*.45,"HKG"]];
  const recent=trades.slice(0,6);
  useEffect(()=>{const iv=setInterval(()=>setRot(r=>(r+.25)%360),50);return()=>clearInterval(iv);},[]);
  const prevLen=useRef(0);
  useEffect(()=>{
    if(trades.length>prevLen.current){
      const t=trades[0];
      if(t&&t.pnl!==0){
        const city=CITIES[Math.floor(Math.random()*CITIES.length)];
        setMoneyLabels(p=>[...p.slice(-6),{id:Math.random().toString(36).slice(2),x:city[0]+(Math.random()-.5)*18,y:city[1]+(Math.random()-.5)*12,val:t.pnl,born:Date.now()}]);
      }
      prevLen.current=trades.length;
    }
  });
  useEffect(()=>{const iv=setInterval(()=>setMoneyLabels(p=>p.filter(m=>Date.now()-m.born<2800)),100);return()=>clearInterval(iv);},[]);
  const lonLines=Array.from({length:8},(_,i)=>i*(360/8)+rot);
  const latLines=[-55,-35,-15,0,15,35,55].map(lat=>{const y=CY-lat/90*R*.9;const rx=R*Math.cos(lat*Math.PI/180);return{y,rx,ry:Math.max(2,rx*.2)};});
  const pnl=totalPnL;
  return(
    <svg width={W} height={H} style={{display:"block",overflow:"visible"}}>
      <defs>
        <radialGradient id="gbg" cx="50%" cy="40%" r="50%">
          <stop offset="0%" stopColor={blackSwan?"#1A0308":"#03091A"} stopOpacity="1"/>
          <stop offset="100%" stopColor={blackSwan?"#0C0203":"#010408"} stopOpacity="1"/>
        </radialGradient>
        <radialGradient id="eye" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity=".95"/>
          <stop offset="25%" stopColor={K.c} stopOpacity=".8"/>
          <stop offset="65%" stopColor="#7B00FF" stopOpacity=".4"/>
          <stop offset="100%" stopColor="#7B00FF" stopOpacity="0"/>
        </radialGradient>
        <radialGradient id="gedge" cx="50%" cy="50%" r="50%">
          <stop offset="65%" stopColor="transparent"/>
          <stop offset="100%" stopColor={blackSwan?K.r:K.c} stopOpacity=".18"/>
        </radialGradient>
        <filter id="ggf"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <clipPath id="gc"><circle cx={CX} cy={CY} r={R}/></clipPath>
      </defs>
      <circle cx={CX} cy={CY} r={R+2} fill="none" stroke={blackSwan?K.r:K.c} strokeWidth=".5" opacity=".25"/>
      <circle cx={CX} cy={CY} r={R} fill="url(#gbg)"/>
      {whaleAlert&&<circle cx={CX} cy={CY} r={R+14} fill="none" stroke={K.pu} strokeWidth="1.8" opacity=".5" style={{animation:"breathe 1s ease-in-out infinite"}}/>}
      {blackSwan&&<circle cx={CX} cy={CY} r={R+8} fill="none" stroke={K.r} strokeWidth="1.2" opacity=".4" style={{animation:"shockwave 1.5s ease-out infinite"}}/>}
      <g clipPath="url(#gc)">
        {latLines.map((l,i)=><ellipse key={i} cx={CX} cy={l.y} rx={l.rx} ry={l.ry} fill="none" stroke={blackSwan?K.r+"80":K.brd} strokeWidth=".5" opacity=".55"/>)}
        {lonLines.map((angle,i)=>{
          const rad=angle*Math.PI/180;
          const sx=CX+R*Math.sin(rad),ex=CX-R*Math.sin(rad);
          return<line key={i} x1={sx} y1={CY-R*.95} x2={ex} y2={CY+R*.95} stroke={blackSwan?K.r+"50":K.brd} strokeWidth=".4" opacity=".4"/>;
        })}
        {recent.map((t,i)=>{
          const c1=CITIES[i%6],c2=CITIES[(i+2)%6];
          const mx=(c1[0]+c2[0])/2,my=(c1[1]+c2[1])/2-22;
          const col=t.side==="BUY"?K.g:K.r;
          return<path key={t.id} d={`M${c1[0]},${c1[1]} Q${mx},${my} ${c2[0]},${c2[1]}`} fill="none" stroke={col} strokeWidth="1.3" opacity=".75" strokeDasharray="4 3" style={{animation:`arcFlow ${1.4+i*.25}s linear infinite`}}/>;
        })}
        {recent.length===0&&CITIES.slice(0,4).map((_,i)=>{
          const c1=CITIES[i],c2=CITIES[(i+2)%6];
          const mx=(c1[0]+c2[0])/2,my=(c1[1]+c2[1])/2-18;
          return<path key={i} d={`M${c1[0]},${c1[1]} Q${mx},${my} ${c2[0]},${c2[1]}`} fill="none" stroke={K.c} strokeWidth=".7" opacity=".25" strokeDasharray="3 5" style={{animation:`arcFlow ${2+i*.6}s linear infinite`}}/>;
        })}
        {CITIES.map(([x,y,name],i)=>(
          <g key={i}>
            <circle cx={x} cy={y} r={8} fill="none" stroke={K.c} strokeWidth=".3" opacity=".3" style={{animation:"breathe 2s ease-in-out infinite"}}/>
            <circle cx={x} cy={y} r={3.5} fill={K.c+"20"} stroke={K.c} strokeWidth=".8" opacity=".7"/>
            <circle cx={x} cy={y} r={1.5} fill={K.c} opacity=".9"/>
            <text x={x} y={y-9} textAnchor="middle" fontSize="6" fill={K.hi} opacity=".55" fontFamily="monospace">{name}</text>
          </g>
        ))}
        <g filter="url(#ggf)" style={{animation:"breathe 3s ease-in-out infinite"}}>
          <circle cx={CX} cy={CY} r={24} fill="url(#eye)" opacity=".85"/>
          <circle cx={CX} cy={CY} r={17} fill="none" stroke={K.c} strokeWidth=".7" opacity=".5"/>
          <circle cx={CX} cy={CY} r={9} fill={K.c} opacity=".25"/>
          <circle cx={CX-6} cy={CY-6} r={3.5} fill="#fff" opacity=".55"/>
        </g>
        {moneyLabels.map(m=>(
          <text key={m.id} x={m.x} y={m.y} textAnchor="middle" fontSize="9" fontFamily="monospace" fontWeight="700" fill={m.val>=0?K.g:K.r} style={{animation:"moneyFloat 2.8s ease-out forwards"}}>
            {m.val>=0?"+$":"-$"}{f2(Math.abs(m.val))}
          </text>
        ))}
        <circle cx={CX} cy={CY} r={R} fill="url(#gedge)"/>
      </g>
      <text x={CX} y={H-24} textAnchor="middle" fontSize="13" fontFamily="monospace" fontWeight="700" fill={pnl>=0?K.g:K.r} style={{filter:`drop-shadow(0 0 6px ${pnl>=0?K.g:K.r})`}}>
        {pnl>=0?"+$":"-$"}{f2(Math.abs(pnl))}
      </text>
      <text x={CX} y={H-10} textAnchor="middle" fontSize="7.5" fontFamily="monospace" fill={K.dim}>TOTAL P&amp;L · {tradeCount} TRADES</text>
      {([["ASIA",K.c,W*.12],["EU",K.gold,W*.5],["US",K.g,W*.88]] as Array<[string,string,number]>).map(([label,col,x])=>(
        <g key={label}>
          <circle cx={x} cy={H-40} r={3} fill={col} opacity=".75" style={{animation:"breathe 2s ease-in-out infinite"}}/>
          <text x={x} y={H-30} textAnchor="middle" fontSize="6" fill={col} fontFamily="monospace" opacity=".8">{label}</text>
        </g>
      ))}
    </svg>
  );
}

function SwarmGraph({st,debate,disabled,swarmRef}:{st:{[k:string]:AgentState},debate:string[],disabled:Set<string>,swarmRef?:React.RefObject<HTMLDivElement|null>}){
  const [hov,setHov]=useState<string|null>(null);
  const nm:{[k:string]:{pos:{x:number,y:number},id:string,name:string,s:string,lv:number,ag:number}}={};
  for(const a of AGENTS)nm[a.id]={...a,pos:gpos(a)};
  return(
    <div ref={swarmRef} style={{position:"relative",display:"inline-block"}}>
      <svg width="480" height="440" style={{display:"block"}}>
        <defs>
          <filter id="agf"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          <filter id="agfS"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
          {AGENTS.map(({id,lv})=>{const n=nm[id];const rv=id==="consensus"?22:lv===1?17:lv===2?13:11;return<clipPath key={id} id={`acp${id}`}><circle cx={n.pos.x} cy={n.pos.y} r={rv-0.5}/></clipPath>;})}
        </defs>
        {CONNS.map(([a,b])=>{
          const pa=nm[a]?.pos,pb=nm[b]?.pos;if(!pa||!pb)return null;
          const deb=debate.includes(a)&&debate.includes(b);
          const dis=disabled.has(a)||disabled.has(b);
          return<line key={a+b} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={dis?"#050810":deb?K.c:K.brd} strokeWidth={deb?1.8:.5} opacity={dis?.07:deb?.9:.3} strokeDasharray={deb?"4 3":"none"}/>;
        })}
        {AGENTS.map(({id,s,lv})=>{
          const n=nm[id],ag=st[id]||{on:false,conf:null,sig:null,th:""};
          const dis=disabled.has(id),isC=id==="consensus",isAegis=id==="aegis";
          const r=isC?22:lv===1?17:lv===2?13:11;
          const col=dis?"#101820":ag.sig==="BUY"?K.g:ag.sig==="SELL"?K.r:isC?K.c:K.co;
          const seed=id.split("").reduce((a,c)=>a+c.charCodeAt(0),0);
          const sn=(x:number)=>(((seed*x*2654435761)>>>0)%100)/100;
          const ar=r*.75;
          const avPts=[
            [n.pos.x-ar*.25+sn(1)*ar*.2,n.pos.y-ar*.75],
            [n.pos.x+ar*.25+sn(2)*ar*.2,n.pos.y-ar*.75],
            [n.pos.x-ar*.55,n.pos.y-ar*.15],
            [n.pos.x+ar*.55,n.pos.y-ar*.15],
            [n.pos.x-ar*.32,n.pos.y+ar*.38],
            [n.pos.x+ar*.32,n.pos.y+ar*.38],
            [n.pos.x,n.pos.y+ar*.82],
          ];
          const edges=[[0,1],[0,2],[1,3],[2,3],[2,4],[3,5],[4,6],[5,6],[0,3],[1,2],[4,5]];
          const eyeL=[n.pos.x-ar*.3,n.pos.y-ar*.12];
          const eyeR=[n.pos.x+ar*.3,n.pos.y-ar*.12];
          return(
            <g key={id} filter={ag.on&&!dis?"url(#agf)":undefined} opacity={dis?.18:1} style={{cursor:"pointer"}} onMouseEnter={()=>setHov(id)} onMouseLeave={()=>setHov(null)}>
              <circle cx={n.pos.x} cy={n.pos.y} r={r+10} fill={col} opacity={ag.on?.06:.015}/>
              <circle cx={n.pos.x} cy={n.pos.y} r={r} fill={col+"14"} stroke={col} strokeWidth={ag.on?1.8:.6} opacity={ag.on?1:.4} strokeDasharray={dis?"3 2":"none"}/>
              {ag.on&&!dis&&<circle cx={n.pos.x} cy={n.pos.y} r={r+5} fill="none" stroke={col} strokeWidth=".5" opacity=".3"/>}
              {isAegis&&ag.sig==="SELL"&&!dis&&<circle cx={n.pos.x} cy={n.pos.y} r={r+9} fill="none" stroke={K.r} strokeWidth="1.2" opacity=".5" style={{animation:"breathe .8s ease-in-out infinite"}}/>}
              <g stroke={col} strokeWidth=".55" opacity={ag.on&&!dis?.6:.18} filter={ag.on&&!dis?"url(#agfS)":undefined}>
                {edges.map(([a,b],ei)=><line key={ei} x1={avPts[a][0]} y1={avPts[a][1]} x2={avPts[b][0]} y2={avPts[b][1]}/>)}
              </g>
              {/* Mesh node dots */}
              {ag.on&&!dis&&avPts.slice(0,5).map(([px,py],vi)=>(
                <circle key={vi} cx={px} cy={py} r={0.9} fill={col} opacity={0.75}/>
              ))}
              {/* Cybernetic scan line */}
              {ag.on&&!dis&&(
                <g clipPath={`url(#acp${id})`}>
                  <rect x={n.pos.x-r+0.5} width={r*2-1} height={1.5} fill={col} opacity={0.5} y={n.pos.y-r}>
                    <animateTransform attributeName="transform" type="translate" from="0 0" to={`0 ${r*2}`} dur="1.8s" repeatCount="indefinite" additive="sum" begin={`${(seed%9)*0.2}s`}/>
                  </rect>
                </g>
              )}
              {/* AEGIS conflict glitch */}
              {isAegis&&ag.sig==="SELL"&&!dis&&(
                <>
                  <circle cx={n.pos.x-2} cy={n.pos.y+1} r={r} fill="none" stroke={K.r} strokeWidth={1} opacity={0.55} style={{animation:"glitch 0.12s step-start infinite"}}/>
                  <circle cx={n.pos.x+2} cy={n.pos.y-1} r={r} fill="none" stroke={K.r} strokeWidth={0.5} opacity={0.3} style={{animation:"glitch 0.18s step-start infinite"}}/>
                </>
              )}
              <polygon points={`${eyeL[0]},${eyeL[1]-2.5} ${eyeL[0]+2.5},${eyeL[1]} ${eyeL[0]},${eyeL[1]+2.5} ${eyeL[0]-2.5},${eyeL[1]}`} fill={col} opacity={ag.on&&!dis?.85:.2}/>
              <polygon points={`${eyeR[0]},${eyeR[1]-2.5} ${eyeR[0]+2.5},${eyeR[1]} ${eyeR[0]},${eyeR[1]+2.5} ${eyeR[0]-2.5},${eyeR[1]}`} fill={col} opacity={ag.on&&!dis?.85:.2}/>
              <text x={n.pos.x} y={n.pos.y+(isC?5:3.5)} textAnchor="middle" fontSize={isC?8:6} fontFamily="monospace" fill={dis?K.dim:ag.on?col:K.tx} fontWeight="700">{s}</text>
              {ag.conf&&!dis&&<text x={n.pos.x} y={n.pos.y+r+12} textAnchor="middle" fontSize="7" fontFamily="monospace" fill={col} opacity=".8">{ag.conf}%</text>}
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
  useEffect(()=>{const t=setTimeout(onDone,3600);return()=>clearTimeout(t);},[onDone]);
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
  useEffect(()=>{const t=setTimeout(onDone,4200);return()=>clearTimeout(t);},[onDone]);
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

export default function NEXUS(){
  const prices=usePrices();
  const pricesRef=useRef(prices);
  useEffect(()=>{pricesRef.current=prices;},[prices]);

  const [booting,setBooting]=useState(true);
  const [port,setPort]=useState({cash:CAP,pos:{} as {[k:string]:Position},equity:CAP,peak:CAP});
  const portRef=useRef(port);
  useEffect(()=>{portRef.current=port;},[port]);

  const [trades,setTrades]=useState<Trade[]>([]);
  const [agSt,setAgSt]=useState<{[k:string]:AgentState}>(()=>Object.fromEntries(AGENTS.map(a=>[a.id,{on:false,conf:null,sig:null,th:""}])));
  const agStRef=useRef(agSt);
  useEffect(()=>{agStRef.current=agSt;},[agSt]);

  const [debate,setDebate]=useState<string[]>([]);
  const [logs,setLogs]=useState<LogEntry[]>([{t:ts(),ag:"SYSTEM",msg:"◈ NEXUS v2.0 — 18 agents online",col:K.c}]);
  const [aiData,setAiData]=useState<{[k:string]:unknown}|null>(null);
  const [dnaData,setDnaData]=useState<{[k:string]:unknown}|null>(null);
  const [analyzing,setAnalyzing]=useState(false);
  const [dnaLoading,setDnaLoading]=useState(false);
  const [running,setRunning]=useState(false);
  const [circuit,setCircuit]=useState(false);
  const [blackSwan,setBlackSwan]=useState(false);
  const [tab,setTab]=useState("terminal");
  const [disabled,setDisabled]=useState<Set<string>>(new Set());
  const [showKill,setShowKill]=useState(false);
  const [modal,setModal]=useState<string|null>(null);
  const [entropy,setEntropy]=useState(42);
  const [winCards,setWinCards]=useState<WinCard[]>([]);
  const [edgeToasts,setEdgeToasts]=useState<EdgeToast[]>([]);
  const [whaleAlert,setWhaleAlert]=useState(false);
  const [beatChoice,setBeatChoice]=useState<{sym:string,side:string}|null>(null);
  const [beatResult,setBeatResult]=useState<string|null>(null);
  const logRef=useRef<HTMLDivElement>(null);
  const swarmRef=useRef<HTMLDivElement>(null);
  const entropyRef=useRef(entropy);
  useEffect(()=>{entropyRef.current=entropy;},[entropy]);

  const log=useCallback((ag:string,msg:string,col=K.hi)=>setLogs(l=>[...l.slice(-150),{t:ts(),ag,msg,col}]),[]);

  useEffect(()=>{
    setPort(p=>{
      let eq=p.cash;
      for(const[s,pos]of Object.entries(p.pos))eq+=pos.qty*(prices[s]?.price||pos.avg);
      return{...p,equity:eq,peak:Math.max(p.peak,eq)};
    });
  },[prices]);

  useEffect(()=>{setBlackSwan(Object.values(prices).filter((d)=>Math.abs((d as PriceData).change)>8).length>=2);},[prices]);

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[logs]);

  // SL/TP auto-exit
  useEffect(()=>{
    if(!running)return;
    for(const[sym,pos]of Object.entries(port.pos)){
      const cur=prices[sym]?.price;if(!cur)continue;
      const pct=((cur-pos.avg)/pos.avg)*100;
      if(pct<=-2.5){
        const pnl=(cur-pos.avg)*pos.qty;
        setPort(prev=>{const p2={...prev.pos};delete p2[sym];return{...prev,cash:prev.cash+cur*pos.qty,pos:p2};});
        addWinCard(sym,pnl,pct,cur,"AEGIS");
        log("AEGIS","⛔ SL "+sym+" -2.5% | "+fU(pnl),K.r);
      }else if(pct>=5.5){
        const pnl=(cur-pos.avg)*pos.qty;
        setPort(prev=>{const p2={...prev.pos};delete p2[sym];return{...prev,cash:prev.cash+cur*pos.qty,pos:p2};});
        addWinCard(sym,pnl,pct,cur,"TITAN");
        log("TITAN","💰 TP "+sym+" +5.5% | "+fU(pnl),K.g);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[prices,running]);

  const addWinCard=(sym:string,pnl:number,pct:number,price:number,agent:string)=>{
    const origin=(()=>{
      const el=swarmRef.current;if(!el)return undefined;
      const rect=el.getBoundingClientRect();
      const scale=rect.width/480;
      return{x:rect.left+GCX*scale,y:rect.top+GCY*scale};
    })();
    const card:WinCard={id:Math.random().toString(36).slice(2),sym,pnl,pct,price,agent,t:ts(),origin};
    setWinCards(prev=>[...prev.slice(-3),card]);
    setTrades(t=>[{id:card.id,sym,side:pnl>=0?"SELL":"SELL",qty:0,price,pnl,conf:80,t:card.t},...t.slice(0,99)]);
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

  // Trade execution
  useEffect(()=>{
    if(!running||circuit)return;
    const iv=setInterval(()=>{
      const cs=agStRef.current["consensus"];
      if(!cs?.on||!cs.conf||cs.conf<70)return;
      const keys=Object.keys(SYMS);
      const sym=keys[Math.floor(Math.random()*keys.length)];
      const p=pricesRef.current[sym];if(!p)return;
      const prt=portRef.current;
      if(cs.sig==="BUY"&&!prt.pos[sym]&&prt.cash>500&&Object.keys(prt.pos).length<3){
        const alloc=Math.min(prt.cash*.15,prt.cash*.9);
        const qty=alloc/p.price;
        setPort(prev=>{if(prev.pos[sym])return prev;return{...prev,cash:prev.cash-alloc,pos:{...prev.pos,[sym]:{qty,avg:p.price}}};});
        setTrades(t=>[{id:Math.random().toString(36).slice(2,8).toUpperCase(),sym,side:"BUY",qty,price:p.price,pnl:0,conf:cs.conf||80,t:ts()},...t.slice(0,99)]);
        log("EXEC","▶ LONG "+sym+" @ $"+f2(p.price)+" conf:"+cs.conf+"%",K.g);
      }else if(cs.sig==="SELL"&&prt.pos[sym]){
        const pos=prt.pos[sym];
        const pnl=(p.price-pos.avg)*pos.qty;
        setPort(prev=>{const p2={...prev.pos};delete p2[sym];return{...prev,cash:prev.cash+pos.qty*p.price,pos:p2};});
        addWinCard(sym,pnl,((p.price-pos.avg)/pos.avg)*100,p.price,"CONSENSUS");
        log("EXEC","◀ CLOSE "+sym+" @ $"+f2(p.price)+" PnL:"+fU(pnl),pnl>=0?K.g:K.r);
      }
    },7500);
    return()=>clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[running,circuit,log]);

  // Edge events
  useEffect(()=>{
    if(!running)return;
    const iv=setInterval(()=>{
      const ev=EDGE_EVENTS[Math.floor(Math.random()*EDGE_EVENTS.length)];
      const toast:EdgeToast={id:Math.random().toString(36).slice(2),...ev};
      setEdgeToasts(p=>[...p.slice(-3),toast]);
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
      const res=await fetch("/api/debate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:`NEXUS AI. JSON strict only.
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
      const res=await fetch("/api/debate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:`NEXUS AI. JSON strict only.
Stats: $${CAP} → $${f2(port.equity)}, P&L: ${fU(pnl)}, Trades: ${trades.length}, WinRate: ${f2(wr)}%
{"traderTitle":"epic title","tradingDNA":["trait1","trait2","trait3"],"strengths":["s1","s2"],"weakness":"main weakness","aiVerdict":"1 powerful sentence","score":0-100,"tier":"BRONZE|SILVER|GOLD|PLATINUM|NEXUS_ELITE"}`}]})});
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
      log("SYS",next?"▶ NEXUS ACTIVATED — 18 agents online":"⏹ SYSTEM HALTED",next?K.g:K.r);
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
        setBeatResult(win?"✓ YOU WIN":"✗ NEXUS WINS");
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
        @keyframes agentPulse{0%,100%{opacity:1}50%{opacity:.15}}
        @keyframes swan{0%,100%{box-shadow:0 0 0 rgba(255,51,102,.2)}50%{box-shadow:0 0 24px rgba(255,51,102,.5)}}
        @keyframes odometerRoll{from{transform:translateY(-100%);opacity:0}to{transform:translateY(0);opacity:1}}
        @keyframes glitch{0%,100%{transform:translate(0)}25%{transform:translate(-2px,1px)}50%{transform:translate(2px,-1px)}75%{transform:translate(-1px,-2px)}}
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
          <div style={{fontSize:19,fontWeight:900,color:blackSwan?K.r:K.c,letterSpacing:".25em",textShadow:"0 0 20px "+(blackSwan?K.r:K.c),animation:"glow 2.5s ease-in-out infinite"}}>◈ NEXUS</div>
          <span style={{fontSize:9,color:"#102030",letterSpacing:".1em"}}>QUANT AI · SANDBOX · v2.0</span>
          <div style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:running?K.g:K.r,boxShadow:"0 0 8px "+(running?K.g:K.r),animation:"pu 1.5s infinite"}}/>
            <span style={{fontSize:9,color:running?K.g:K.r}}>{running?"LIVE · AUTO":"STANDBY"}</span>
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
          <div style={{display:"flex",gap:5}}>
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
        {[["terminal","◈ COMMAND"],["trades","◎ TRADE STREAM"],["crisis","⊞ CRISIS REPLAY"],["dna","🧬 SWARM DNA"]].map(([v,l])=>(
          <button key={v} className={`tab${tab===v?" on":""}`} onClick={()=>setTab(v)}>{l}</button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:12,fontSize:8,color:"#0A1D2A"}}>
          <span>WIN {f2(wr,0)}% · {trades.length} TRADES</span>
          <span style={{color:K.r+"60"}}>PAPER ONLY</span>
        </div>
      </div>

      {tab==="terminal"&&(
        <div style={{flex:1,display:"grid",gridTemplateColumns:"240px 1fr 260px",gridTemplateRows:"1fr 170px",gap:6,padding:8,overflow:"hidden",minHeight:0}}>
          {/* LEFT */}
          <div style={{gridRow:"1/3",display:"flex",flexDirection:"column",gap:6,overflow:"hidden"}}>
            <div className="panel" style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"8px 4px 6px"}}>
              <div style={{fontSize:8,color:K.dim,letterSpacing:".12em",marginBottom:4,alignSelf:"flex-start",paddingLeft:6}}>◉ GLOBAL MACRO SPHERE</div>
              <Globe trades={trades} blackSwan={blackSwan} whaleAlert={whaleAlert} totalPnL={totalPnL} tradeCount={trades.length}/>
            </div>
            <div className="panel" style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
              <div style={{fontSize:8,color:K.dim,padding:"6px 10px 4px",borderBottom:"1px solid #060A14",letterSpacing:".12em"}}>◉ LIVE MARKET</div>
              <div style={{overflow:"auto",flex:1}}>
                {Object.entries(prices).map(([sym,d])=>{
                  const sv=SYMS[sym],up=d.trend==="up",pos=port.pos[sym];
                  return(
                    <div key={sym} className="tr" style={{padding:"6px 10px",borderBottom:"1px solid #050810",borderLeft:"2px solid "+(pos?K.c:"transparent")}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:2}}>
                        <div style={{display:"flex",alignItems:"center",gap:5}}>
                          <span style={{color:sv?.col,fontSize:13}}>{sv?.icon}</span>
                          <span style={{color:K.hi,fontSize:11,fontWeight:600}}>{sym}</span>
                        </div>
                        <span style={{color:up?K.g:K.r,fontSize:11,fontWeight:600}}>{sym==="BTC"?"$"+f2(d.price,0):sym==="BONK"?"$"+f2(d.price,7):"$"+f2(d.price)}</span>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <Spark data={d.hist} color={up?K.g:K.r} w={68} h={17}/>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:9,color:up?K.g:K.r}}>{fP(d.change)}</div>
                          <div style={{fontSize:8,color:d.rsi>70?K.r:d.rsi<30?K.g:K.gold}}>RSI {f2(d.rsi,0)}</div>
                        </div>
                      </div>
                      {pos&&<div style={{marginTop:2,fontSize:8,display:"flex",gap:7}}><span style={{color:K.c}}>LONG</span><span style={{color:((prices[sym]?.price||pos.avg)-pos.avg)/pos.avg*100>=0?K.g:K.r}}>{fP(((prices[sym]?.price||pos.avg)-pos.avg)/pos.avg*100)}</span></div>}
                    </div>
                  );
                })}
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
                        <span>SL:${f2(pos.avg*.975)}</span><span>TP:${f2(pos.avg*1.055)}</span>
                      </div>
                    </div>
                  );
                })}
            </div>
            <div className="panel" style={{padding:9}}>
              <div style={{fontSize:8,color:K.dim,marginBottom:5,letterSpacing:".12em"}}>◉ STATUS</div>
              {([{l:"Execution",v:circuit?"LOCKED":"ACTIVE",c:circuit?K.r:K.g},{l:"SL/TP",v:"-2.5% / +5.5%",c:K.tx},{l:"Agents",v:(AGENTS.length-disabled.size)+"/18",c:disabled.size>0?K.gold:K.g},{l:"Positions",v:Object.keys(port.pos).length+"/3",c:K.tx},{l:"Entropy",v:Math.round(entropy)+"/100",c:entropyCol}] as Array<{l:string,v:string,c:string}>).map((r,i)=>(
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

      {tab==="trades"&&(
        <div style={{flex:1,padding:10,overflow:"auto"}}>
          <div className="panel">
            <div style={{padding:"8px 13px",borderBottom:"1px solid #060A14",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:9,color:K.dim,letterSpacing:".12em"}}>EXECUTIONS · {trades.length}</span>
              <div style={{display:"flex",gap:16,fontSize:10}}>
                {([{l:"P&L",v:fU(cl.reduce((a,t)=>a+t.pnl,0)),c:cl.reduce((a,t)=>a+t.pnl,0)>=0?K.g:K.r},{l:"WIN",v:f2(wr,0)+"%",c:wr>=50?K.g:K.r}] as Array<{l:string,v:string,c:string}>).map((x,i)=>(
                  <div key={i} style={{textAlign:"right"}}><div style={{fontSize:8,color:K.dim}}>{x.l}</div><div style={{color:x.c}}>{x.v}</div></div>
                ))}
              </div>
            </div>
            {trades.length===0
              ?<div style={{padding:50,textAlign:"center",color:"#0A1E30"}}>No trades yet. Activate swarm.</div>
              :<table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr style={{fontSize:8,color:K.dim,borderBottom:"1px solid #060A14"}}>
                  {["ID","TIME","ASSET","SIDE","PRICE","P&L","CONF"].map(h=><th key={h} style={{padding:"6px 11px",textAlign:"left",fontWeight:400}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {trades.map(t=>{
                    const sv=SYMS[t.sym],col=t.side==="BUY"?K.g:K.r;
                    return(
                      <tr key={t.id} className="tr" style={{borderBottom:"1px solid #040910"}}>
                        <td style={{padding:"5px 11px",color:K.dim,fontSize:9}}>{t.id}</td>
                        <td style={{padding:"5px 11px",color:"#102030"}}>{t.t}</td>
                        <td style={{padding:"5px 11px"}}><span style={{color:sv?.col,marginRight:4}}>{sv?.icon}</span><span style={{color:K.c,fontWeight:600}}>{t.sym}</span></td>
                        <td style={{padding:"5px 11px"}}><span style={{padding:"1px 6px",background:col+"15",color:col,border:"1px solid "+col+"30",fontSize:8,borderRadius:1}}>{t.side}</span></td>
                        <td style={{padding:"5px 11px",color:K.hi}}>${t.sym==="BTC"?f2(t.price,0):t.sym==="BONK"?f2(t.price,7):f2(t.price)}</td>
                        <td style={{padding:"5px 11px",color:t.pnl>0?K.g:t.pnl<0?K.r:K.tx}}>{t.pnl!==0?fU(t.pnl):"—"}</td>
                        <td style={{padding:"5px 11px"}}><div style={{display:"flex",alignItems:"center",gap:5}}><div style={{height:3,width:32,background:"#040910",borderRadius:1}}><div style={{height:"100%",borderRadius:1,background:K.c,width:t.conf+"%"}}/></div><span style={{color:K.tx,fontSize:9}}>{t.conf}%</span></div></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>}
          </div>
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
              {([{l:"Drop",v:s.drop,c:K.r},{l:"Duration",v:s.dur,c:K.tx},{l:"SOL",v:s.sol,c:K.r},{l:"NEXUS",v:s.out,c:s.col}] as Array<{l:string,v:string,c:string}>).map((r,j)=>(
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
                <div style={{fontSize:13,color:K.pu,letterSpacing:".2em",fontWeight:900,marginBottom:4}}>◈ NEXUS PERFORMANCE DNA</div>
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
                  <div style={{fontSize:9,color:K.pu,marginBottom:3,letterSpacing:".1em"}}>NEXUS VERDICT</div>
                  <p style={{fontSize:11,color:K.hi,lineHeight:1.5,fontStyle:"italic"}}>&quot;{String(dnaData.aiVerdict||"")}&quot;</p>
                </div>
                <button className="btn" onClick={()=>{const txt=`My NEXUS DNA: ${dnaData.traderTitle} | ${dnaData.tier} | Score:${dnaData.score}/100 | "${dnaData.aiVerdict}"`;navigator.clipboard?.writeText(txt);}} style={{background:K.pu+"20",color:K.pu,border:"1px solid "+K.pu+"50",padding:"8px 20px",fontSize:10,width:"100%"}}>[ SHARE YOUR DNA ]</button>
              </div>
            )}
          </div>
        </div>
      )}

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
              <div style={{fontSize:13,color:K.pu,letterSpacing:".2em",fontWeight:900}}>◈ NEXUS PERFORMANCE DNA</div>
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
            <p style={{fontSize:10,color:K.tx,marginBottom:14,lineHeight:1.5}}>Pick an asset + direction. Race NEXUS over 30 seconds. Whoever calls the next move correctly wins.</p>
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
                  ?<div style={{padding:"14px",textAlign:"center",fontSize:16,fontWeight:900,color:beatResult.includes("WIN")&&!beatResult.includes("NEXUS")?K.g:K.r,background:(beatResult.includes("WIN")&&!beatResult.includes("NEXUS")?K.g:K.r)+"10",border:"1px solid "+(beatResult.includes("WIN")&&!beatResult.includes("NEXUS")?K.g:K.r)+"40",borderRadius:3}}>{beatResult}</div>
                  :<button className="btn" onClick={()=>{beatStart(beatChoice.sym,beatChoice.side);}} style={{width:"100%",background:K.gold+"15",color:K.gold,border:"1px solid "+K.gold+"40",padding:"10px 0",fontSize:11,letterSpacing:".1em"}}>⚡ START 30s RACE</button>
                }
                <div style={{marginTop:8,fontSize:8,color:K.dim,textAlign:"center"}}>2,842 observers online · NEXUS win rate: 67%</div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{background:"#020608",borderTop:"1px solid #050A12",padding:"3px 16px",display:"flex",justifyContent:"space-between",fontSize:8,color:"#081525",letterSpacing:".1em"}}>
        <span>◈ NEXUS v2.0 — PAPER TRADING · $10,000 SANDBOX CAPITAL · NO REAL FUNDS</span>
        <span>Claude Sonnet · 18 Agents · {new Date().toLocaleString("en-US")}</span>
      </div>
    </div>
  );
}
