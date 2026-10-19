import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '../components/ui/Button.jsx';
import { Input } from '../components/ui/Fields.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { parseError, post } from '../services/api.js';
import { zPassword } from '../utils/zod.js';

function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[420px] overflow-hidden rounded-[32px] border border-line bg-surface shadow-card">
        <div className="bg-sidebar px-8 pb-7 pt-9">
          <p className="text-[22px] font-bold text-white">Smart Parking</p>
          <p className="mt-1 text-[13px] text-sidebar-ink/70">Management System</p>
        </div>
        <div className="px-8 py-8">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
          <div className="mt-6">{children}</div>
          {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

const Alert = ({ tone = 'danger', children }) => (
  <p role="alert" className={`rounded-xl px-3 py-2 text-sm ${tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}`}>{children}</p>
);

const loginSchema = z.object({ username: z.string().trim().min(1, 'Username is required'), password: z.string().min(1, 'Password is required'), code: z.string().optional() });

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const { register, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(loginSchema) });

  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  const submit = handleSubmit(async (v) => {
    setError('');
    if (needCode && !/^\d{6}$/.test(v.code || '')) { setFieldError('code', { message: 'Enter the 6-digit code from your SMS' }); return; }
    try {
      await login(v.username, v.password, needCode ? v.code : undefined);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      const e = parseError(err);
      if (e.code === 'ACTIVATION_CODE_REQUIRED') { setNeedCode(true); setError(e.message); } else setError(e.message);
    }
  });

  return (
    <AuthShell title="Sign in" subtitle="Use the username and password sent to you by SMS."
      footer={<><Link to="/forgot-password" className="font-semibold text-primary hover:underline">Forgot your password?</Link><br /><span>New here? </span><Link to="/signup" className="font-semibold text-primary hover:underline">Create an account</Link></>}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Input label="Username" autoComplete="username" autoCapitalize="none" error={errors.username?.message} {...register('username')} />
        <Input label="Password" type="password" autoComplete="current-password" error={errors.password?.message} {...register('password')} />
        {needCode && <Input label="Code (from your SMS)" inputMode="numeric" maxLength={6} autoComplete="one-time-code" error={errors.code?.message} help="Needed once, to activate your account." {...register('code')} />}
        {error && <Alert>{error}</Alert>}
        <Button type="submit" size="lg" className="h-[52px] w-full rounded-2xl text-base" loading={isSubmitting}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name'),
  phone: z.string().trim().min(1, 'Phone number is required').refine((v) => /^(250)?0?7\d{8}$/.test(v.replace(/\D/g, '')), 'Use a Rwandan number like 0788 123 456'),
  nationalId: z.string().trim().regex(/^\d{16}$/, 'National ID must be 16 digits'),
});

export function SignUpPage() {
  const [done, setDone] = useState('');
  const [error, setError] = useState('');
  const { register, handleSubmit, setError: setFieldError, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(signupSchema) });
  const submit = handleSubmit(async (v) => {
    setError('');
    try { setDone((await post('/auth/register', v)).data.message); }
    catch (err) {
      const e = parseError(err);
      for (const [f, m] of Object.entries(e.fields)) setFieldError(f, { message: m });
      setError(e.message);
    }
  });
  return (
    <AuthShell title="Create an account" subtitle="An administrator approves your request, then you get your code, username and password by SMS." footer={<Link to="/login" className="font-semibold text-primary hover:underline">Back to sign in</Link>}>
      {done ? <Alert tone="success">{done}</Alert> : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Input label="Full name" autoComplete="name" error={errors.name?.message} {...register('name')} />
          <Input label="Phone number" placeholder="+250 788 123 456" inputMode="tel" autoComplete="tel" error={errors.phone?.message} {...register('phone')} />
          <Input label="National ID" inputMode="numeric" maxLength={16} error={errors.nationalId?.message} {...register('nationalId')} />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" size="lg" className="h-[52px] w-full rounded-2xl text-base" loading={isSubmitting}>Send request</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(z.object({ username: z.string().trim().min(1, 'Username is required') })) });
  const submit = handleSubmit(async (v) => {
    setError('');
    try { setResult((await post('/auth/forgot-password', v)).data); } catch (err) { setError(parseError(err).message); }
  });
  return (
    <AuthShell title="Reset your password" subtitle="Enter your username. If you cannot sign in at all, ask an administrator to generate new credentials." footer={<Link to="/login" className="font-semibold text-primary hover:underline">Back to sign in</Link>}>
      {result ? (
        <div className="space-y-3 text-sm">
          <Alert tone="success">{result.message}</Alert>
          {result.devResetToken ? (
            <p className="rounded-xl bg-warning-soft px-3 py-2 text-warning">
              Development mode: no message service is connected, so the reset link is shown here.{' '}
              <Link className="font-semibold underline" to={`/reset-password?token=${result.devResetToken}`}>Open reset page</Link>
            </p>
          ) : <p className="text-muted">An administrator can also generate new credentials for you in Users.</p>}
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Input label="Username" autoComplete="username" autoCapitalize="none" error={errors.username?.message} {...register('username')} />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" size="lg" className="h-[52px] w-full rounded-2xl text-base" loading={isSubmitting}>Request reset</Button>
        </form>
      )}
    </AuthShell>
  );
}

const resetSchema = z.object({ newPassword: zPassword, confirm: z.string() }).refine((v) => v.newPassword === v.confirm, { message: 'Passwords do not match', path: ['confirm'] });

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(resetSchema) });
  const token = params.get('token');
  const submit = handleSubmit(async (v) => {
    setError('');
    try {
      await post('/auth/reset-password', { token, newPassword: v.newPassword });
      setDone(true);
      setTimeout(() => navigate('/login'), 1800);
    } catch (err) { setError(parseError(err).message); }
  });
  return (
    <AuthShell title="Choose a new password" subtitle="At least 10 characters, with a letter and a digit.">
      {!token ? <Alert>This reset link is missing its token. Request a new one.</Alert> : done ? <Alert tone="success">Password updated. Redirecting to sign in...</Alert> : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <Input label="New password" type="password" autoComplete="new-password" error={errors.newPassword?.message} {...register('newPassword')} />
          <Input label="Confirm password" type="password" autoComplete="new-password" error={errors.confirm?.message} {...register('confirm')} />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" size="lg" className="h-[52px] w-full rounded-2xl text-base" loading={isSubmitting}>Update password</Button>
        </form>
      )}
    </AuthShell>
  );
}
