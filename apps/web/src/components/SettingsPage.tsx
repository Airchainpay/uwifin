'use client';
import { useState, type FormEvent } from 'react';
import { request } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
export function SettingsPage() {
  const { user, updateName } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [message, setMessage] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await updateName(name.trim());
      setMessage('Profile saved.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Unable to save profile.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="page-heading">
        <h1>Settings.</h1>
      </section>
      <section className="card settings-card">
        <form className="stacked-form" onSubmit={save}>
          <label htmlFor="name">Full name</label>
          <input
            className="input"
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            minLength={2}
            maxLength={60}
            required
          />
          <label htmlFor="email">Email</label>
          <input className="input" id="email" value={user?.email || ''} readOnly />
          <p>Email changes require account verification.</p>
          <p role="status">{message}</p>
          <button className="button primary" disabled={busy}>
            Save profile
          </button>
        </form>
      </section>
      <section className="card settings-card">
        <h2>Account security</h2>
        <form
          className="stacked-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              await request('/auth/password', {
                method: 'POST',
                body: JSON.stringify({
                  current_password: currentPassword,
                  new_password: newPassword,
                }),
              });
              setCurrentPassword('');
              setNewPassword('');
              setMessage('Password changed. Other sessions have been signed out.');
            } catch (err) {
              setMessage(err instanceof Error ? err.message : 'Unable to change password.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="current-password">Current password</label>
          <input
            id="current-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            maxLength={128}
            required
          />
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          <button className="button primary" disabled={busy}>
            Change password
          </button>
        </form>
        <button
          className="button secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await request('/auth/revoke-sessions', { method: 'POST', body: '{}' });
              setMessage('Other sessions signed out.');
            } catch (err) {
              setMessage(err instanceof Error ? err.message : 'Unable to sign out sessions.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Sign out other sessions
        </button>
      </section>
      <section className="card settings-card">
        <h2>Wallet security</h2>
        <p>
          Privy manages your embedded signing wallet. Keep your UwiFin account password secure.
          UwiFin does not store your private wallet keys.
        </p>
      </section>
    </>
  );
}
