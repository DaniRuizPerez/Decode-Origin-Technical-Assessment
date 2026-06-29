import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Release Documentation Agent",
  description: "Automatically generate release documentation from engineering artifacts.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
