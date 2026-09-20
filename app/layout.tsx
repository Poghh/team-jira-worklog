import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "./nav";
import { BuildWatcher } from "./build-watch";
import { enabledModuleNav, isModuleEnabled } from "@/lib/modules/state";
import { getBuildNotify } from "@/lib/modules/branches/config";
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
  /**
   * The build watcher runs app-wide, so the layout is where it has to be
   * switched on — a module that is off must not be polling App Store Connect
   * from every screen. `watching` is the user's own switch inside the module,
   * for teams that use the board for branches and have no build channel at all.
   */
  const branchesOn = isModuleEnabled('branches')
  const watchBuilds = branchesOn && getBuildNotify()

  return (
    <html
      lang="vi"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full">
        {/* Around the navigation as well as the page: the watcher draws nothing
            itself, but the nav reads its unread count, and both have to sit
            inside one provider for that. Outside `children`, so the timer
            survives navigating between pages — the whole point of it living
            here rather than on the board. */}
        <BuildWatcher enabled={branchesOn} watching={watchBuilds}>
          <div className="grid min-h-screen grid-cols-1 md:grid-cols-[196px_1fr]">
            <Nav label={label} modules={modules} />
            <main className="max-w-[1340px] px-6 pb-12 pt-5">{children}</main>
          </div>
        </BuildWatcher>
      </body>
    </html>
  );
}
