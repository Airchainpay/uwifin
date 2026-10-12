'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Heart, ShieldCheck } from 'lucide-react';
import { Brand } from './Brand';
import { FamilyIllustration } from './FamilyIllustration';
import { useAuth } from '@/contexts/AuthContext';
export function AuthPage({ register = false }: { register?: boolean }) {
  const { login, register: createAccount } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (register) await createAccount(email, password, name);
      else await login(email, password);
      router.push(register ? '/wallet' : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Link href="/" aria-label="UwiFin home">
          <Brand />
        </Link>
        <div className="auth-story-content">
          <span className="eyebrow">MODERN TECHNOLOGY. GLOBAL CONNECTION.</span>
          <h1>
            Wherever life
            <br />
            takes you,
            <br />
            <em>home is close.</em>
          </h1>
          <p>A little support. A shared dream. A simple way to connect with the people you love.</p>
          <FamilyIllustration />
          <span className="auth-tagline">
            <Heart size={16} />
            Padala para sa Pamilya.
          </span>
        </div>
        <span className="auth-copyright">© 2026 UwiFin. Made for your family.</span>
      </section>
      <section className="auth-form-panel">
        <Link href="/" className="auth-back">
          <ArrowLeft size={16} />
          Back to overview
        </Link>
        <div className="auth-form-content">
          <span className="auth-icon">
            <ShieldCheck size={24} />
          </span>
          <h2>{register ? 'A little closer starts here.' : 'Good to have you back.'}</h2>
          <p>
            {register
              ? 'Create your account and start your UwiFin journey.'
              : 'Sign in to your UwiFin account.'}
          </p>
          <form className="stacked-form" onSubmit={submit}>
            {register && (
              <>
                <label htmlFor="auth-name">Full name</label>
                <input
                  className="input"
                  id="auth-name"
                  autoComplete="name"
                  placeholder="Your full name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={60}
                />
              </>
            )}
            <label htmlFor="auth-email">Email address</label>
            <input
              className="input"
              id="auth-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <label htmlFor="auth-password">Password</label>
            <div className="password-input">
              <input
                id="auth-password"
                type={visible ? 'text' : 'password'}
                autoComplete={register ? 'new-password' : 'current-password'}
                placeholder={register ? 'At least 12 characters' : 'Enter your password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={register ? 12 : 1}
                maxLength={128}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={visible ? 'Hide password' : 'Show password'}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {error && (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary full-width" disabled={busy}>
              {busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
              <ArrowRight size={16} />
            </button>
          </form>
          <p className="auth-switch">
            {register ? 'Already part of the family?' : 'New to UwiFin?'}{' '}
            <Link href={register ? '/login' : '/register'}>
              {register ? 'Sign in' : 'Create an account'}
            </Link>
          </p>
          <span className="secure-form-note">
            <ShieldCheck size={14} />A simple experience. Security at every step.
          </span>
        </div>
      </section>
    </main>
  );
}
