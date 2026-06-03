"use client";
import { useState, useEffect } from "react";

const K={bg:"#02040A",hi:"#C8E8FF",c:"#00F2FE",g:"#00FF88",r:"#FF3366",gold:"#FFD700",pu:"#BD00FF",dim:"#1E3A5A",brd:"#061828",pan:"#030810",tx:"#4A7FA0"};

const MOCK_TRADERS=[
  {rank:1,name:"LEVIATHAN_7",score:847,wr:73,pnl:8470,trades:124,tier:"ELITE",streak:12},
  {rank:2,name:"PHANTOM_X",score:791,wr:68,pnl:7910,trades:98,tier:"APEX",streak:8},
  {rank:3,name:"SURGE_ALPHA",score:744,wr:71,pnl:7440,trades:115,tier:"APEX",streak:5},
  {rank:4,name:"NEXUS_KING",score:712,wr:65,pnl:7120,trades:87,tier:"GOLD",streak:3},
  {rank:5,name:"ATLAS_PRO",score:698,wr:63,pnl:6980,trades:102,tier:"GOLD",streak:7},
  {rank:6,name:"RAZOR_BOT",score:641,wr:60,pnl:6410,trades:93,tier:"GOLD",streak:2},
  {rank:7,name:"ECHO_TRADER",score:589,wr:58,pnl:5890,trades:78,tier:"SILVER",streak:4},
  {rank:8,name:"ORACLE_X2",score:534,wr:56,pnl:5340,trades:67,tier:"SILVER",streak:1},
  {rank:9,name:"VECTOR_42",score:498,wr:54,pnl:4980,trades:71,tier:"SILVER",streak:6},
  {rank:10,name:"HYDRA_Q",score:441,wr:52,pnl:4410,trades:59,tier:"BRONZE",streak:0},
];

const TIER_COLS:Record<string,string>={ELITE:K.gold,APEX:K.c,GOLD:K.gold,SILVER:"#B0C0D0",BRONZE:"#CD7F32"};

export default function LeaderboardPage(){
  const [myScore,setMyScore]=useState<number|null>(null);
  const [filter,setFilter]=useState<"ALL"|"WEEK"|"TODAY">("ALL");

  useEffect(()=>{
    try{
      const stored=localStorage.getItem("kymia_equity");
      if(stored){
        const eq=parseFloat(stored);
        if(!isNaN(eq))setMyScore(Math.round((eq-10000)/100));
      }
    }catch{}
  },[]);

  return(
    <div style={{fontFamily:"'JetBrains Mono','Courier New',monospace",background:K.bg,color:K.hi,minHeight:"100vh",padding:0}}>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#0A1D33}`}</style>

      {/* Header */}
      <header style={{borderBottom:"1px solid "+K.brd,padding:"12px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"#040810",position:"sticky",top:0,zIndex:10}}>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <a href="/" style={{textDecoration:"none"}}>
            <span style={{fontSize:16,fontWeight:900,color:K.c,letterSpacing:".25em",textShadow:"0 0 16px "+K.c}}>KYMIA</span>
          </a>
          <span style={{fontSize:9,color:K.dim,letterSpacing:".15em"}}>/ LEADERBOARD</span>
        </div>
        <a href="/nexus" style={{padding:"6px 16px",background:K.g+"18",color:K.g,border:"1px solid "+K.g+"40",borderRadius:4,textDecoration:"none",fontSize:10,letterSpacing:".1em"}}>▶ TRADE NOW</a>
      </header>

      <div style={{maxWidth:900,margin:"0 auto",padding:"32px 20px"}}>
        {/* Title */}
        <div style={{textAlign:"center",marginBottom:36}}>
          <div style={{fontSize:10,color:K.c,letterSpacing:".4em",marginBottom:12}}>GLOBAL RANKINGS</div>
          <div style={{fontSize:28,fontWeight:900,color:K.hi,letterSpacing:".1em",marginBottom:8}}>KYMIA LEADERBOARD</div>
          <div style={{fontSize:11,color:K.tx}}>Top traders by performance score · Updated live</div>
        </div>

        {/* My score banner */}
        {myScore!==null&&myScore>0&&(
          <div style={{padding:"14px 20px",background:K.pu+"12",border:"1px solid "+K.pu+"30",borderRadius:8,marginBottom:28,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <div style={{fontSize:9,color:K.pu,letterSpacing:".2em",marginBottom:4}}>YOUR SESSION SCORE</div>
              <div style={{fontSize:22,fontWeight:900,color:K.pu}}>{myScore > 0 ? "+" : ""}{myScore} pts</div>
            </div>
            <div style={{padding:"6px 14px",background:K.pu+"20",color:K.pu,border:"1px solid "+K.pu+"40",borderRadius:4,fontSize:10,fontWeight:700}}>SUBMIT SCORE →</div>
          </div>
        )}

        {/* Filter */}
        <div style={{display:"flex",gap:8,marginBottom:24}}>
          {(["ALL","WEEK","TODAY"] as const).map(f=>(
            <button key={f} onClick={()=>setFilter(f)} style={{padding:"6px 16px",background:filter===f?K.c+"20":"transparent",color:filter===f?K.c:K.dim,border:"1px solid "+(filter===f?K.c+"50":K.brd),borderRadius:3,fontFamily:"monospace",fontSize:10,cursor:"pointer",letterSpacing:".1em"}}>{f}</button>
          ))}
          <div style={{flex:1}}/>
          <div style={{padding:"6px 14px",background:K.g+"10",border:"1px solid "+K.g+"30",borderRadius:3,fontSize:9,color:K.g,display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:5,height:5,borderRadius:"50%",background:K.g,animation:"pu 1.5s infinite"}}/>
            {MOCK_TRADERS.length * 847 + 3241} traders ranked
          </div>
        </div>

        {/* Table header */}
        <div style={{display:"grid",gridTemplateColumns:"48px 1fr 80px 80px 100px 80px 60px",gap:8,padding:"8px 16px",fontSize:8,color:K.dim,letterSpacing:".12em",borderBottom:"1px solid "+K.brd,marginBottom:4}}>
          <div>RANK</div><div>TRADER</div><div style={{textAlign:"right"}}>SCORE</div><div style={{textAlign:"right"}}>P&amp;L</div><div style={{textAlign:"right"}}>WIN RATE</div><div style={{textAlign:"right"}}>TRADES</div><div style={{textAlign:"right"}}>STREAK</div>
        </div>

        {/* Rows */}
        {MOCK_TRADERS.map((t,i)=>{
          const tc=TIER_COLS[t.tier]||K.hi;
          const isTop3=t.rank<=3;
          return(
            <div key={t.rank} style={{display:"grid",gridTemplateColumns:"48px 1fr 80px 80px 100px 80px 60px",gap:8,padding:"12px 16px",borderBottom:"1px solid "+K.brd,background:isTop3?tc+"06":"transparent",transition:"background .2s",cursor:"default"}}>
              <div style={{display:"flex",alignItems:"center"}}>
                {t.rank<=3?(
                  <span style={{fontSize:16}}>{t.rank===1?"🥇":t.rank===2?"🥈":"🥉"}</span>
                ):(
                  <span style={{fontSize:12,color:K.dim,fontWeight:700}}>#{t.rank}</span>
                )}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:28,height:28,borderRadius:4,background:tc+"20",border:"1px solid "+tc+"40",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:tc,fontWeight:900}}>{t.name[0]}</div>
                <div>
                  <div style={{fontSize:12,color:K.hi,fontWeight:700}}>{t.name}</div>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
                    <span style={{fontSize:8,padding:"1px 6px",background:tc+"20",color:tc,border:"1px solid "+tc+"30",borderRadius:1}}>{t.tier}</span>
                    {t.streak>=5&&<span style={{fontSize:8,color:K.gold}}>🔥 {t.streak} streak</span>}
                  </div>
                </div>
              </div>
              <div style={{textAlign:"right",fontSize:13,fontWeight:700,color:tc,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>{t.score.toLocaleString()}</div>
              <div style={{textAlign:"right",fontSize:12,color:K.g,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>+${t.pnl.toLocaleString()}</div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:6}}>
                <div style={{width:44,height:4,background:"#060A14",borderRadius:2}}>
                  <div style={{height:"100%",borderRadius:2,background:t.wr>65?K.g:t.wr>55?K.gold:K.r,width:t.wr+"%"}}/>
                </div>
                <span style={{fontSize:11,color:t.wr>65?K.g:t.wr>55?K.gold:K.r,fontWeight:700}}>{t.wr}%</span>
              </div>
              <div style={{textAlign:"right",fontSize:11,color:K.tx,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>{t.trades}</div>
              <div style={{textAlign:"right",fontSize:11,color:t.streak>0?K.gold:K.dim,display:"flex",alignItems:"center",justifyContent:"flex-end"}}>{t.streak>0?`🔥${t.streak}`:"—"}</div>
            </div>
          );
        })}

        {/* CTA */}
        <div style={{textAlign:"center",padding:"40px 20px",marginTop:16}}>
          <div style={{fontSize:11,color:K.tx,marginBottom:16}}>Think you can make the top 10?</div>
          <a href="/nexus" style={{display:"inline-block",padding:"14px 32px",background:K.g+"18",color:K.g,border:"2px solid "+K.g+"40",borderRadius:6,textDecoration:"none",fontSize:12,fontWeight:700,letterSpacing:".1em",boxShadow:"0 0 24px "+K.g+"15"}}>▶ START TRADING — FREE</a>
        </div>
      </div>

      <style>{`@keyframes pu{0%,100%{opacity:1}50%{opacity:.15}}`}</style>
    </div>
  );
}
