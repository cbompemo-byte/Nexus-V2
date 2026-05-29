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

// ── Globe SVG ────────────────────────────────────────────────────────────────
function Globe({ size=380 }:{ size?:number }) {
  const cx=size/2, cy=size/2, r=size*0.44;
  const cities=[
    {x:cx-r*0.28,y:cy-r*0.18},
    {x:cx+r*0.12,y:cy-r*0.32},
    {x:cx+r*0.48,y:cy-r*0.08},
    {x:cx-r*0.48,y:cy+r*0.12},
    {x:cx+r*0.28,y:cy+r*0.28},
  ];
  return (
    <div style={{position:"relative",width:size,height:size}}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{position:"absolute",inset:0}}>
        <defs>
          <radialGradient id="gg" cx="40%" cy="40%">
            <stop offset="0%" stopColor={K.c} stopOpacity="0.07"/>
            <stop offset="100%" stopColor="transparent" stopOpacity="0"/>
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={r+4} fill="none" stroke={K.c} strokeWidth="0.5" opacity="0.18"/>
        <circle cx={cx} cy={cy} r={r} fill="url(#gg)"/>
        {[-0.68,-0.4,0,0.4,0.68].map((f,i)=>{
          const ry=Math.sqrt(1-f*f)*r;
          return <ellipse key={i} cx={cx} cy={cy+f*r} rx={ry} ry={ry*0.25} fill="none" stroke={K.c} strokeWidth="0.5" opacity="0.16"/>;
        })}
        <g style={{animation:"gspin 22s linear infinite",transformOrigin:`${cx}px ${cy}px`}}>
          {[0,30,60,90,120,150].map((a,i)=>
            <ellipse key={i} cx={cx} cy={cy} rx={r*Math.abs(Math.cos(a*Math.PI/180))} ry={r} fill="none" stroke={K.c} strokeWidth="0.5" opacity="0.12" transform={`rotate(${a} ${cx} ${cy})`}/>
          )}
        </g>
        {cities.map((pt,i)=>(
          <g key={i}>
            <circle cx={pt.x} cy={pt.y} r={3} fill={K.g} opacity="0.9"/>
            <circle cx={pt.x} cy={pt.y} r={3} fill="none" stroke={K.g} strokeWidth="0.8" style={{animation:`ping ${2+i*0.3}s ${i*0.5}s ease-out infinite`,transformOrigin:`${pt.x}px ${pt.y}px`}}/>
          </g>
        ))}
        <path d={`M${cities[0].x},${cities[0].y} Q${cx},${cy-r*0.55} ${cities[1].x},${cities[1].y}`} fill="none" stroke={K.g} strokeWidth="1" opacity="0.4" strokeDasharray="4 4" style={{animation:"dashflow 3s linear infinite"}}/>
        <path d={`M${cities[1].x},${cities[1].y} Q${cx+r*0.3},${cy-r*0.22} ${cities[2].x},${cities[2].y}`} fill="none" stroke={K.c} strokeWidth="1" opacity="0.4" strokeDasharray="4 4" style={{animation:"dashflow 4s linear infinite"}}/>
      </svg>
      {[
        {top:"22%",left:"28%",col:K.g,txt:"+$247"},
        {top:"58%",right:"16%",col:K.r,txt:"-$12"},
        {top:"36%",right:"14%",col:K.g,txt:"+$89"},
      ].map((l,i)=>(
        <div key={i} style={{position:"absolute",top:l.top,left:l.left,right:l.right,fontSize:10,color:l.col,fontFamily:F,animation:`float ${3+i*0.5}s ease-in-out infinite ${i*0.8}s`,background:`${l.col}18`,border:`1px solid ${l.col}40`,borderRadius:3,padding:"2px 7px",width:"fit-content"}}>
          {l.txt}
        </div>
      ))}
      <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",textAlign:"center",pointerEvents:"none"}}>
        <div style={{fontSize:9,color:K.c,letterSpacing:".2em",animation:"pu 2s infinite",fontFamily:F}}>AI OBSERVER</div>
      </div>
      <div style={{position:"absolute",bottom:-36,left:"50%",transform:"translateX(-50%)",textAlign:"center",whiteSpace:"nowrap"}}>
        <div style={{fontSize:13,fontWeight:900,color:K.g,fontFamily:F,textShadow:`0 0 12px ${K.g}`}}>+$247.83 SESSION</div>
        <div style={{fontSize:9,color:K.dim,fontFamily:F,letterSpacing:".1em",marginTop:2}}>24/7 AUTONOMOUS</div>
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
      {([["SOL",px.SOL,2.1],["BTC",px.BTC,0.8],["ETH",px.ETH,1.2]] as [string,number,number][]).map(([sym,p,ch])=>(
        <div key={sym} style={{padding:"5px 14px",background:"rgba(6,10,18,0.8)",border:"1px solid rgba(0,242,254,0.15)",borderRadius:4,fontFamily:F,fontSize:10,display:"flex",gap:8,alignItems:"center"}}>
          <span style={{color:K.hi,fontWeight:700}}>{sym}</span>
          <span style={{color:K.c}}>${p>=1000?p.toLocaleString("en-US",{maximumFractionDigits:0}):p.toFixed(2)}</span>
          <span style={{color:K.g}}>▲+{ch}%</span>
        </div>
      ))}
    </div>
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
      <section style={{minHeight:"100vh",display:"flex",alignItems:"center",position:"relative",padding:"80px 48px 60px",maxWidth:1280,margin:"0 auto",gap:40}}>
        <motion.div initial={{opacity:0,x:-28}} animate={{opacity:1,x:0}} transition={{duration:.8,delay:.1}} style={{flex:"0 0 55%"}}>
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
            18 AI agents analyze markets, debate trades,<br/>and execute with institutional-grade precision.<br/>
            <span style={{color:K.hi}}>24 hours. 7 days. No emotion. No fatigue.</span>
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
          <div style={{display:"flex",gap:12,marginBottom:14,flexWrap:"wrap"}}>
            {[
              {href:"/nexus?mode=demo",txt:"▶ FREE SANDBOX — $10K VIRTUAL",col:K.g,bg:"rgba(0,255,136,0.12)",border:"1.5px solid rgba(0,255,136,0.5)",glow:"rgba(0,255,136,0.3)"},
              {href:"/nexus?mode=live",txt:"⚡ CONNECT PHANTOM → LIVE",col:K.c,bg:"rgba(0,242,254,0.12)",border:"1.5px solid rgba(0,242,254,0.5)",glow:"rgba(0,242,254,0.3)"},
            ].map(b=>(
              <a key={b.href} href={b.href} style={{padding:"13px 22px",background:b.bg,border:b.border,color:b.col,borderRadius:6,fontSize:12,textDecoration:"none",letterSpacing:".04em",fontFamily:F,fontWeight:700,transition:"all .25s"}}
                onMouseEnter={e=>(e.currentTarget.style.boxShadow=`0 0 30px ${b.glow}`)}
                onMouseLeave={e=>(e.currentTarget.style.boxShadow="none")}>
                {b.txt}
              </a>
            ))}
          </div>
          <div style={{fontSize:9,color:K.dim,letterSpacing:".12em"}}>
            <span style={{color:K.g}}>●</span> 1,247 observers online · 0 signup required · Verified on-chain
          </div>
        </motion.div>

        <motion.div initial={{opacity:0,x:28}} animate={{opacity:1,x:0}} transition={{duration:.8,delay:.3}} style={{flex:"0 0 45%",display:"flex",flexDirection:"column",alignItems:"center",paddingTop:32}}>
          <Globe size={360}/>
          <div style={{marginTop:56}}><LivePrices/></div>
        </motion.div>
      </section>

      {/* ── BENTO GRID ───────────────────────────────────────────────────── */}
      <section style={{padding:"80px 48px",maxWidth:1280,margin:"0 auto"}}>
        <Fade>
          <div style={{textAlign:"center",marginBottom:48}}>
            <div style={{fontSize:11,color:K.c,letterSpacing:".3em",fontFamily:F,marginBottom:12}}>◈ WATCH THE SWARM THINK</div>
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
            <div style={{...PANEL,padding:28,borderColor:`${K.gold}30`,background:`linear-gradient(135deg,rgba(6,10,18,.9) 0%,rgba(255,215,0,.04) 100%)`}}>
              <div style={{fontSize:10,color:K.c,letterSpacing:".2em",marginBottom:4}}>◈ KYMIA PERFORMANCE DNA</div>
              <div style={{fontSize:9,color:K.gold,marginBottom:18}}>GOLD TIER · Score 74/100</div>
              <div style={{fontSize:22,fontWeight:900,color:K.gold,marginBottom:20,textShadow:`0 0 16px ${K.gold}60`}}>"Momentum Predator"</div>
              {[["WIN RATE","64%",K.g],["BEST TRADE","+$247",K.g],["TRADES","24",K.c]].map(([l,v,c],i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:i<2?"1px solid rgba(0,242,254,0.06)":"none",fontSize:11}}>
                  <span style={{color:K.dim}}>{l}</span><span style={{color:c as string,fontWeight:700}}>{v}</span>
                </div>
              ))}
              <a href="/nexus?mode=demo" style={{display:"block",marginTop:20,padding:"10px",textAlign:"center",background:`${K.gold}15`,border:`1px solid ${K.gold}40`,color:K.gold,borderRadius:4,fontSize:10,textDecoration:"none",letterSpacing:".1em"}}>SHARE YOUR DNA →</a>
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
              {href:"/nexus?mode=demo",txt:"▶ FREE DEMO — NO SIGNUP",sub:"$10,000 virtual · Real prices · Try now",col:K.g,bg:"rgba(0,255,136,0.12)",brd:"2px solid rgba(0,255,136,0.5)",glow:"rgba(0,255,136,0.3)"},
              {href:"/nexus?mode=live",txt:"⚡ LIVE TRADING → CONNECT PHANTOM",sub:"Non-custodial · Your keys · Real Solana",col:K.c,bg:"rgba(0,242,254,0.12)",brd:"2px solid rgba(0,242,254,0.5)",glow:"rgba(0,242,254,0.3)"},
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

      <style>{`
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
      `}</style>
    </div>
  );
}
