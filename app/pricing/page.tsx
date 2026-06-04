"use client";
import { useState } from "react";

const K={c:"#00F2FE",g:"#00FF88",r:"#FF3366",gold:"#FFD700",pu:"#BD00FF",dim:"#2A5070",hi:"#A8D0EC",bg:"#04060D",pan:"rgba(6,10,18,0.75)"};
const F="'JetBrains Mono','Courier New',monospace";

const PLANS=[
  {
    id:"sandbox",name:"SANDBOX",badge:"FREE FOREVER",badgeCol:K.g,
    price:{monthly:0,yearly:0},
    description:"Experience the full power of KYMIA\nwith virtual capital. No risk.",
    cta:"Launch Sandbox →",ctaLink:"/nexus?mode=demo",ctaStyle:"outline",icon:"◎",col:K.g,
    features:[
      {text:"$10,000 virtual capital",included:true},
      {text:"All 18 AI agents active",included:true},
      {text:"Real market prices",included:true},
      {text:"Full dashboard access",included:true},
      {text:"Performance DNA card",included:true},
      {text:"Leaderboard ranking",included:true},
      {text:"Crisis replay (FTX, LUNA)",included:true},
      {text:"Share results on X",included:true},
      {text:"Live trading (real funds)",included:false},
      {text:"Memecoin early alerts",included:false},
      {text:"Profit share mode",included:false},
    ],highlight:false,
  },
  {
    id:"alpha",name:"ALPHA",badge:"7 DAYS FREE",badgeCol:K.c,
    price:{monthly:39.99,yearly:29.99},
    description:"Real trading with institutional\nrisk management. 5 live trades/day.",
    cta:"Start 7-Day Trial →",ctaLink:"/nexus?mode=live&plan=alpha",ctaStyle:"solid",icon:"⚡",col:K.c,popular:true,
    features:[
      {text:"5 live trades per day",included:true,tooltip:"Unlimited if win rate > 65%"},
      {text:"1 Phantom wallet address",included:true},
      {text:"All 18 AI agents",included:true},
      {text:"Top 100 market scanner",included:true},
      {text:"Memecoin early alerts",included:true},
      {text:"Advanced DNA analytics",included:true},
      {text:"Real-time P&L tracking",included:true},
      {text:"Win streak bonus trades",included:true,tooltip:"+2 bonus trades on 3+ win streak"},
      {text:"Daily Alpha Report",included:true},
      {text:"Multiple wallets",included:false},
      {text:"API access",included:false},
    ],highlight:true,
  },
  {
    id:"performance",name:"PERFORMANCE",badge:"7 DAYS FREE",badgeCol:K.gold,
    price:{monthly:0,yearly:0},
    priceLabel:"10% of winning trades",priceSub:"Pay nothing when you lose",
    description:"The hedge fund model. KYMIA\nearns only when you earn.",
    cta:"Start Performance →",ctaLink:"/nexus?mode=live&plan=performance",ctaStyle:"gold",icon:"◈",col:K.gold,
    features:[
      {text:"10 live trades per day",included:true},
      {text:"10% fee on winning trades only",included:true,tooltip:"If trade wins +$100, KYMIA takes $10"},
      {text:"Zero monthly fee",included:true},
      {text:"Pay only on profit",included:true},
      {text:"2 Phantom wallet addresses",included:true},
      {text:"All 18 AI agents",included:true},
      {text:"Priority memecoin alerts",included:true},
      {text:"Weekly performance report",included:true},
      {text:"Loss protection: pause on -3",included:true,tooltip:"Auto-pause after 3 consecutive losses"},
      {text:"Dedicated Telegram alerts",included:true},
      {text:"API access",included:false},
    ],highlight:false,
  },
  {
    id:"institutional",name:"INSTITUTIONAL",badge:"ENTERPRISE",badgeCol:K.pu,
    price:{monthly:499,yearly:399},
    description:"Built for funds, DAOs and\nserious professional traders.",
    cta:"Contact for Access →",ctaLink:"mailto:contact@kymia.ai",ctaStyle:"purple",icon:"◈",col:K.pu,
    features:[
      {text:"Unlimited live trades",included:true},
      {text:"5 Phantom wallet addresses",included:true},
      {text:"Custom risk parameters",included:true},
      {text:"Private API access",included:true},
      {text:"White-label dashboard",included:true},
      {text:"Auto PDF weekly report",included:true},
      {text:"Priority 24/7 support",included:true},
      {text:"Custom agent configuration",included:true},
      {text:"Dedicated Telegram channel",included:true},
      {text:"Direct access to Cedrick",included:true},
      {text:"Multi-exchange integration",included:true},
    ],highlight:false,
  },
] as const;

type PlanId="sandbox"|"alpha"|"performance"|"institutional";
type BillingType="monthly"|"yearly";

export default function PricingPage(){
  const [billing,setBilling]=useState<BillingType>("monthly");
  const [hovered,setHovered]=useState<PlanId|null>(null);

  return(
    <div style={{background:K.bg,minHeight:"100vh",fontFamily:F,position:"relative",overflow:"hidden"}}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#0A1D33}
        @keyframes pu{0%,100%{opacity:1}50%{opacity:.15}}
        @keyframes glowPulse{0%,100%{opacity:.7}50%{opacity:1}}
        .plan-card{transition:all .3s ease}
        .plan-card:hover{transform:translateY(-6px)!important}
        .cta-btn{transition:all .25s}
        .cta-btn:hover{filter:brightness(1.15)}
      `}</style>

      {/* Ambient BG */}
      <div style={{position:"fixed",inset:0,pointerEvents:"none",background:"radial-gradient(ellipse at 50% -10%,rgba(0,242,254,0.05) 0%,transparent 60%)"}}/>
      <div style={{position:"fixed",inset:0,pointerEvents:"none",background:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.009) 3px,rgba(0,242,254,0.009) 4px)"}}/>
      <div style={{position:"fixed",top:"30%",left:"-10%",width:400,height:400,borderRadius:"50%",background:"rgba(0,81,255,0.03)",filter:"blur(80px)",pointerEvents:"none"}}/>
      <div style={{position:"fixed",top:"50%",right:"-5%",width:300,height:300,borderRadius:"50%",background:"rgba(189,0,255,0.03)",filter:"blur(60px)",pointerEvents:"none"}}/>

      {/* Nav */}
      <header style={{padding:"14px 32px",borderBottom:"1px solid rgba(0,242,254,0.07)",background:"rgba(4,6,13,0.9)",backdropFilter:"blur(12px)",position:"sticky",top:0,zIndex:100,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <a href="/" style={{textDecoration:"none",fontSize:17,fontWeight:900,color:K.c,letterSpacing:".25em",textShadow:"0 0 16px "+K.c}}>KYMIA</a>
          <span style={{fontSize:9,color:"#0A1D33",letterSpacing:".15em"}}>/ PRICING</span>
        </div>
        <div style={{display:"flex",gap:10}}>
          <a href="/leaderboard" style={{padding:"5px 14px",background:"rgba(255,215,0,0.08)",border:"1px solid rgba(255,215,0,0.3)",color:K.gold,fontSize:9,borderRadius:3,textDecoration:"none",letterSpacing:".1em"}}>🏆 LEADERBOARD</a>
          <a href="/nexus?mode=demo" style={{padding:"5px 14px",background:"rgba(0,255,136,0.12)",border:"1px solid rgba(0,255,136,0.4)",color:K.g,fontSize:9,borderRadius:3,textDecoration:"none",letterSpacing:".1em"}}>▶ FREE DEMO</a>
          <a href="/nexus?mode=live" style={{padding:"5px 14px",background:"rgba(0,242,254,0.12)",border:"1px solid rgba(0,242,254,0.4)",color:K.c,fontSize:9,borderRadius:3,textDecoration:"none",letterSpacing:".1em"}}>⚡ LIVE →</a>
        </div>
      </header>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"72px 32px 80px",position:"relative"}}>

        {/* ── Hero ── */}
        <div style={{textAlign:"center",marginBottom:56}}>
          <div style={{fontSize:10,color:K.c,letterSpacing:".5em",marginBottom:16,animation:"glowPulse 3s ease infinite"}}>◈ CHOOSE YOUR INTELLIGENCE LEVEL</div>
          <h1 style={{fontSize:clamp(32,48),fontWeight:900,color:"white",margin:"0 0 14px",lineHeight:1.2}}>
            Simple. Transparent.<br/>
            <span style={{color:K.c,textShadow:"0 0 30px "+K.c+"60"}}>No hidden fees.</span>
          </h1>
          <p style={{fontSize:15,color:K.dim,lineHeight:1.9,marginBottom:36}}>
            Start free. Upgrade when you&apos;re ready.<br/>
            Cancel anytime. Your keys, your funds.
          </p>

          {/* Billing toggle */}
          <div style={{display:"inline-flex",alignItems:"center",gap:6,padding:"5px 6px",background:"rgba(6,10,18,0.9)",border:"1px solid rgba(0,242,254,0.1)",borderRadius:30}}>
            {(["monthly","yearly"] as BillingType[]).map(b=>(
              <button key={b} onClick={()=>setBilling(b)} style={{
                padding:"9px 22px",borderRadius:24,
                background:billing===b?"rgba(0,242,254,0.12)":"transparent",
                border:billing===b?"1px solid rgba(0,242,254,0.3)":"1px solid transparent",
                color:billing===b?K.c:K.dim,
                fontFamily:F,fontSize:11,fontWeight:700,cursor:"pointer",letterSpacing:".1em",transition:"all .2s"
              }}>
                {b==="monthly"?"MONTHLY":"YEARLY"}
                {b==="yearly"&&<span style={{marginLeft:8,padding:"1px 7px",background:"rgba(0,255,136,0.15)",border:"1px solid rgba(0,255,136,0.3)",borderRadius:10,fontSize:9,color:K.g}}>-25%</span>}
              </button>
            ))}
          </div>
        </div>

        {/* ── Plans grid ── */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:52}}>
          {PLANS.map(plan=>{
            const isHov=hovered===plan.id;
            const price=(plan.price as Record<string,number>)[billing];
            const planCol=plan.col;
            return(
              <div key={plan.id} className="plan-card"
                onMouseEnter={()=>setHovered(plan.id as PlanId)}
                onMouseLeave={()=>setHovered(null)}
                style={{
                  position:"relative",
                  background:plan.highlight
                    ?`linear-gradient(160deg,rgba(0,242,254,0.08) 0%,rgba(4,6,13,0.95) 100%)`
                    :"rgba(6,10,18,0.75)",
                  backdropFilter:"blur(14px)",
                  border:`1px solid ${plan.highlight?"rgba(0,242,254,0.35)":isHov?planCol+"40":"rgba(0,242,254,0.06)"}`,
                  borderRadius:12,padding:"28px 22px",
                  transform:plan.highlight?"translateY(-4px)":"translateY(0)",
                  boxShadow:plan.highlight
                    ?`0 8px 48px rgba(0,242,254,0.1),0 0 0 1px rgba(0,242,254,0.08),inset 0 1px 0 rgba(255,255,255,0.04)`
                    :isHov?`0 8px 36px rgba(0,0,0,0.5),0 0 28px ${planCol}18`
                    :"0 4px 24px rgba(0,0,0,0.25)",
                }}>

                {/* Popular badge */}
                {"popular" in plan && plan.popular&&(
                  <div style={{position:"absolute",top:-13,left:"50%",transform:"translateX(-50%)",padding:"4px 18px",background:"linear-gradient(90deg,#00F2FE,#0051FF)",borderRadius:20,fontSize:9,color:"white",fontWeight:900,letterSpacing:".15em",whiteSpace:"nowrap",boxShadow:"0 4px 16px rgba(0,242,254,0.3)"}}>
                    ◈ MOST POPULAR
                  </div>
                )}

                {/* Glow line at top for popular */}
                {plan.highlight&&<div style={{position:"absolute",top:0,left:"10%",right:"10%",height:1,background:"linear-gradient(90deg,transparent,rgba(0,242,254,0.6),transparent)"}}/>}

                {/* Badge */}
                <div style={{display:"inline-block",padding:"3px 10px",background:`${plan.badgeCol}15`,border:`1px solid ${plan.badgeCol}40`,borderRadius:20,fontSize:8,color:plan.badgeCol,letterSpacing:".15em",marginBottom:14}}>
                  {plan.badge}
                </div>

                {/* Icon + Name */}
                <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:12}}>
                  <span style={{fontSize:22,color:planCol,filter:`drop-shadow(0 0 10px ${planCol})`}}>{plan.icon}</span>
                  <span style={{fontSize:18,fontWeight:900,color:planCol,letterSpacing:".15em",textShadow:`0 0 20px ${planCol}60`}}>{plan.name}</span>
                </div>

                {/* Price */}
                <div style={{marginBottom:14}}>
                  {"priceLabel" in plan?(
                    <>
                      <div style={{fontSize:15,fontWeight:900,color:planCol,lineHeight:1.3,textShadow:`0 0 16px ${planCol}`}}>{plan.priceLabel}</div>
                      <div style={{fontSize:10,color:K.dim,marginTop:4}}>{plan.priceSub}</div>
                    </>
                  ):price===0?(
                    <div style={{fontSize:38,fontWeight:900,color:planCol,textShadow:`0 0 24px ${planCol}80`,lineHeight:1}}>FREE</div>
                  ):(
                    <div>
                      <div style={{display:"flex",alignItems:"baseline",gap:3}}>
                        <span style={{fontSize:14,color:K.dim}}>$</span>
                        <span style={{fontSize:42,fontWeight:900,color:"white",lineHeight:1,textShadow:`0 0 20px ${planCol}50`}}>{price}</span>
                        <span style={{fontSize:12,color:K.dim}}>/mo</span>
                      </div>
                      {billing==="yearly"&&<div style={{fontSize:9,color:K.g,marginTop:4}}>Billed yearly · Save ${((39.99-price)*12).toFixed(0)}/yr</div>}
                    </div>
                  )}
                </div>

                {/* Description */}
                <p style={{fontSize:11,color:K.dim,lineHeight:1.75,margin:"0 0 16px",whiteSpace:"pre-line"}}>{plan.description}</p>

                {/* Divider */}
                <div style={{height:1,marginBottom:18,background:`linear-gradient(90deg,${planCol}30,transparent)`}}/>

                {/* Features */}
                <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:24,minHeight:270}}>
                  {plan.features.map((f,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"flex-start",gap:9}}>
                      <span style={{fontSize:12,flexShrink:0,marginTop:1,color:f.included?planCol:"#1A3050",fontWeight:700}}>{f.included?"✓":"—"}</span>
                      <div>
                        <span style={{fontSize:11,lineHeight:1.5,color:f.included?K.hi:"#1A3050"}}>{f.text}</span>
                        {"tooltip" in f&&f.tooltip&&f.included&&<div style={{fontSize:9,color:planCol,opacity:.65,marginTop:1,fontStyle:"italic"}}>↳ {f.tooltip}</div>}
                      </div>
                    </div>
                  ))}
                </div>

                {/* CTA */}
                <a href={plan.ctaLink} className="cta-btn" style={{
                  display:"block",padding:"13px",textAlign:"center",textDecoration:"none",
                  borderRadius:8,fontSize:12,fontWeight:700,letterSpacing:".1em",fontFamily:F,
                  ...(plan.ctaStyle==="solid"?{background:`linear-gradient(135deg,${planCol}25,${planCol}15)`,border:`2px solid ${planCol}60`,color:planCol,boxShadow:`0 0 24px ${planCol}25`}
                    :plan.ctaStyle==="gold"?{background:"linear-gradient(135deg,rgba(255,215,0,0.15),rgba(255,215,0,0.08))",border:"2px solid rgba(255,215,0,0.5)",color:K.gold,boxShadow:"0 0 24px rgba(255,215,0,0.15)"}
                    :plan.ctaStyle==="purple"?{background:"linear-gradient(135deg,rgba(189,0,255,0.15),rgba(189,0,255,0.08))",border:"2px solid rgba(189,0,255,0.4)",color:K.pu,boxShadow:"0 0 24px rgba(189,0,255,0.12)"}
                    :{background:"transparent",border:`1px solid ${planCol}45`,color:planCol})
                }}>
                  {plan.cta}
                </a>
              </div>
            );
          })}
        </div>

        {/* ── Alpha win-streak callout ── */}
        <div style={{padding:"22px 28px",marginBottom:16,background:"rgba(0,242,254,0.04)",border:"1px solid rgba(0,242,254,0.12)",borderRadius:10,display:"flex",alignItems:"center",gap:22}}>
          <div style={{fontSize:34,flexShrink:0,filter:"drop-shadow(0 0 14px #00F2FE)"}}>⚡</div>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:K.c,fontFamily:F,marginBottom:5,letterSpacing:".08em"}}>ALPHA PLAN · UNLIMITED TRADES WHEN YOU&apos;RE HOT</div>
            <div style={{fontSize:11,color:K.dim,lineHeight:1.8}}>On the ALPHA plan, your daily 5-trade limit unlocks completely when your win rate exceeds 65%. Because when the swarm is firing correctly — nothing should stop it.</div>
          </div>
        </div>

        {/* ── Performance model callout ── */}
        <div style={{padding:"22px 28px",marginBottom:40,background:"rgba(255,215,0,0.03)",border:"1px solid rgba(255,215,0,0.12)",borderRadius:10,display:"flex",alignItems:"center",gap:22}}>
          <div style={{fontSize:34,flexShrink:0,color:K.gold,textShadow:"0 0 16px "+K.gold}}>◈</div>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:K.gold,fontFamily:F,marginBottom:5,letterSpacing:".08em"}}>PERFORMANCE PLAN · THE HEDGE FUND MODEL</div>
            <div style={{fontSize:11,color:K.dim,lineHeight:1.8}}>No monthly fee. KYMIA takes 10% only when a trade wins. If KYMIA loses — you pay nothing. Our incentives are perfectly aligned: we only make money when you make money. <span style={{color:K.gold}}>This is how the best hedge funds operate.</span></div>
          </div>
        </div>

        {/* ── Comparison table ── */}
        <div style={{background:"rgba(6,10,18,0.8)",border:"1px solid rgba(0,242,254,0.06)",borderRadius:12,overflow:"hidden",marginBottom:48}}>
          <div style={{padding:"14px 24px",borderBottom:"1px solid rgba(0,242,254,0.06)",fontSize:9,color:K.c,letterSpacing:".3em"}}>◈ FULL FEATURE COMPARISON</div>

          {/* Header row */}
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr",borderBottom:"1px solid rgba(0,242,254,0.08)",background:"rgba(0,242,254,0.02)"}}>
            <div style={{padding:"10px 24px",fontSize:8,color:K.dim,letterSpacing:".1em"}}>FEATURE</div>
            {([{l:"SANDBOX",c:K.g},{l:"ALPHA",c:K.c},{l:"PERF.",c:K.gold},{l:"INSTIT.",c:K.pu}]).map((h,i)=>(
              <div key={i} style={{padding:"10px",textAlign:"center",fontSize:9,color:h.c,fontWeight:700,letterSpacing:".1em"}}>{h.l}</div>
            ))}
          </div>

          {([
            {feature:"Live trading",sandbox:false,alpha:true,perf:true,inst:true},
            {feature:"Daily trades",sandbox:"∞ demo",alpha:"5 (+∞ if WR>65%)",perf:"10",inst:"∞"},
            {feature:"Monthly cost",sandbox:"$0",alpha:"$39.99",perf:"10% wins",inst:"$499"},
            {feature:"Phantom wallets",sandbox:"—",alpha:"1",perf:"2",inst:"5"},
            {feature:"18 AI agents",sandbox:true,alpha:true,perf:true,inst:true},
            {feature:"Top 100 scanner",sandbox:false,alpha:true,perf:true,inst:true},
            {feature:"Memecoin alerts",sandbox:false,alpha:true,perf:true,inst:true},
            {feature:"Performance DNA",sandbox:true,alpha:true,perf:true,inst:true},
            {feature:"API access",sandbox:false,alpha:false,perf:false,inst:true},
            {feature:"Custom risk params",sandbox:false,alpha:false,perf:false,inst:true},
            {feature:"Weekly PDF report",sandbox:false,alpha:false,perf:true,inst:true},
          ] as {feature:string;sandbox:boolean|string;alpha:boolean|string;perf:boolean|string;inst:boolean|string}[]).map((row,i)=>(
            <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr 1fr",borderBottom:"1px solid rgba(0,242,254,0.04)",background:i%2===0?"transparent":"rgba(0,242,254,0.012)"}}>
              <div style={{padding:"11px 24px",fontSize:11,color:K.hi}}>{row.feature}</div>
              {([{val:row.sandbox,col:K.g},{val:row.alpha,col:K.c},{val:row.perf,col:K.gold},{val:row.inst,col:K.pu}]).map((cell,j)=>(
                <div key={j} style={{padding:"11px",textAlign:"center",fontSize:11,fontFamily:F}}>
                  {typeof cell.val==="boolean"
                    ?<span style={{color:cell.val?cell.col:"#1A3050",fontSize:14}}>{cell.val?"✓":"—"}</span>
                    :<span style={{color:cell.col,fontWeight:700,fontSize:10}}>{cell.val}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* ── FAQ ── */}
        <div style={{maxWidth:720,margin:"0 auto 64px"}}>
          <div style={{textAlign:"center",fontSize:10,color:K.c,letterSpacing:".4em",marginBottom:28}}>◈ PRICING FAQ</div>
          {([
            {q:"How does the 10% performance fee work?",a:"On the PERFORMANCE plan, when a trade closes in profit, KYMIA keeps 10% of that gain. If a trade loses, you pay nothing. Example: +$100 win → you keep $90, KYMIA keeps $10."},
            {q:"Can I switch plans?",a:"Yes, anytime. Upgrade, downgrade, or cancel. No lock-in. Your Phantom wallet always remains yours."},
            {q:"What happens after the 7-day trial?",a:"You're automatically billed unless you cancel. We send reminders at day 5 and day 7."},
            {q:"Is KYMIA non-custodial?",a:"100%. We never hold your funds. Every transaction is signed by your Phantom wallet. You control everything."},
            {q:"What is virtual capital in the sandbox?",a:"The sandbox uses $10,000 of simulated virtual funds with real market prices. No real money is at risk. It's a full live simulation of KYMIA's trading intelligence."},
          ]).map((faq,i)=>(
            <div key={i} style={{padding:"16px 22px",marginBottom:8,background:"rgba(6,10,18,0.6)",border:"1px solid rgba(0,242,254,0.07)",borderRadius:8}}>
              <div style={{fontSize:12,color:K.hi,fontWeight:700,marginBottom:6}}>{faq.q}</div>
              <div style={{fontSize:11,color:K.dim,lineHeight:1.85}}>{faq.a}</div>
            </div>
          ))}
        </div>

        {/* ── Trust strip ── */}
        <div style={{display:"flex",justifyContent:"center",gap:32,marginBottom:56,flexWrap:"wrap"}}>
          {(["◈ Non-custodial · your keys","⚡ Cancel anytime","✓ 7-day free trial","◎ No hidden fees","▲ Real market data"]).map((t,i)=>(
            <div key={i} style={{fontSize:10,color:K.dim,letterSpacing:".08em"}}>{t}</div>
          ))}
        </div>

        {/* ── Bottom CTA ── */}
        <div style={{textAlign:"center",padding:"48px 24px",background:"rgba(0,242,254,0.03)",border:"1px solid rgba(0,242,254,0.08)",borderRadius:16,position:"relative",overflow:"hidden"}}>
          <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:500,height:200,background:"radial-gradient(ellipse,rgba(0,242,254,0.06) 0%,transparent 70%)",pointerEvents:"none"}}/>
          <div style={{fontSize:32,fontWeight:900,color:"white",marginBottom:12,lineHeight:1.35,position:"relative"}}>
            Start free.<br/>
            <span style={{color:K.c,textShadow:"0 0 30px "+K.c+"60"}}>Upgrade when the swarm proves itself.</span>
          </div>
          <p style={{fontSize:13,color:K.dim,marginBottom:28,position:"relative"}}>No credit card for sandbox. 7-day trial for paid plans.</p>
          <a href="/nexus?mode=demo" style={{display:"inline-block",padding:"14px 40px",background:"rgba(0,242,254,0.12)",border:"2px solid rgba(0,242,254,0.4)",borderRadius:8,color:K.c,fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".1em",boxShadow:"0 0 32px rgba(0,242,254,0.2)",fontFamily:F,position:"relative"}}>
            ▶ Start Free — No Credit Card
          </a>
        </div>
      </div>
    </div>
  );
}

// clamp utility — returns value between min and max as string for fontSize
function clamp(min:number,max:number){return`clamp(${min}px,4vw,${max}px)`;}
