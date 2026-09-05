'use client';

import { useActionState } from 'react';
import { deleteAccount, updatePassword } from '@/app/(login)/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  boxShadow: 'var(--shadow-sm)',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--slate-700)',
  marginBottom: 4,
};

type PasswordState = {
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
  error?: string;
  success?: string;
};

type DeleteState = {
  password?: string;
  error?: string;
  success?: string;
};

export default function AccountPage() {
  const [passwordState, passwordAction, passwordPending] = useActionState<
    PasswordState,
    FormData
  >(updatePassword, {});
  const [deleteState, deleteAction, deletePending] = useActionState<DeleteState, FormData>(
    deleteAccount,
    {}
  );

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>Account</span>

        <div style={card}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Password</span>
          <form action={passwordAction} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label>
              <span style={labelStyle}>Current password</span>
              <Input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={passwordState.currentPassword}
              />
            </label>
            <label>
              <span style={labelStyle}>New password</span>
              <Input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={passwordState.newPassword}
              />
            </label>
            <label>
              <span style={labelStyle}>Confirm new password</span>
              <Input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={passwordState.confirmPassword}
              />
            </label>
            {passwordState.error ? (
              <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--red-700)' }}>
                {passwordState.error}
              </p>
            ) : null}
            {passwordState.success ? (
              <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--green-700)' }}>
                {passwordState.success}
              </p>
            ) : null}
            <Button type="submit" disabled={passwordPending} className="self-start">
              {passwordPending ? 'Saving' : 'Update password'}
            </Button>
          </form>
        </div>

        <div style={card}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Delete account</span>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--slate-600)', lineHeight: 1.5 }}>
            This removes your membership and the login. Type your password to confirm.
          </p>
          <form action={deleteAction} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label>
              <span style={labelStyle}>Password</span>
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={deleteState.password}
              />
            </label>
            {deleteState.error ? (
              <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--red-700)' }}>
                {deleteState.error}
              </p>
            ) : null}
            <Button type="submit" variant="destructive" disabled={deletePending} className="self-start">
              {deletePending ? 'Deleting' : 'Delete account'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
