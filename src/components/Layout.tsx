import { Outlet } from 'react-router-dom';
import { LogOut } from 'lucide-react';

// Cloudflare Access signs people in before the page loads; this logout URL ends that session
const ACCESS_LOGOUT_URL = '/cdn-cgi/access/logout';

export default function Layout() {
  return (
    <div className="min-h-screen bg-[#fafafa] text-slate-900 flex flex-col font-sans">
      <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-6 sticky top-0 z-30">
        <span className="text-base font-bold font-heading tracking-tight text-slate-900">Dental Home Leads</span>
        <a
          href={ACCESS_LOGOUT_URL}
          className="flex items-center px-3 py-1.5 text-xs font-semibold font-heading text-slate-500 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors"
        >
          <LogOut size={14} className="mr-1.5" />
          Sign Out
        </a>
      </header>

      <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        <div className="flex-1 p-4 sm:p-6 md:p-8 max-w-7xl w-full mx-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
