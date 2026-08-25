import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trickshot",
  description: "Rebuild any Solana token from the chain and play back what any wallet did on it.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto w-full max-w-[1200px] px-4 sm:px-6">
          {children}
        </main>
        <Analytics />
      </body>
    </html>
  );
}
