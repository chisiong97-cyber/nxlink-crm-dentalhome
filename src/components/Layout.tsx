import { Outlet } from 'react-router-dom';

// The Worker asks for the portal password (browser login box) before this page loads
export default function Layout() {
  return (
    <div className="min-h-screen bg-[#fafafa] text-slate-900 flex flex-col font-sans">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center px-4 sm:px-6 sticky top-0 z-30">
        <span className="text-base font-bold font-heading tracking-tight text-slate-900">Dental Home Leads</span>
      </header>

      <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        <div className="flex-1 p-4 sm:p-6 md:p-8 max-w-7xl w-full mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
