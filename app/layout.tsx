import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Git Repository Forensics",
  description: "Git history analysis, change coupling and developer activity intelligence",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
