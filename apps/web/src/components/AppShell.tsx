'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  ChevronDown,
  CircleHelp,
  CreditCard,
  Heart,
  LayoutGrid,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  Wallet,
  X,
  ArrowLeftRight,
  Check,
} from 'lucide-react';
import { useFinance } from '@/contexts/FinanceContext';
import { Brand } from './Brand';
import { useAuth } from '@/contexts/AuthContext';

const navigation = [
  { name: 'Overview', href: '/', icon: LayoutGrid },
  { name: 'My wallet', href: '/wallet', icon: Wallet },
  { name: 'Send money', href: '/send', icon: ArrowUpRight },
  { name: 'Receive money', href: '/receive', icon: ArrowDownLeft },
  { name: 'Transactions', href: '/transactions', icon: ArrowLeftRight },
  { name: 'Add money', href: '/payments', icon: CreditCard },
];
export function AppShell({ children }: { children: ReactNode }) {
  const { networkLabel, settingUp, setupError, walletReady, retryWalletSetup } = useFinance();
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const [notifications, setNotifications] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [logoutError, setLogoutError] = useState('');
  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);
  useEffect(() => {
    setMobileOpen(false);
    setNotifications(false);
    setProfileOpen(false);
  }, [pathname]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNotifications(false);
        setProfileOpen(false);
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    const desktop = window.matchMedia('(min-width: 801px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    document.body.style.overflow = 'hidden';
    sidebar.current?.querySelector<HTMLButtonElement>('.mobile-close')?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = sidebar.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled)',
      );
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    closeOnDesktop();
    desktop.addEventListener('change', closeOnDesktop);
    document.addEventListener('keydown', trapFocus);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener('change', closeOnDesktop);
      document.removeEventListener('keydown', trapFocus);
      previousFocus?.focus();
    };
  }, [mobileOpen]);
  if (loading || !user)
    return (
      <div className="loading-page">
        <Brand />
        <span className="loading-spinner" />
        <p>Opening your account…</p>
      </div>
    );
  const name = user?.name || user?.email.split('@')[0] || 'Account';
  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      {mobileOpen && (
        <button
          className="sidebar-overlay"
          tabIndex={-1}
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        id="main-navigation"
        className={`sidebar ${mobileOpen ? 'is-open' : ''}`}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen || undefined}
        aria-label={mobileOpen ? 'Navigation' : undefined}
      >
        <div className="sidebar-brand">
          <Link href="/" aria-label="UwiFin overview">
            <Brand />
          </Link>
          <button
            className="icon-button mobile-close"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        <span className="sidebar-eyebrow">YOUR EVERYDAY FINANCE</span>
        <nav aria-label="Main navigation">
          {navigation.map(({ name, href, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${pathname === href || (href === '/' && pathname === '/dashboard') ? 'active' : ''}`}
              aria-current={pathname === href ? 'page' : undefined}
            >
              <Icon size={19} />
              <span>{name}</span>
              {href === '/payments' && <span className="nav-new">NEW</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="home-note">
            <span className="home-note-icon">
              <Heart size={19} />
            </span>
            <h3>A little closer to home.</h3>
            <p>
              Big dreams. Everyday moments.
              <br />
              Keep your family connected.
            </p>
            <span>Padala para sa Pamilya.</span>
          </div>
          {user.role === 'admin' && (
            <Link href="/admin" className="nav-link">
              <ShieldCheck size={19} />
              Administration
            </Link>
          )}
          <Link href="/settings" className={`nav-link ${pathname === '/settings' ? 'active' : ''}`}>
            <Settings size={19} />
            <span>Settings</span>
          </Link>
          <Link href="/help" className={`nav-link ${pathname === '/help' ? 'active' : ''}`}>
            <CircleHelp size={19} />
            <span>Help & support</span>
            <ArrowUpRight size={14} className="nav-end" />
          </Link>
          <div className="sidebar-security">
            <ShieldCheck size={15} />
            <span>Designed with security in mind</span>
          </div>
        </div>
      </aside>
      <div className="workspace" inert={mobileOpen}>
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            aria-controls="main-navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={22} />
          </button>
          <div className="breadcrumb">
            Your workspace <span>/</span>{' '}
            <strong>
              {navigation.find((item) => item.href === pathname)?.name ||
                (pathname === '/settings'
                  ? 'Settings'
                  : pathname === '/admin'
                    ? 'Administration'
                    : pathname === '/help'
                      ? 'Help & support'
                      : 'Overview')}
            </strong>
          </div>
          <div className="topbar-actions">
            <form
              className="global-search"
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                router.push(`/transactions?q=${encodeURIComponent(query)}`);
              }}
            >
              <Search size={16} />
              <input
                aria-label="Search transactions"
                placeholder="Search anything…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd>↵</kbd>
            </form>
            <span className="network-pill">
              <span />
              {networkLabel}
            </span>
            <div className="popover-wrap">
              <button
                className={`icon-button notification-button ${notifications ? 'selected' : ''}`}
                aria-label="Notifications"
                aria-expanded={notifications}
                onClick={() => {
                  setNotifications(!notifications);
                  setProfileOpen(false);
                }}
              >
                <Bell size={20} />
                <span className="notification-dot" />
              </button>
              {notifications && (
                <div className="popover notification-popover">
                  <h3>Notifications</h3>
                  <div>
                    <span className="notification-icon">
                      <Check size={17} />
                    </span>
                    <p>
                      <strong>Welcome to UwiFin</strong>
                      <small>
                        Your wallet is created automatically. Visit My wallet to view its address
                        and balance.
                      </small>
                    </p>
                  </div>
                  <Link href="/transactions">
                    View your activity <ArrowUpRight size={14} />
                  </Link>
                </div>
              )}
            </div>
            <span className="topbar-divider" />
            <div className="popover-wrap">
              <button
                className="profile-button"
                aria-label="Account menu"
                aria-expanded={profileOpen}
                onClick={() => {
                  setProfileOpen(!profileOpen);
                  setNotifications(false);
                }}
              >
                <span className="avatar">
                  {name
                    .split(' ')
                    .map((item) => item[0])
                    .slice(0, 2)
                    .join('')
                    .toUpperCase()}
                </span>
                <ChevronDown size={14} />
              </button>
              {profileOpen && (
                <div className="popover profile-popover">
                  <strong>{name}</strong>
                  <small>{user?.email || ''}</small>
                  <Link href="/settings">
                    <Settings size={16} />
                    Account settings
                  </Link>
                  <Link href="/login">
                    <LogOut size={16} />
                    Switch account
                  </Link>
                  <button
                    onClick={async () => {
                      try {
                        await logout();
                        router.push('/login');
                      } catch {
                        setLogoutError('Unable to sign out. Please try again.');
                      }
                    }}
                  >
                    <LogOut size={16} />
                    Sign out
                  </button>
                  {logoutError && <p className="field-error">{logoutError}</p>}
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {!walletReady && settingUp && (
            <p className="info-note" role="status">
              Preparing your wallet automatically… Your address will appear when setup finishes.
            </p>
          )}
          {!walletReady && setupError && (
            <div className="error-banner" role="alert">
              <p>{setupError}</p>
              <button className="text-link" onClick={retryWalletSetup}>
                Retry wallet setup
              </button>
            </div>
          )}
          {children}
        </main>
        <footer className="app-footer">
          <span>
            © 2026 UwiFin <span className="footer-dot">·</span> Made for the people you love.
          </span>
          <span>
            <ShieldCheck size={13} />
            {networkLabel}
          </span>
        </footer>
      </div>
    </div>
  );
}
