import type { Metadata } from "next";
import "./globals.css";
import {Header} from "@/components/units/header";

export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`antialiased`}
        data-theme="forge"
        data-typography
      >
        <Header />
        <div className="mx-auto max-w-screen-md mt-6">
            {children}
        </div>
      </body>
    </html>
  );
}
