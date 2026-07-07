"use client";
import { useState, useEffect, useRef } from "react";
import { useInView } from "framer-motion";
import { supabase } from "../lib/supabase";

const K = { c:"#00F2FE",g:"#00FF88",r:"#FF3366",gold:"#FFD700",pu:"#BD00FF",dim:"#2A5070",hi:"#A8D0EC",bg:"#04060D" };
const F = "'JetBrains Mono','Courier New',monospace";
const PANEL = { background:"rgba(6,10,18,0.75)", backdropFilter:"blur(12px)", border:"1px solid rgba(0,242,254,0.08)", borderRadius:8 } as const;

// Fire this from any sub-component to open the demo login modal
const triggerDemoModal=()=>window.dispatchEvent(new CustomEvent('kymia:demo'));

const DemoLoginModal=({onClose}:{onClose:()=>void})=>(
  <div style={{position:'fixed',inset:0,zIndex:9999,background:'rgba(2,4,10,0.96)',backdropFilter:'blur(20px)',display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={onClose}>
    <div onClick={e=>e.stopPropagation()} style={{background:'#060A12',border:'1px solid rgba(0,242,254,0.2)',borderRadius:16,padding:36,width:380,textAlign:'center',boxShadow:'0 0 60px rgba(0,242,254,0.1)'}}>
      <div style={{fontSize:32,color:'#00F2FE',marginBottom:8,textShadow:'0 0 20px #00F2FE'}}>◈</div>
      <h2 style={{fontSize:20,fontWeight:900,color:'white',margin:'0 0 8px',fontFamily:'monospace'}}>Start your free session</h2>
      <p style={{fontSize:12,color:'#2A5070',lineHeight:1.7,margin:'0 0 28px'}}>Sign in to track your trading performance.<br/>$10,000 virtual capital. No credit card.</p>
      <button onClick={()=>supabase.auth.signInWithOAuth({provider:'google',options:{redirectTo:'https://kymia.ai/nexus?mode=demo',queryParams:{access_type:'offline',prompt:'consent'}}})} style={{width:'100%',padding:'14px',background:'rgba(255,255,255,0.07)',border:'1px solid rgba(255,255,255,0.15)',borderRadius:8,color:'white',fontSize:13,fontWeight:700,cursor:'pointer',marginBottom:10,display:'flex',alignItems:'center',justifyContent:'center',gap:10,fontFamily:'monospace'}}>
        <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
        Continue with Google
      </button>
      <button onClick={()=>supabase.auth.signInWithOAuth({provider:'github',options:{redirectTo:'https://kymia.ai/nexus?mode=demo'}})} style={{width:'100%',padding:'14px',background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:8,color:'white',fontSize:13,fontWeight:700,cursor:'pointer',marginBottom:24,display:'flex',alignItems:'center',justifyContent:'center',gap:10,fontFamily:'monospace'}}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
        Continue with GitHub
      </button>
      <button onClick={()=>{window.location.href='/nexus?mode=demo';}} style={{background:'none',border:'none',color:'#2A5070',cursor:'pointer',fontSize:11,fontFamily:'monospace',textDecoration:'underline'}}>Skip — trade without saving</button>
      <div style={{marginTop:20,padding:'10px 14px',background:'rgba(0,242,254,0.04)',border:'1px solid rgba(0,242,254,0.1)',borderRadius:6,fontSize:10,color:'#2A5070',lineHeight:1.7}}>◈ We only use your email to save your<br/>trading history. No spam. No card required.</div>
    </div>
  </div>
);

// ── Fade on scroll ─────────────────────────────────────────────────────────────
function Fade({ children, delay=0 }:{ children:React.ReactNode; delay?:number }) {
  const ref=useRef(null);
  const inView=useInView(ref,{once:true,margin:"-8% 0px"});
  return (
    <div ref={ref} style={{opacity:inView?1:0,transform:inView?"translateY(0)":"translateY(28px)",transition:`opacity .7s ${delay}s, transform .7s ${delay}s`}}>
      {children}
    </div>
  );
}

// ── Sticky Nav ─────────────────────────────────────────────────────────────────
function Nav() {
  const [show,setShow]=useState(false);
  useEffect(()=>{
    const fn=()=>setShow(window.scrollY>100);
    window.addEventListener("scroll",fn,{passive:true});
    return ()=>window.removeEventListener("scroll",fn);
  },[]);
  return (
    <div className="kymia-nav" style={{position:"fixed",top:0,left:0,right:0,zIndex:900,height:52,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 32px",background:"rgba(4,6,13,0.92)",backdropFilter:"blur(16px)",borderBottom:"1px solid rgba(0,242,254,0.08)",fontFamily:F,transform:show?"translateY(0)":"translateY(-100%)",transition:"transform .3s ease"}}>
      <a href="/" style={{fontSize:15,fontWeight:900,color:K.c,textDecoration:"none",letterSpacing:".2em",textShadow:`0 0 16px ${K.c}`}}>◈ KYMIA</a>
      <div className="kymia-nav-links" style={{display:"flex",gap:28,fontSize:10,color:K.dim,letterSpacing:".1em"}}>
        {[["HOW IT WORKS","#how"],["PRICING","/pricing"],["LEADERBOARD","/leaderboard"]].map(([l,h])=>(
          <a key={l} href={h} style={{color:K.dim,textDecoration:"none",transition:"color .2s"}}
            onMouseEnter={e=>(e.currentTarget.style.color=K.c)} onMouseLeave={e=>(e.currentTarget.style.color=K.dim)}>{l}</a>
        ))}
      </div>
      <div style={{display:"flex",gap:8}}>
        <a href="/leaderboard" style={{padding:"5px 14px",background:"rgba(255,215,0,0.08)",border:"1px solid rgba(255,215,0,0.3)",color:"#FFD700",fontSize:9,borderRadius:3,textDecoration:"none",letterSpacing:".1em",fontFamily:F}}>🏆 LEADERBOARD</a>
        <button onClick={triggerDemoModal} style={{padding:"5px 14px",background:"rgba(0,255,136,0.12)",border:"1px solid rgba(0,255,136,0.4)",color:K.g,fontSize:9,borderRadius:3,cursor:"pointer",letterSpacing:".1em",fontFamily:F}}>▶ FREE DEMO</button>
        <a href="/nexus?mode=live" style={{padding:"5px 14px",background:"rgba(0,242,254,0.12)",border:"1px solid rgba(0,242,254,0.4)",color:K.c,fontSize:9,borderRadius:3,textDecoration:"none",letterSpacing:".1em",fontFamily:F}}>⚡ LIVE →</a>
      </div>
    </div>
  );
}

// ── Founder Section ────────────────────────────────────────────────────────────
function FounderSection() {
  return (
    <section className="kymia-section" style={{padding:'100px 40px',background:'rgba(6,10,18,0.4)',position:'relative',borderTop:'1px solid rgba(0,242,254,0.06)',overflow:'hidden'}}>
      <div style={{position:'absolute',inset:0,opacity:0.02,backgroundImage:`linear-gradient(rgba(0,242,254,1) 1px,transparent 1px),linear-gradient(90deg,rgba(0,242,254,1) 1px,transparent 1px)`,backgroundSize:'60px 60px'}}/>
      <div className="kymia-founder-grid" style={{maxWidth:900,margin:'0 auto',position:'relative',display:'grid',gridTemplateColumns:'1fr 1.6fr',gap:64,alignItems:'center'}}>
        <Fade>
          <div className="kymia-founder-avatar" style={{position:'relative'}}>
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
        <Fade delay={.15}>
          <div>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:16,fontFamily:'monospace'}}>◈ THE FOUNDER</div>
            <h2 className="kymia-h2" style={{fontSize:38,fontWeight:900,color:'white',margin:'0 0 8px',lineHeight:1.2,fontFamily:'monospace'}}>Cedrick B.</h2>
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

// ── FAQ Section ────────────────────────────────────────────────────────────────
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
    <section className="kymia-section" style={{padding:'clamp(60px, 8vw, 100px) clamp(20px, 5vw, 80px)',background:'#04060D',borderTop:'1px solid rgba(0,242,254,0.06)'}}>
      <div style={{maxWidth:780,margin:'0 auto'}}>
        <Fade>
          <div style={{textAlign:'center',marginBottom:56}}>
            <div style={{fontSize:10,color:K.c,letterSpacing:'.4em',marginBottom:12,fontFamily:'monospace'}}>◈ QUESTIONS & ANSWERS</div>
            <h2 className="kymia-h2" style={{fontSize:36,fontWeight:900,color:'white',margin:0}}>Everything you need to know.</h2>
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

// ── Disclaimer Section ─────────────────────────────────────────────────────────
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

// ── Pricing Preview ────────────────────────────────────────────────────────────
function PricingPreview() {
  const MINI_PLANS=[
    {name:"SANDBOX",price:"Free",col:K.g,cta:"Start Now",link:"/nexus?mode=demo",demo:true},
    {name:"ALPHA",price:"$39.99/mo",col:K.c,cta:"7 Days Free",link:"/nexus?mode=live&plan=alpha",popular:true},
    {name:"PERFORMANCE",price:"10% wins",col:K.gold,cta:"7 Days Free",link:"/nexus?mode=live&plan=performance"},
    {name:"INSTITUTIONAL",price:"$499/mo",col:"#BD00FF",cta:"Contact Us",link:"mailto:contact@kymia.ai"},
  ];
  return(
    <section className="kymia-section" style={{padding:"80px 40px",background:"rgba(6,10,18,0.4)",borderTop:"1px solid rgba(0,242,254,0.06)"}}>
      <div style={{maxWidth:920,margin:"0 auto",textAlign:"center"}}>
        <div style={{fontSize:10,color:K.c,letterSpacing:".4em",marginBottom:12,fontFamily:F}}>◈ PRICING</div>
        <h2 className="kymia-h2" style={{fontSize:34,fontWeight:900,color:"white",margin:"0 0 12px",fontFamily:F,lineHeight:1.2}}>Free to start. Fair to scale.</h2>
        <p style={{fontSize:14,color:K.dim,lineHeight:1.85,marginBottom:40}}>Sandbox is always free. Pay only when you go live.</p>
        <div className="kymia-pricing-grid" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:32}}>
          {MINI_PLANS.map((p,i)=>(
            <div className="kymia-pricing-card" key={i} style={{padding:"22px 16px",background:p.popular?"rgba(0,242,254,0.06)":"rgba(6,10,18,0.8)",border:`1px solid ${p.popular?"rgba(0,242,254,0.3)":p.col+"25"}`,borderRadius:10,textAlign:"center",boxShadow:p.popular?"0 0 32px rgba(0,242,254,0.08)":"none",position:"relative"}}>
              {p.popular&&<div style={{position:"absolute",top:-11,left:"50%",transform:"translateX(-50%)",padding:"3px 14px",background:"linear-gradient(90deg,#00F2FE,#0051FF)",borderRadius:20,fontSize:8,color:"white",fontWeight:700,letterSpacing:".12em",whiteSpace:"nowrap"}}>MOST POPULAR</div>}
              <div style={{fontSize:11,color:p.col,fontWeight:700,letterSpacing:".15em",marginBottom:8,fontFamily:F}}>{p.name}</div>
              <div style={{fontSize:17,fontWeight:900,color:"white",marginBottom:14,fontFamily:F}}>{p.price}</div>
              {'demo' in p&&p.demo?<button onClick={triggerDemoModal} style={{display:"block",width:"100%",padding:"9px",background:`${p.col}15`,border:`1px solid ${p.col}35`,borderRadius:5,fontSize:10,color:p.col,cursor:"pointer",fontFamily:F,fontWeight:700}}>{p.cta}</button>:<a href={p.link} style={{display:"block",padding:"9px",background:`${p.col}15`,border:`1px solid ${p.col}35`,borderRadius:5,fontSize:10,color:p.col,textDecoration:"none",fontFamily:F,fontWeight:700,transition:"all .2s"}}>{p.cta}</a>}
            </div>
          ))}
        </div>
        <a href="/pricing" style={{fontSize:12,color:K.dim,fontFamily:F,textDecoration:"none",borderBottom:"1px solid #0A1D33",paddingBottom:2}}>View full comparison table →</a>
      </div>
    </section>
  );
}

// ── Footer ─────────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer style={{background:'rgba(4,6,13,0.98)',borderTop:'1px solid rgba(0,242,254,0.08)',padding:'60px 40px 32px'}}>
      <div style={{maxWidth:1100,margin:'0 auto'}}>
        <div className="kymia-footer-grid" style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr 1fr',gap:48,marginBottom:48}}>
          <div className="kymia-footer-brand">
            <div style={{fontSize:24,fontWeight:900,color:K.c,fontFamily:'monospace',letterSpacing:'.2em',textShadow:'0 0 20px #00F2FE',marginBottom:12}}>◈ KYMIA</div>
            <div style={{fontSize:10,color:K.dim,letterSpacing:'.2em',marginBottom:16}}>AUTONOMOUS QUANT INTELLIGENCE</div>
            <p style={{fontSize:12,color:'#1A3050',lineHeight:1.8,maxWidth:280,margin:0}}>18 AI agents analyzing Solana markets 24/7. Real data. Real signals. Verifiable on-chain.</p>
            <div style={{display:'flex',gap:10,marginTop:20}}>
              {([['https://github.com/cbompemo-byte/Nexus-V2','GITHUB ↗'],['https://x.com','X / TWITTER ↗']] as [string,string][]).map(([href,txt],i)=>(
                <a key={i} href={href} target="_blank" rel="noopener" style={{padding:'8px 14px',background:'rgba(168,208,236,0.06)',border:'1px solid rgba(168,208,236,0.15)',borderRadius:4,fontSize:9,color:K.hi,textDecoration:'none',fontFamily:'monospace'}}>{txt}</a>
              ))}
            </div>
          </div>
          <div>
            <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:20,fontFamily:'monospace'}}>PRODUCT</div>
            {([['Demo Sandbox','/nexus?mode=demo'],['Live Trading','/nexus?mode=live'],['Crisis Replay','/nexus?mode=demo#crisis'],['Swarm DNA','/nexus?mode=demo#dna'],['Performance','#performance']] as [string,string][]).map(([l,h],i)=>(
              <a key={i} href={h} style={{display:'block',fontSize:12,color:K.dim,textDecoration:'none',marginBottom:10,fontFamily:'monospace',transition:'color .2s'}}
                onMouseEnter={e=>(e.currentTarget.style.color=K.c)}
                onMouseLeave={e=>(e.currentTarget.style.color=K.dim)}>{l}</a>
            ))}
          </div>
          <div>
            <div style={{fontSize:9,color:K.dim,letterSpacing:'.2em',marginBottom:20,fontFamily:'monospace'}}>INTELLIGENCE</div>
            {([['18 Agents','#swarm'],['Data Sources','#apis'],['How It Works','#how'],['Public Wallet','#performance'],['GitHub','https://github.com/cbompemo-byte/Nexus-V2']] as [string,string][]).map(([l,h],i)=>(
              <a key={i} href={h} target={h.startsWith('http')?'_blank':undefined} rel={h.startsWith('http')?'noopener':undefined}
                style={{display:'block',fontSize:12,color:K.dim,textDecoration:'none',marginBottom:10,fontFamily:'monospace',transition:'color .2s'}}
                onMouseEnter={e=>(e.currentTarget.style.color=K.c)}
                onMouseLeave={e=>(e.currentTarget.style.color=K.dim)}>{l}</a>
            ))}
          </div>
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

// ── Logo strip data ────────────────────────────────────────────────────────────
const LOGOS_ROW1 = [
  {name:'Solana',      emoji:'◎'},
  {name:'Jupiter',     emoji:'♃'},
  {name:'Phantom',     emoji:'👻'},
  {name:'Raydium',     emoji:'◈'},
  {name:'Kraken',      emoji:'🐙'},
  {name:'Binance',     emoji:'⬡'},
  {name:'DexScreener', emoji:'◉'},
  {name:'CoinGecko',   emoji:'🦎'},
  {name:'Orca',        emoji:'🐋'},
  {name:'Meteora',     emoji:'☄'},
];

const LOGOS_ROW2 = [
  {name:'Pyth',      emoji:'🐍'},
  {name:'Jito',      emoji:'⚡'},
  {name:'Drift',     emoji:'〜'},
  {name:'Tensor',    emoji:'T'},
  {name:'MagicEden', emoji:'ME'},
  {name:'Helius',    emoji:'H'},
  {name:'Backpack',  emoji:'🎒'},
  {name:'Zeta',      emoji:'Z'},
  {name:'Lifinity',  emoji:'∞'},
  {name:'Mango',     emoji:'🥭'},
];

// ── Main Landing Page ──────────────────────────────────────────────────────────
export default function LandingPage() {
  const [showDemoLogin, setShowDemoLogin] = useState(false);

  useEffect(() => {
    const h = () => setShowDemoLogin(true);
    window.addEventListener('kymia:demo', h);
    return () => window.removeEventListener('kymia:demo', h);
  }, []);

  return (
    <div style={{background:'#04060D',minHeight:'100vh',fontFamily:F,color:K.hi,overflowX:'hidden'}}>
      <Nav/>

      {/* Scanlines */}
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:1,background:'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)'}}/>
      {/* Vignette */}
      <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:1,background:'radial-gradient(ellipse at center,transparent 60%,rgba(2,4,10,0.65) 100%)'}}/>

      {/* ── HERO ─────────────────────────────────────────────────────────────── */}
      <section style={{
        background:'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(0,242,254,0.08) 0%, transparent 70%), #04060D',
        minHeight:'100vh',
        display:'flex',
        alignItems:'center',
        justifyContent:'center',
        textAlign:'center',
        padding:'120px 40px 80px',
        position:'relative',
      }}>
        <div style={{maxWidth:900,width:'100%',position:'relative',zIndex:2}}>
          {/* Live label */}
          <div style={{
            display:'inline-flex',alignItems:'center',
            gap:8,padding:'6px 16px',
            background:'rgba(0,242,254,0.08)',
            border:'1px solid rgba(0,242,254,0.2)',
            borderRadius:20,marginBottom:32,
          }}>
            <div style={{
              width:6,height:6,borderRadius:'50%',
              background:'#00FF88',
              boxShadow:'0 0 8px #00FF88',
              animation:'pulse 1.5s infinite',
            }}/>
            <span style={{
              fontSize:13,color:'#00F2FE',
              fontFamily:'monospace',fontWeight:600,
              letterSpacing:'.05em',
            }}>
              18 AI agents trading live on Solana
            </span>
          </div>

          {/* Big title */}
          <h1 style={{
            fontSize:'clamp(42px, 7vw, 88px)',
            fontWeight:900,lineHeight:1.05,
            color:'white',margin:'0 0 24px',
            letterSpacing:'-0.02em',
          }}>
            The AI swarm that<br/>
            <span style={{
              background:'linear-gradient(135deg, #00F2FE, #00FF88)',
              WebkitBackgroundClip:'text',
              WebkitTextFillColor:'transparent',
            }}>
              trades while you sleep.
            </span>
          </h1>

          {/* Subtitle */}
          <p style={{
            fontSize:'clamp(16px, 2vw, 22px)',
            color:'#4A7090',maxWidth:600,
            lineHeight:1.6,margin:'0 auto 40px',
          }}>
            18 specialized agents analyzing real Solana
            markets 24/7. Consensus-driven execution.
            Full transparency — wins and losses both shown.
          </p>

          {/* CTAs */}
          <div style={{display:'flex',gap:12,flexWrap:'wrap',justifyContent:'center'}}>
            <button onClick={() => setShowDemoLogin(true)} style={{
              padding:'14px 32px',
              background:'rgba(0,242,254,0.12)',
              border:'2px solid rgba(0,242,254,0.4)',
              borderRadius:8,color:'#00F2FE',
              fontSize:16,fontWeight:700,
              cursor:'pointer',fontFamily:'monospace',
              letterSpacing:'0.05em',
              boxShadow:'0 0 30px rgba(0,242,254,0.1)',
            }}>
              ▶ Watch AI Trade Live
            </button>
            <a href="/nexus?mode=live" style={{
              padding:'14px 32px',
              background:'transparent',
              border:'1px solid rgba(255,255,255,0.1)',
              borderRadius:8,color:'#4A7090',
              fontSize:16,fontWeight:600,
              cursor:'pointer',textDecoration:'none',
              display:'inline-flex',alignItems:'center',
            }}>
              See how it works →
            </a>
          </div>

          {/* Trust line */}
          <p style={{fontSize:13,color:'#2A4060',marginTop:20}}>
            Free 10-day trial · No credit card · Non-custodial
          </p>
        </div>
      </section>

      {/* ── LOGO STRIP ───────────────────────────────────────────────────────── */}
      <section style={{
        padding:'60px 0',
        borderTop:'1px solid rgba(255,255,255,0.05)',
        borderBottom:'1px solid rgba(255,255,255,0.05)',
        overflow:'hidden',
      }} className="logo-strip">
        <div style={{
          textAlign:'center',marginBottom:32,
          fontSize:12,color:'#2A4060',
          fontFamily:'monospace',letterSpacing:'.2em',
        }}>
          CONNECTED TO THE SOLANA ECOSYSTEM
        </div>

        {/* Row 1 — scrolls left */}
        <div style={{overflow:'hidden',marginBottom:16}}>
          <div className="scroll-left">
            {[...LOGOS_ROW1,...LOGOS_ROW1].map((logo,i) => (
              <div key={i} style={{
                display:'flex',alignItems:'center',
                gap:8,padding:'8px 24px',
                margin:'0 4px',
                background:'rgba(255,255,255,0.03)',
                border:'1px solid rgba(255,255,255,0.06)',
                borderRadius:8,whiteSpace:'nowrap',
                flexShrink:0,
              }}>
                <span style={{fontSize:16}}>{logo.emoji}</span>
                <span style={{fontSize:13,color:'#4A7090',fontWeight:600,fontFamily:'monospace'}}>{logo.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Row 2 — scrolls right */}
        <div style={{overflow:'hidden'}}>
          <div className="scroll-right">
            {[...LOGOS_ROW2,...LOGOS_ROW2].map((logo,i) => (
              <div key={i} style={{
                display:'flex',alignItems:'center',
                gap:8,padding:'8px 24px',
                margin:'0 4px',
                background:'rgba(255,255,255,0.03)',
                border:'1px solid rgba(255,255,255,0.06)',
                borderRadius:8,whiteSpace:'nowrap',
                flexShrink:0,
              }}>
                <span style={{fontSize:16}}>{logo.emoji}</span>
                <span style={{fontSize:13,color:'#4A7090',fontWeight:600,fontFamily:'monospace'}}>{logo.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── STATS BAR ────────────────────────────────────────────────────────── */}
      <section style={{
        padding:'60px 40px',
        display:'grid',
        gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))',
        gap:32,maxWidth:1200,margin:'0 auto',
        borderBottom:'1px solid rgba(255,255,255,0.05)',
      }}>
        {[
          {n:'18',    label:'Specialized AI Agents', sub:'working in consensus'},
          {n:'24/7',  label:'Autonomous Trading',    sub:'server-side execution'},
          {n:'3',     label:'Trading Layers',        sub:'Core · Top 50 · New Tokens'},
          {n:'100%',  label:'Non-Custodial',         sub:'your keys, your funds'},
        ].map((stat,i) => (
          <Fade key={i} delay={i * 0.08}>
            <div style={{textAlign:'center'}}>
              <div style={{
                fontSize:'clamp(36px,5vw,56px)',
                fontWeight:900,color:'white',
                fontFamily:'monospace',lineHeight:1,
                background:'linear-gradient(135deg,white,#4A7090)',
                WebkitBackgroundClip:'text',
                WebkitTextFillColor:'transparent',
                marginBottom:8,
              }}>
                {stat.n}
              </div>
              <div style={{fontSize:16,color:'#8BAABB',fontWeight:600,marginBottom:4}}>{stat.label}</div>
              <div style={{fontSize:13,color:'#2A4060'}}>{stat.sub}</div>
            </div>
          </Fade>
        ))}
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────────── */}
      <section id="how" style={{padding:'80px 40px',maxWidth:1200,margin:'0 auto'}}>
        <Fade>
          <div style={{fontSize:12,color:'#00F2FE',letterSpacing:'.3em',fontFamily:'monospace',marginBottom:16,textAlign:'center'}}>
            HOW IT WORKS
          </div>
          <h2 style={{
            fontSize:'clamp(32px,4vw,52px)',
            fontWeight:900,color:'white',
            textAlign:'center',marginBottom:16,
            lineHeight:1.1,letterSpacing:'-0.02em',
          }}>
            Intelligence at every layer
          </h2>
          <p style={{
            fontSize:18,color:'#4A7090',
            textAlign:'center',
            maxWidth:600,margin:'0 auto 60px',
          }}>
            Three specialized trading layers work
            simultaneously to find the best opportunities.
          </p>
        </Fade>

        <div style={{
          display:'grid',
          gridTemplateColumns:'repeat(auto-fit, minmax(300px, 1fr))',
          gap:24,
        }}>
          {[
            {
              tag:'LAYER 1',
              col:'#00F2FE',
              title:'Core Trading',
              desc:'SOL, BTC, ETH and JUP analyzed continuously with EMA trend following, RSI, volume and macro confirmation.',
              features:['EMA 9/21/50 alignment','RSI momentum filter','ATR dynamic stops'],
            },
            {
              tag:'LAYER 2',
              col:'#BD00FF',
              title:'Opportunity Scanner',
              desc:'Every 30 minutes, the swarm scans the top 50 cryptocurrencies for high-conviction setups.',
              features:['50 tokens scanned','Volume anomaly detection','Breakout identification'],
            },
            {
              tag:'LAYER 3',
              col:'#FFD700',
              title:'New Token Hunter',
              desc:'Detects new Solana tokens under 4 hours old with real liquidity. Safety score before any capital moves.',
              features:['< 4h old tokens','Rug pull detection','Your approval required'],
            },
          ].map((layer,i) => (
            <Fade key={i} delay={i * 0.1}>
              <div style={{
                padding:'32px 28px',
                background:'rgba(255,255,255,0.02)',
                border:'1px solid rgba(255,255,255,0.06)',
                borderTop:`2px solid ${layer.col}`,
                borderRadius:12,
                height:'100%',
              }}>
                <div style={{
                  fontSize:11,color:layer.col,
                  fontFamily:'monospace',
                  letterSpacing:'.2em',
                  marginBottom:16,fontWeight:700,
                }}>
                  {layer.tag}
                </div>
                <h3 style={{fontSize:24,fontWeight:800,color:'white',marginBottom:12,margin:'0 0 12px'}}>
                  {layer.title}
                </h3>
                <p style={{fontSize:15,color:'#4A7090',lineHeight:1.7,marginBottom:24,margin:'0 0 24px'}}>
                  {layer.desc}
                </p>
                <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  {layer.features.map((f,j) => (
                    <div key={j} style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:'#8BAABB'}}>
                      <span style={{color:layer.col}}>→</span>
                      {f}
                    </div>
                  ))}
                </div>
              </div>
            </Fade>
          ))}
        </div>
      </section>

      {/* ── FINAL CTA ────────────────────────────────────────────────────────── */}
      <section style={{
        padding:'100px 40px',
        textAlign:'center',
        background:'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(0,242,254,0.05) 0%, transparent 70%)',
      }}>
        <Fade>
          <div style={{
            fontSize:12,color:'#2A4060',
            letterSpacing:'.3em',fontFamily:'monospace',
            marginBottom:16,
          }}>
            START TODAY
          </div>
          <h2 style={{
            fontSize:'clamp(36px,5vw,64px)',
            fontWeight:900,color:'white',
            marginBottom:16,lineHeight:1.05,
            letterSpacing:'-0.02em',
          }}>
            Ready to let AI<br/>trade for you?
          </h2>
          <p style={{
            fontSize:18,color:'#4A7090',
            maxWidth:480,
            margin:'0 auto 40px',
          }}>
            Start your free 10-day trial.
            No credit card required.
            Your funds stay in your wallet.
          </p>
          <button onClick={() => setShowDemoLogin(true)} style={{
            padding:'16px 48px',
            background:'rgba(0,242,254,0.12)',
            border:'2px solid rgba(0,242,254,0.5)',
            borderRadius:10,color:'#00F2FE',
            fontSize:18,fontWeight:700,
            cursor:'pointer',fontFamily:'monospace',
            boxShadow:'0 0 40px rgba(0,242,254,0.15)',
          }}>
            ▶ Start Free Trial
          </button>
          <p style={{fontSize:13,color:'#2A4060',marginTop:16}}>
            10 days free · then $39.99/month · cancel anytime
          </p>
        </Fade>
      </section>

      <FounderSection/>
      <FAQSection/>
      <PricingPreview/>
      <DisclaimerSection/>
      <Footer/>

      {showDemoLogin&&<DemoLoginModal onClose={()=>setShowDemoLogin(false)}/>}

      <style>{`
        @keyframes scrollLeft {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @keyframes scrollRight {
          from { transform: translateX(-50%); }
          to   { transform: translateX(0); }
        }
        .scroll-left {
          animation: scrollLeft 30s linear infinite;
          display: flex;
          width: max-content;
        }
        .scroll-right {
          animation: scrollRight 25s linear infinite;
          display: flex;
          width: max-content;
        }
        .logo-strip:hover .scroll-left,
        .logo-strip:hover .scroll-right {
          animation-play-state: paused;
        }
        @keyframes pulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.6; transform:scale(0.97); }
        }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes pu    { 0%,100%{opacity:1} 50%{opacity:.3} }
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }

        @media (max-width: 768px) {
          .kymia-nav-links  { display: none !important; }
          .kymia-nav        { padding: 0 16px !important; height: 52px !important; }
          .kymia-founder-grid  { grid-template-columns: 1fr !important; }
          .kymia-founder-avatar { margin: 0 auto 24px !important; width: 200px !important; }
          .kymia-footer-grid   { grid-template-columns: 1fr 1fr !important; }
          .kymia-footer-brand  { grid-column: 1 / -1 !important; }
          .kymia-pricing-grid  { display: flex !important; overflow-x: auto !important; scroll-snap-type: x mandatory !important; -webkit-overflow-scrolling: touch !important; gap: 12px !important; padding: 0 20px 16px !important; }
          .kymia-pricing-card  { min-width: 280px !important; flex-shrink: 0 !important; scroll-snap-align: start !important; }
          .kymia-h2 { font-size: clamp(22px, 6vw, 32px) !important; }
        }

        @media (max-width: 480px) {
          .kymia-h1 { font-size: 26px !important; }
        }
      `}</style>
    </div>
  );
}
