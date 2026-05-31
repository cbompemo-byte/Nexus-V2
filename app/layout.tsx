import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KYMIA — Autonomous Quant Intelligence",
  description: "18 AI agents analyzing Solana markets 24/7. Real data. Real signals. Free sandbox.",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "32x32" },
    ],
    apple: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "KYMIA — Autonomous Quant Intelligence",
    description: "18 AI agents analyzing Solana markets in real time. Free sandbox. No signup.",
    url: "https://nexus-v2-seven.vercel.app",
    siteName: "KYMIA",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "KYMIA — AI Swarm Trading",
    description: "18 AI agents. Real Solana prices. Free sandbox.",
  },
};

export const viewport: Viewport = {
  themeColor: "#00F2FE",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
