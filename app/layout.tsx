import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "./nav";
import { enabledModuleNav } from "@/lib/modules/state";
import { SETTING_KEYS, getSetting, getTeamScope } from "@/lib/settings";

const geistSans = Geist({
  variable: "--font-geist-sans",
  // Geist has no "vietnamese" subset; latin-ext carries the diacritics.
  subsets: ["latin", "latin-ext"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  // Geist has no "vietnamese" subset; latin-ext carries the diacritics.
  subsets: ["latin", "latin-ext"],
});

export const metadata: Metadata = {
  title: "Jira Logwork",
  description: "Log work và tạo daily report cho Jira",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reflects the configured project rather than a hardcoded one, so the app
  // reads correctly for whoever runs it.
  const project = getSetting(SETTING_KEYS.jiraProjectKey)
  const board = getSetting(SETTING_KEYS.jiraBoardId)
  // The team label is part of the identity of what is on screen: with it set,
  // every list is narrowed to that team, and "nothing here" needs to be
  // readable as "nothing here for CTALK" rather than "nothing here at all".
  const team = getTeamScope().label
  const label = project
    ? `${project}${board ? ` · board ${board}` : ''}${team ? ` · ${team}` : ''}`
    : undefined
  const modules = enabledModuleNav()

  return (
    <html
      lang="vi"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        <div className="grid min-h-screen grid-cols-1 md:grid-cols-[196px_1fr]">
          <Nav label={label} modules={modules} />
          {/* `min-w-0`: the column is `1fr`, i.e. `minmax(auto, 1fr)`, so without
              it one long unbreakable line — a code snippet in a review, a long
              branch name — widens `main` past the viewport and the whole page
              scrolls sideways. With it, that content scrolls in its own box. */}
          <main className="min-w-0 max-w-[1340px] px-6 pb-12 pt-5">{children}</main>
        </div>
      </body>
    </html>
  );
}
