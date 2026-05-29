import NexusLoader from "./nexus-loader";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const params = await searchParams;
  const isLive = params.mode === "live";
  return <NexusLoader isLive={isLive} />;
}
