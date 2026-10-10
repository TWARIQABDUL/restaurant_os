// client/src/admin/Team.tsx — milestone 27 part C, from project/AdminTeam.dc.html.
//
// CREATED, NOT INVITED (repositories/adminTeam.ts says why): there is no email service, so a super admin makes the account with a
// starting password and hands it over — the way the merchant console's Staff panel creates a manager. The password is generated
// here, shown once in the confirmation, and not stored anywhere on the client.
//
// THE MATRIX IS READ FROM THE PERMISSION ROWS, not drawn. Change what a role can do in the database and this page changes with it, so
// the table a super admin reads before granting a role cannot be out of date with what the role does.
//
// "VIEW AS MERCHANT" IS NOT A ROW: the board lists it, and no such session exists (Merchants' header explains). A row promising a
// permission nothing checks would be the same lie as a tick nobody earned.
//
// THE BOARD'S "LAST SEEN" COLUMN IS "JOINED": the system does not record sign-in times against a person, and inventing a column
// from nothing would make an access review less honest, not more.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure } from '../app/api.ts';
import { Alert, Button, ConfirmModal, TextField, Toast } from '../shared/ui/index.ts';
import { adminOpsApi } from './adminApi.ts';
import type { TeamPage, TeamRole } from './adminApi.ts';
import { TEAM_ROLE_LABEL, joinedText, startingPassword } from './adminLines.ts';
import { useAdmin } from './Admin.tsx';

const reason = (cause: unknown, fallback: string): string => (cause instanceof ApiFailure ? cause.message : fallback);

type Props = { initial?: TeamPage; initialAdding?: boolean; initialCreated?: { name: string; email: string; password: string } };

export function Team({ initial, initialAdding, initialCreated }: Props): ReactNode {
  const { me } = useAdmin();
  const [page, setPage] = useState<TeamPage | null>(initial ?? null);
  const [adding, setAdding] = useState(initialAdding ?? false);
  const [form, setForm] = useState({ name: '', email: '', role: 'support' as TeamRole, password: '' });
  const [created, setCreated] = useState(initialCreated ?? null);
  const [doomed, setDoomed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seeded = useRef(initial !== undefined);

  const load = useCallback(async (): Promise<void> => {
    try {
      setPage(await adminOpsApi.team());
      setError(null);
    } catch (cause) {
      setError(reason(cause, 'The team could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (seeded.current) return;
    void load();
  }, [load]);

  const flash = (m: string): void => {
    setToast(m);
    window.setTimeout(() => setToast((c) => (c === m ? null : c)), 3000);
  };

  const create = async (): Promise<void> => {
    setBusy('add');
    setError(null);
    try {
      setPage(await adminOpsApi.addMember({ name: form.name.trim(), email: form.email.trim(), role: form.role, password: form.password }));
      setCreated({ name: form.name.trim(), email: form.email.trim(), password: form.password });
      setAdding(false);
      setForm({ name: '', email: '', role: 'support', password: '' });
    } catch (cause) {
      setError(reason(cause, 'That person could not be added.'));
    } finally {
      setBusy(null);
    }
  };

  const change = async (userId: string, role: TeamRole): Promise<void> => {
    setBusy(userId);
    setError(null);
    try {
      setPage(await adminOpsApi.setRole(userId, role));
      flash(`Role changed to ${TEAM_ROLE_LABEL[role]}`);
    } catch (cause) {
      setError(reason(cause, 'That role could not be changed.'));
    } finally {
      setBusy(null);
    }
  };

  const target = page?.members.find((m) => m.userId === doomed) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 grow">
          <h1 className="m-0 font-display text-[28px]">Admin team &amp; roles</h1>
          <span className="text-caption text-muted">Everyone at Vendlyfy who can open this console. Two-step sign-in is required for all.</span>
        </div>
        <Button tone="brand" onClick={() => { setAdding(!adding); setError(null); if (!adding) setForm((f) => ({ ...f, password: startingPassword() })); }}>
          Add teammate
        </Button>
      </header>

      {error === null ? null : <Alert tone="danger" headline={error} />}

      {created === null ? null : (
        <Alert tone="info" headline={`${created.name} can sign in now.`}>
          <span>
            Give them <strong>{created.email}</strong> and the starting password <code className="font-mono">{created.password}</code>. It won’t be shown again. They’ll be asked for a code each time they sign in.
          </span>
          <Button variant="text" tone="brand" onClick={() => setCreated(null)}>
            Done
          </Button>
        </Alert>
      )}

      {adding ? (
        <section className="flex flex-col gap-3 rounded-card border-2 border-brand bg-surface p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <TextField label="Name" value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField label="Work email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <label className="flex flex-col gap-1.5 text-body font-semibold">
              Role
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as TeamRole })} className="h-11 rounded-control border border-control-line bg-surface px-2.5 font-normal">
                {(page?.roles ?? []).map((r) => (
                  <option key={r} value={r}>
                    {TEAM_ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <div className="grow">
                <TextField label="Starting password" hint="At least 10 characters." value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
              <Button variant="secondary" onClick={() => setForm({ ...form, password: startingPassword() })}>
                Generate
              </Button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="text" tone="brand" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button tone="brand" busy={busy === 'add'} busyLabel="Adding…" disabled={form.name.trim().length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim()) || form.password.length < 10} onClick={() => void create()}>
              Add to the team
            </Button>
          </div>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-card border border-line bg-surface">
        {page === null ? <div className="p-10 text-center text-muted">Loading…</div> : null}
        {page?.members.map((m) => {
          const mine = m.userId === me.id;
          return (
            <div key={m.userId} className="grid grid-cols-1 items-center gap-2 border-t border-line-subtle px-4 py-3 first:border-t-0 md:grid-cols-[minmax(0,1.6fr)_170px_150px_150px] md:gap-3">
              <span className="flex min-w-0 flex-col">
                <strong className="truncate">
                  {m.name} {mine ? <span className="font-normal text-muted">(you)</span> : null}
                </strong>
                <span className="truncate text-[12px] text-muted">{m.email}</span>
              </span>
              {mine ? (
                <span className="justify-self-start rounded-pill bg-status-neutral px-2.5 py-0.5 text-[12px] font-bold">{TEAM_ROLE_LABEL[m.role]}</span>
              ) : (
                <select aria-label={`Role for ${m.name}`} value={m.role} disabled={busy === m.userId} onChange={(e) => void change(m.userId, e.target.value as TeamRole)} className="h-10 rounded-control border border-control-line bg-surface px-2 text-caption font-semibold">
                  {page.roles.map((r) => (
                    <option key={r} value={r}>
                      {TEAM_ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              )}
              <span className="text-caption text-muted">
                Joined {joinedText(m.joinedAt)}
                {m.addedBy === null ? '' : ` · by ${m.addedBy.split(' ')[0]}`}
              </span>
              <span className="flex md:justify-end">
                {mine ? null : (
                  <Button variant="text" onClick={() => setDoomed(m.userId)}>
                    Remove
                  </Button>
                )}
              </span>
            </div>
          );
        })}
      </section>

      <section className="overflow-x-auto rounded-card border border-line bg-surface">
        <div className="px-4 py-3.5">
          <h2 className="m-0 text-[16px]">What each role can do</h2>
        </div>
        <div className="grid min-w-[640px] grid-cols-[minmax(0,2fr)_repeat(4,100px)] gap-2 bg-ground px-4 py-2.5 text-[12px] font-bold text-muted">
          <span>Permission</span>
          {(page?.roles ?? []).map((r) => (
            <span key={r} className="text-center">
              {TEAM_ROLE_LABEL[r]}
            </span>
          ))}
        </div>
        {page?.matrix.map((row) => (
          <div key={row.label} className="grid min-w-[640px] grid-cols-[minmax(0,2fr)_repeat(4,100px)] items-center gap-2 border-t border-line-subtle px-4 py-2.5 text-body">
            <span>{row.label}</span>
            {page.roles.map((r) => (
              <span key={r} aria-label={row.roles[r] ? 'Can' : 'Cannot'} className={`text-center font-extrabold ${row.roles[r] ? 'text-status-success-fg' : 'text-control-line'}`}>
                {row.roles[r] ? '✓' : '—'}
              </span>
            ))}
          </div>
        ))}
      </section>

      <ConfirmModal
        open={target !== null}
        onClose={() => setDoomed(null)}
        title={`Remove ${target?.name ?? ''} from the team?`}
        body="They’re signed out everywhere and lose all access to this console at once. Everything they did stays in the audit log under their name."
        confirmLabel="Remove"
        onConfirm={() => {
          const id = doomed;
          setDoomed(null);
          if (id === null) return;
          void adminOpsApi.removeMember(id).then((p) => { setPage(p); flash(`${target?.name ?? 'They'} removed`); }).catch((cause: unknown) => setError(reason(cause, 'That person could not be removed.')));
        }}
      />

      {toast === null ? null : (
        <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
          <Toast message={toast} />
        </div>
      )}
    </div>
  );
}
