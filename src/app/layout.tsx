import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Canvas On-prem",
  description: "AI Canvas On-prem demo",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}

