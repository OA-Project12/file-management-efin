import type { Metadata } from "next";
import "./globals.css";
import "./redesign.css";
import { IBM_Plex_Sans_Thai } from "next/font/google";

const font = IBM_Plex_Sans_Thai({ subsets: ["thai", "latin"], weight: ["400", "500", "600", "700"], display: "swap", variable: "--font-efin" });

export const metadata: Metadata = {
  title: "EFIN DMS | Document workspace",
  description: "จัดการไฟล์ โฟลเดอร์ และ metadata ในพื้นที่เดียว",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th" className={font.variable}>
      <body>{children}</body>
    </html>
  );
}
