"use client";
export default function LandingPage() {
  return (
    <div style={{
      background:"#04060D",minHeight:"100vh",
      fontFamily:"'JetBrains Mono','Courier New',monospace",
      display:"flex",flexDirection:"column",
      alignItems:"center",justifyContent:"center",
      position:"relative",overflow:"hidden",
    }}>
      {/* Radial glow bg */}
      <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at 50% 40%, #0A1628 0%, #04060D 70%)"}}/>
      {/* Scanlines */}
      <div style={{position:"absolute",inset:0,pointerEvents:"none",background:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,242,254,0.012) 3px,rgba(0,242,254,0.012) 4px)"}}/>

      {/* LOGO */}
      <div style={{position:"relative",textAlign:"center",marginBottom:48}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:16,marginBottom:10}}>
          <svg width="52" height="52" viewBox="0 0 30 30" style={{filter:"drop-shadow(0 0 18px #00F2FE)"}}>
            <polygon points="15,1 27,8 27,22 15,29 3,22 3,8" fill="none" stroke="#00F2FE" strokeWidth="1.5"/>
            <ellipse cx="15" cy="15" rx="7" ry="4.2" fill="none" stroke="#00F2FE" strokeWidth="1" opacity=".8"/>
            <circle cx="15" cy="15" r="2.8" fill="#00F2FE" opacity=".9"/>
            <circle cx="15" cy="15" r="1.1" fill="#000" opacity=".7"/>
          </svg>
          <div style={{fontSize:64,fontWeight:900,color:"#00F2FE",letterSpacing:".25em",textShadow:"0 0 40px #00F2FE,0 0 80px #00F2FE40"}}>KYMIA</div>
        </div>
        <div style={{fontSize:12,color:"#2A5070",letterSpacing:".4em",textTransform:"uppercase"}}>Autonomous Quant Intelligence</div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginTop:14}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:"#00FF88",boxShadow:"0 0 10px #00FF88",animation:"pulse 1s infinite"}}/>
          <span style={{fontSize:10,color:"#00FF88",letterSpacing:".15em"}}>18 AGENTS LIVE · SOLANA NETWORK</span>
        </div>
      </div>

      {/* MODE CARDS */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,maxWidth:780,width:"90%",position:"relative"}}>

        {/* DEMO CARD */}
        <a href="/nexus?mode=demo" style={{textDecoration:"none"}}
          onMouseEnter={e=>{const d=e.currentTarget.querySelector("div") as HTMLDivElement;if(d){d.style.borderColor="rgba(0,255,136,0.6)";d.style.boxShadow="0 0 60px rgba(0,255,136,0.15)";d.style.transform="translateY(-4px)";}}}
          onMouseLeave={e=>{const d=e.currentTarget.querySelector("div") as HTMLDivElement;if(d){d.style.borderColor="rgba(0,255,136,0.25)";d.style.boxShadow="0 0 40px rgba(0,255,136,0.06)";d.style.transform="translateY(0)";}}}
        >
          <div style={{background:"rgba(6,10,18,0.85)",border:"1px solid rgba(0,255,136,0.25)",borderRadius:12,padding:"32px 28px",cursor:"pointer",transition:"all .3s ease",backdropFilter:"blur(12px)",boxShadow:"0 0 40px rgba(0,255,136,0.06)"}}>
            <div style={{display:"inline-block",padding:"4px 12px",background:"rgba(0,255,136,0.12)",border:"1px solid rgba(0,255,136,0.3)",borderRadius:20,fontSize:9,color:"#00FF88",letterSpacing:".15em",marginBottom:20}}>FREE · NO SIGNUP</div>
            <div style={{fontSize:28,fontWeight:900,color:"#00FF88",marginBottom:8}}>DEMO MODE</div>
            <div style={{fontSize:13,color:"#2A5070",lineHeight:1.8,marginBottom:24}}>
              Test the AI swarm with<br/>
              <span style={{color:"#00FF88",fontWeight:700}}>$10,000 virtual capital</span>.<br/>
              Real market prices.<br/>Zero risk.
            </div>
            {["18 AI agents live","Real Solana prices","Full dashboard access","Share your results"].map((f,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,fontSize:11,color:"#A8D0EC"}}>
                <span style={{color:"#00FF88"}}>✓</span>{f}
              </div>
            ))}
            <div style={{marginTop:24,padding:"12px",background:"rgba(0,255,136,0.12)",border:"1px solid rgba(0,255,136,0.3)",borderRadius:8,textAlign:"center",fontSize:13,fontWeight:700,color:"#00FF88",letterSpacing:".1em"}}>
              ▶ LAUNCH SANDBOX →
            </div>
          </div>
        </a>

        {/* LIVE CARD */}
        <a href="/nexus?mode=live" style={{textDecoration:"none"}}
          onMouseEnter={e=>{const d=e.currentTarget.querySelector("div") as HTMLDivElement;if(d){d.style.borderColor="rgba(0,242,254,0.6)";d.style.boxShadow="0 0 60px rgba(0,242,254,0.15)";d.style.transform="translateY(-4px)";}}}
          onMouseLeave={e=>{const d=e.currentTarget.querySelector("div") as HTMLDivElement;if(d){d.style.borderColor="rgba(0,242,254,0.25)";d.style.boxShadow="0 0 40px rgba(0,242,254,0.06)";d.style.transform="translateY(0)";}}}
        >
          <div style={{background:"rgba(6,10,18,0.85)",border:"1px solid rgba(0,242,254,0.25)",borderRadius:12,padding:"32px 28px",cursor:"pointer",transition:"all .3s ease",backdropFilter:"blur(12px)",boxShadow:"0 0 40px rgba(0,242,254,0.06)",position:"relative",overflow:"hidden"}}>
            <div style={{display:"inline-block",padding:"4px 12px",background:"rgba(0,242,254,0.12)",border:"1px solid rgba(0,242,254,0.3)",borderRadius:20,fontSize:9,color:"#00F2FE",letterSpacing:".15em",marginBottom:20}}>PHANTOM REQUIRED</div>
            <div style={{fontSize:28,fontWeight:900,color:"#00F2FE",marginBottom:8}}>LIVE MODE</div>
            <div style={{fontSize:13,color:"#2A5070",lineHeight:1.8,marginBottom:24}}>
              Connect your Phantom wallet.<br/>
              <span style={{color:"#00F2FE",fontWeight:700}}>Real Solana trading</span>.<br/>
              Non-custodial.<br/>You keep your keys.
            </div>
            {["Real fund execution","Jupiter swaps","Drift Protocol shorts","On-chain verifiable"].map((f,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,fontSize:11,color:"#A8D0EC"}}>
                <span style={{color:"#00F2FE"}}>✓</span>{f}
              </div>
            ))}
            <div style={{marginTop:24,padding:"12px",background:"rgba(0,242,254,0.12)",border:"1px solid rgba(0,242,254,0.3)",borderRadius:8,textAlign:"center",fontSize:13,fontWeight:700,color:"#00F2FE",letterSpacing:".1em"}}>
              ⚡ CONNECT PHANTOM →
            </div>
          </div>
        </a>
      </div>

      {/* Stats bar */}
      <div style={{position:"relative",marginTop:48,display:"flex",gap:48,fontSize:11}}>
        {[{v:"18",l:"AI AGENTS"},{v:"50+",l:"MARKETS"},{v:"24/7",l:"ACTIVE"},{v:"100%",l:"ON-CHAIN"}].map((s,i)=>(
          <div key={i} style={{textAlign:"center"}}>
            <div style={{fontSize:22,fontWeight:900,color:"#00F2FE",textShadow:"0 0 16px #00F2FE"}}>{s.v}</div>
            <div style={{fontSize:9,color:"#2A5070",letterSpacing:".15em",marginTop:3}}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Public wallet */}
      {process.env.NEXT_PUBLIC_KYMIA_WALLET&&(
        <div style={{position:"relative",marginTop:32,padding:"8px 20px",background:"rgba(0,242,254,0.05)",border:"1px solid rgba(0,242,254,0.15)",borderRadius:4,fontSize:10,color:"#2A5070",display:"flex",alignItems:"center",gap:10}}>
          <span>◈ PUBLIC WALLET:</span>
          <span style={{color:"#00F2FE",fontFamily:"monospace"}}>{process.env.NEXT_PUBLIC_KYMIA_WALLET.slice(0,16)}...</span>
          <a href={`https://solscan.io/account/${process.env.NEXT_PUBLIC_KYMIA_WALLET}`} target="_blank" rel="noopener" style={{color:"#00F2FE",textDecoration:"none",padding:"2px 8px",border:"1px solid rgba(0,242,254,0.3)",borderRadius:2}}>VERIFY ↗</a>
        </div>
      )}

      {/* Footer */}
      <div style={{position:"relative",marginTop:40,fontSize:9,color:"#0A1828",letterSpacing:".12em"}}>
        PAPER TRADING · NO FINANCIAL ADVICE · BUILT WITH CLAUDE AI
      </div>

      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
      `}</style>
    </div>
  );
}
