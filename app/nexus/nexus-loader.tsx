"use client";
import dynamic from "next/dynamic";

const NEXUS = dynamic(() => import("./nexus-client"), { ssr: false });

export default function NexusLoader({ isLive }: { isLive: boolean }) {
  return <NEXUS isLive={isLive} />;
}
