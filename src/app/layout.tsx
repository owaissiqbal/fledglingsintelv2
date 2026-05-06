import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";

const outfit = Outfit({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Fledglings · Inspection Intelligence",
  description:
    "Where Growth Takes Flight. Find institutions whose latest inspection identifies weaknesses our four curricula address — and reach them with the source quote in hand.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-GB" className={outfit.variable}>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Nav />
        {children}
      </body>
    </html>
  );
}
