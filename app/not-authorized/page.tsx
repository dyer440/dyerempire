import { SignOutButton } from '@clerk/nextjs'

export default function NotAuthorized() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-black text-white">
      <h1 className="text-2xl tracking-widest uppercase mb-4" style={{ fontFamily: 'Georgia, serif' }}>
        Access Denied
      </h1>
      <p className="text-white/50 mb-8 tracking-wider text-sm">
        You are not authorized to view this site.
      </p>
      <SignOutButton>
        <button className="border border-white/30 px-6 py-2 text-sm tracking-widest uppercase hover:bg-white/10 transition-all">
          Sign Out
        </button>
      </SignOutButton>
    </main>
  )
}
