import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Opportunity Radar | Live Student Opportunities Across India",
  description:
    "Find currently open internships, hackathons, competitions, scholarships, fellowships and open-source programs matched directly to your profile from 20 trusted sources.",
  keywords: [
    "internships",
    "hackathons",
    "scholarships",
    "fellowships",
    "open source",
    "college students",
    "India",
    "opportunity radar",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-slate-50 text-slate-900 dark:bg-[#0b0f19] dark:text-slate-100 antialiased transition-colors duration-200">
        {children}
      </body>
    </html>
  );
}
