import type { Metadata } from "next";
import { Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { TooltipLayer } from "@/components/tooltip-layer";
import "./globals.css";

const hanken = Hanken_Grotesk({ variable: "--font-hanken", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Forge",
  description: "Our team's AI app builder",
};

// Sets the theme before the first paint (saved choice, else the system setting), so there is no flash.
const themeScript = `try{var t=localStorage.getItem("forge-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${hanken.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <Script id="forge-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        {children}
        <TooltipLayer />
      </body>
    </html>
  );
}
