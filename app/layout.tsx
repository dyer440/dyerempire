import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { ClerkProvider } from '@clerk/nextjs'
import './globals.css'

// Self-hosted so the build never reaches out to a font service.
// Source Serif 4 (variable) for names and headings, IBM Plex Sans for
// everything else, both under the SIL Open Font License.
const serif = localFont({
  src: './fonts/SourceSerif4.woff2',
  variable: '--font-source-serif',
  weight: '200 900',
  display: 'swap',
})
const sans = localFont({
  src: [
    { path: './fonts/IBMPlexSans-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexSans-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexSans-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Dyer Empire',
  description: 'The Dyer Empire',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${serif.variable} ${sans.variable}`}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
