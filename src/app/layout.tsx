import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EFIN DMS | Document workspace",
  description: "จัดการไฟล์ โฟลเดอร์ และ metadata ในพื้นที่เดียว",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
