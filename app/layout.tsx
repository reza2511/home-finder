import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reza Property Finder",
  description: "Aggregated rental listings from multiple sources",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
