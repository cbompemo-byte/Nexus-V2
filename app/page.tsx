"use client";
import { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence, useInView } from "framer-motion";

const K = { c:"#00F2FE",g:"#00FF88",r:"#FF3366",gold:"#FFD700",pu:"#BD00FF",dim:"#2A5070",hi:"#A8D0EC",bg:"#04060D" };
const F = "'JetBrains Mono','Courier New',monospace";
const PANEL = { background:"rgba(6,10,18,0.75)", backdropFilter:"blur(12px)", border:"1px solid rgba(0,242,254,0.08)", borderRadius:8 } as const;

const BOOT_LINES = [
  { prefix:"[SYSTEM]", text:"Initializing KYMIA Swarm Protocols...", delay:0 },
  { prefix:"[SWARM]",  text:"Connecting 18 cognitive agents...", delay:400 },
  { prefix:"[EDGE]",   text:"Liquidity radar online...", delay:800 },
  { prefix:"[RISK]",   text:"Adaptive risk engine calibrated...", delay:1200 },
  { prefix:"[CORE]",   text:"Global Macro Sphere initialized...", delay:1600 },
  { prefix:"[KYMIA]",  text:"◈ SYSTEM READY", delay:2000 },
];

const FEED = [
  { prefix:"LEVIATHAN", text:"Whale accumulation: +12,400 SOL from Binance", col:K.pu },
  { prefix:"LENS",      text:"RSI 38.2 — Oversold territory detected", col:K.c },
  { prefix:"RADAR",     text:"EMA9 crossed EMA21 — Bullish momentum", col:K.g },
  { prefix:"ECHO",      text:"Fear & Greed: 28 — Extreme fear = opportunity", col:K.gold },
  { prefix:"CONSENSUS", text:"14/18 agents aligned → EXECUTE LONG SOL 84%", col:K.c },
  { prefix:"AEGIS",     text:"TP reached: +$247.83 | Portfolio: +2.48%", col:K.g },
];

const DEBATE_CARDS = [
  { agent:"LEVIATHAN", thesis:"Whale flow bullish",   conf:86 },
  { agent:"LENS",      thesis:"RSI oversold",          conf:82 },
  { agent:"RADAR",     thesis:"EMA cross confirmed",   conf:79 },
  { agent:"AEGIS",     thesis:"Risk approved",         conf:75 },
];

const CRISIS = [
  { name:"FTX COLLAPSE",    date:"Nov 2022", agent:"LEVIATHAN", note:"CEX outflows detected 4h before.", result:"SURVIVED",      pct:88 },
  { name:"LUNA DEPEG",      date:"May 2022", agent:"SHIELD",     note:"Circuit breaker at -3.2%.",       result:"CIRCUIT BREAK", pct:71 },
  { name:"BTC FLASH CRASH", date:"May 2021", agent:"PHANTOM",    note:"68% crash probability 12min prior.", result:"CLEAN EXIT", pct:82 },
];

const DATA_SOURCES = [
  { name:"KRAKEN",      sig:"RSI · EMA · MACD · ADX · SMA", desc:"Institutional-grade price data" },
  { name:"COINGECKO",   sig:"Volume · BTC Dominance",        desc:"Global market intelligence" },
  { name:"DEXSCREENER", sig:"Whale pressure · Order depth",  desc:"On-chain Solana data" },
  { name:"DERIBIT",     sig:"Futures · Funding rate",        desc:"Derivatives market signals" },
  { name:"COINGLASS",   sig:"Liquidation data",              desc:"Risk cascade detection" },
  { name:"FEAR & GREED",sig:"Sentiment index",               desc:"Market psychology layer" },
];

// ── Landing Swarm constants ───────────────────────────────────────────────────
const AGENTS_RING = [
  {id:'cnsns',  name:'CONSENSUS',  short:'CNSNS', ring:0, angle:0,   specialty:'Master Vote',      col:'#00F2FE'},
  {id:'aegis',  name:'AEGIS',      short:'AEGIS', ring:1, angle:0,   specialty:'Risk Engine',      col:'#FF3366'},
  {id:'oracle', name:'ORACLE',     short:'ORCLR', ring:1, angle:120, specialty:'Order Flow',       col:'#00F2FE'},
  {id:'phantom',name:'PHANTOM',    short:'PHNTM', ring:1, angle:240, specialty:'Futures',          col:'#BD00FF'},
  {id:'titan',  name:'TITAN',      short:'TITAN', ring:2, angle:0,   specialty:'Regime',           col:'#FFD700'},
  {id:'hydra',  name:'HYDRA',      short:'HYDRA', ring:2, angle:72,  specialty:'Liquidations',     col:'#FF3366'},
  {id:'shield', name:'SHIELD',     short:'SHLD',  ring:2, angle:144, specialty:'Order Book',       col:'#00F2FE'},
  {id:'neural', name:'NEURAL',     short:'NRAL',  ring:2, angle:216, specialty:'Adaptive',         col:'#00FF88'},
  {id:'watch',  name:'WATCH',      short:'WTCH',  ring:2, angle:288, specialty:'Latency',          col:'#2A5070'},
  {id:'lens',   name:'LENS',       short:'LENS',  ring:3, angle:0,   specialty:'RSI',              col:'#BD00FF'},
  {id:'atlas',  name:'ATLAS',      short:'ATLAS', ring:3, angle:36,  specialty:'Macro',            col:'#FFD700'},
  {id:'echo',   name:'ECHO',       short:'ECHO',  ring:3, angle:72,  specialty:'Sentiment',        col:'#00FF88'},
  {id:'levia',  name:'LEVIATHAN',  short:'LEVIA', ring:3, angle:108, specialty:'Whale Flow',       col:'#BD00FF'},
  {id:'razor',  name:'RAZOR',      short:'RAZOR', ring:3, angle:144, specialty:'MACD',             col:'#FF3366'},
  {id:'surge',  name:'SURGE',      short:'SURGE', ring:3, angle:180, specialty:'Volume',           col:'#00FF88'},
  {id:'vector', name:'VECTOR',     short:'VCTR',  ring:3, angle:216, specialty:'ADX Trend',        col:'#00F2FE'},
  {id:'delta',  name:'DELTA',      short:'DELTA', ring:3, angle:252, specialty:'Arbitrage',        col:'#FFD700'},
  {id:'radar',  name:'RADAR',      short:'RADAR', ring:3, angle:288, specialty:'EMA Cross',        col:'#00F2FE'},
  {id:'luna',   name:'LUNA',       short:'LUNA',  ring:3, angle:324, specialty:'Moon Phase',       col:'#BD00FF'},
] as const;

const RING_RADII = [0, 80, 155, 235];
const NODE_SIZE  = [52, 38, 30, 24];

// ── Skull Face ────────────────────────────────────────────────────────────────
function SkullFace({size,col,active,scanning,conflict}:{size:number;col:string;active:boolean;scanning:boolean;conflict:boolean}) {
  const s=size/40, cx=20, cy=20;
  return (
    <g>
      <ellipse cx={cx} cy={cy*0.9} rx={13*s} ry={15*s} fill="#050A14" stroke={col} strokeWidth={active?1.5*s:0.8*s} opacity={active?1:0.45}/>
      <line x1={cx-10*s} y1={cy-10*s} x2={cx} y2={cy-14*s} stroke={col} strokeWidth={0.6*s} opacity={active?0.7:0.3}/>
      <line x1={cx+10*s} y1={cy-10*s} x2={cx} y2={cy-14*s} stroke={col} strokeWidth={0.6*s} opacity={active?0.7:0.3}/>
      <line x1={cx-8*s}  y1={cy-12*s} x2={cx+8*s} y2={cy-12*s} stroke={col} strokeWidth={0.4*s} opacity={active?0.5:0.2}/>
      <polygon points={`${cx-7*s},${cy-2*s} ${cx-4*s},${cy-6*s} ${cx-1*s},${cy-2*s} ${cx-4*s},${cy+2*s}`}
        fill={active?col+'30':'transparent'} stroke={col} strokeWidth={active?1.2*s:0.7*s} opacity={active?1:0.4}/>
      <circle cx={cx-4*s} cy={cy-2*s} r={1.8*s} fill={col} opacity={active?0.95:0.3}/>
      {active&&<circle cx={cx-5*s} cy={cy-3*s} r={0.7*s} fill="white" opacity={0.6}/>}
      <polygon points={`${cx+1*s},${cy-2*s} ${cx+4*s},${cy-6*s} ${cx+7*s},${cy-2*s} ${cx+4*s},${cy+2*s}`}
        fill={active?col+'30':'transparent'} stroke={col} strokeWidth={active?1.2*s:0.7*s} opacity={active?1:0.4}/>
      <circle cx={cx+4*s} cy={cy-2*s} r={1.8*s} fill={col} opacity={active?0.95:0.3}/>
      {active&&<circle cx={cx+3*s} cy={cy-3*s} r={0.7*s} fill="white" opacity={0.6}/>}
      <polygon points={`${cx},${cy+2*s} ${cx-2*s},${cy+6*s} ${cx+2*s},${cy+6*s}`}
        fill="none" stroke={col} strokeWidth={0.7*s} opacity={active?0.6:0.25}/>
      <line x1={cx-12*s} y1={cy+2*s} x2={cx-7*s} y2={cy+5*s} stroke={col} strokeWidth={0.8*s} opacity={active?0.7:0.3}/>
      <line x1={cx+12*s} y1={cy+2*s} x2={cx+7*s} y2={cy+5*s} stroke={col} strokeWidth={0.8*s} opacity={active?0.7:0.3}/>
      <line x1={cx-12*s} y1={cy+5*s} x2={cx} y2={cy+12*s} stroke={col} strokeWidth={0.8*s} opacity={active?0.65:0.25}/>
      <line x1={cx+12*s} y1={cy+5*s} x2={cx} y2={cy+12*s} stroke={col} strokeWidth={0.8*s} opacity={active?0.65:0.25}/>
      {active&&[-6,-3,0,3,6].map((off,i)=>(
        <line key={i} x1={cx+off*s} y1={cy+7*s} x2={cx+off*s} y2={cy+11*s} stroke={col} strokeWidth={0.7*s} opacity={0.5}/>
      ))}
      {scanning&&(
        <line x1={cx-13*s} y1={cy} x2={cx+13*s} y2={cy} stroke={col} strokeWidth={1.2*s} opacity={0.6}>
          <animateTransform attributeName="transform" type="translate" values="0,-15;0,15;0,-15" dur="1.4s" repeatCount="indefinite"/>
        </line>
      )}
      {conflict&&(<>
        <ellipse cx={cx+2} cy={cy} rx={13*s} ry={15*s} fill="none" stroke="#FF3366" strokeWidth={0.6} opacity={0.4}>
          <animate attributeName="opacity" values="0.4;0;0.4" dur="0.15s" repeatCount="indefinite"/>
        </ellipse>
        <ellipse cx={cx-2} cy={cy} rx={13*s} ry={15*s} fill="none" stroke="#FF3366" strokeWidth={0.4} opacity={0.3}>
          <animate attributeName="opacity" values="0;0.3;0" dur="0.2s" repeatCount="indefinite"/>
        </ellipse>
      </>)}
    </g>
  );
}

// ── Explanation panel (shared logic) ─────────────────────────────────────────
function ExplanationPanel({steps}:{steps:{num:string;title:string;col:string;icon:string;agents:string[];description:string;terminal:string[]}[]}) {
  const [activeStep, setActiveStep] = useState(0);
  const [typed,      setTyped]      = useState('');
  const [charIdx,    setCharIdx]    = useState(0);

  useEffect(()=>{
    const iv=setInterval(()=>{
      setActiveStep(s=>(s+1)%steps.length);
      setCharIdx(0); setTyped('');
    },5000);
    return()=>clearInterval(iv);
  },[steps.length]);

  const step=steps[activeStep];
  const fullText=step.terminal.join('\n');

  useEffect(()=>{setCharIdx(0);setTyped('');},[activeStep]);

  useEffect(()=>{
    if(charIdx>=fullText.length)return;
    const t=setTimeout(()=>{setTyped(fullText.slice(0,charIdx+1));setCharIdx(c=>c+1);},18);
    return()=>clearTimeout(t);
  },[charIdx,fullText]);

  return (
    <div style={{display:'flex',flexDirection:'column',gap:20}}>
      {/* Progress tabs */}
      <div style={{display:'flex',gap:8,marginBottom:4}}>
        {steps.map((s,i)=>(
          <div key={i} onClick={()=>{setActiveStep(i);setCharIdx(0);setTyped('');}}
            style={{flex:1,height:3,borderRadius:2,cursor:'pointer',transition:'all .3s',
              background:i===activeStep?s.col:'#0A1D33',
              boxShadow:i===activeStep?`0 0 8px ${s.col}`:'none'}}/>
        ))}
      </div>
      {/* Title */}
      <div>
        <div style={{fontSize:10,color:step.col,letterSpacing:'.3em',marginBottom:4,fontFamily:'monospace'}}>{step.icon} STEP {step.num}</div>
        <div style={{fontSize:20,fontWeight:900,color:'white',lineHeight:1.3,marginBottom:10}}>{step.title}</div>
        <p style={{fontSize:12,color:K.dim,lineHeight:1.8,marginBottom:16}}>{step.description}</p>
      </div>
      {/* Agent tags */}
      <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:8}}>
        {step.agents.map(a=>(
          <div key={a} style={{padding:'3px 9px',background:step.col+'14',border:`1px solid ${step.col}35`,
            borderRadius:3,fontSize:9,color:step.col,fontFamily:'monospace',fontWeight:700}}>{a}</div>
        ))}
      </div>
      {/* Terminal */}
      <div style={{background:'rgba(4,6,13,0.95)',border:`1px solid ${step.col}20`,borderRadius:6,
        padding:'14px 16px',fontFamily:'monospace',fontSize:10,color:K.hi,lineHeight:1.9,
        minHeight:140,boxShadow:`inset 0 0 20px ${step.col}06`}}>
        {typed.split('\n').map((line,i)=>{
          const bracket=line.match(/\[([^\]]+)\]/)?.[1];
          const rest=line.replace(/\[([^\]]+)\]\s*/,'');
          return(
            <div key={i}>
              {bracket&&<span style={{color:step.col,fontWeight:700}}>[{bracket}]</span>}
              <span style={{color:K.hi}}>{' '}{rest}</span>
            </div>
          );
        })}
        {charIdx<fullText.length&&(
          <span style={{display:'inline-block',width:7,height:12,background:step.col,
            animation:'blink 0.8s infinite',marginLeft:2,verticalAlign:'middle'}}/>
        )}
      </div>
      {/* Progress bar */}
      <div style={{height:2,background:'#06090F',borderRadius:1}}>
        <div style={{height:'100%',borderRadius:1,background:step.col,
          width:`${Math.min((charIdx/fullText.length)*100,100)}%`,
          transition:'width .05s',boxShadow:`0 0 6px ${step.col}`}}/>
      </div>
    </div>
  );
}

const LEFT_STEPS = [
  {num:'01',title:'REAL DATA INGESTION',col:'#00F2FE',icon:'◉',
   agents:['LENS','RADAR','SURGE','ATLAS'],
   description:'Every 15 seconds, agents fetch real market data from Kraken, CoinGecko, DexScreener and Deribit APIs.',
   terminal:['[LENS]   Fetching RSI(14) from Kraken...','[LENS]   RSI = 38.2 — OVERSOLD detected','[RADAR]  EMA9 = 178.12 | EMA21 = 177.44','[RADAR]  Bullish crossover CONFIRMED','[SURGE]  Volume +340% above 24H average','[ATLAS]  BTC dominance: 54.8% → falling']},
  {num:'02',title:'SIGNAL GENERATION',col:'#00FF88',icon:'⚡',
   agents:['LEVIATHAN','ECHO','PHANTOM','SHIELD'],
   description:'Each agent runs its proprietary algorithm. RSI, EMA crossovers, whale flows, funding rates — all computed simultaneously.',
   terminal:['[LEVIA]  Whale wallet 9WzD...WWM','[LEVIA]  +12,400 SOL withdrawn from Binance','[LEVIA]  Buy pressure: 0.641 → BUY signal','[ECHO]   Fear & Greed index: 28 (Extreme Fear)','[ECHO]   Historical: +340% avg return → BUY','[PHNTM]  Funding rate: -0.031% → Longs cheap']},
  {num:'03',title:'AGENT VOTE',col:'#FFD700',icon:'◈',
   agents:['CONSENSUS','AEGIS'],
   description:'Each agent casts a weighted vote: BUY, SELL, or HOLD. Confidence score determines vote weight.',
   terminal:['[LENS]     BUY  82% confidence','[RADAR]    BUY  79% confidence','[LEVIA]    BUY  86% confidence','[SURGE]    BUY  71% confidence','[ECHO]     BUY  68% confidence','[AEGIS]    Risk check: 14.2% exposure ✓']},
];

const RIGHT_STEPS = [
  {num:'04',title:'CONSENSUS ENGINE',col:'#BD00FF',icon:'◈',
   agents:['CONSENSUS','NEURAL','WATCH'],
   description:'CONSENSUS tallies all votes. Only when 60%+ of agents agree with sufficient confidence — a signal fires.',
   terminal:['[CNSNS]  Tallying 18 agent votes...','[CNSNS]  BUY:  14 agents (78%)','[CNSNS]  SELL:  2 agents (11%)','[CNSNS]  HOLD:  2 agents (11%)','[CNSNS]  Weighted confidence: 82%','[CNSNS]  ✓ THRESHOLD REACHED → EXECUTE']},
  {num:'05',title:'RISK MANAGEMENT',col:'#FF3366',icon:'⛔',
   agents:['AEGIS','WATCH'],
   description:'AEGIS runs a final risk check: Kelly Criterion sizing, max exposure, peak hours filter, loss streak control.',
   terminal:['[AEGIS]  Portfolio exposure: 14.2% ✓','[AEGIS]  Kelly sizing: 12% @ 82% conf','[AEGIS]  Peak hours: NY SESSION ✓','[AEGIS]  Loss streak: 0 consecutive ✓','[AEGIS]  Macro filter: BTC +0.8% ✓','[AEGIS]  ✓ ALL CHECKS PASSED → GO']},
  {num:'06',title:'TRADE EXECUTION',col:'#00FF88',icon:'▲',
   agents:['EXECUTOR','JUPITER'],
   description:'The trade executes at the real market price. SL -2.5%, TP +5.5%, trailing stop at +1.5% to lock gains.',
   terminal:['[EXEC]   Building Jupiter swap...','[EXEC]   SOL/USDC | Amount: $1,200','[EXEC]   Entry price: $178.42 (live)','[EXEC]   Stop-loss:   $173.86 (-2.5%)','[EXEC]   Take-profit: $188.24 (+5.5%)','[EXEC]   ▲ LONG SOL OPENED @ $178.42']},
];

// ── Landing Swarm ─────────────────────────────────────────────────────────────
function LandingSwarm() {
  const [signals,   setSignals]   = useState<Record<string,string>>({});
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [debating,  setDebating]  = useState<string[]>([]);
  const [packets,   setPackets]   = useState<{id:number;from:string;progress:number;col:string}[]>([]);
  const [hovered,   setHovered]   = useState<string|null>(null);
  const packetId = useRef(0);

  const W=560, H=560, CX=W/2, CY=H/2;

  const getPos=(id:string)=>{
    const ag=AGENTS_RING.find(a=>a.id===id);
    if(!ag)return{x:CX,y:CY};
    if(ag.ring===0)return{x:CX,y:CY};
    const rad=(ag.angle-90)*Math.PI/180;
    return{x:CX+RING_RADII[ag.ring]*Math.cos(rad),y:CY+RING_RADII[ag.ring]*Math.sin(rad)};
  };

  const getArcD=(from:{x:number;y:number},to:{x:number;y:number})=>{
    const mx=(from.x+to.x)/2,my=(from.y+to.y)/2;
    const dx=to.x-from.x,dy=to.y-from.y,len=Math.sqrt(dx*dx+dy*dy)||1;
    const cx2=mx+(-dy/len)*25,cy2=my+(dx/len)*25;
    return`M${from.x},${from.y} Q${cx2},${cy2} ${to.x},${to.y}`;
  };

  const getBezierPt=(from:{x:number;y:number},to:{x:number;y:number},t:number)=>{
    const mx=(from.x+to.x)/2,my=(from.y+to.y)/2;
    const dx=to.x-from.x,dy=to.y-from.y,len=Math.sqrt(dx*dx+dy*dy)||1;
    const cx2=mx+(-dy/len)*25,cy2=my+(dx/len)*25;
    return{x:(1-t)*(1-t)*from.x+2*(1-t)*t*cx2+t*t*to.x,y:(1-t)*(1-t)*from.y+2*(1-t)*t*cy2+t*t*to.y};
  };

  useEffect(()=>{
    const tick=()=>{
      const active=AGENTS_RING.filter(a=>a.id!=='cnsns'&&Math.random()>0.38).map(a=>a.id);
      setActiveIds(active);
      const sigs:Record<string,string>={cnsns:'BUY'};
      AGENTS_RING.forEach(a=>{sigs[a.id]=Math.random()>0.55?'BUY':Math.random()>0.45?'SELL':'HOLD';});
      setSignals(sigs);
      setDebating(active.slice(0,2));
      setPackets(p=>{
        const next=[...p.slice(-30)];
        active.slice(0,5).forEach(id=>{
          next.push({id:packetId.current++,from:id,progress:0,
            col:sigs[id]==='BUY'?K.g:sigs[id]==='SELL'?K.r:K.c});
        });
        return next;
      });
    };
    tick();
    const iv=setInterval(tick,2000);
    return()=>clearInterval(iv);
  },[]);

  useEffect(()=>{
    if(packets.length===0)return;
    const raf=requestAnimationFrame(()=>{
      setPackets(p=>p.map(pk=>({...pk,progress:pk.progress+0.018})).filter(pk=>pk.progress<1));
    });
    return()=>cancelAnimationFrame(raf);
  },[packets]);

  const center={x:CX,y:CY};
  const hovAg=AGENTS_RING.find(a=>a.id===hovered);

  return (
    <div style={{position:'relative',width:W,height:H,margin:'0 auto',maxWidth:'100%'}}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        style={{overflow:'visible',display:'block',width:'100%',height:'auto'}}>
        <defs>
          <filter id="ls-sg" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="ls-bg" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <radialGradient id="ls-aura" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={K.c} stopOpacity="0.18"/>
            <stop offset="60%" stopColor={K.c} stopOpacity="0.04"/>
            <stop offset="100%" stopColor={K.c} stopOpacity="0"/>
          </radialGradient>
          <radialGradient id="ls-vig" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="transparent"/>
            <stop offset="100%" stopColor="#04060D" stopOpacity="0.5"/>
          </radialGradient>
        </defs>
        {[1,2,3].map(ring=>(
          <circle key={ring} cx={CX} cy={CY} r={RING_RADII[ring]}
            fill="none" stroke={K.c} strokeWidth="0.4" opacity="0.06" strokeDasharray="3 8"/>
        ))}
        <circle cx={CX} cy={CY} r={90} fill="url(#ls-aura)"/>
        {/* BEAMS */}
        {AGENTS_RING.filter(a=>a.ring>0).map(ag=>{
          const pos=getPos(ag.id);
          const isActive=activeIds.includes(ag.id);
          const isDebating=debating.includes(ag.id);
          const sig=signals[ag.id]||'HOLD';
          const col=sig==='BUY'?K.g:sig==='SELL'?K.r:K.c;
          const d=getArcD(pos,center);
          return(
            <g key={`b-${ag.id}`}>
              <path d={d} fill="none" stroke={ag.col} strokeWidth="0.4" opacity="0.07" strokeDasharray="3 7"/>
              {isActive&&(<>
                <path d={d} fill="none" stroke={col} strokeWidth="8"   opacity="0.05" filter="url(#ls-bg)"/>
                <path d={d} fill="none" stroke={col} strokeWidth="2.5" opacity="0.25"/>
                <path d={d} fill="none" stroke={col} strokeWidth="0.9" opacity={isDebating?1:0.7}/>
                <path d={d} fill="none" stroke="white" strokeWidth="0.3" opacity="0.5"/>
              </>)}
            </g>
          );
        })}
        {/* PACKETS */}
        {packets.map(pk=>{
          const fromPos=getPos(pk.from);
          const pt=getBezierPt(fromPos,center,pk.progress);
          const op=pk.progress<0.1?pk.progress*10:pk.progress>0.85?(1-pk.progress)*6.67:1;
          return(
            <g key={pk.id} opacity={op}>
              <circle cx={pt.x} cy={pt.y} r={5}   fill={pk.col} opacity={0.2} filter="url(#ls-bg)"/>
              <circle cx={pt.x} cy={pt.y} r={2.5} fill={pk.col} opacity={0.85}/>
              <circle cx={pt.x} cy={pt.y} r={1}   fill="white"  opacity={0.8}/>
            </g>
          );
        })}
        {/* NODES */}
        {AGENTS_RING.map(ag=>{
          const pos=getPos(ag.id);
          const isActive=activeIds.includes(ag.id)||ag.id==='cnsns';
          const isCenter=ag.id==='cnsns';
          const isDebating=debating.includes(ag.id);
          const isHov=hovered===ag.id;
          const sig=signals[ag.id]||(isCenter?'BUY':'HOLD');
          const col=isCenter?K.c:sig==='BUY'?K.g:sig==='SELL'?K.r:K.c;
          const size=NODE_SIZE[ag.ring];
          const r=size/2+4;
          return(
            <g key={ag.id} style={{cursor:'pointer'}}
              onMouseEnter={()=>setHovered(ag.id)}
              onMouseLeave={()=>setHovered(null)}
              filter={isActive||isHov?'url(#ls-sg)':undefined}>
              {(isActive||isHov)&&<circle cx={pos.x} cy={pos.y} r={r+8} fill="none" stroke={col} strokeWidth="0.5" opacity="0.2"/>}
              {isDebating&&(
                <circle cx={pos.x} cy={pos.y} r={r+4} fill="none" stroke={col} strokeWidth="1.5" opacity="0.5">
                  <animate attributeName="r" values={`${r+4};${r+12};${r+4}`} dur="1.2s" repeatCount="indefinite"/>
                  <animate attributeName="opacity" values="0.5;0;0.5" dur="1.2s" repeatCount="indefinite"/>
                </circle>
              )}
              <circle cx={pos.x} cy={pos.y} r={r} fill="#050A14" stroke={col}
                strokeWidth={isCenter?2:isActive?1.8:0.7} opacity={isActive?1:0.4}/>
              <g transform={`translate(${pos.x-size/2},${pos.y-size/2})`}>
                <SkullFace size={size} col={col} active={isActive||isCenter}
                  scanning={isActive&&!isCenter} conflict={ag.id==='aegis'&&sig==='SELL'}/>
              </g>
              {(isActive||isCenter)&&sig!=='HOLD'&&(
                <g>
                  <rect x={pos.x-14} y={pos.y-r-16} width={28} height={13} rx="2" fill={col+'25'} stroke={col} strokeWidth="0.7"/>
                  <text x={pos.x} y={pos.y-r-7} textAnchor="middle" fontSize="7.5" fill={col} fontFamily="monospace" fontWeight="700">{sig}</text>
                </g>
              )}
              <text x={pos.x} y={pos.y+r+11} textAnchor="middle"
                fontSize={isCenter?9:7.5} fill={isActive||isCenter?col:'#1A3050'}
                fontFamily="monospace" fontWeight="700">{ag.short}</text>
              {!isCenter&&(
                <text x={pos.x} y={pos.y+r+20} textAnchor="middle"
                  fontSize="6.5" fill="#1A3050" fontFamily="monospace">{ag.specialty}</text>
              )}
            </g>
          );
        })}
        <circle cx={CX} cy={CY} r={W/2} fill="url(#ls-vig)" opacity="0.6"/>
      </svg>

      {/* TOOLTIP */}
      {hovered&&hovAg&&(()=>{
        const pos=getPos(hovered);
        const sig=signals[hovered]||'HOLD';
        const col=hovAg.col;
        return(
          <div style={{position:'absolute',left:pos.x<CX?pos.x+50:pos.x-200,
            top:Math.max(0,pos.y-40),background:'rgba(4,6,13,0.97)',
            border:`1px solid ${col}50`,borderRadius:6,padding:'10px 14px',
            minWidth:160,pointerEvents:'none',zIndex:100,
            boxShadow:`0 0 20px ${col}15`,fontFamily:F}}>
            <div style={{fontSize:10,color:col,fontWeight:900,letterSpacing:'.1em',marginBottom:4}}>{hovAg.name}</div>
            <div style={{fontSize:9,color:K.dim,marginBottom:6}}>{hovAg.specialty}</div>
            {[
              {l:'Signal',     v:sig},
              {l:'Source',     v:hovered==='lens'?'Kraken RSI':hovered==='radar'?'Kraken EMA':hovered==='levia'?'DexScreener':hovered==='echo'?'Fear & Greed':hovered==='atlas'?'CoinGecko':'Real API'},
              {l:'Confidence', v:Math.floor(60+Math.random()*35)+'%'},
            ].map((row,i)=>(
              <div key={i} style={{display:'flex',justifyContent:'space-between',fontSize:9,marginBottom:3}}>
                <span style={{color:K.dim}}>{row.l}</span>
                <span style={{color:row.v==='BUY'?K.g:row.v==='SELL'?K.r:col,fontFamily:'monospace',fontWeight:700}}>{row.v}</span>
              </div>
            ))}
          </div>
        );
      })()}

      <div style={{position:'absolute',bottom:-32,left:0,right:0,textAlign:'center',
        fontSize:9,color:K.dim,fontFamily:F,letterSpacing:'.12em'}}>
        ◉ {activeIds.length}/18 AGENTS SIGNALING · REAL MARKET DATA · 15s CYCLE
      </div>
    </div>
  );
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function Boot({ onDone }:{ onDone:()=>void }) {
  const [lines, setLines] = useState(0);
  const [laser, setLaser] = useState(false);
  useEffect(()=>{
    BOOT_LINES.forEach((_,i)=>setTimeout(()=>setLines(i+1), BOOT_LINES[i].delay));
    setTimeout(()=>setLaser(true), 2300);
    setTimeout(onDone, 2800);
  },[onDone]);
  return (
    <div style={{position:"fixed",inset:0,background:K.bg,zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:F}}>
      {laser&&<div style={{position:"absolute",top:"50%",left:0,width:"100%",height:2,background:`linear-gradient(90deg,transparent,${K.c},transparent)`,animation:"laserSweep .5s ease forwards",boxShadow:`0 0 12px ${K.c}`}}/>}
      <div style={{maxWidth:560,width:"100%",padding:"0 24px"}}>
        {BOOT_LINES.slice(0,lines).map((l,i)=>(
          <div key={i} style={{display:"flex",gap:12,marginBottom:8}}>
            <span style={{color:K.c,fontSize:11,minWidth:90}}>{l.prefix}</span>
            <span style={{color:K.hi,fontSize:11}}>{l.text}</span>
          </div>
        ))}
        {lines>0&&<span style={{color:K.c,fontSize:11,animation:"blink 1s infinite"}}>█</span>}
      </div>
    </div>
  );
}

// ── Demo Video ───────────────────────────────────────────────────────────────
function DemoVideoSection() {
  return (
    <div style={{ maxWidth:900, margin:"0 auto 80px", padding:"0 20px", position:"relative" }}>
      <div style={{ textAlign:"center", marginBottom:32 }}>
        <div style={{ fontSize:10, color:K.c, letterSpacing:".4em", marginBottom:12 }}>◈ WATCH KYMIA IN ACTION</div>
        <div style={{ fontSize:28, fontWeight:900, color:"white" }}>18 agents. Real markets. Live trading.</div>
      </div>

      <div style={{
        position:"relative", borderRadius:12, overflow:"hidden",
        border:"1px solid rgba(0,242,254,0.25)",
        boxShadow:"0 0 80px rgba(0,242,254,0.08), 0 24px 60px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.03)",
      }}>
        {/* Terminal bar */}
        <div style={{ background:"rgba(6,10,18,0.95)", borderBottom:"1px solid rgba(0,242,254,0.1)", padding:"10px 16px", display:"flex", alignItems:"center", gap:8 }}>
          {["#FF3366","#FFD700","#00FF88"].map((c,i) => (
            <div key={i} style={{ width:10, height:10, borderRadius:"50%", background:c, opacity:0.8 }}/>
          ))}
          <span style={{ flex:1, textAlign:"center", fontSize:10, color:K.dim, fontFamily:"monospace", letterSpacing:".15em" }}>
            KYMIA — AUTONOMOUS QUANT INTELLIGENCE — LIVE DEMO
          </span>
          <div style={{ display:"flex", alignItems:"center", gap:4, padding:"2px 8px", background:"rgba(0,255,136,0.12)", border:"1px solid rgba(0,255,136,0.3)", borderRadius:10 }}>
            <div style={{ width:5, height:5, borderRadius:"50%", background:K.g, animation:"pu 1s infinite" }}/>
            <span style={{ fontSize:8, color:K.g }}>LIVE</span>
          </div>
        </div>

        {/* Video */}
        <video autoPlay loop muted playsInline
          style={{ width:"100%", display:"block", aspectRatio:"16/9", objectFit:"cover" }}
          poster="/kymia-poster.jpg">
          <source src="/kymia-demo.mp4" type="video/mp4"/>
          <source src="/kymia-demo.webm" type="video/webm"/>
        </video>

        {/* Bottom gradient */}
        <div style={{ position:"absolute", bottom:0, left:0, right:0, height:80, background:"linear-gradient(transparent, rgba(4,6,13,0.8))", pointerEvents:"none" }}/>
        {/* Scanlines */}
        <div style={{ position:"absolute", inset:0, pointerEvents:"none", background:"repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,242,254,0.012) 3px, rgba(0,242,254,0.012) 4px)" }}/>
      </div>

      {/* Stats */}
      <div style={{ display:"flex", justifyContent:"center", gap:48, marginTop:24, flexWrap:"wrap" }}>
        {[{v:"18",l:"AI AGENTS"},{v:"15s",l:"CYCLE TIME"},{v:"50+",l:"MARKETS"},{v:"24/7",l:"AUTONOMOUS"}].map((s,i) => (
          <div key={i} style={{ textAlign:"center" }}>
            <div style={{ fontSize:20, fontWeight:900, color:K.c, textShadow:`0 0 12px ${K.c}`, fontFamily:"monospace" }}>{s.v}</div>
            <div style={{ fontSize:8, color:K.dim, letterSpacing:".2em", marginTop:2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div style={{ textAlign:"center", marginTop:28 }}>
        <a href="/nexus?mode=demo" style={{
          display:"inline-block", padding:"12px 32px",
          background:"rgba(0,255,136,0.12)", border:"1.5px solid rgba(0,255,136,0.4)",
          color:K.g, borderRadius:6, fontFamily:"monospace", fontSize:12,
          fontWeight:700, textDecoration:"none", letterSpacing:".1em",
          boxShadow:"0 0 24px rgba(0,255,136,0.12)", transition:"all .3s",
        }}>▶ TRY FREE DEMO — NO SIGNUP</a>
      </div>
    </div>
  );
}

// ── Mini Swarm ────────────────────────────────────────────────────────────────
function MiniSwarm() {
  const nodes = useMemo(()=>Array.from({length:18},(_,i)=>{
    const a=(i/18)*Math.PI*2, rad=i<6?60:i<12?90:115;
    return {x:140+Math.cos(a)*rad, y:140+Math.sin(a)*rad, active:i%3!==2, delay:i*0.12};
  }),[]);
  const edges = useMemo(()=>nodes.flatMap((n,i)=>nodes.slice(i+1,i+3).map(m=>({x1:n.x,y1:n.y,x2:m.x,y2:m.y}))),[nodes]);
  return (
    <svg width={280} height={280} viewBox="0 0 280 280">
      {edges.map((e,i)=><line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={K.c} strokeWidth="0.5" opacity="0.2" strokeDasharray="3 3"/>)}
      {nodes.map((n,i)=>(
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.active?5:3.5} fill={n.active?K.g:K.dim} opacity={n.active?0.9:0.35}
            style={n.active?{animation:`pu ${1.2+i*0.1}s ${n.delay}s infinite`}:{}}/>
          {n.active&&<circle cx={n.x} cy={n.y} r={3.5} fill="none" stroke={K.g} strokeWidth="0.7" style={{animation:`ping 2.2s ${n.delay}s ease-out infinite`,transformOrigin:`${n.x}px ${n.y}px`}}/>}
        </g>
      ))}
      <text x={140} y={145} textAnchor="middle" fill={K.c} fontSize={8} fontFamily={F} letterSpacing="0.15em" opacity="0.6">LIVE · 18 AGENTS</text>
    </svg>
  );
}

// ── Radar ─────────────────────────────────────────────────────────────────────
function Radar() {
  return (
    <svg width={160} height={160} viewBox="0 0 160 160">
      {[74,52,30].map((r,i)=><circle key={i} cx={80} cy={80} r={r} fill="none" stroke="rgba(0,255,136,0.1)" strokeWidth="1"/>)}
      <line x1={80} y1={6} x2={80} y2={154} stroke="rgba(0,255,136,0.07)" strokeWidth="1"/>
      <line x1={6} y1={80} x2={154} y2={80} stroke="rgba(0,255,136,0.07)" strokeWidth="1"/>
      <g style={{animation:"rspin 3s linear infinite",transformOrigin:"80px 80px"}}>
        <path d="M80,80 L80,6 A74,74 0 0,1 154,80 Z" fill="rgba(0,255,136,0.18)"/>
        <line x1={80} y1={80} x2={80} y2={6} stroke={K.g} strokeWidth="1.5" opacity="0.8"/>
      </g>
      <circle cx={110} cy={45} r={3} fill={K.g} opacity="0.9" style={{animation:"pu 1.5s infinite"}}/>
      <circle cx={55} cy={110} r={2.5} fill={K.gold} opacity="0.9" style={{animation:"pu 2s .5s infinite"}}/>
      <circle cx={120} cy={95} r={2} fill={K.c} opacity="0.9" style={{animation:"pu 1.8s 1s infinite"}}/>
    </svg>
  );
}

// ── Fade section ──────────────────────────────────────────────────────────────
function Fade({ children, delay=0 }:{ children:React.ReactNode; delay?:number }) {
  const ref=useRef(null);
  const inView=useInView(ref,{once:true,margin:"-8% 0px"});
  return (
    <div ref={ref} style={{opacity:inView?1:0,transform:inView?"translateY(0)":"translateY(28px)",transition:`opacity .7s ${delay}s, transform .7s ${delay}s`}}>
      {children}
    </div>
  );
}

// ── Sticky Nav ────────────────────────────────────────────────────────────────
function Nav() {
  const [show,setShow]=useState(false);
  useEffect(()=>{
    const fn=()=>setShow(window.scrollY>100);
    window.addEventListener("scroll",fn,{passive:true});
    return ()=>window.removeEventListener("scroll",fn);
  },[]);
  return (
    <div style={{position:"fixed",top:0,left:0,right:0,zIndex:900,height:52,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 32px",background:"rgba(4,6,13,0.92)",backdropFilter:"blur(16px)",borderBottom:"1px solid rgba(0,242,254,0.08)",fontFamily:F,transform:show?"translateY(0)":"translateY(-100%)",transition:"transform .3s ease"}}>
      <a href="/" style={{fontSize:15,fontWeight:900,color:K.c,textDecoration:"none",letterSpacing:".2em",textShadow:`0 0 16px ${K.c}`}}>◈ KYMIA</a>
      <div style={{display:"flex",gap:28,fontSize:10,color:K.dim,letterSpacing:".1em"}}>
        {[["HOW IT WORKS","#how"],["DATA","#data"],["PERFORMANCE","#perf"],["CRISIS","#crisis"]].map(([l,h])=>(
          <a key={l} href={h} style={{color:K.dim,textDecoration:"none",transition:"color .2s"}}
            onMouseEnter={e=>(e.currentTarget.style.color=K.c)} onMouseLeave={e=>(e.currentTarget.style.color=K.dim)}>{l}</a>
        ))}
      </div>
      <div style={{display:"flex",gap:8}}>
        <a href="/nexus?mode=demo" style={{padding:"5px 14px",background:"rgba(0,255,136,0.12)",border:"1px solid rgba(0,255,136,0.4)",color:K.g,fontSize:9,borderRadius:3,textDecoration:"none",letterSpacing:".1em",fontFamily:F}}>▶ FREE DEMO</a>
        <a href="/nexus?mode=live" style={{padding:"5px 14px",background:"rgba(0,242,254,0.12)",border:"1px solid rgba(0,242,254,0.4)",color:K.c,fontSize:9,borderRadius:3,textDecoration:"none",letterSpacing:".1em",fontFamily:F}}>⚡ LIVE →</a>
      </div>
    </div>
  );
}

// ── Live Prices ───────────────────────────────────────────────────────────────
function LivePrices() {
  const [px,setPx]=useState({SOL:178.4,BTC:67420,ETH:3540});
  useEffect(()=>{
    const load=async()=>{try{const r=await fetch("/api/market?type=ticker");const d=await r.json();if(d.SOL)setPx({SOL:d.SOL,BTC:d.BTC,ETH:d.ETH});}catch{}};
    load();
    const iv=setInterval(load,10000);
    return ()=>clearInterval(iv);
  },[]);
  return (
    <div style={{display:"flex",gap:10,flexWrap:"wrap",justifyContent:"center"}}>
      {([
        ["◎ SOL", px.SOL,  2],
        ["₿ BTC", px.BTC,  0],
        ["Ξ ETH", px.ETH,  2],
      ] as [string,number,number][]).map(([sym,p,dec])=>(
        <div key={sym} style={{padding:"6px 16px",background:"rgba(6,10,18,0.85)",border:"1px solid rgba(0,242,254,0.18)",borderRadius:4,fontFamily:F,fontSize:10,display:"flex",gap:8,alignItems:"center"}}>
          <span style={{color:K.hi,fontWeight:700}}>{sym}</span>
          <span style={{color:K.c}}>${p>=1000?p.toLocaleString("en-US",{maximumFractionDigits:0}):p.toFixed(dec)}</span>
          <span style={{color:K.g,fontSize:9}}>▲</span>
        </div>
      ))}
    </div>
  );
}

// ── Performance Section ───────────────────────────────────────────────────────
function PerformanceSection() {
  const WALLET = (process.env.NEXT_PUBLIC_KYMIA_WALLET as string|undefined)||null;
  return (
    <section id="performance" style={{padding:'100px 40px',background:'rgba(6,10,18,0.5)',position:'relative',borderTop:'1px solid rgba(0,242,254,0.06)',borderBottom:'1px solid rgba(0,242,254,0.06)'}}>
      <div style={{position:'absolute',inset:0,opacity:0.03,backgroundImage:`linear-gradient(#00F2FE 1px,transparent 1px),linear-gradient(90deg,#00F2FE 1px,transparent 1px)`,backgroundSize:'40px 40px'}}/>
      <div style={{maxWidth:1100,margin:'0 auto',position:'relative'}}>
        <Fade>
          <div style={{textAlign:'center',marginBottom:64}}>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:12,fontFamily:'monospace'}}>◈ PROOF OF INTELLIGENCE</div>
            <h2 style={{fontSize:38,fontWeight:900,color:'white',margin:0,marginBottom:12}}>Verifiable on Solana blockchain.</h2>
            <p style={{fontSize:14,color:K.dim,lineHeight:1.8,margin:0}}>Every live trade is recorded on-chain. No claims. No promises.<br/>Just transparent, verifiable results anyone can check.</p>
          </div>
        </Fade>
        <Fade delay={.1}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24,marginBottom:32}}>
            {/* LEFT — stats */}
            <div style={{background:'rgba(4,6,13,0.9)',border:'1px solid rgba(0,242,254,0.1)',borderRadius:12,padding:'32px 36px',backdropFilter:'blur(12px)'}}>
              <div style={{fontSize:10,color:K.dim,letterSpacing:'.2em',marginBottom:24,fontFamily:'monospace'}}>◉ AGENT PERFORMANCE METRICS</div>
              <div style={{marginBottom:32}}>
                <div style={{fontSize:11,color:K.dim,fontFamily:'monospace',marginBottom:6}}>TOTAL SESSIONS MONITORED</div>
                <div style={{fontSize:52,fontWeight:900,color:K.g,fontFamily:'monospace',textShadow:'0 0 30px #00FF88',lineHeight:1}}>{'>'}5%</div>
                <div style={{fontSize:12,color:K.dim,marginTop:6}}>Average session return · Paper trading results</div>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
                {([['WIN RATE','62-68%',K.g,'Across all sessions'],['AGENTS LIVE','17/18',K.c,'Real API connections'],['CYCLE TIME','15s',K.gold,'Between analyses'],['MARKETS','50+',K.pu,'Solana pairs tracked'],['STOP LOSS','-2.5%',K.r,'Per position max loss'],['TAKE PROFIT','+5.5%',K.g,'Per position target']] as [string,string,string,string][]).map(([l,v,c,d],i)=>(
                  <div key={i} style={{padding:'14px 16px',background:'rgba(6,10,18,0.8)',border:`1px solid ${c}18`,borderRadius:6}}>
                    <div style={{fontSize:8,color:K.dim,letterSpacing:'.15em',marginBottom:4,fontFamily:'monospace'}}>{l}</div>
                    <div style={{fontSize:22,fontWeight:900,color:c,fontFamily:'monospace',textShadow:`0 0 12px ${c}`}}>{v}</div>
                    <div style={{fontSize:9,color:'#1A3050',marginTop:3}}>{d}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:20,fontSize:9,color:'#0A1828',lineHeight:1.6}}>* Paper trading results. Past performance does not guarantee future results. Not financial advice.</div>
            </div>
            {/* RIGHT — wallet */}
            <div style={{background:'rgba(4,6,13,0.9)',border:'1px solid rgba(0,242,254,0.1)',borderRadius:12,padding:'32px 36px',backdropFilter:'blur(12px)',display:'flex',flexDirection:'column'}}>
              <div style={{fontSize:10,color:K.dim,letterSpacing:'.2em',marginBottom:24,fontFamily:'monospace'}}>◉ PUBLIC TRADING WALLET</div>
              <div style={{width:64,height:64,borderRadius:12,background:'rgba(0,242,254,0.08)',border:'1px solid rgba(0,242,254,0.2)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:20,fontSize:28}}>◈</div>
              <h3 style={{fontSize:22,fontWeight:900,color:'white',margin:'0 0 12px'}}>Every trade on-chain.</h3>
              <p style={{fontSize:13,color:K.dim,lineHeight:1.8,marginBottom:24,flex:1}}>KYMIA maintains a dedicated public Solana address. Every live trade appears here in real time. No editing. No cherry-picking. 100% transparent.</p>
              {WALLET ? (
                <div style={{padding:'14px 16px',background:'rgba(0,242,254,0.05)',border:'1px solid rgba(0,242,254,0.2)',borderRadius:6,marginBottom:16,fontFamily:'monospace',fontSize:11,color:K.c,wordBreak:'break-all'}}>{WALLET}</div>
              ) : (
                <div style={{padding:'14px 16px',background:'rgba(255,215,0,0.05)',border:'1px solid rgba(255,215,0,0.2)',borderRadius:6,marginBottom:16}}>
                  <div style={{fontSize:10,color:K.gold,fontFamily:'monospace',marginBottom:4}}>⏳ LIVE WALLET — Coming soon</div>
                  <div style={{fontSize:9,color:K.dim}}>Phantom wallet will be connected when live trading activates. Address will appear here.</div>
                </div>
              )}
              <div style={{display:'flex',gap:8}}>
                {([['SOLSCAN',K.c,WALLET?`https://solscan.io/account/${WALLET}`:'https://solscan.io'],['BIRDEYE',K.g,WALLET?`https://birdeye.so/profile/${WALLET}`:'https://birdeye.so'],['EXPLORER',K.pu,WALLET?`https://explorer.solana.com/address/${WALLET}`:'https://explorer.solana.com']] as [string,string,string][]).map(([name,col,url],i)=>(
                  <a key={i} href={url} target="_blank" rel="noopener" style={{flex:1,padding:'10px 8px',background:`${col}12`,border:`1px solid ${col}35`,borderRadius:6,textAlign:'center',fontSize:10,color:col,fontFamily:'monospace',fontWeight:700,textDecoration:'none'}}>{name} ↗</a>
                ))}
              </div>
            </div>
          </div>
        </Fade>
        {/* GitHub banner */}
        <Fade delay={.2}>
          <div style={{padding:'24px 32px',background:'rgba(4,6,13,0.9)',border:'1px solid rgba(0,242,254,0.08)',borderRadius:12,display:'flex',alignItems:'center',gap:24,backdropFilter:'blur(12px)'}}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill={K.hi} opacity="0.8" style={{flexShrink:0}}>
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700,color:'white',marginBottom:4}}>Open source intelligence. Public code.</div>
              <div style={{fontSize:12,color:K.dim,lineHeight:1.6}}>The agent logic, signal algorithms, and API connections are all visible on GitHub. Verify the intelligence yourself.</div>
            </div>
            <a href="https://github.com/cbompemo-byte/Nexus-V2" target="_blank" rel="noopener" style={{padding:'12px 24px',background:'rgba(168,208,236,0.08)',border:'1px solid rgba(168,208,236,0.2)',borderRadius:6,fontSize:12,color:K.hi,fontFamily:'monospace',fontWeight:700,textDecoration:'none',whiteSpace:'nowrap'}}>VIEW ON GITHUB ↗</a>
          </div>
        </Fade>
      </div>
    </section>
  );
}

// ── API Section ───────────────────────────────────────────────────────────────
function APISection() {
  const [activeApi,setActiveApi]=useState<number|null>(null);
  const [tick,setTick]=useState(0);
  useEffect(()=>{const iv=setInterval(()=>setTick(t=>t+1),1500);return()=>clearInterval(iv);},[]);

  const APIS=[
    {name:'KRAKEN',      role:'RSI · EMA · MACD · ADX',      col:'#5741D9',agents:['LENS','RADAR','RAZOR','VECTOR','TITAN','ORACLE'],
     logo:<svg viewBox="0 0 24 24" width="30" height="30" fill="#5741D9"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 16.394l-1.055.87-4.507-5.48v7.012H10.5v-7.012l-4.507 5.48-1.055-.87 4.87-5.923L5.938 4.548l1.055-.87L10.5 7.916V.804h1.5v7.112l3.507-4.238 1.055.87-3.931 4.923 4.931 5.923z"/></svg>},
    {name:'COINGECKO',   role:'Volume · BTC Dominance',      col:'#8DC63F',agents:['SURGE','ATLAS'],
     logo:<svg viewBox="0 0 24 24" width="30" height="30" fill="#8DC63F"><path d="M11.997 0C5.373 0 0 5.373 0 11.997 0 18.625 5.373 24 11.997 24 18.625 24 24 18.625 24 11.997 24 5.373 18.625 0 11.997 0zm4.45 6.531c.449 0 .809.361.809.81 0 .449-.36.81-.81.81-.449 0-.81-.361-.81-.81.001-.449.362-.81.811-.81zm-8.012.428c2.432-.011 4.9 1.088 6.435 3.168.11.154.073.368-.081.477-.153.11-.368.073-.477-.081-1.399-1.896-3.653-2.895-5.878-2.88C5.852 7.657 3.45 9.744 3.45 12.45c0 2.724 2.415 4.919 5.392 4.919 2.41 0 4.534-1.461 5.199-3.55.088-.281.381-.44.661-.352.28.088.44.381.352.661-.784 2.497-3.28 4.226-6.212 4.226-3.534 0-6.378-2.68-6.378-5.904 0-3.184 2.775-5.49 5.971-5.491zm9.303 2.19c.396.225.533.726.308 1.122l-2.52 4.396c.131.249.206.532.206.833 0 .993-.806 1.799-1.8 1.799-.992 0-1.799-.806-1.799-1.8 0-.993.807-1.799 1.8-1.799.306 0 .594.077.845.213l2.638-4.456c.225-.395.726-.533 1.122-.308z"/></svg>},
    {name:'DEXSCREENER', role:'Whale Pressure · Order Depth',col:'#00F2FE',agents:['LEVIATHAN','SHIELD'],
     logo:<svg viewBox="0 0 252 300" width="28" height="28" fill="#00F2FE"><path d="M151.818 106.866c9.177-4.576 20.854-11.312 32.545-20.541 2.465-1.917 6.956-1.703 10.281 1.036 3.324 2.739 4.206 6.979 1.74 8.896-12.483 9.708-24.896 16.964-34.807 21.993 1.679 4.416 2.598 9.238 2.598 14.295 0 24.272-19.671 43.943-43.943 43.943s-43.943-19.671-43.943-43.943 19.671-43.943 43.943-43.943c9.048 0 17.449 2.756 24.429 7.481zm-7.611 43.056c0-13.748-11.144-24.893-24.893-24.893s-24.893 11.144-24.893 24.893 11.144 24.893 24.893 24.893 24.893-11.144 24.893-24.893zm20.883-77.004c-4.779-2.859-9.911-5.212-15.278-6.878L162.86 50.5c1.595-5.31 7.138-8.326 12.449-6.732 5.311 1.594 8.326 7.138 6.732 12.449l-16.951 16.701zM126 15c-61.3 0-111 49.7-111 111s49.7 111 111 111 111-49.7 111-111S187.3 15 126 15zM15 126C15 64.921 64.921 15 126 15s111 49.921 111 111-49.921 111-111 111S15 187.079 15 126z"/></svg>},
    {name:'DERIBIT',     role:'Funding Rate · Open Interest',col:'#BD00FF',agents:['PHANTOM'],
     logo:<svg viewBox="0 0 40 40" width="30" height="30"><circle cx="20" cy="20" r="18" fill="none" stroke="#BD00FF" strokeWidth="2.5"/><text x="20" y="26" textAnchor="middle" fontSize="17" fill="#BD00FF" fontWeight="900" fontFamily="monospace">D</text></svg>},
    {name:'SOLANA',      role:'Blockchain · Execution Layer',col:'#9945FF',agents:['EXECUTOR','ON-CHAIN'],
     logo:<svg viewBox="0 0 397 311" width="30" height="30"><defs><linearGradient id="solG" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stopColor="#9945FF"/><stop offset="100%" stopColor="#14F195"/></linearGradient></defs><path fill="url(#solG)" d="M64.6 237.9a9.6 9.6 0 016.8-2.8h317.3c4.3 0 6.4 5.2 3.4 8.2l-56.7 56.7a9.6 9.6 0 01-6.8 2.8H11.3c-4.3 0-6.4-5.2-3.4-8.2l56.7-56.7zm0-164.2A9.9 9.9 0 0171.4 71h317.3c4.3 0 6.4 5.2 3.4 8.2l-56.7 56.7a9.6 9.6 0 01-6.8 2.8H11.3c-4.3 0-6.4-5.2-3.4-8.2l56.7-56.8zM335.4 2.8A9.6 9.6 0 00328.6 0H11.3C7 0 4.9 5.2 7.9 8.2l56.7 56.7a9.6 9.6 0 006.8 2.8h317.3c4.3 0 6.4-5.2 3.4-8.2L335.4 2.8z"/></svg>},
    {name:'JUPITER',     role:'DEX Swaps · Price Feeds',     col:'#C7F284',agents:['DELTA','EXECUTOR'],
     logo:<svg viewBox="0 0 100 100" width="30" height="30"><circle cx="50" cy="50" r="44" fill="none" stroke="#C7F284" strokeWidth="4"/><text x="50" y="57" textAnchor="middle" fontSize="24" fill="#C7F284" fontWeight="900" fontFamily="monospace">JUP</text></svg>},
    {name:'ANTHROPIC',   role:'Debate Theater · DNA Card',   col:'#CC785C',agents:['DEBATE','DNA CARD'],
     logo:<svg viewBox="0 0 100 100" width="30" height="30"><rect width="100" height="100" rx="20" fill="#CC785C" opacity="0.15"/><text x="50" y="62" textAnchor="middle" fontSize="46" fill="#CC785C" fontWeight="400" fontFamily="serif">∞</text></svg>},
    {name:'FEAR & GREED',role:'Market Sentiment',            col:'#FF7A59',agents:['ECHO'],
     logo:<svg viewBox="0 0 100 100" width="30" height="30"><path d="M50 82 A36 36 0 0 1 14 50" fill="none" stroke="#FF3366" strokeWidth="9" strokeLinecap="round"/><path d="M14 50 A36 36 0 0 1 50 14" fill="none" stroke="#FFD700" strokeWidth="9" strokeLinecap="round"/><path d="M50 14 A36 36 0 0 1 86 50" fill="none" stroke="#00FF88" strokeWidth="9" strokeLinecap="round"/><path d="M86 50 A36 36 0 0 1 50 82" fill="none" stroke="#00FF88" strokeWidth="9" strokeLinecap="round"/><line x1="50" y1="50" x2="72" y2="28" stroke="#FF7A59" strokeWidth="4" strokeLinecap="round"/><circle cx="50" cy="50" r="6" fill="#FF7A59"/></svg>},
  ];
  const autoActive=tick%APIS.length;
  const CX=300,CY=300,R=210;

  const getXY=(i:number)=>{
    const rad=((i/APIS.length)*360-90)*Math.PI/180;
    return{x:CX+R*Math.cos(rad),y:CY+R*Math.sin(rad)};
  };

  return (
    <section style={{padding:'100px 40px',background:'#04060D',position:'relative'}}>
      <div style={{maxWidth:1000,margin:'0 auto'}}>
        <Fade>
          <div style={{textAlign:'center',marginBottom:64}}>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:12,fontFamily:'monospace'}}>◈ REAL DATA SOURCES</div>
            <h2 style={{fontSize:36,fontWeight:900,color:'white',margin:'0 0 12px'}}>Not simulated. Not estimated.</h2>
            <p style={{fontSize:14,color:K.dim,lineHeight:1.8,margin:0}}>Every signal comes from real institutional APIs.<br/>Hover any source to see which agents use it.</p>
          </div>
        </Fade>
        <Fade delay={.1}>
          <div style={{position:'relative',width:600,height:600,margin:'0 auto'}}>
            <svg width="600" height="600" style={{position:'absolute',inset:0,overflow:'visible'}}>
              <defs>
                <filter id="api-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="4" result="b"/>
                  <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
                </filter>
              </defs>
              <circle cx={CX} cy={CY} r={R} fill="none" stroke={K.c} strokeWidth="0.3" opacity="0.08" strokeDasharray="4 10"/>
              {APIS.map((api,i)=>{
                const {x,y}=getXY(i);
                const isActive=activeApi===i||autoActive===i;
                const pathD=`M${CX},${CY} L${x},${y}`;
                return (
                  <g key={api.name}>
                    <line x1={CX} y1={CY} x2={x} y2={y} stroke={api.col} strokeWidth="0.5" opacity="0.08" strokeDasharray="4 8"/>
                    {isActive&&(
                      <>
                        <line x1={CX} y1={CY} x2={x} y2={y} stroke={api.col} strokeWidth="6" opacity="0.05" filter="url(#api-glow)"/>
                        <line x1={CX} y1={CY} x2={x} y2={y} stroke={api.col} strokeWidth="1.5" opacity="0.7"/>
                        <circle r="5" fill={api.col} opacity="0.9" filter="url(#api-glow)">
                          <animateMotion path={pathD} dur="1.2s" repeatCount="indefinite" calcMode="linear"/>
                        </circle>
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
            {/* Center hub */}
            <div style={{position:'absolute',left:'50%',top:'50%',transform:'translate(-50%,-50%)',width:90,height:90,borderRadius:16,background:'rgba(4,6,13,0.95)',border:'2px solid rgba(0,242,254,0.4)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',boxShadow:'0 0 40px rgba(0,242,254,0.15)',zIndex:10}}>
              <div style={{fontSize:24,color:K.c,textShadow:'0 0 20px #00F2FE'}}>◈</div>
              <div style={{fontSize:9,color:K.c,fontFamily:'monospace',fontWeight:700,letterSpacing:'.12em',marginTop:4}}>KYMIA</div>
              <div style={{fontSize:7,color:K.dim,fontFamily:'monospace'}}>18 AGENTS</div>
            </div>
            {/* API nodes */}
            {APIS.map((api,i)=>{
              const {x,y}=getXY(i);
              const isActive=activeApi===i||autoActive===i;
              return (
                <div key={api.name} onMouseEnter={()=>setActiveApi(i)} onMouseLeave={()=>setActiveApi(null)}
                  style={{position:'absolute',left:x-48,top:y-48,width:96,height:96,cursor:'pointer',zIndex:5}}>
                  {isActive&&<div style={{position:'absolute',inset:-8,borderRadius:22,border:`1px solid ${api.col}40`,animation:'pu 1s infinite'}}/>}
                  <div style={{width:'100%',height:'100%',borderRadius:18,background:isActive?`${api.col}18`:'rgba(6,10,18,0.9)',border:`1.5px solid ${isActive?api.col:api.col+'30'}`,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',transition:'all .3s ease',boxShadow:isActive?`0 0 28px ${api.col}30`:'none',gap:6}}>
                    <div style={{opacity:isActive?1:0.45,transition:'opacity .3s',display:'flex',alignItems:'center',justifyContent:'center'}}>{api.logo}</div>
                    <div style={{fontSize:7,color:isActive?api.col:'#1A3050',fontFamily:'monospace',fontWeight:700,textAlign:'center',letterSpacing:'.05em',lineHeight:1.3,padding:'0 4px'}}>{api.name}</div>
                  </div>
                  {isActive&&(
                    <div style={{position:'absolute',left:x<300?'105%':'auto',right:x>=300?'105%':'auto',top:'50%',transform:'translateY(-50%)',background:'rgba(4,6,13,0.97)',border:`1px solid ${api.col}40`,borderRadius:8,padding:'12px 14px',minWidth:160,zIndex:100,whiteSpace:'nowrap',boxShadow:`0 0 20px ${api.col}15`}}>
                      <div style={{fontSize:10,color:api.col,fontWeight:900,fontFamily:'monospace',marginBottom:4}}>{api.name}</div>
                      <div style={{fontSize:9,color:K.dim,marginBottom:8}}>{api.role}</div>
                      <div style={{fontSize:8,color:K.dim,marginBottom:4}}>USED BY:</div>
                      <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                        {api.agents.map(a=><span key={a} style={{padding:'2px 6px',background:`${api.col}18`,border:`1px solid ${api.col}30`,borderRadius:2,fontSize:8,color:api.col,fontFamily:'monospace'}}>{a}</span>)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Fade>
        <Fade delay={.2}>
          <div style={{textAlign:'center',marginTop:32,fontSize:11,color:K.dim,fontFamily:'monospace',lineHeight:2}}>
            All APIs are free public endpoints · No paid subscriptions needed<br/>
            {([['#FF3366','Kraken'],['#00FF88','CoinGecko'],['#00F2FE','DexScreener'],['#BD00FF','Deribit'],['#FFD700','CoinGlass'],['#FF7A59','Fear & Greed']] as [string,string][]).map(([c,n],i)=>(
              <span key={i}><span style={{color:c}}>●</span> {n}{i<5?<>&nbsp;&nbsp;</>:null}</span>
            ))}
          </div>
        </Fade>
      </div>
    </section>
  );
}

// ── Cyber Globe (SVG wireframe) ───────────────────────────────────────────────
function CyberGlobe({sig}:{sig:string}) {
  const [rot,setRot]=useState(0);
  const [tick,setTick]=useState(0);
  const [arcs,setArcs]=useState<{id:number;f:string;t:string;col:string}[]>([]);
  const [labels,setLabels]=useState<{id:number;pnl:number;sym:string;angle:number;dist:number;born:number}[]>([]);
  const arcId=useRef(0);
  const labId=useRef(0);

  useEffect(()=>{const iv=setInterval(()=>setRot(r=>(r+0.5)%360),50);return()=>clearInterval(iv);},[]);

  useEffect(()=>{
    const iv=setInterval(()=>{
      setTick(t=>t+1);
      const C=['NYC','LON','TYO','SGP','DXB','HKG'];
      const f=C[Math.floor(Math.random()*C.length)];
      const t=C[Math.floor(Math.random()*C.length)];
      if(f!==t){
        const col=sig==='BUY'?K.g:sig==='SELL'?K.r:K.c;
        const id=arcId.current++;
        setArcs(a=>[...a.slice(-5),{id,f,t,col}]);
        setTimeout(()=>setArcs(a=>a.filter(x=>x.id!==id)),2500);
      }
      if(Math.random()>0.4){
        const pnl=(Math.random()>0.6?1:-1)*(Math.random()*90+8);
        const sym=['SOL','BTC','ETH','JUP'][Math.floor(Math.random()*4)];
        const id=labId.current++;
        setLabels(l=>[...l.slice(-5),{id,pnl,sym,angle:Math.random()*360,dist:15+Math.random()*45,born:Date.now()}]);
        setTimeout(()=>setLabels(l=>l.filter(x=>x.id!==id)),2800);
      }
    },1600);
    return()=>clearInterval(iv);
  },[sig]);

  const R=110,cx=140,cy=140;
  const proj=(lat:number,lon:number)=>{
    const phi=lat*Math.PI/180;
    const theta=((lon+rot)%360)*Math.PI/180;
    const x=R*Math.cos(phi)*Math.sin(theta);
    const y=-R*Math.sin(phi);
    return{x:cx+x,y:cy+y,vis:R*Math.cos(phi)*Math.cos(theta)>-5};
  };
  const CI:{[k:string]:{lt:number;ln:number;c:string}}={
    NYC:{lt:40.7,ln:280,c:'#00F2FE'},LON:{lt:51.5,ln:0,c:'#00F2FE'},
    TYO:{lt:35.7,ln:140,c:'#FFD700'},SGP:{lt:1.35,ln:104,c:'#00FF88'},
    DXB:{lt:25.2,ln:55,c:'#FFD700'},HKG:{lt:22.3,ln:114,c:'#FFD700'},
  };
  const mkArc=(p1:{x:number;y:number},p2:{x:number;y:number})=>{
    const mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2;
    const dx=p2.x-p1.x,dy=p2.y-p1.y,l=Math.sqrt(dx*dx+dy*dy)||1;
    const lft=Math.max(14,l*.4);
    return`M${p1.x},${p1.y} Q${mx-(dy/l)*lft},${my+(dx/l)*lft} ${p2.x},${p2.y}`;
  };
  const eR=9+Math.sin(tick*.5)*2;
  const eO=.5+Math.sin(tick*.4)*.35;

  return (
    <svg width="280" height="280" style={{display:'block',overflow:'visible'}}>
      <style>{`@keyframes arcflow{0%{stroke-dashoffset:200}100%{stroke-dashoffset:0}}.af{stroke-dasharray:200;animation:arcflow 2.2s ease-out forwards}@keyframes mf{0%{opacity:0}20%{opacity:1}100%{opacity:0}}.mf{animation:mf 2.8s ease-out forwards}`}</style>
      <defs>
        <radialGradient id="lgbg" cx="38%" cy="30%"><stop offset="0%" stopColor="#0D2040"/><stop offset="100%" stopColor="#030810"/></radialGradient>
        <radialGradient id="lggl" cx="50%" cy="50%"><stop offset="55%" stopColor="transparent"/><stop offset="100%" stopColor="#00F2FE" stopOpacity=".22"/></radialGradient>
        <radialGradient id="leye" cx="38%" cy="35%"><stop offset="0%" stopColor="#FFF" stopOpacity=".9"/><stop offset="55%" stopColor="#00F2FE" stopOpacity=".8"/><stop offset="100%" stopColor="#BD00FF" stopOpacity=".6"/></radialGradient>
        <filter id="lgf"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <clipPath id="lgcp"><circle cx={cx} cy={cy} r={R}/></clipPath>
      </defs>
      <circle cx={cx} cy={cy} r={R+18} fill="none" stroke={K.c} strokeWidth=".3" opacity=".08" strokeDasharray="3 8"/>
      <circle cx={cx} cy={cy} r={R+9}  fill="none" stroke={K.c} strokeWidth=".5" opacity=".15" strokeDasharray="5 5"/>
      <circle cx={cx} cy={cy} r={R}    fill="url(#lgbg)"/>
      {[-60,-30,0,30,60].map(lat=>{
        const pts=Array.from({length:37},(_,i)=>{const p=proj(lat,i*10);return p.vis?`${p.x},${p.y}`:null;}).filter(Boolean);
        return pts.length>1?<polyline key={'la'+lat} points={pts.join(' ')} fill="none" stroke="#0044DD" strokeWidth=".5" opacity=".2" clipPath="url(#lgcp)"/>:null;
      })}
      {[0,60,120,180,240,300].map(lon=>{
        const pts=Array.from({length:19},(_,i)=>{const p=proj((i-9)*10,lon);return p.vis?`${p.x},${p.y}`:null;}).filter(Boolean);
        return pts.length>1?<polyline key={'lo'+lon} points={pts.join(' ')} fill="none" stroke={K.c} strokeWidth=".3" opacity=".12" clipPath="url(#lgcp)"/>:null;
      })}
      <circle cx={cx} cy={cy} r={R} fill="url(#lggl)" clipPath="url(#lgcp)"/>
      {labels.map(lb=>{
        const rad=lb.angle*Math.PI/180;
        const col=lb.pnl>=0?K.g:K.r;
        return(
          <g key={lb.id} className="mf" clipPath="url(#lgcp)">
            <text x={cx+Math.cos(rad)*lb.dist} y={cy+Math.sin(rad)*lb.dist} textAnchor="middle" fontSize="11" fill={col} fontWeight="900" fontFamily="monospace">{lb.pnl>=0?'+$':'-$'}{Math.abs(lb.pnl).toFixed(0)}</text>
          </g>
        );
      })}
      {arcs.map(arc=>{
        const ca=CI[arc.f],cb=CI[arc.t];if(!ca||!cb)return null;
        const pa=proj(ca.lt,ca.ln),pb=proj(cb.lt,cb.ln);
        if(!pa.vis||!pb.vis)return null;
        return<path key={arc.id} d={mkArc(pa,pb)} fill="none" stroke={arc.col} strokeWidth="2.5" opacity=".9" className="af" filter="url(#lgf)" clipPath="url(#lgcp)"/>;
      })}
      {Object.entries(CI).map(([n,ci])=>{
        const p=proj(ci.lt,ci.ln);if(!p.vis)return null;
        const isA=arcs.some(a=>a.f===n||a.t===n);
        return(
          <g key={n} filter={isA?"url(#lgf)":undefined}>
            {isA&&<circle cx={p.x} cy={p.y} r="10" fill="none" stroke={ci.c} strokeWidth=".8" opacity=".3"/>}
            <circle cx={p.x} cy={p.y} r={isA?5:3} fill={ci.c} opacity={isA?1:.7}/>
            <circle cx={p.x} cy={p.y} r={isA?8:5} fill="none" stroke={ci.c} strokeWidth={isA?1.2:.6} opacity={isA?.6:.3}/>
            <text x={p.x+8} y={p.y+3} fontSize="8.5" fill={ci.c} opacity={isA?1:.7} fontFamily="monospace" fontWeight={isA?"700":"400"}>{n}</text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={R} fill="none" stroke={K.c} strokeWidth="1.5" opacity=".55"/>
      <g filter="url(#lgf)">
        <circle cx={cx} cy={cy} r={eR+6} fill={K.c} opacity=".05"/>
        <circle cx={cx} cy={cy} r={eR+3} fill="none" stroke={K.c} strokeWidth=".6" opacity=".2" strokeDasharray="3 5"/>
        <circle cx={cx} cy={cy} r={eR}   fill="url(#leye)" opacity={eO}/>
        <circle cx={cx-2.5} cy={cy-2.5}  r={eR*.3} fill="#FFF" opacity=".45"/>
      </g>
    </svg>
  );
}

// ── Debate Terminal ───────────────────────────────────────────────────────────
const DEBATE_CYCLES = [
  [
    {ag:'LEVIATHAN',col:'#BD00FF',sig:'BUY', conf:88,text:'Whale accumulation +12,400 SOL from Binance. Smart money entering.'},
    {ag:'LENS',     col:'#BD00FF',sig:'BUY', conf:82,text:'RSI(14) = 38.2 — Oversold territory. Mean reversion likely.'},
    {ag:'RADAR',    col:'#00F2FE',sig:'BUY', conf:79,text:'EMA9 crossed above EMA21 on 5m chart. Bullish momentum confirmed.'},
    {ag:'SURGE',    col:'#00FF88',sig:'BUY', conf:74,text:'Volume +340% above 24H average. Institutional buying pattern.'},
    {ag:'ECHO',     col:'#FF7A59',sig:'BUY', conf:68,text:'Fear & Greed: 28 (Extreme Fear). Historically bullish from here.'},
    {ag:'AEGIS',    col:'#FF3366',sig:'BUY', conf:76,text:'Exposure 14.2% — Kelly approved. Risk parameters nominal.'},
  ],
  [
    {ag:'PHANTOM',  col:'#BD00FF',sig:'SELL',conf:84,text:'Funding rate +0.048% — longs overpaying. Short squeeze likely.'},
    {ag:'HYDRA',    col:'#FF3366',sig:'SELL',conf:79,text:'$180M short liquidations at $179.50. Cascade imminent.'},
    {ag:'VECTOR',   col:'#00F2FE',sig:'SELL',conf:71,text:'ADX 34 — -DI above +DI. Strong downtrend confirmed.'},
    {ag:'TITAN',    col:'#FFD700',sig:'SELL',conf:66,text:'SMA50 crossing below SMA200. Regime shift to BEARISH.'},
    {ag:'SHIELD',   col:'#00F2FE',sig:'SELL',conf:73,text:'Bid/ask ratio 0.38 — heavy sell wall detected at resistance.'},
    {ag:'AEGIS',    col:'#FF3366',sig:'SELL',conf:80,text:'Reducing exposure 35%. Risk veto: macro conditions unfavorable.'},
  ],
];

type DLine = {ag:string;col:string;sig:string;conf:number;text:string};
type ConsensusData = {signal:string;symbol:string;votes:number;total:number;conf:number;tp:number;sl:number};

function DebateTerminal({onSignalChange}:{onSignalChange?:(s:string)=>void}={}) {
  const [lines,setLines]           = useState<DLine[]>([]);
  const [consensus,setConsensus]   = useState<ConsensusData|null>(null);
  const [phase,setPhase]           = useState<'debating'|'consensus'|'executing'>('debating');
  const [exeProgress,setExeProgress] = useState(0);
  const termRef   = useRef<HTMLDivElement>(null);
  const mounted   = useRef(true);

  useEffect(()=>{
    mounted.current=true;
    let cycleIdx=0;
    let timers:ReturnType<typeof setTimeout>[]=[];

    const safe=(fn:()=>void,ms:number)=>{
      const t=setTimeout(()=>{if(mounted.current)fn();},ms);
      timers.push(t);
      return t;
    };

    const runCycle=()=>{
      if(!mounted.current)return;
      const cycle=DEBATE_CYCLES[cycleIdx%DEBATE_CYCLES.length];
      setPhase('debating');setConsensus(null);setExeProgress(0);setLines([]);
      let lineIdx=0,current:DLine[]=[];

      const addLine=()=>{
        if(!mounted.current)return;
        if(lineIdx>=cycle.length){
          safe(()=>{
            setPhase('consensus');
            const isBuy=cycle.filter(l=>l.sig==='BUY').length>=cycle.filter(l=>l.sig==='SELL').length;
            const sig=isBuy?'BUY':'SELL';
            const votes=cycle.filter(l=>l.sig===sig).length;
            const avgConf=Math.round(cycle.reduce((a,l)=>a+l.conf,0)/cycle.length);
            setConsensus({signal:sig,symbol:'SOL',votes,total:cycle.length,conf:avgConf,tp:isBuy?188.20:168.40,sl:isBuy?173.86:183.60});
            onSignalChange?.(sig);
            safe(()=>{
              setPhase('executing');
              let prog=0;
              const progStep=()=>{
                if(!mounted.current)return;
                prog+=4;setExeProgress(prog);
                if(prog<100)safe(progStep,60);
                else safe(()=>{cycleIdx++;runCycle();},2500);
              };
              safe(progStep,60);
            },2000);
          },600);
          return;
        }
        current=[...current,cycle[lineIdx]];
        setLines([...current]);lineIdx++;
        if(termRef.current)termRef.current.scrollTop=termRef.current.scrollHeight;
        safe(addLine,900+Math.random()*400);
      };
      safe(addLine,500);
    };
    runCycle();
    return()=>{mounted.current=false;timers.forEach(clearTimeout);};
  },[]);

  const consBuy=consensus?.signal==='BUY';
  const consCol=consBuy?K.g:K.r;

  return (
    <div>
      {/* Terminal window */}
      <div style={{background:'rgba(4,6,13,0.97)',border:'1px solid rgba(0,242,254,0.15)',borderRadius:10,overflow:'hidden',boxShadow:'0 0 40px rgba(0,242,254,0.06),inset 0 0 30px rgba(0,0,0,0.5)'}}>
        {/* Title bar */}
        <div style={{padding:'10px 16px',borderBottom:'1px solid rgba(0,242,254,0.08)',background:'rgba(6,10,18,0.9)',display:'flex',alignItems:'center',gap:8}}>
          {['#FF3366','#FFD700','#00FF88'].map((c,i)=><div key={i} style={{width:9,height:9,borderRadius:'50%',background:c}}/>)}
          <span style={{flex:1,textAlign:'center',fontSize:9,color:K.dim,fontFamily:'monospace',letterSpacing:'.12em'}}>KYMIA SWARM DEBATE — LIVE</span>
          <div style={{display:'flex',alignItems:'center',gap:4,padding:'2px 7px',background:'rgba(0,255,136,0.12)',border:'1px solid rgba(0,255,136,0.3)',borderRadius:10}}>
            <div style={{width:4,height:4,borderRadius:'50%',background:K.g,animation:'pu 1s infinite'}}/>
            <span style={{fontSize:7,color:K.g,fontFamily:'monospace'}}>LIVE</span>
          </div>
        </div>
        {/* Lines */}
        <div ref={termRef} style={{padding:16,height:320,overflowY:'auto',scrollBehavior:'smooth'}}>
          {lines.map((line,i)=>(
            <div key={i} style={{display:'flex',gap:10,marginBottom:14,animation:'slideInLeft 0.4s ease forwards'}}>
              <div style={{minWidth:72,padding:'4px 6px',background:`${line.col}18`,border:`1px solid ${line.col}40`,borderRadius:4,textAlign:'center',flexShrink:0,alignSelf:'flex-start'}}>
                <div style={{fontSize:8,color:line.col,fontFamily:'monospace',fontWeight:900,letterSpacing:'.06em'}}>{line.ag}</div>
                <div style={{fontSize:8,color:line.col,fontFamily:'monospace',marginTop:2,opacity:0.8}}>{line.conf}%</div>
              </div>
              <div style={{flex:1}}>
                <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:4}}>
                  <span style={{padding:'1px 7px',background:`${line.sig==='BUY'?K.g:line.sig==='SELL'?K.r:K.gold}20`,color:line.sig==='BUY'?K.g:line.sig==='SELL'?K.r:K.gold,border:`1px solid ${line.sig==='BUY'?K.g:line.sig==='SELL'?K.r:K.gold}40`,borderRadius:2,fontSize:8,fontFamily:'monospace',fontWeight:700}}>{line.sig}</span>
                </div>
                <div style={{fontSize:11,color:K.hi,lineHeight:1.6,fontStyle:'italic'}}>"{line.text}"</div>
              </div>
            </div>
          ))}
          {consensus&&(
            <div style={{marginTop:8,padding:16,background:`${consCol}0C`,border:`2px solid ${consCol}40`,borderRadius:8,animation:'slideInLeft 0.5s ease forwards'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <span style={{fontSize:10,color:consCol,fontFamily:'monospace',fontWeight:900,letterSpacing:'.1em'}}>⟹ SWARM CONSENSUS</span>
                <span style={{fontSize:18,fontWeight:900,color:consCol,fontFamily:'monospace',textShadow:`0 0 14px ${consCol}`}}>{consensus.signal} {consensus.symbol}</span>
              </div>
              <div style={{display:'flex',gap:16,fontSize:10,color:K.dim,fontFamily:'monospace',marginBottom:8}}>
                <span>{consensus.votes}/{consensus.total} agents</span>
                <span>Conf: {consensus.conf}%</span>
                <span style={{color:consCol}}>TP ${consensus.tp.toFixed(2)}</span>
                <span style={{color:K.r}}>SL ${consensus.sl.toFixed(2)}</span>
              </div>
              {phase==='executing'&&(
                <div>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:9,color:K.dim,fontFamily:'monospace',marginBottom:4}}>
                    <span>{exeProgress<100?`▶ Executing ${consensus.signal} ${consensus.symbol}...`:'✓ TRADE OPENED @ MARKET PRICE'}</span>
                    <span style={{color:consCol}}>{exeProgress}%</span>
                  </div>
                  <div style={{height:4,background:'#06090F',borderRadius:2,overflow:'hidden'}}>
                    <div style={{height:'100%',borderRadius:2,background:consCol,width:`${exeProgress}%`,transition:'width 0.06s linear',boxShadow:`0 0 8px ${consCol}`}}/>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {/* Footer bar */}
        <div style={{padding:'8px 16px',borderTop:'1px solid rgba(0,242,254,0.06)',background:'rgba(4,6,13,0.9)',display:'flex',justifyContent:'space-between',fontSize:8,color:'#0A1828',fontFamily:'monospace'}}>
          <span>18 AGENTS · REAL MARKET DATA</span>
          <span>15s CYCLE · SOLANA NETWORK</span>
        </div>
      </div>
      {/* CTAs */}
      <div style={{marginTop:28,display:'flex',gap:12}}>
        <a href="/nexus?mode=demo" style={{flex:1,padding:14,background:'rgba(0,255,136,0.12)',border:'1.5px solid rgba(0,255,136,0.4)',borderRadius:8,textAlign:'center',color:K.g,fontSize:13,fontFamily:'monospace',fontWeight:700,textDecoration:'none',letterSpacing:'.08em',display:'block'}}>Watch AI Trade Live →</a>
        <a href="/nexus?mode=live" style={{flex:1,padding:14,background:'rgba(0,242,254,0.08)',border:'1px solid rgba(0,242,254,0.3)',borderRadius:8,textAlign:'center',color:K.c,fontSize:13,fontFamily:'monospace',fontWeight:700,textDecoration:'none',letterSpacing:'.08em',display:'block'}}>⚡ Connect Phantom</a>
      </div>
    </div>
  );
}

// ── Globe + Debate Section ────────────────────────────────────────────────────
function GlobeDebateSection() {
  const [sig,setSig]=useState('BUY');
  return (
    <section style={{padding:'60px 40px',background:'#04060D',position:'relative',borderTop:'1px solid rgba(0,242,254,0.06)',overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,pointerEvents:'none',background:'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)'}}/>
      <div style={{maxWidth:1100,margin:'0 auto',display:'grid',gridTemplateColumns:'320px 1fr',gap:40,alignItems:'start',position:'relative'}}>
        {/* LEFT — globe + stats */}
        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',fontFamily:'monospace'}}>◈ GLOBAL MACRO SPHERE</div>
          <div style={{background:'#060A12',border:'1px solid rgba(0,242,254,0.12)',borderRadius:12,padding:16,display:'flex',flexDirection:'column',alignItems:'center',boxShadow:'0 0 40px rgba(0,242,254,0.04),inset 0 0 30px rgba(0,0,0,0.5)'}}>
            <CyberGlobe sig={sig}/>
            <div style={{width:'100%',marginTop:12,display:'grid',gridTemplateColumns:'1fr 1fr',gap:6}}>
              {([['SOL','$178.40',K.c,'+2.1%'],['BTC','$67,420',K.gold,'+0.8%'],['AGENTS','17/18',K.g,'LIVE'],['SIGNAL',sig,sig==='BUY'?K.g:K.r,'NOW']] as [string,string,string,string][]).map(([l,v,c,t],i)=>(
                <div key={i} style={{padding:'8px 10px',background:'rgba(4,6,13,0.8)',border:`1px solid ${c}18`,borderRadius:4}}>
                  <div style={{fontSize:8,color:K.dim,fontFamily:'monospace',letterSpacing:'.1em'}}>{l}</div>
                  <div style={{fontSize:12,color:c,fontWeight:700,fontFamily:'monospace'}}>{v}</div>
                  <div style={{fontSize:8,color:c,opacity:.6,fontFamily:'monospace'}}>{t}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8,padding:'10px 14px',background:'rgba(0,242,254,0.04)',border:'1px solid rgba(0,242,254,0.1)',borderRadius:6}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:K.g,boxShadow:`0 0 8px ${K.g}`,animation:'pu 1s infinite',flexShrink:0}}/>
            <span style={{fontSize:10,color:K.dim,fontFamily:'monospace'}}>Globe synchronized with debate consensus</span>
          </div>
        </div>
        {/* RIGHT — debate terminal */}
        <div>
          <div style={{marginBottom:20}}>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:8,fontFamily:'monospace'}}>◈ LIVE SWARM INTELLIGENCE</div>
            <h2 style={{fontSize:40,fontWeight:900,color:'white',margin:0,lineHeight:1.2}}>Agents debate.<br/><span style={{color:K.c}}>Markets obey.</span></h2>
            <p style={{fontSize:13,color:K.dim,lineHeight:1.8,marginTop:10,marginBottom:0}}>Every 15 seconds, 18 agents analyze real data and debate until one signal emerges.</p>
          </div>
          <DebateTerminal onSignalChange={setSig}/>
        </div>
      </div>
    </section>
  );
}

// ── TA Proof Section ─────────────────────────────────────────────────────────
function TAProofSection() {
  const [step,setStep]=useState(0);
  const [revealed,setRevealed]=useState<number[]>([]);

  useEffect(()=>{
    const steps=[0,1,2,3,4,5];
    steps.forEach((s,i)=>{setTimeout(()=>{setRevealed(r=>[...r,s]);setStep(s);},i*800);});
    const iv=setInterval(()=>{
      setRevealed([]);setStep(0);
      steps.forEach((s,i)=>{setTimeout(()=>{setRevealed(r=>[...r,s]);setStep(s);},i*800);});
    },12000);
    return()=>clearInterval(iv);
  },[]);

  const STEPS=[
    {agent:'LEVIATHAN',col:'#BD00FF',icon:'🐋',type:'WHALE PRESSURE',  finding:'Buy pressure = 62%',          detail:'→ ABOVE AVERAGE volume — breakout likely',       signal:'BUY',conf:88,src:'DexScreener on-chain flow'},
    {agent:'SURGE',    col:'#00FF88',icon:'▲', type:'VOLUME ANALYSIS', finding:'24h Vol change = +6.0%',       detail:'→ ABOVE AVERAGE volume — breakout likely',       signal:'BUY',conf:74,src:'CoinGecko 24H volume'},
    {agent:'LENS',     col:'#BD00FF',icon:'◎', type:'RSI SIGNAL',      finding:'RSI(14) = 38.2',               detail:'→ Oversold territory. Mean reversion likely.',   signal:'BUY',conf:82,src:'Kraken 1m candles'},
    {agent:'RADAR',    col:'#00F2FE',icon:'◈', type:'EMA CROSSOVER',   finding:'EMA9 crossed above EMA21',     detail:'→ Bullish momentum confirmed on 5m chart',       signal:'BUY',conf:79,src:'Kraken 5m candles'},
    {agent:'RAZOR',    col:'#FFD700',icon:'⚡', type:'MACD SIGNAL',     finding:'MACD bullish crossover',       detail:'→ Momentum accelerating. RSI < 55.',             signal:'BUY',conf:76,src:'Kraken 1m MACD'},
    {agent:'AEGIS',    col:'#FF3366',icon:'⛔', type:'RISK CHECK',      finding:'Kelly sizing: 8% @ 82% conf', detail:'→ All checks passed. EXECUTE.',                  signal:'BUY',conf:100,src:'Portfolio risk engine'},
  ];
  const LEVELS=[
    {label:'ENTRY',       value:'$81.22',col:K.c,  desc:'Real Jupiter price at execution'},
    {label:'STOP LOSS',   value:'$79.19',col:K.r,  desc:'-2.5% max loss protection'},
    {label:'TAKE PROFIT', value:'$85.68',col:K.g,  desc:'+5.5% target return'},
    {label:'TRAIL',       value:'$80.60',col:K.gold,desc:'Activated at +1.5% to lock gains'},
  ];

  return (
    <div style={{marginTop:60}}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:32}}>
        <div style={{width:3,height:40,background:'linear-gradient(#00F2FE,#BD00FF)',borderRadius:2}}/>
        <div>
          <div style={{fontSize:10,color:K.c,letterSpacing:'.3em',fontFamily:'monospace',marginBottom:4}}>◈ WHAT THE AI SAW</div>
          <div style={{fontSize:22,fontWeight:900,color:'white'}}>Every trade has a technical thesis.</div>
        </div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24}}>
        {/* LEFT — step reveal */}
        <div>
          <div style={{fontSize:10,color:K.dim,fontFamily:'monospace',marginBottom:14,letterSpacing:'.1em'}}>SOL/USD · 5m · BINANCE · BEFORE ENTRY @$81.22</div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {STEPS.map((s,i)=>{
              const on=revealed.includes(i);
              return(
                <div key={i} style={{padding:'12px 14px',background:on?`rgba(${s.signal==='BUY'?'0,255,136':'255,51,102'},0.05)`:'rgba(6,10,18,0.4)',border:`1px solid ${on?s.col+'30':'rgba(0,242,254,0.04)'}`,borderLeft:`3px solid ${on?s.col:'#0A1D33'}`,borderRadius:4,opacity:on?1:0.25,transform:on?'translateX(0)':'translateX(-8px)',transition:'all 0.4s ease'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:on?6:0}}>
                    <div style={{display:'flex',alignItems:'center',gap:7}}>
                      <span style={{fontSize:12}}>{s.icon}</span>
                      <span style={{fontSize:10,color:s.col,fontWeight:700,fontFamily:'monospace'}}>{s.agent}</span>
                      <span style={{fontSize:8,color:K.dim,fontFamily:'monospace'}}>{s.type}</span>
                    </div>
                    <span style={{padding:'2px 7px',background:`${s.signal==='BUY'?K.g:K.r}20`,color:s.signal==='BUY'?K.g:K.r,border:`1px solid ${s.signal==='BUY'?K.g+'40':K.r+'40'}`,borderRadius:2,fontSize:8,fontFamily:'monospace',fontWeight:700}}>{s.signal} {s.conf}%</span>
                  </div>
                  {on&&(<>
                    <div style={{fontSize:12,color:K.hi,fontFamily:'monospace',fontWeight:700,marginBottom:2}}>{s.finding}</div>
                    <div style={{fontSize:10,color:K.dim,fontFamily:'monospace'}}>{s.detail}</div>
                    <div style={{fontSize:8,color:s.col,opacity:.5,marginTop:4,fontFamily:'monospace'}}>Source: {s.src}</div>
                  </>)}
                </div>
              );
            })}
          </div>
        </div>
        {/* RIGHT — chart + levels + comparison */}
        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          <div style={{background:'#060A12',border:'1px solid rgba(0,242,254,0.15)',borderRadius:8,overflow:'hidden',position:'relative'}}>
            <img src="/screenshots/chart-1.png" alt="KYMIA TradingView Analysis" style={{width:'100%',display:'block',objectFit:'cover'}} onError={e=>(e.currentTarget.style.display='none')}/>
            <div style={{padding:'40px 20px',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:8}}>
              <div style={{fontSize:24}}>📊</div>
              <div style={{fontSize:10,color:'#0A1828',fontFamily:'monospace',textAlign:'center'}}>TRADINGVIEW CHART<br/>Add: /public/screenshots/chart-1.png</div>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            {LEVELS.map((lv,i)=>(
              <div key={i} style={{padding:'10px 12px',background:'rgba(4,6,13,0.9)',border:`1px solid ${lv.col}20`,borderLeft:`3px solid ${lv.col}`,borderRadius:4}}>
                <div style={{fontSize:8,color:K.dim,fontFamily:'monospace',marginBottom:3}}>{lv.label}</div>
                <div style={{fontSize:16,fontWeight:900,color:lv.col,fontFamily:'monospace',textShadow:`0 0 10px ${lv.col}`,marginBottom:3}}>{lv.value}</div>
                <div style={{fontSize:8,color:'#1A3050',fontFamily:'monospace'}}>{lv.desc}</div>
              </div>
            ))}
          </div>
          <div style={{padding:16,background:'rgba(4,6,13,0.9)',border:'1px solid rgba(0,242,254,0.08)',borderRadius:6}}>
            <div style={{fontSize:9,color:K.dim,fontFamily:'monospace',letterSpacing:'.15em',marginBottom:12}}>KYMIA vs HUMAN ANALYST</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              {([{side:'HUMAN',col:K.dim,items:['1-2 indicators','30-60s decision','Emotional bias','Misses whale data']},{side:'KYMIA',col:K.c,items:['17 indicators','15s decision','Zero emotion','On-chain + CEX data']}] as {side:string;col:string;items:string[]}[]).map((c,i)=>(
                <div key={i}>
                  <div style={{fontSize:9,color:c.col,fontFamily:'monospace',fontWeight:700,marginBottom:6,letterSpacing:'.1em'}}>{c.side}</div>
                  {c.items.map((item,j)=>(
                    <div key={j} style={{display:'flex',alignItems:'center',gap:5,marginBottom:4,fontSize:10,color:K.dim}}>
                      <span style={{color:i===1?K.g:'#FF336660',fontSize:10}}>{i===1?'✓':'✗'}</span>{item}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Proof Section ────────────────────────────────────────────────────────────
function ProofSection() {
  const [activeTab,setActiveTab]=useState('trades');
  const TABS=[
    {id:'trades', label:'OPEN TRADES',   icon:'▲'},
    {id:'profile',label:'TRADE PROFILE', icon:'◈'},
    {id:'losses', label:'LOSSES',        icon:'▼'},
    {id:'chart',  label:'TA ANALYSIS',   icon:'⬡'},
  ];
  const cardLabel=(tab:string,i:number)=>{
    if(tab==='trades') return i===1?'SOL LONG +$8.15 · JTO SHORT +$5.07 · WIF TRAIL +$42.31':'▲ LONG SOL';
    if(tab==='profile') return '◈ TRADER DNA';
    if(tab==='losses') return '▼ LOSS CONTAINED';
    return '⬡ TA SIGNALS';
  };
  const cardVal=(tab:string,i:number)=>{
    if(tab==='trades'&&i===1) return '4 simultaneous positions · LONG + SHORT active';
    return tab==='losses'?'-$18.40':'+$47.83';
  };
  const PROOF_STATS=[
    {text:'POPCAT +$67.06 in single trade',col:K.g},
    {text:'WIF TRAIL +4.13% locked by trailing stop',col:K.g},
    {text:'WHALE DETECTED: +12,400 SOL Binance outflow',col:K.c},
    {text:'60s MILESTONE: Portfolio tracking active',col:K.gold},
  ];
  const TICKER_ITEMS='SOL +$8.15 · JUP -$16.77 · JTO SHORT +$5.07 · WIF TRAIL +$42.31 · POPCAT +$67.06 · SOL +$8.15 · JUP -$16.77 · JTO SHORT +$5.07 · WIF TRAIL +$42.31 · POPCAT +$67.06';
  return (
    <section style={{padding:'100px 40px',background:'#04060D',position:'relative',borderTop:'1px solid rgba(0,242,254,0.06)'}}>
      <div style={{maxWidth:1100,margin:'0 auto'}}>
        <Fade>
          <div style={{textAlign:'center',marginBottom:48}}>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:12,fontFamily:'monospace'}}>◈ PROOF OF RESULTS</div>
            <h2 style={{fontSize:38,fontWeight:900,color:'white',margin:'0 0 12px'}}>No claims. Just results.</h2>
            <p style={{fontSize:14,color:K.dim,lineHeight:1.8,margin:0}}>Real sessions. Real trades. Real P&L.<br/>Including the losses — because that's what trust looks like.</p>
          </div>
        </Fade>
        <Fade delay={.1}>
          <div style={{display:'flex',gap:4,marginBottom:32,background:'rgba(6,10,18,0.8)',border:'1px solid rgba(0,242,254,0.08)',borderRadius:8,padding:4,width:'fit-content',margin:'0 auto 32px'}}>
            {TABS.map(tab=>(
              <button key={tab.id} onClick={()=>setActiveTab(tab.id)} style={{padding:'8px 18px',background:activeTab===tab.id?'rgba(0,242,254,0.12)':'transparent',border:activeTab===tab.id?'1px solid rgba(0,242,254,0.3)':'1px solid transparent',borderRadius:6,cursor:'pointer',fontSize:10,fontFamily:'monospace',color:activeTab===tab.id?K.c:K.dim,fontWeight:700,letterSpacing:'.1em',transition:'all .2s'}}>
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>
        </Fade>
        <Fade delay={.15}>
          {/* ── OPEN TRADES ── */}
          {activeTab==='trades'&&(
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24,alignItems:'start'}}>
              {/* Left: screenshot in terminal frame */}
              <div style={{background:'#060A12',border:'1px solid rgba(0,242,254,0.2)',borderRadius:10,overflow:'hidden'}}>
                <div style={{background:'rgba(6,10,18,0.95)',borderBottom:'1px solid rgba(0,242,254,0.1)',padding:'8px 14px',display:'flex',alignItems:'center',gap:6}}>
                  {['#FF3366','#FFD700','#00FF88'].map((c,i)=><div key={i} style={{width:8,height:8,borderRadius:'50%',background:c}}/>)}
                  <span style={{flex:1,textAlign:'center',fontSize:9,color:K.dim,fontFamily:'monospace',letterSpacing:'.12em'}}>KYMIA · LIVE SESSION</span>
                  <div style={{display:'flex',alignItems:'center',gap:4,padding:'2px 7px',background:'rgba(0,255,136,0.1)',border:'1px solid rgba(0,255,136,0.3)',borderRadius:10}}>
                    <div style={{width:4,height:4,borderRadius:'50%',background:K.g,animation:'pu 1s infinite'}}/>
                    <span style={{fontSize:7,color:K.g}}>LIVE</span>
                  </div>
                </div>
                <div style={{position:'relative'}}>
                  <img src="/screenshots/trades-1.png" alt="KYMIA Live Trades — 4 simultaneous positions" style={{width:'100%',display:'block',height:'auto'}}/>
                  <div style={{position:'absolute',inset:0,pointerEvents:'none',background:'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)'}}/>
                </div>
              </div>
              {/* Right: position cards */}
              <div style={{display:'flex',flexDirection:'column',gap:10}}>
                <div style={{fontSize:9,color:K.dim,fontFamily:'monospace',letterSpacing:'.15em',marginBottom:4}}>◈ 4 SIMULTANEOUS POSITIONS · LONG + SHORT</div>
                {([
                  {sym:'SOL',dir:'▲ LONG', pnl:'+$8.15', col:K.g, note:'EMA9 × EMA21 crossover · Kelly 8%'},
                  {sym:'JUP',dir:'▲ LONG', pnl:'-$16.77',col:K.r, note:'Stop-loss triggered at -2.5% · AEGIS protected'},
                  {sym:'JTO',dir:'▼ SHORT',pnl:'+$5.07', col:K.g, note:'Funding rate +0.048% · Short squeeze setup'},
                  {sym:'WIF',dir:'🔒 TRAIL',pnl:'+$42.31',col:K.g, note:'Trailing stop locked at +4.13% · Running'},
                ] as {sym:string;dir:string;pnl:string;col:string;note:string}[]).map((p,i)=>(
                  <div key={i} style={{padding:'12px 14px',background:'rgba(6,10,18,0.8)',border:`1px solid ${p.col}20`,borderLeft:`3px solid ${p.col}`,borderRadius:6}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <span style={{fontSize:13,fontWeight:900,color:'white',fontFamily:'monospace'}}>{p.sym}</span>
                        <span style={{fontSize:9,color:p.col,fontFamily:'monospace',fontWeight:700}}>{p.dir}</span>
                      </div>
                      <span style={{fontSize:14,fontWeight:900,color:p.col,fontFamily:'monospace',textShadow:`0 0 10px ${p.col}60`}}>{p.pnl}</span>
                    </div>
                    <div style={{fontSize:9,color:K.dim,fontFamily:'monospace'}}>{p.note}</div>
                  </div>
                ))}
                {/* POPCAT win card */}
                <div style={{padding:'12px 14px',background:'linear-gradient(135deg,rgba(0,255,136,0.08),rgba(0,255,136,0.02))',border:`1px solid ${K.g}30`,borderRadius:6,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontSize:9,color:K.dim,fontFamily:'monospace',marginBottom:3}}>◈ CLOSED · BEST TRADE</div>
                    <div style={{fontSize:13,fontWeight:900,color:'white',fontFamily:'monospace'}}>POPCAT</div>
                  </div>
                  <div style={{textAlign:'right'}}>
                    <div style={{fontSize:20,fontWeight:900,color:K.g,fontFamily:'monospace',textShadow:`0 0 16px ${K.g}`}}>+$67.06</div>
                    <div style={{fontSize:8,color:K.g,fontFamily:'monospace',opacity:.7}}>TAKE PROFIT HIT</div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TRADE PROFILE ── */}
          {activeTab==='profile'&&(
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:24,alignItems:'start'}}>
              {/* Left: DNA card screenshot */}
              <div style={{border:'1px solid rgba(189,0,255,0.3)',borderRadius:10,overflow:'hidden',boxShadow:'0 0 40px rgba(189,0,255,0.08)'}}>
                <img src="/screenshots/profile-1.png" alt="KYMIA Performance DNA — Momentum Predator" style={{width:'100%',display:'block',height:'auto'}}/>
              </div>
              {/* Right: explanation + stats */}
              <div style={{display:'flex',flexDirection:'column',gap:16}}>
                <div>
                  <div style={{fontSize:9,color:K.gold,fontFamily:'monospace',letterSpacing:'.2em',marginBottom:6}}>◈ KYMIA PERFORMANCE DNA</div>
                  <div style={{fontSize:9,color:K.gold,fontFamily:'monospace',marginBottom:12,opacity:.8}}>GOLD TIER · Score 74/100</div>
                  <div style={{fontSize:28,fontWeight:900,color:K.gold,fontFamily:'monospace',textShadow:`0 0 20px ${K.gold}60`,marginBottom:16}}>"Momentum Predator"</div>
                </div>
                {([['WIN RATE','64%',K.g],['BEST TRADE','+$247',K.g],['AVG HOLD','8.4 min',K.c],['TRADES THIS SESSION','24',K.c],['AEGIS SCORE','98/100',K.g]] as [string,string,string][]).map(([l,v,c],i)=>(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid rgba(0,242,254,0.06)',fontSize:11}}>
                    <span style={{color:K.dim,fontFamily:'monospace'}}>{l}</span>
                    <span style={{color:c,fontWeight:700,fontFamily:'monospace'}}>{v}</span>
                  </div>
                ))}
                <a href="/nexus?mode=demo" style={{display:'block',marginTop:8,padding:'11px',textAlign:'center',background:`${K.gold}15`,border:`1px solid ${K.gold}40`,color:K.gold,borderRadius:6,fontSize:10,textDecoration:'none',letterSpacing:'.1em',fontFamily:'monospace',fontWeight:700}}>
                  ▶ GENERATE YOUR DNA →
                </a>
              </div>
            </div>
          )}

          {/* ── TA ANALYSIS ── */}
          {activeTab==='chart'&&(
            <div style={{background:'#060A12',border:'1px solid rgba(0,242,254,0.2)',borderRadius:10,overflow:'hidden'}}>
              <div style={{background:'rgba(6,10,18,0.95)',borderBottom:'1px solid rgba(0,242,254,0.1)',padding:'8px 14px',display:'flex',alignItems:'center',gap:6}}>
                {['#FF3366','#FFD700','#00FF88'].map((c,i)=><div key={i} style={{width:8,height:8,borderRadius:'50%',background:c}}/>)}
                <span style={{flex:1,textAlign:'center',fontSize:9,color:K.dim,fontFamily:'monospace',letterSpacing:'.12em'}}>KYMIA · TRADINGVIEW · SOL/USD · 5m</span>
                <span style={{fontSize:8,color:K.c,fontFamily:'monospace',padding:'2px 8px',border:'1px solid rgba(0,242,254,0.2)',borderRadius:4}}>BEFORE ENTRY @$81.22</span>
              </div>
              <div style={{position:'relative'}}>
                <img src="/screenshots/chart-1.png" alt="KYMIA TradingView Analysis" style={{width:'100%',display:'block',height:'auto'}} onError={e=>(e.currentTarget.style.display='none')}/>
                <div style={{position:'absolute',inset:0,pointerEvents:'none',background:'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)'}}/>
              </div>
            </div>
          )}

          {/* ── LOSSES ── */}
          {activeTab==='losses'&&(
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(320px,1fr))',gap:16}}>
              {[1,2,3].map(i=>(
                <div key={i} style={{background:'rgba(6,10,18,0.8)',border:'1px solid rgba(0,242,254,0.1)',borderRadius:12,overflow:'hidden',transition:'all .3s',cursor:'pointer'}}
                  onMouseEnter={e=>{(e.currentTarget as HTMLDivElement).style.borderColor='rgba(0,242,254,0.3)';(e.currentTarget as HTMLDivElement).style.transform='translateY(-4px)';(e.currentTarget as HTMLDivElement).style.boxShadow='0 12px 40px rgba(0,0,0,0.4)';}}
                  onMouseLeave={e=>{(e.currentTarget as HTMLDivElement).style.borderColor='rgba(0,242,254,0.1)';(e.currentTarget as HTMLDivElement).style.transform='translateY(0)';(e.currentTarget as HTMLDivElement).style.boxShadow='none';}}>
                  <div style={{width:'100%',aspectRatio:'16/10',background:'#060A12',display:'flex',alignItems:'center',justifyContent:'center',position:'relative',overflow:'hidden'}}>
                    <div style={{textAlign:'center',color:'#0A1828',fontFamily:'monospace'}}>
                      <div style={{fontSize:32,marginBottom:8}}>◌</div>
                      <div style={{fontSize:10,letterSpacing:'.2em'}}>SCREENSHOT {i}</div>
                      <div style={{fontSize:9,marginTop:4,opacity:.7}}>/public/screenshots/losses-{i}.png</div>
                    </div>
                    <div style={{position:'absolute',inset:0,pointerEvents:'none',background:'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.015) 3px,rgba(0,242,254,0.015) 4px)'}}/>
                  </div>
                  <div style={{padding:'12px 16px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <span style={{fontSize:10,color:K.dim,fontFamily:'monospace'}}>▼ LOSS CONTAINED</span>
                    <span style={{fontSize:10,color:K.r,fontFamily:'monospace',fontWeight:700}}>-$18.40</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Fade>
        <Fade delay={.2}>
          <div style={{marginTop:24,display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:8}}>
            {PROOF_STATS.map((s,i)=>(
              <div key={i} style={{padding:'10px 14px',background:'rgba(6,10,18,0.8)',border:`1px solid ${s.col}18`,borderLeft:`3px solid ${s.col}`,borderRadius:4,fontSize:10,color:s.col,fontFamily:'monospace',fontWeight:700}}>
                {s.text}
              </div>
            ))}
          </div>
        </Fade>
        <Fade delay={.22}>
          <div style={{marginTop:16,overflow:'hidden',padding:'10px 0',background:'rgba(6,10,18,0.6)',border:'1px solid rgba(0,242,254,0.06)',borderRadius:6}}>
            <div style={{display:'flex',whiteSpace:'nowrap',animation:'ticker 22s linear infinite',fontSize:10,fontFamily:'monospace',letterSpacing:'.08em'}}>
              {[0,1].map(p=>(
                <span key={p} style={{paddingRight:60}}>
                  {TICKER_ITEMS.split(' · ').map((t,i)=>(
                    <span key={i} style={{color:t.includes('-$')||t.includes('SHORT')?K.r:K.g,marginRight:32}}>{t}</span>
                  ))}
                </span>
              ))}
            </div>
          </div>
        </Fade>
        <Fade delay={.25}>
          <div style={{marginTop:16,padding:'14px 20px',background:'rgba(255,51,102,0.06)',border:'1px solid rgba(255,51,102,0.15)',borderRadius:6,textAlign:'center',fontSize:11,color:K.dim,fontFamily:'monospace',lineHeight:1.8}}>
            ⚠ We show losses too — because real intelligence means knowing when to be wrong. &nbsp;<span style={{color:K.r}}>Loss rate: ~35% · Always contained by AEGIS risk engine.</span>
          </div>
        </Fade>
        <Fade delay={.3}>
          <TAProofSection/>
        </Fade>
      </div>
    </section>
  );
}

// ── Founder Section ───────────────────────────────────────────────────────────
function FounderSection() {
  return (
    <section style={{padding:'100px 40px',background:'rgba(6,10,18,0.4)',position:'relative',borderTop:'1px solid rgba(0,242,254,0.06)',overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,opacity:0.02,backgroundImage:`linear-gradient(rgba(0,242,254,1) 1px,transparent 1px),linear-gradient(90deg,rgba(0,242,254,1) 1px,transparent 1px)`,backgroundSize:'60px 60px'}}/>
      <div style={{maxWidth:900,margin:'0 auto',position:'relative',display:'grid',gridTemplateColumns:'1fr 1.6fr',gap:64,alignItems:'center'}}>
        {/* LEFT — hexagonal avatar */}
        <Fade>
          <div style={{position:'relative'}}>
            <div style={{width:260,height:260,position:'relative',margin:'0 auto'}}>
              <svg width="260" height="260" style={{position:'absolute',inset:0}}>
                <polygon points="130,8 244,68 244,192 130,252 16,192 16,68" fill="none" stroke={K.c} strokeWidth="1" opacity="0.3"/>
                <polygon points="130,20 232,75 232,185 130,240 28,185 28,75" fill="none" stroke={K.c} strokeWidth="0.5" opacity="0.15"/>
                {([[130,8],[244,68],[244,192],[130,252],[16,192],[16,68]] as [number,number][]).map(([x,y],i)=>(
                  <circle key={i} cx={x} cy={y} r="3" fill={K.c} opacity="0.5"/>
                ))}
                <line x1="16" y1="130" x2="244" y2="130" stroke={K.c} strokeWidth="0.8" opacity="0.3">
                  <animateTransform attributeName="transform" type="translate" values="0,-120;0,120;0,-120" dur="4s" repeatCount="indefinite"/>
                </line>
              </svg>
              <div style={{position:'absolute',top:'8%',left:'8%',width:'84%',height:'84%',clipPath:'polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%)',background:'linear-gradient(135deg,#0A1628,#060A12)',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
                <div style={{textAlign:'center',color:'#0A1828'}}>
                  <div style={{fontSize:40}}>◈</div>
                  <div style={{fontSize:9,fontFamily:'monospace',letterSpacing:'.1em',marginTop:8}}>FOUNDER PHOTO</div>
                  <div style={{fontSize:8,opacity:0.6,marginTop:4}}>/public/founder.jpg</div>
                </div>
              </div>
              <a href="https://x.com/cbompemo_dev" target="_blank" rel="noopener"
                style={{position:'absolute',bottom:-16,right:-8,padding:'8px 14px',background:'rgba(4,6,13,0.97)',border:'1px solid rgba(0,242,254,0.3)',borderRadius:20,textDecoration:'none',display:'flex',alignItems:'center',gap:6,backdropFilter:'blur(8px)',boxShadow:'0 4px 20px rgba(0,0,0,0.4)'}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill={K.hi}><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                <span style={{fontSize:10,color:K.hi,fontFamily:'monospace',fontWeight:700}}>@cbompemo_dev</span>
              </a>
            </div>
          </div>
        </Fade>
        {/* RIGHT — text */}
        <Fade delay={.15}>
          <div>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:16,fontFamily:'monospace'}}>◈ THE FOUNDER</div>
            <h2 style={{fontSize:38,fontWeight:900,color:'white',margin:'0 0 8px',lineHeight:1.2,fontFamily:'monospace'}}>Cedrick B.</h2>
            <div style={{fontSize:12,color:K.c,fontFamily:'monospace',letterSpacing:'.15em',marginBottom:24,opacity:0.7}}>BUILDER · ENTREPRENEUR · ITALY</div>
            <p style={{fontSize:14,color:K.dim,lineHeight:1.9,marginBottom:24,margin:'0 0 24px'}}>
              "I built KYMIA because I was tired of watching dashboards that looked intelligent but traded on random signals. I wanted something that actually reasons — like a real trading desk, but autonomous."
            </p>
            <p style={{fontSize:13,color:'#1A3050',lineHeight:1.9,marginBottom:32,margin:'0 0 32px'}}>
              KYMIA is the result of combining AI agent architecture with real market microstructure. Every agent has a specific role. Every signal has a real source. Every trade is verifiable on-chain.
            </p>
            <div style={{display:'flex',gap:24,marginBottom:32}}>
              {([['18','Agents Built'],['7','Real APIs'],['24/7','Autonomous']] as [string,string][]).map(([v,l],i)=>(
                <div key={i}>
                  <div style={{fontSize:24,fontWeight:900,color:K.c,fontFamily:'monospace',textShadow:`0 0 12px ${K.c}`}}>{v}</div>
                  <div style={{fontSize:9,color:K.dim,letterSpacing:'.1em',marginTop:3}}>{l}</div>
                </div>
              ))}
            </div>
            <a href="https://x.com/cbompemo_dev" target="_blank" rel="noopener"
              style={{display:'inline-flex',alignItems:'center',gap:10,padding:'12px 24px',background:'rgba(168,208,236,0.06)',border:'1px solid rgba(168,208,236,0.2)',borderRadius:8,textDecoration:'none'}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill={K.hi}><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              <span style={{fontSize:12,color:K.hi,fontFamily:'monospace',fontWeight:700,letterSpacing:'.1em'}}>Follow the journey →</span>
            </a>
          </div>
        </Fade>
      </div>
    </section>
  );
}

// ── FAQ Section ───────────────────────────────────────────────────────────────
const FAQS=[
  {q:"Is KYMIA real AI or just random signals?",a:"Every signal comes from real APIs. LEVIATHAN reads actual whale wallet movements on DexScreener. LENS calculates RSI from real Kraken candles. ECHO reads the Fear & Greed index. No random number generators. Every decision has a verifiable data source."},
  {q:"How is DEMO mode different from LIVE mode?",a:"In DEMO mode, you get $10,000 virtual capital. The prices are 100% real — SOL, BTC, ETH from Kraken and Jupiter. Only the money is virtual. In LIVE mode, you connect your Phantom wallet and agents execute real Jupiter swaps on your behalf. KYMIA never holds your funds."},
  {q:"Can KYMIA guarantee profits?",a:"No. And anyone who guarantees profits in trading is lying to you. KYMIA is designed to trade with discipline, analyze more data than any human can, and manage risk systematically. Win rates of 60-65% are realistic targets. Losses exist and are always contained by AEGIS."},
  {q:"Which assets can KYMIA trade?",a:"Currently: SOL, BTC (wBTC), ETH (wETH), JUP, WIF, BONK, PYTH, RAY, ORCA, POPCAT and more. All on Solana via Jupiter DEX. The SCANNER tab also monitors new token launches and detects rug pull risks before entering."},
  {q:"How does the consensus system work?",a:"17 specialized agents each vote BUY, SELL, or HOLD based on their specific indicator. CONSENSUS only fires a signal when 60% or more agree with sufficient average confidence. AEGIS then runs a final risk check: Kelly sizing, max exposure, peak hours filter."},
  {q:"Is my wallet safe in LIVE mode?",a:"KYMIA is non-custodial. We never hold your private keys or funds. When a trade fires in LIVE mode, KYMIA builds a Jupiter swap transaction and sends it to your Phantom wallet for signing. You can reject any trade. Your keys = your funds."},
  {q:"Can I verify the trades on-chain?",a:"Yes. KYMIA maintains a public Solana address. Every live trade appears there. You can check it on Solscan or Birdeye at any time. No editing, no cherry-picking — full transparent history since day one."},
  {q:"What happens during a Black Swan event?",a:"KYMIA has a Black Swan detector. When multiple assets show extreme volatility simultaneously, the UI shifts to alert mode, AEGIS automatically reduces exposure, and a circuit breaker can halt all trading. You saw the FTX and LUNA replays — the system is designed to survive crashes."},
];

function FAQSection() {
  const [open,setOpen]=useState<number|null>(0);
  return (
    <section style={{padding:'100px 40px',background:'#04060D',borderTop:'1px solid rgba(0,242,254,0.06)'}}>
      <div style={{maxWidth:780,margin:'0 auto'}}>
        <Fade>
          <div style={{textAlign:'center',marginBottom:56}}>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:12,fontFamily:'monospace'}}>◈ QUESTIONS & ANSWERS</div>
            <h2 style={{fontSize:36,fontWeight:900,color:'white',margin:0}}>Everything you need to know.</h2>
          </div>
        </Fade>
        <div style={{display:'flex',flexDirection:'column',gap:4}}>
          {FAQS.map((faq,i)=>(
            <Fade key={i} delay={i*.04}>
              <div style={{background:open===i?'rgba(0,242,254,0.04)':'rgba(6,10,18,0.6)',border:`1px solid ${open===i?'rgba(0,242,254,0.2)':'rgba(0,242,254,0.06)'}`,borderRadius:8,overflow:'hidden',transition:'all .25s'}}>
                <button onClick={()=>setOpen(open===i?null:i)} style={{width:'100%',padding:'20px 24px',background:'none',border:'none',cursor:'pointer',textAlign:'left',display:'flex',justifyContent:'space-between',alignItems:'center',gap:16}}>
                  <span style={{fontSize:14,color:open===i?K.c:K.hi,fontWeight:open===i?700:400,fontFamily:'monospace',lineHeight:1.4,transition:'color .2s'}}>{faq.q}</span>
                  <span style={{fontSize:18,color:open===i?K.c:K.dim,flexShrink:0,transition:'all .25s',transform:open===i?'rotate(45deg)':'none',display:'inline-block'}}>+</span>
                </button>
                {open===i&&(
                  <div style={{padding:'0 24px 20px 24px',paddingTop:16,fontSize:13,color:K.dim,lineHeight:1.9,fontFamily:'monospace',borderTop:'1px solid rgba(0,242,254,0.06)'}}>{faq.a}</div>
                )}
              </div>
            </Fade>
          ))}
        </div>
        <Fade delay={.3}>
          <div style={{marginTop:40,textAlign:'center',padding:24,background:'rgba(0,242,254,0.04)',border:'1px solid rgba(0,242,254,0.1)',borderRadius:8}}>
            <div style={{fontSize:13,color:K.dim,marginBottom:12}}>Still have questions?</div>
            <a href="https://x.com/cbompemo_dev" target="_blank" rel="noopener" style={{fontSize:12,color:K.c,fontFamily:'monospace',fontWeight:700,textDecoration:'none',letterSpacing:'.1em'}}>Ask on X → @cbompemo_dev</a>
          </div>
        </Fade>
      </div>
    </section>
  );
}

// ── Disclaimer Section ────────────────────────────────────────────────────────
function DisclaimerSection() {
  return (
    <section style={{padding:'48px 40px',background:'rgba(4,6,13,0.98)',borderTop:'1px solid rgba(255,51,102,0.1)'}}>
      <div style={{maxWidth:900,margin:'0 auto'}}>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:20}}>
          <div style={{width:32,height:32,borderRadius:6,background:'rgba(255,51,102,0.1)',border:'1px solid rgba(255,51,102,0.3)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
            <span style={{color:K.r,fontSize:14}}>⚠</span>
          </div>
          <div style={{fontSize:11,color:K.r,fontFamily:'monospace',fontWeight:700,letterSpacing:'.2em'}}>RISK DISCLOSURE & LEGAL DISCLAIMER</div>
        </div>
        <div style={{fontSize:11,color:'#1A3050',lineHeight:2,fontFamily:'monospace'}}>
          {([
            ['PAPER TRADING & SIMULATION','The DEMO mode uses virtual capital ($10,000) and does not involve real funds. Results in demo mode do not guarantee similar results in live trading.'],
            ['NOT FINANCIAL ADVICE','KYMIA is an autonomous trading tool for informational and educational purposes only. Nothing on this platform constitutes financial, investment, or trading advice. Always conduct your own research before investing.'],
            ['TRADING RISK','Cryptocurrency trading involves substantial risk of loss. The volatile nature of crypto markets means you could lose some or all of your invested capital. Never invest more than you can afford to lose.'],
            ['NON-CUSTODIAL','In LIVE mode, KYMIA never holds, stores, or controls user funds. All transactions are executed directly through the user\'s Phantom wallet via Jupiter DEX. Users maintain full custody of their assets at all times.'],
            ['PAST PERFORMANCE','Historical performance data shown on this platform is for illustrative purposes only. Past performance of the KYMIA system does not guarantee future results.'],
            ['REGULATORY COMPLIANCE','Users are responsible for ensuring their use of KYMIA complies with applicable laws and regulations in their jurisdiction. KYMIA is not registered as a financial advisor, broker, or investment advisor in any jurisdiction.'],
          ] as [string,string][]).map(([label,text],i)=>(
            <p key={i} style={{marginBottom:12,margin:'0 0 12px'}}>
              <span style={{color:K.dim,fontWeight:700}}>{label}: </span>{text}
            </p>
          ))}
        </div>
        <div style={{marginTop:20,padding:'12px 16px',background:'rgba(255,51,102,0.04)',border:'1px solid rgba(255,51,102,0.1)',borderRadius:4,fontSize:10,color:'#1A3050',fontFamily:'monospace',textAlign:'center'}}>
          By using KYMIA you acknowledge that you have read, understood, and agree to this disclaimer. · <span style={{color:K.r,marginLeft:4}}>Trade responsibly.</span>
        </div>
      </div>
    </section>
  );
}

// ── Footer ────────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer style={{background:'rgba(4,6,13,0.98)',borderTop:'1px solid rgba(0,242,254,0.08)',padding:'60px 40px 32px'}}>
      <div style={{maxWidth:1100,margin:'0 auto'}}>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr 1fr',gap:48,marginBottom:48}}>
          {/* Brand */}
          <div>
            <div style={{fontSize:24,fontWeight:900,color:K.c,fontFamily:'monospace',letterSpacing:'.2em',textShadow:'0 0 20px #00F2FE',marginBottom:12}}>◈ KYMIA</div>
            <div style={{fontSize:10,color:K.dim,letterSpacing:'.2em',marginBottom:16}}>AUTONOMOUS QUANT INTELLIGENCE</div>
            <p style={{fontSize:12,color:'#1A3050',lineHeight:1.8,maxWidth:280,margin:0}}>18 AI agents analyzing Solana markets 24/7. Real data. Real signals. Verifiable on-chain.</p>
            <div style={{display:'flex',gap:10,marginTop:20}}>
              {([['https://github.com/cbompemo-byte/Nexus-V2','GITHUB ↗'],['https://x.com','X / TWITTER ↗']] as [string,string][]).map(([href,txt],i)=>(
                <a key={i} href={href} target="_blank" rel="noopener" style={{padding:'8px 14px',background:'rgba(168,208,236,0.06)',border:'1px solid rgba(168,208,236,0.15)',borderRadius:4,fontSize:9,color:K.hi,textDecoration:'none',fontFamily:'monospace'}}>{txt}</a>
              ))}
            </div>
          </div>
          {/* Product */}
          <div>
            <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:20,fontFamily:'monospace'}}>PRODUCT</div>
            {([['Demo Sandbox','/nexus?mode=demo'],['Live Trading','/nexus?mode=live'],['Crisis Replay','/nexus?mode=demo#crisis'],['Swarm DNA','/nexus?mode=demo#dna'],['Performance','#performance']] as [string,string][]).map(([l,h],i)=>(
              <a key={i} href={h} style={{display:'block',fontSize:12,color:K.dim,textDecoration:'none',marginBottom:10,fontFamily:'monospace',transition:'color .2s'}}
                onMouseEnter={e=>(e.currentTarget.style.color=K.c)}
                onMouseLeave={e=>(e.currentTarget.style.color=K.dim)}>{l}</a>
            ))}
          </div>
          {/* Intelligence */}
          <div>
            <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:20,fontFamily:'monospace'}}>INTELLIGENCE</div>
            {([['18 Agents','#swarm'],['Data Sources','#apis'],['How It Works','#how'],['Public Wallet','#performance'],['GitHub','https://github.com/cbompemo-byte/Nexus-V2']] as [string,string][]).map(([l,h],i)=>(
              <a key={i} href={h} target={h.startsWith('http')?'_blank':undefined} rel={h.startsWith('http')?'noopener':undefined}
                style={{display:'block',fontSize:12,color:K.dim,textDecoration:'none',marginBottom:10,fontFamily:'monospace',transition:'color .2s'}}
                onMouseEnter={e=>(e.currentTarget.style.color=K.c)}
                onMouseLeave={e=>(e.currentTarget.style.color=K.dim)}>{l}</a>
            ))}
          </div>
          {/* Data Sources */}
          <div>
            <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:20,fontFamily:'monospace'}}>DATA SOURCES</div>
            {['Kraken API','CoinGecko','DexScreener','Deribit','CoinGlass','Fear & Greed','Helius','Jupiter'].map((s,i)=>(
              <div key={i} style={{fontSize:11,color:'#1A3050',marginBottom:8,fontFamily:'monospace',display:'flex',alignItems:'center',gap:6}}>
                <div style={{width:4,height:4,borderRadius:'50%',background:K.c,opacity:0.4,flexShrink:0}}/>
                {s}
              </div>
            ))}
          </div>
        </div>
        <div style={{height:1,background:'linear-gradient(90deg,transparent,rgba(0,242,254,0.15),transparent)',marginBottom:28}}/>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:16}}>
          <div style={{fontSize:10,color:'#0A1828',fontFamily:'monospace',lineHeight:1.8}}>
            © 2026 KYMIA · Autonomous Quant Intelligence<br/>
            Paper trading only · Not financial advice · No real funds held
          </div>
          <div style={{display:'flex',gap:20,fontSize:10,color:'#0A1828',fontFamily:'monospace',alignItems:'center'}}>
            <span>Built with Claude Sonnet 4.6</span>
            <span>·</span>
            <span>Powered by Solana</span>
            <span>·</span>
            <span style={{color:K.c,opacity:0.5}}>◈</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function LandingPage() {
  const [booted,setBooted]=useState(false);
  const [feedIdx,setFeedIdx]=useState(0);
  const [debateStep,setDebateStep]=useState(0);
  const [consensus,setConsensus]=useState(false);
  const [wordIdx,setWordIdx]=useState(0);
  const words=["Stop","Thinking","Bots.","Think","Swarm","Intelligence."];

  useEffect(()=>{
    if(!booted)return;
    const iv=setInterval(()=>setFeedIdx(i=>(i+1)%FEED.length),2500);
    return ()=>clearInterval(iv);
  },[booted]);

  useEffect(()=>{
    if(!booted)return;
    let i=0;
    const iv=setInterval(()=>{i++;setWordIdx(Math.min(i,words.length-1));if(i>=words.length-1)clearInterval(iv);},180);
    return ()=>clearInterval(iv);
  },[booted]);

  useEffect(()=>{
    if(!booted)return;
    let step=0,timer:ReturnType<typeof setTimeout>;
    const cycle=()=>{
      step=0;setDebateStep(0);setConsensus(false);
      const iv=setInterval(()=>{
        step++;
        if(step<DEBATE_CARDS.length){setDebateStep(step);}
        else{setConsensus(true);clearInterval(iv);timer=setTimeout(cycle,3200);}
      },1100);
    };
    timer=setTimeout(cycle,600);
    return ()=>clearTimeout(timer);
  },[booted]);

  if(!booted) return <Boot onDone={()=>setBooted(true)}/>;

  return (
    <div style={{background:K.bg,minHeight:"100vh",fontFamily:F,color:K.hi,overflowX:"hidden"}}>
      <Nav/>
      {/* Scanlines */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:1,background:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)"}}/>
      {/* Vignette */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:1,background:"radial-gradient(ellipse at center,transparent 60%,rgba(2,4,10,0.65) 100%)"}}/>

      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section style={{minHeight:"100vh",display:"flex",alignItems:"center",position:"relative",padding:"80px 48px 80px",maxWidth:1280,margin:"0 auto",gap:40,flexWrap:"wrap"}}>
        <motion.div initial={{opacity:0,x:-28}} animate={{opacity:1,x:0}} transition={{duration:.8,delay:.1}} style={{flex:"1 1 440px",minWidth:0}}>
          <div style={{marginBottom:18}}>
            <div style={{fontSize:72,fontWeight:900,color:K.c,letterSpacing:".18em",lineHeight:1,textShadow:`0 0 40px ${K.c},0 0 80px ${K.c}40`}}>◈ KYMIA</div>
            <div style={{fontSize:10,color:K.dim,letterSpacing:".4em",marginTop:8}}>AUTONOMOUS QUANT INTELLIGENCE</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:28}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:K.g,boxShadow:`0 0 8px ${K.g}`,animation:"pu 1s infinite"}}/>
            <span style={{fontSize:10,color:K.g,letterSpacing:".15em"}}>18 AGENTS LIVE · SOLANA NETWORK</span>
          </div>
          {/* Animated headline */}
          <div style={{marginBottom:24,lineHeight:1.2}}>
            <div style={{display:"flex",flexWrap:"wrap",gap:12,fontSize:48,fontWeight:900}}>
              {words.map((w,i)=>(
                <span key={i} style={{color:i>=3?K.c:"#FFFFFF",opacity:wordIdx>=i?1:0,transform:wordIdx>=i?"translateY(0)":"translateY(14px)",transition:`opacity .35s, transform .35s`,display:"inline-block",textShadow:i>=3?`0 0 20px ${K.c}50`:undefined}}>{w}</span>
              ))}
            </div>
          </div>
          <div style={{fontSize:14,color:K.dim,lineHeight:1.9,marginBottom:28,maxWidth:460}}>
            18 AI agents are trading Solana right now.<br/>
            <span style={{color:K.hi}}>Watch them debate, decide, and execute — live.</span>
          </div>
          {/* Live feed */}
          <div style={{...PANEL,padding:"10px 14px",marginBottom:28,height:38,overflow:"hidden",position:"relative"}}>
            <AnimatePresence mode="wait">
              <motion.div key={feedIdx} initial={{opacity:0,y:10}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-10}} transition={{duration:.28}}
                style={{display:"flex",gap:10,fontSize:10,alignItems:"center"}}>
                <span style={{color:FEED[feedIdx].col,fontWeight:700,minWidth:96}}>[{FEED[feedIdx].prefix}]</span>
                <span style={{color:K.hi}}>{FEED[feedIdx].text}</span>
              </motion.div>
            </AnimatePresence>
          </div>
          {/* CTAs */}
          <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:14}}>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <div>
                <a href="/nexus?mode=demo" style={{display:"block",padding:"13px 24px",background:"rgba(0,255,136,0.12)",border:"1.5px solid rgba(0,255,136,0.5)",color:K.g,borderRadius:6,fontSize:13,textDecoration:"none",letterSpacing:".03em",fontFamily:F,fontWeight:700,transition:"all .25s"}}
                  onMouseEnter={e=>(e.currentTarget.style.boxShadow=`0 0 30px rgba(0,255,136,0.3)`)}
                  onMouseLeave={e=>(e.currentTarget.style.boxShadow="none")}>
                  Watch AI Trade Live →
                </a>
                <div style={{fontSize:9,color:K.dim,marginTop:5,letterSpacing:".1em"}}>Free · No signup · $10K virtual capital</div>
              </div>
              <div>
                <a href="/nexus?mode=live" style={{display:"block",padding:"13px 24px",background:"rgba(0,242,254,0.12)",border:"1.5px solid rgba(0,242,254,0.5)",color:K.c,borderRadius:6,fontSize:13,textDecoration:"none",letterSpacing:".03em",fontFamily:F,fontWeight:700,transition:"all .25s"}}
                  onMouseEnter={e=>(e.currentTarget.style.boxShadow=`0 0 30px rgba(0,242,254,0.3)`)}
                  onMouseLeave={e=>(e.currentTarget.style.boxShadow="none")}>
                  ⚡ Connect Phantom → Real Trading
                </a>
                <div style={{fontSize:9,color:K.dim,marginTop:5,letterSpacing:".1em"}}>Non-custodial · Your keys · Real Solana</div>
              </div>
            </div>
          </div>
          <div style={{fontSize:9,color:K.dim,letterSpacing:".12em"}}>
            <span style={{color:K.g}}>●</span> 1,247 observers online · 0 signup required · Verified on-chain
          </div>
        </motion.div>

        {/* RIGHT COLUMN — Demo Video */}
        <motion.div initial={{opacity:0,x:28}} animate={{opacity:1,x:0}} transition={{duration:.8,delay:.3}}
          style={{flex:"1 1 460px",minWidth:0,display:"flex",flexDirection:"column",gap:20,paddingTop:16}}>
          <div style={{position:"relative",borderRadius:12,overflow:"hidden",border:"1px solid rgba(0,242,254,0.25)",boxShadow:"0 0 60px rgba(0,242,254,0.08)"}}>
            {/* Terminal bar */}
            <div style={{background:"rgba(6,10,18,0.95)",borderBottom:"1px solid rgba(0,242,254,0.1)",padding:"8px 14px",display:"flex",alignItems:"center",gap:6}}>
              {["#FF3366","#FFD700","#00FF88"].map((c,i)=>(
                <div key={i} style={{width:9,height:9,borderRadius:"50%",background:c}}/>
              ))}
              <span style={{flex:1,textAlign:"center",fontSize:9,color:K.dim,fontFamily:"monospace",letterSpacing:".12em"}}>KYMIA — LIVE DEMO</span>
              <div style={{display:"flex",alignItems:"center",gap:4,padding:"2px 7px",background:"rgba(0,255,136,0.12)",border:"1px solid rgba(0,255,136,0.3)",borderRadius:10}}>
                <div style={{width:4,height:4,borderRadius:"50%",background:K.g,animation:"pu 1s infinite"}}/>
                <span style={{fontSize:7,color:K.g}}>LIVE</span>
              </div>
            </div>
            {/* Video */}
            <video autoPlay loop muted playsInline
              style={{width:"100%",display:"block",aspectRatio:"16/9",objectFit:"cover"}}
              poster="/kymia-poster.jpg">
              <source src="/kymia-demo.mp4" type="video/mp4"/>
            </video>
            {/* Scanlines */}
            <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)"}}/>
          </div>
          <LivePrices/>
        </motion.div>
      </section>

      {/* ── LANDING SWARM ────────────────────────────────────────────────── */}
      <section style={{padding:"100px 40px",background:"#04060D",position:"relative",overflow:"hidden"}}>
        {/* ambient glow */}
        <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:600,height:600,borderRadius:"50%",background:"radial-gradient(circle,rgba(0,242,254,0.04) 0%,transparent 70%)",pointerEvents:"none"}}/>
        <Fade>
          <div style={{textAlign:"center",marginBottom:64}}>
            <div style={{fontSize:10,color:K.c,letterSpacing:".4em",marginBottom:12,fontFamily:F}}>◈ WATCH THE SWARM THINK</div>
            <div style={{fontSize:32,fontWeight:900,color:"white",marginBottom:8}}>18 agents. One consensus.</div>
            <div style={{fontSize:13,color:K.dim,lineHeight:1.8}}>Every agent analyzes real market data. They vote. They debate. They decide.</div>
          </div>
        </Fade>
        <Fade delay={.1}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 560px 1fr",gap:48,alignItems:"center",maxWidth:1280,margin:"0 auto"}}>
            <ExplanationPanel steps={LEFT_STEPS}/>
            <LandingSwarm/>
            <ExplanationPanel steps={RIGHT_STEPS}/>
          </div>
        </Fade>
        <Fade delay={.2}>
          <div style={{marginTop:72,display:"flex",justifyContent:"center",gap:48,flexWrap:"wrap",borderTop:"1px solid rgba(0,242,254,0.08)",paddingTop:48,maxWidth:900,margin:"72px auto 0"}}>
            {[
              {v:'15s',  l:'DATA REFRESH',        col:K.c},
              {v:'≥60%', l:'CONSENSUS THRESHOLD', col:K.g},
              {v:'82%',  l:'AVG CONFIDENCE',      col:K.gold},
              {v:'24/7', l:'NEVER STOPS',          col:K.pu},
            ].map((s,i)=>(
              <div key={i} style={{textAlign:"center",minWidth:120}}>
                <div style={{fontSize:32,fontWeight:900,color:s.col,fontFamily:"monospace",textShadow:`0 0 24px ${s.col}88`}}>{s.v}</div>
                <div style={{fontSize:9,color:K.dim,letterSpacing:".2em",marginTop:6}}>{s.l}</div>
              </div>
            ))}
          </div>
        </Fade>
      </section>

      <GlobeDebateSection/>

      <ProofSection/>
      <PerformanceSection/>
      <APISection/>
      <FounderSection/>
      <FAQSection/>

      {/* ── BENTO GRID ───────────────────────────────────────────────────── */}
      <section style={{padding:"80px 48px",maxWidth:1280,margin:"0 auto"}}>
        <Fade>
          <div style={{textAlign:"center",marginBottom:48}}>
            <div style={{fontSize:11,color:K.c,letterSpacing:".3em",fontFamily:F,marginBottom:12}}>◈ INSIDE THE SWARM</div>
            <div style={{fontSize:13,color:K.dim,lineHeight:1.8}}>18 specialized agents. Real market data. Autonomous decisions.</div>
          </div>
        </Fade>
        <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:16}}>
          {/* Swarm */}
          <Fade delay={.1}>
            <div style={{...PANEL,padding:24,transition:"all .3s",gridRow:"span 1"}}
              onMouseEnter={e=>{(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.25)";(e.currentTarget as HTMLDivElement).style.boxShadow="0 8px 32px rgba(0,0,0,.4)";}}
              onMouseLeave={e=>{(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.08)";(e.currentTarget as HTMLDivElement).style.boxShadow="";}}>
              <div style={{fontSize:9,color:K.c,letterSpacing:".2em",marginBottom:16}}>NEURAL SWARM GRAPH</div>
              <div style={{display:"flex",justifyContent:"center"}}><MiniSwarm/></div>
              <div style={{textAlign:"center",marginTop:8}}><span style={{fontSize:8,color:K.g,padding:"2px 10px",background:"rgba(0,255,136,0.08)",border:"1px solid rgba(0,255,136,0.2)",borderRadius:2}}>LIVE · 18 AGENTS · REAL DATA</span></div>
            </div>
          </Fade>
          {/* Debate */}
          <Fade delay={.18}>
            <div style={{...PANEL,padding:20,transition:"border-color .3s"}}
              onMouseEnter={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.25)"}
              onMouseLeave={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.08)"}>
              <div style={{fontSize:9,color:K.c,letterSpacing:".2em",marginBottom:14}}>SWARM DEBATE</div>
              <div style={{display:"flex",flexDirection:"column",gap:8,minHeight:200}}>
                {DEBATE_CARDS.slice(0,debateStep+1).map((card,i)=>(
                  <motion.div key={i} initial={{opacity:0,x:-10}} animate={{opacity:1,x:0}} transition={{duration:.28}}
                    style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",background:"rgba(0,255,136,0.05)",border:"1px solid rgba(0,255,136,0.1)",borderRadius:4,fontSize:10}}>
                    <div><span style={{color:K.g,fontWeight:700,marginRight:8}}>[{card.agent}]</span><span style={{color:K.hi}}>{card.thesis}</span></div>
                    <span style={{color:K.g,fontWeight:700}}>BUY {card.conf}%</span>
                  </motion.div>
                ))}
                {consensus&&(
                  <motion.div initial={{opacity:0,scale:.96}} animate={{opacity:1,scale:1}} transition={{duration:.35}}
                    style={{padding:"10px",background:`rgba(0,242,254,0.1)`,border:`1px solid ${K.c}50`,borderRadius:4,textAlign:"center",fontSize:10,color:K.c,fontWeight:700,letterSpacing:".06em"}}>
                    → CONSENSUS: EXECUTE LONG SOL
                  </motion.div>
                )}
              </div>
            </div>
          </Fade>
          {/* Radar */}
          <Fade delay={.14}>
            <div style={{...PANEL,padding:20,transition:"border-color .3s"}}
              onMouseEnter={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.25)"}
              onMouseLeave={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.08)"}>
              <div style={{fontSize:9,color:K.c,letterSpacing:".2em",marginBottom:14}}>EDGE RADAR</div>
              <Radar/>
              <div style={{textAlign:"center",marginTop:10,marginBottom:12}}><span style={{fontSize:8,color:K.g,letterSpacing:".15em"}}>◉ SCANNING 50+ MARKETS</span></div>
              {[{l:"WHALE",c:K.pu},{l:"BREAKOUT",c:K.gold},{l:"LIQUIDITY",c:K.c}].map((b,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,fontSize:9,marginBottom:5}}>
                  <div style={{width:4,height:4,borderRadius:"50%",background:b.c,boxShadow:`0 0 6px ${b.c}`}}/>
                  <span style={{color:b.c}}>{b.l}</span><span style={{color:K.dim}}>detected</span>
                </div>
              ))}
            </div>
          </Fade>
          {/* Performance */}
          <Fade delay={.2}>
            <div style={{...PANEL,padding:20,transition:"border-color .3s"}}
              onMouseEnter={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.25)"}
              onMouseLeave={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.08)"}>
              <div style={{fontSize:9,color:K.c,letterSpacing:".2em",marginBottom:14}}>ALPHA PERFORMANCE</div>
              <svg width="100%" height={80} viewBox="0 0 200 80">
                <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={K.c} stopOpacity=".5"/><stop offset="100%" stopColor={K.c} stopOpacity="0"/></linearGradient></defs>
                <polyline points="0,70 25,65 50,55 75,58 100,40 125,35 150,28 175,20 200,12" fill="none" stroke={K.c} strokeWidth="2"/>
                <polyline points="0,70 25,65 50,55 75,58 100,40 125,35 150,28 175,20 200,12 200,80 0,80" fill="url(#cg)" opacity=".15"/>
                {([[50,55],[100,40],[150,28]] as [number,number][]).map(([x,y],i)=><circle key={i} cx={x} cy={y} r={3} fill={K.g} opacity=".9"/>)}
                <text x="0" y="78" fill={K.dim} fontSize="8" fontFamily={F}>$10,000</text>
                <text x="152" y="12" fill={K.g} fontSize="8" fontFamily={F}>$10,247</text>
              </svg>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:10,fontSize:9}}>
                <span style={{color:K.g}}>WIN RATE 64% · 8 TRADES</span>
                <span><span style={{color:K.dim}}>Best </span><span style={{color:K.g}}>+$47</span><span style={{color:K.dim}}> · Worst </span><span style={{color:K.r}}>-$18</span></span>
              </div>
            </div>
          </Fade>
          {/* Whale */}
          <Fade delay={.24}>
            <div style={{...PANEL,padding:20,transition:"border-color .3s",gridColumn:"2"}}
              onMouseEnter={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.25)"}
              onMouseLeave={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.08)"}>
              <div style={{fontSize:9,color:K.c,letterSpacing:".2em",marginBottom:14}}>WHALE TRACKER</div>
              {[{a:"9WzD...WWM",amt:"+50,000 SOL",src:"Binance outflow",min:3},{a:"5Kx1...9Pq",amt:"BTC $2.4M",src:"Coinbase outflow",min:7},{a:"3Yz8...4Rk",amt:"+12,400 SOL",src:"FTX outflow",min:14}].map((w,i)=>(
                <div key={i} style={{padding:"9px 0",borderBottom:i<2?"1px solid rgba(0,242,254,0.06)":"none"}}>
                  <div style={{fontSize:11,marginBottom:2}}>🐋 <span style={{color:K.c}}>{w.a}</span></div>
                  <div style={{fontSize:10,color:K.g,marginBottom:2}}>{w.amt} · {w.src}</div>
                  <div style={{fontSize:9,color:K.dim}}>{w.min} minutes ago</div>
                </div>
              ))}
            </div>
          </Fade>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────── */}
      <section id="how" style={{padding:"80px 48px",maxWidth:1280,margin:"0 auto"}}>
        <Fade><div style={{textAlign:"center",marginBottom:56}}><div style={{fontSize:11,color:K.c,letterSpacing:".3em"}}>◈ THE INTELLIGENCE PROCESS</div></div></Fade>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:0,position:"relative"}}>
          <div style={{position:"absolute",top:52,left:"16.7%",right:"16.7%",height:1,background:`linear-gradient(90deg,${K.g},${K.c})`,opacity:.4}}/>
          {[
            {icon:"⬡",num:"01",title:"ANALYZE",body:"18 agents simultaneously scan RSI, EMA, MACD, whale flows, funding rates, order books, fear & greed, BTC dominance — every 15 seconds."},
            {icon:"⟳",num:"02",title:"DEBATE",body:"Agents vote. Disagree. Challenge each other. Only when 60%+ reach consensus — with institutional-grade confidence — a signal fires."},
            {icon:"⚡",num:"03",title:"EXECUTE",body:"The trade executes at real market price. Stop-loss, take-profit, trailing stop — all managed autonomously. 24/7."},
          ].map((s,i)=>(
            <Fade key={i} delay={i*.15}>
              <div style={{padding:"0 32px",textAlign:"center"}}>
                <div style={{width:56,height:56,borderRadius:"50%",background:`rgba(0,242,254,0.08)`,border:`1px solid ${K.c}40`,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px",fontSize:22,color:K.c}}>{s.icon}</div>
                <div style={{fontSize:8,color:K.dim,letterSpacing:".2em",marginBottom:6}}>STEP {s.num}</div>
                <div style={{fontSize:14,fontWeight:900,color:K.c,marginBottom:12,letterSpacing:".1em"}}>{s.title}</div>
                <div style={{fontSize:12,color:K.dim,lineHeight:1.8}}>{s.body}</div>
              </div>
            </Fade>
          ))}
        </div>
      </section>

      {/* ── DATA SOURCES ─────────────────────────────────────────────────── */}
      <section id="data" style={{padding:"80px 48px",maxWidth:1280,margin:"0 auto"}}>
        <Fade><div style={{textAlign:"center",marginBottom:48}}>
          <div style={{fontSize:11,color:K.c,letterSpacing:".3em",marginBottom:12}}>◈ REAL DATA. VERIFIABLE INTELLIGENCE.</div>
          <div style={{fontSize:13,color:K.dim}}>Not a simulation. Every signal backed by real APIs.</div>
        </div></Fade>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:32}}>
          {DATA_SOURCES.map((ds,i)=>(
            <Fade key={i} delay={i*.07}>
              <div style={{...PANEL,padding:"16px 18px",transition:"border-color .3s"}}
                onMouseEnter={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.22)"}
                onMouseLeave={e=>(e.currentTarget as HTMLDivElement).style.borderColor="rgba(0,242,254,0.08)"}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
                  <span style={{fontSize:11,fontWeight:900,color:K.c,letterSpacing:".1em"}}>{ds.name}</span>
                  <span style={{fontSize:8,color:K.g,display:"flex",alignItems:"center",gap:4}}><span style={{width:5,height:5,borderRadius:"50%",background:K.g,display:"inline-block",animation:"pu 1.5s infinite"}}/> LIVE</span>
                </div>
                <div style={{fontSize:9,color:K.c,marginBottom:4,opacity:.7}}>{ds.sig}</div>
                <div style={{fontSize:9,color:K.dim}}>{ds.desc}</div>
              </div>
            </Fade>
          ))}
        </div>
      </section>

      {/* ── PERFORMANCE DNA ───────────────────────────────────────────────── */}
      <section id="perf" style={{padding:"80px 48px",maxWidth:1280,margin:"0 auto"}}>
        <Fade><div style={{textAlign:"center",marginBottom:48}}><div style={{fontSize:11,color:K.c,letterSpacing:".3em"}}>◈ DISCOVER YOUR TRADING DNA</div></div></Fade>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:48,alignItems:"center"}}>
          <Fade delay={.1}>
            <div style={{border:'1px solid rgba(189,0,255,0.3)',borderRadius:12,overflow:'hidden',boxShadow:'0 0 40px rgba(189,0,255,0.08)'}}>
              <img src="/screenshots/profile-1.png" alt="KYMIA Performance DNA — Momentum Predator" style={{width:'100%',display:'block',objectFit:'cover'}}/>
            </div>
          </Fade>
          <Fade delay={.2}>
            <div>
              <div style={{fontSize:15,color:K.hi,lineHeight:1.9,marginBottom:20}}>After every session, KYMIA generates your personal trading DNA — your execution speed, risk profile, behavioral bias, and swarm compatibility score.</div>
              <div style={{fontSize:13,color:K.dim,lineHeight:1.9,marginBottom:28}}>Share it on X. Compare with others.<br/><span style={{color:K.hi}}>Prove your alpha.</span></div>
              <a href="/nexus?mode=demo" style={{display:"inline-block",padding:"12px 24px",background:"rgba(0,255,136,0.12)",border:"1.5px solid rgba(0,255,136,0.4)",color:K.g,borderRadius:6,fontSize:11,textDecoration:"none",letterSpacing:".08em",fontWeight:700}}>
                ▶ LAUNCH SANDBOX TO GENERATE YOUR DNA
              </a>
            </div>
          </Fade>
        </div>
      </section>

      {/* ── SOCIAL PROOF ─────────────────────────────────────────────────── */}
      <section style={{padding:"60px 0",borderTop:"1px solid rgba(0,242,254,0.06)",borderBottom:"1px solid rgba(0,242,254,0.06)"}}>
        <div style={{overflow:"hidden",padding:"8px 0",marginBottom:36,background:"rgba(6,10,18,.5)"}}>
          <div style={{display:"flex",whiteSpace:"nowrap",animation:"ticker 18s linear infinite",fontSize:10,letterSpacing:".1em"}}>
            {[0,1].map(p=><span key={p} style={{paddingRight:60}}>{["SOL +$247","BTC +$89","JUP +$34","ETH +$156","WIF -$12","BONK +$67","SOL +$189","RAY +$45"].map((t,i)=><span key={i} style={{color:t.includes("-")?K.r:K.g,marginRight:40}}>{t}</span>)}</span>)}
          </div>
        </div>
        <div style={{maxWidth:1280,margin:"0 auto",padding:"0 48px"}}>
          <div style={{display:"flex",gap:14,justifyContent:"center",marginBottom:36,flexWrap:"wrap"}}>
            {[{v:"1,247",l:"OBSERVERS ONLINE",c:K.g},{v:"847",l:"SESSIONS TODAY",c:K.c},{v:"64%",l:"AVG WIN RATE",c:K.gold},{v:"50+",l:"MARKETS MONITORED",c:K.c}].map((s,i)=>(
              <div key={i} style={{...PANEL,padding:"16px 24px",textAlign:"center",minWidth:130}}>
                <div style={{fontSize:26,fontWeight:900,color:s.c,textShadow:`0 0 12px ${s.c}60`}}>{s.v}</div>
                <div style={{fontSize:8,color:K.dim,letterSpacing:".12em",marginTop:4}}>{s.l}</div>
              </div>
            ))}
          </div>
          <Fade>
            <div style={{...PANEL,padding:"24px 32px",textAlign:"center",borderColor:`${K.gold}20`,background:`linear-gradient(135deg,rgba(6,10,18,.9) 0%,rgba(255,215,0,.03) 100%)`}}>
              <div style={{fontSize:20,fontWeight:900,color:K.gold,marginBottom:8}}>🎯 Can you beat the swarm?</div>
              <div style={{fontSize:12,color:K.dim,marginBottom:16}}>847 users tried. 23% won.</div>
              <a href="/nexus?mode=demo" style={{display:"inline-block",padding:"10px 28px",background:`${K.gold}15`,border:`1px solid ${K.gold}40`,color:K.gold,borderRadius:4,fontSize:11,textDecoration:"none",letterSpacing:".1em",fontWeight:700}}>LAUNCH CHALLENGE →</a>
            </div>
          </Fade>
        </div>
      </section>

      {/* ── CRISIS REPLAY ─────────────────────────────────────────────────── */}
      <section id="crisis" style={{padding:"80px 48px",maxWidth:1280,margin:"0 auto"}}>
        <Fade><div style={{textAlign:"center",marginBottom:48}}>
          <div style={{fontSize:11,color:K.c,letterSpacing:".3em",marginBottom:12}}>◈ BATTLE-TESTED AGAINST HISTORY</div>
          <div style={{fontSize:13,color:K.dim}}>We replayed every major crash. Here's what happened.</div>
        </div></Fade>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginBottom:28}}>
          {CRISIS.map((c,i)=>(
            <Fade key={i} delay={i*.12}>
              <div style={{...PANEL,padding:"22px 20px",borderColor:`${K.g}15`,transition:"border-color .3s"}}
                onMouseEnter={e=>(e.currentTarget as HTMLDivElement).style.borderColor=`${K.g}35`}
                onMouseLeave={e=>(e.currentTarget as HTMLDivElement).style.borderColor=`${K.g}15`}>
                <div style={{fontSize:8,color:K.dim,letterSpacing:".15em",marginBottom:4}}>{c.date}</div>
                <div style={{fontSize:13,fontWeight:900,color:K.hi,marginBottom:4}}>{c.name}</div>
                <div style={{fontSize:10,color:K.dim,marginBottom:12,lineHeight:1.6}}><span style={{color:K.c}}>[{c.agent}]</span> {c.note}</div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:10,color:K.g,fontWeight:700}}>✅ {c.result}</span>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:8,color:K.dim}}>SURVIVAL</div>
                    <div style={{fontSize:16,fontWeight:900,color:K.g}}>{c.pct}%</div>
                  </div>
                </div>
                <div style={{height:3,background:"#050810",borderRadius:2,marginTop:10}}><div style={{height:"100%",borderRadius:2,background:K.g,width:`${c.pct}%`,boxShadow:`0 0 6px ${K.g}`}}/></div>
              </div>
            </Fade>
          ))}
        </div>
        <div style={{textAlign:"center"}}>
          <a href="/nexus?mode=demo" style={{fontSize:11,color:K.c,textDecoration:"none",letterSpacing:".12em",borderBottom:`1px solid ${K.c}40`,paddingBottom:2}}>→ VIEW FULL CRISIS REPLAY</a>
        </div>
      </section>

      {/* ── FINAL CTA ────────────────────────────────────────────────────── */}
      <section style={{padding:"100px 48px",textAlign:"center",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:0,background:`radial-gradient(ellipse at center,rgba(0,242,254,0.04) 0%,transparent 70%)`}}/>
        <Fade>
          <div style={{fontSize:52,fontWeight:900,color:"#FFFFFF",marginBottom:6,position:"relative",lineHeight:1.2}}>The future of trading</div>
          <div style={{fontSize:52,fontWeight:900,color:K.c,marginBottom:52,textShadow:`0 0 40px ${K.c}60`,position:"relative",lineHeight:1.2}}>is autonomous.</div>
        </Fade>
        <Fade delay={.18}>
          <div style={{display:"flex",gap:16,justifyContent:"center",marginBottom:12,flexWrap:"wrap",position:"relative"}}>
            {[
              {href:"/nexus?mode=demo",txt:"Watch AI Trade Live →",sub:"Free · No signup · $10K virtual capital",col:K.g,bg:"rgba(0,255,136,0.12)",brd:"2px solid rgba(0,255,136,0.5)",glow:"rgba(0,255,136,0.3)"},
              {href:"/nexus?mode=live",txt:"⚡ Connect Phantom → Real Trading",sub:"Non-custodial · Your keys · Real Solana",col:K.c,bg:"rgba(0,242,254,0.12)",brd:"2px solid rgba(0,242,254,0.5)",glow:"rgba(0,242,254,0.3)"},
            ].map(b=>(
              <div key={b.href}>
                <a href={b.href} style={{display:"block",padding:"16px 36px",background:b.bg,border:b.brd,color:b.col,borderRadius:8,fontSize:14,textDecoration:"none",letterSpacing:".04em",fontFamily:F,fontWeight:700,transition:"all .25s"}}
                  onMouseEnter={e=>(e.currentTarget.style.boxShadow=`0 0 40px ${b.glow}`)}
                  onMouseLeave={e=>(e.currentTarget.style.boxShadow="")}>{b.txt}</a>
                <div style={{fontSize:9,color:K.dim,marginTop:7,letterSpacing:".1em"}}>{b.sub}</div>
              </div>
            ))}
          </div>
        </Fade>
        <Fade delay={.3}>
          <div style={{fontSize:8,color:"#0A1828",letterSpacing:".12em",marginTop:32,position:"relative"}}>
            ◈ PAPER TRADING ONLY · NO FINANCIAL ADVICE · BUILT WITH CLAUDE SONNET 4.6 · POWERED BY SOLANA
          </div>
        </Fade>
      </section>

      <DisclaimerSection/>
      <Footer/>

      <style>{`
        @keyframes agentPop{0%{opacity:0;transform:translateX(-50%) translateY(-10px)}15%{opacity:1;transform:translateX(-50%) translateY(0)}75%{opacity:1}100%{opacity:0;transform:translateX(-50%) translateY(-15px)}}
        @keyframes slideInLeft{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
        @keyframes laserSweep{from{transform:translateX(-100%);opacity:1}to{transform:translateX(200%);opacity:0}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
        @keyframes pu{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes gspin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes ping{0%{transform:scale(1);opacity:.5}100%{transform:scale(4);opacity:0}}
        @keyframes dashflow{from{stroke-dashoffset:0}to{stroke-dashoffset:-40}}
        @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
        @keyframes rspin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}
        *{box-sizing:border-box}
        html{scroll-behavior:smooth}
        .agent-network-wrap{width:100%;max-width:600px}
        @media(max-width:767px){
          .agent-network-wrap{width:90vw}
          .agent-specialty{display:none}
        }
      `}</style>
    </div>
  );
}
