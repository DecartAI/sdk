import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Decart Realtime Demo",
  description: "Real-time video transformation with Decart SDK",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
