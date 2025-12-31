import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Decart SDK - Next.js Proxy Example",
  description: "Next.js proxy example using Decart SDK with proxy middleware",
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

