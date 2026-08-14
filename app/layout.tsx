import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fluxo — controle financeiro pessoal",
  description: "Transforme faturas e extratos em decisões financeiras mais claras.",
  manifest: "/manifest.webmanifest",
  applicationName: "Fluxo",
  appleWebApp: {
    capable: true,
    title: "Fluxo",
    statusBarStyle: "default",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
