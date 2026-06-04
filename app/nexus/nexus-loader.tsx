"use client";
import dynamic from "next/dynamic";
import { Suspense } from "react";

const NEXUS = dynamic(() => import("./nexus-client"), { ssr: false });

export default function NexusLoader({ isLive }: { isLive: boolean }) {
  return (
    <Suspense fallback={<div style={{background:"#04060D",minHeight:"100vh"}}/>}>
      <NEXUS isLive={isLive} />
    </Suspense>
  );
}
