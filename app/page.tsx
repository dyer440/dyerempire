import { UserButton } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'

const NAV_ITEMS = [
  { label: 'Real Estate', href: '#' },
  { label: 'The Coal Trader', href: '#' },
  { label: 'Rare Earths Intel', href: '#' },
  { label: 'Fusetrader', href: '#' },
  { label: "Thomas's Car", href: '/thomas-car' },
]

export default async function Home() {
  await auth.protect()

  return (
    <main className="relative min-h-screen w-full overflow-hidden">
      {/* Background Image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: "url('/bg.jpg')" }}
      />

      {/* Overlay */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Content */}
      <div className="relative z-10 flex flex-col min-h-screen">

        {/* Top right user button */}
        <div className="absolute top-6 right-8">
          <UserButton />
        </div>

        {/* Center content */}
        <div className="flex flex-col items-center justify-center flex-1 px-6">
          {/* Title */}
          <h1
            className="text-white mb-16 tracking-[0.3em] uppercase text-center"
            style={{
              fontFamily: "'Georgia', serif",
              fontSize: 'clamp(2rem, 5vw, 4rem)',
              fontWeight: 300,
              textShadow: '0 2px 20px rgba(0,0,0,0.5)',
              letterSpacing: '0.4em',
            }}
          >
            Dyer Empire
          </h1>

          {/* Nav Links */}
          <nav className="flex flex-col items-center gap-4 w-full max-w-xs">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="w-full text-center py-3 px-8 text-white/90 hover:text-white border border-white/30 hover:border-white/80 hover:bg-white/10 transition-all duration-300 tracking-widest uppercase text-sm"
                style={{
                  fontFamily: "'Georgia', serif",
                  letterSpacing: '0.2em',
                  backdropFilter: 'blur(4px)',
                }}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>

        {/* Footer */}
        <footer className="text-center pb-6 text-white/30 text-xs tracking-widest uppercase"
          style={{ fontFamily: "'Georgia', serif" }}>
          tutto passa
        </footer>

      </div>
    </main>
  )
}
