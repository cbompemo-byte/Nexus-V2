"use client";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type MoneyLabel = { id: number; pnl: number; angle: number; born: number };
type AgentLabel = { name: string; sig: string; conf: number };

const CITIES = [
  { lat: 40.7,  lng: -74,    col: 0x00F2FE },
  { lat: 51.5,  lng: -0.1,   col: 0x00F2FE },
  { lat: 35.7,  lng: 139.7,  col: 0xFFD700 },
  { lat: 1.35,  lng: 103.8,  col: 0x00FF88 },
  { lat: 25.2,  lng: 55.3,   col: 0xFFD700 },
  { lat: 22.3,  lng: 114.2,  col: 0xFFD700 },
];

const AGENT_NAMES = ["LEVIATHAN","LENS","RADAR","SURGE","ATLAS","ECHO","PHANTOM"];
const SIGS = ["BUY","BUY","BUY","SELL","HOLD"] as const;
const ARC_COLS = [0x00FF88, 0x00F2FE, 0xFF3366];

function latLngToVec3(lat: number, lng: number) {
  const phi   = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -Math.sin(phi) * Math.cos(theta),
     Math.cos(phi),
     Math.sin(phi) * Math.sin(theta)
  );
}

export function LandingGlobe() {
  const mountRef  = useRef<HTMLDivElement>(null);
  const labelId   = useRef(0);
  const [moneyLabels, setMoneyLabels] = useState<MoneyLabel[]>([]);
  const [agentLabel,  setAgentLabel]  = useState<AgentLabel | null>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const W = el.offsetWidth  || 800;
    const H = el.offsetHeight || W;   // square fallback

    // ── Scene ────────────────────────────────────────────────────────────────
    const scene    = new THREE.Scene();
    const camera   = new THREE.PerspectiveCamera(42, W / H, 0.1, 1000);
    camera.position.z = 2.8;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    // ── Earth ────────────────────────────────────────────────────────────────
    const loader  = new THREE.TextureLoader();
    const earthGeo = new THREE.SphereGeometry(1, 64, 64);
    const earthMat = new THREE.MeshPhongMaterial({
      map:       loader.load("https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"),
      bumpMap:   loader.load("https://unpkg.com/three-globe/example/img/earth-topology.png"),
      bumpScale: 0.04,
      specular:  new THREE.Color("#112244"),
      shininess: 10,
    });
    const earth = new THREE.Mesh(earthGeo, earthMat);
    scene.add(earth);

    // ── Atmosphere ───────────────────────────────────────────────────────────
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.06, 64, 64),
      new THREE.MeshPhongMaterial({ color: 0x00F2FE, transparent: true, opacity: 0.06 })
    ));
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.18, 32, 32),
      new THREE.MeshPhongMaterial({ color: 0x0051FF, transparent: true, opacity: 0.025, side: THREE.BackSide })
    ));

    // ── Stars ────────────────────────────────────────────────────────────────
    const starArr = new Float32Array(6000);
    for (let i = 0; i < 6000; i++) starArr[i] = (Math.random() - 0.5) * 100;
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starArr, 3));
    scene.add(new THREE.Points(starGeo,
      new THREE.PointsMaterial({ color: 0xFFFFFF, size: 0.06, transparent: true, opacity: 0.5 })
    ));

    // ── City dots + ping rings ───────────────────────────────────────────────
    type PingEntry = { mesh: THREE.Mesh; phase: number; offset: number };
    const pings: PingEntry[] = [];

    CITIES.forEach((city, ci) => {
      const pos = latLngToVec3(city.lat, city.lng);

      // dot
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 8, 8),
        new THREE.MeshBasicMaterial({ color: city.col })
      );
      dot.position.copy(pos);
      scene.add(dot);

      // ring
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.02, 0.038, 16),
        new THREE.MeshBasicMaterial({ color: city.col, transparent: true, opacity: 0.7, side: THREE.DoubleSide })
      );
      ring.position.copy(pos.clone().multiplyScalar(1.01));
      ring.lookAt(new THREE.Vector3(0, 0, 0));
      scene.add(ring);
      pings.push({ mesh: ring, phase: ci * 0.18, offset: 0 });
    });

    // ── Trade arcs ──────────────────────────────────────────────────────────
    const arcGroup = new THREE.Group();
    scene.add(arcGroup);

    const spawnArc = () => {
      const i1 = Math.floor(Math.random() * CITIES.length);
      let i2 = Math.floor(Math.random() * CITIES.length);
      if (i2 === i1) i2 = (i1 + 1) % CITIES.length;
      const start = latLngToVec3(CITIES[i1].lat, CITIES[i1].lng);
      const end   = latLngToVec3(CITIES[i2].lat, CITIES[i2].lng);
      const mid   = new THREE.Vector3().addVectors(start, end).normalize().multiplyScalar(1.5);
      const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
      const geo   = new THREE.BufferGeometry().setFromPoints(curve.getPoints(50));
      const line  = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ color: ARC_COLS[Math.floor(Math.random() * 3)], transparent: true, opacity: 0.85 })
      );
      arcGroup.add(line);
      setTimeout(() => arcGroup.remove(line), 2500);
    };

    // ── Lighting ────────────────────────────────────────────────────────────
    scene.add(new THREE.AmbientLight(0x333333));
    const sun = new THREE.DirectionalLight(0xFFFFFF, 1.3);
    sun.position.set(5, 3, 5);
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x00F2FE, 0.5);
    rim.position.set(-5, -3, -5);
    scene.add(rim);

    // ── Intervals ───────────────────────────────────────────────────────────
    const arcIv = setInterval(spawnArc, 1800);

    const moneyIv = setInterval(() => {
      const pnl   = (Math.random() > 0.55 ? 1 : -1) * (Math.random() * 120 + 10);
      const id    = labelId.current++;
      const angle = Math.random() * 360;
      setMoneyLabels(l => [...l.slice(-6), { id, pnl, angle, born: Date.now() }]);
      setTimeout(() => setMoneyLabels(l => l.filter(x => x.id !== id)), 2500);
    }, 1400);

    const agentIv = setInterval(() => {
      const name = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
      const sig  = SIGS[Math.floor(Math.random() * SIGS.length)];
      const conf = 60 + Math.floor(Math.random() * 35);
      setAgentLabel({ name, sig, conf });
      setTimeout(() => setAgentLabel(null), 3000);
    }, 4000);

    // ── Animate ─────────────────────────────────────────────────────────────
    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      earth.rotation.y    += 0.0018;
      arcGroup.rotation.y += 0.0018;
      pings.forEach((pg, i) => {
        pg.offset = (pg.offset + 0.012) % 1;
        const staggered = (pg.offset + pg.phase) % 1;
        const s = 1 + staggered * 14;
        pg.mesh.scale.set(s, s, 1);
        (pg.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - staggered);
      });
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      clearInterval(arcIv);
      clearInterval(moneyIv);
      clearInterval(agentIv);
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mountRef} style={{ width: "100%", height: "100%", position: "absolute", inset: 0 }} />

      {/* Floating P&L labels */}
      {moneyLabels.map(lb => {
        const rad = lb.angle * Math.PI / 180;
        const col = lb.pnl >= 0 ? "#00FF88" : "#FF3366";
        const age = Math.min((Date.now() - lb.born) / 2500, 1);
        const opacity = age < 0.15 ? age / 0.15 : age > 0.75 ? (1 - age) / 0.25 : 1;
        return (
          <div key={lb.id} style={{
            position: "absolute",
            left: `${48 + Math.cos(rad) * 22}%`,
            top:  `${48 + Math.sin(rad) * 22}%`,
            color: col, fontWeight: 900, fontFamily: "monospace", fontSize: 14,
            textShadow: `0 0 14px ${col}`,
            opacity,
            transform: `translateY(${-age * 30}px)`,
            pointerEvents: "none", zIndex: 10,
          }}>
            {lb.pnl >= 0 ? "+$" : "-$"}{Math.abs(lb.pnl).toFixed(0)}
          </div>
        );
      })}

      {/* Agent signal popup */}
      {agentLabel && (() => {
        const col = agentLabel.sig === "BUY" ? "#00FF88" : agentLabel.sig === "SELL" ? "#FF3366" : "#00F2FE";
        return (
          <div style={{
            position: "absolute", top: "20%", left: "50%",
            transform: "translateX(-50%)", textAlign: "center",
            pointerEvents: "none", zIndex: 10,
            animation: "agentPop 3s ease-out forwards",
          }}>
            <div style={{ fontSize: 12, color: col, fontFamily: "monospace", fontWeight: 900, letterSpacing: ".15em", textShadow: "0 0 12px currentColor", marginBottom: 4 }}>
              {agentLabel.name}
            </div>
            <div style={{ padding: "3px 10px", background: `${col}30`, border: `1px solid ${col}50`, borderRadius: 3, fontSize: 10, color: col, fontFamily: "monospace", fontWeight: 700 }}>
              {agentLabel.sig} {agentLabel.conf}%
            </div>
            <div style={{ width: 1, height: 20, background: `linear-gradient(${col}, transparent)`, margin: "4px auto 0" }} />
          </div>
        );
      })()}
    </div>
  );
}
