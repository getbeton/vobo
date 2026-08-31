'use client';

import { useActionState } from 'react';
import { deleteAccount, updatePassword } from '@/app/(login)/actions';

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

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 14,
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
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={passwordState.currentPassword}
                style={inputStyle}
              />
            </label>
            <label>
              <span style={labelStyle}>New password</span>
              <input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={passwordState.newPassword}
                style={inputStyle}
              />
            </label>
            <label>
              <span style={labelStyle}>Confirm new password</span>
              <input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={passwordState.confirmPassword}
                style={inputStyle}
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
            <button
              type="submit"
              disabled={passwordPending}
              style={{
                alignSelf: 'flex-start',
                border: 0,
                borderRadius: 8,
                padding: '8px 14px',
                background: 'var(--slate-900)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {passwordPending ? 'Saving' : 'Update password'}
            </button>
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
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                maxLength={100}
                defaultValue={deleteState.password}
                style={inputStyle}
              />
            </label>
            {deleteState.error ? (
              <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--red-700)' }}>
                {deleteState.error}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={deletePending}
              style={{
                alignSelf: 'flex-start',
                border: 0,
                borderRadius: 8,
                padding: '8px 14px',
                background: 'var(--red-700)',
                color: '#fff',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              {deletePending ? 'Deleting' : 'Delete account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
