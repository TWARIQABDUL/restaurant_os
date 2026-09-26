// client/src/auth/AuthPage.tsx — milestone 15, from project/Auth.dc.html.
//
// The flow, and the four personas' destinations. The board's own routing table:
//
//   owner        → "Welcome back, Aline"                  Dashboard
//   manager      → "You're in Nyama & Co. as a Manager"   Orders
//   rider        → "You have 2 deliveries assigned"       My deliveries
//   super admin  → "Signed in to the Vendlyfy console"    Console, and "Every admin action is recorded"
//
// WHO YOU ARE COMES FROM THE SERVER, ALWAYS. On mount this asks GET /api/session; if there is a live
// cookie it skips straight to the destination. Nothing is remembered in the browser — §2.5 — so a reload
// is a fresh question to the server rather than a cached answer.

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiFailure, api } from '../app/api.ts';
import type { InviteResult, Membership, SessionResult, SignInResult } from '../app/api.ts';
import { AuthShell } from './AuthShell.tsx';
import {
  CodeStep,
  ForgotStep,
  NewPasswordStep,
  RoutedStep,
  SignInStep,
  StorePickerStep,
} from './steps.tsx';
import type { StepError } from './steps.tsx';
import { Alert, Button, SkeletonRow } from '../shared/ui/index.ts';

type Step =
  | { name: 'loading' }
  | { name: 'signin' }
  | { name: 'two-step'; userId: string; sentTo: string }
  | { name: 'choose-store'; memberships: Membership[] }
  | { name: 'forgot' }
  | { name: 'reset-code'; identifier: string }
  | { name: 'reset-password'; identifier: string; code: string }
  | { name: 'invite'; token: string; invite: InviteResult }
  | { name: 'routed'; title: string; sub: string; cta: string; href: string };

/** The board's destination per role, word for word. */
function destinationFor(session: SessionResult, chosen: Membership | null): Step {
  if (session.platformRole !== null) {
    return {
      name: 'routed',
      title: 'Signed in to the Vendlyfy console',
      sub: 'Every admin action is recorded in the audit log.',
      cta: 'Open console',
      href: '/admin',
    };
  }

  const membership = chosen ?? session.memberships[0] ?? null;
  const firstName = session.user.name.split(' ')[0] ?? session.user.name;

  if (membership === null) {
    // A customer, or staff whose membership was revoked. Both have a valid identity and nowhere to be
    // sent — the second is States.dc.html's "No permission" in a different place.
    return {
      name: 'routed',
      title: `Hi ${firstName}`,
      sub: 'Your account is active. Shopping at a store? Sign in on the store itself.',
      cta: 'Go to my account',
      href: '/account',
    };
  }

  if (membership.role === 'rider') {
    return {
      name: 'routed',
      title: `Hi ${firstName}`,
      sub: `Your deliveries for ${membership.name}.`,
      cta: 'Open my deliveries',
      href: `/rider/${membership.slug}`,
    };
  }

  if (membership.role === 'manager') {
    return {
      name: 'routed',
      title: `Welcome, ${firstName}`,
      // The board's multi-store line: "Opening Inzu Threads. You're a Manager here, so payouts are
      // hidden." That is the permission model showing through — a manager holds no wallet.read.
      sub: `You’re in ${membership.name} as a Manager, so payouts and the wallet are hidden.`,
      cta: 'Open orders',
      href: `/app/${membership.slug}/orders`,
    };
  }

  return {
    name: 'routed',
    title: `Welcome back, ${firstName}`,
    sub: `Opening the ${membership.name} dashboard.`,
    cta: 'Go to dashboard',
    href: `/app/${membership.slug}`,
  };
}

function problemFrom(error: unknown): StepError {
  if (error instanceof ApiFailure) {
    return { message: error.message, ...(error.hint === undefined ? {} : { hint: error.hint }) };
  }
  return { message: 'Something went wrong. Please try again.' };
}

/** An invite link is /invite/<token>; everything else is the sign-in flow. */
function inviteTokenFromPath(): string | null {
  const match = /^\/invite\/([A-Za-z0-9_-]{20,200})\/?$/.exec(window.location.pathname);
  return match?.[1] ?? null;
}

export function AuthPage(): ReactNode {
  const [step, setStep] = useState<Step>({ name: 'loading' });
  const [error, setError] = useState<StepError>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [resent, setResent] = useState(false);
  const [rules, setRules] = useState<string[]>([]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(problemFrom(failure));
    } finally {
      setBusy(false);
    }
  }, []);

  // On mount: ask the server who this is. An invite link is answered first, because somebody arriving on
  // one may already be signed in as somebody else and the invite is what they came for.
  useEffect(() => {
    void (async () => {
      const token = inviteTokenFromPath();
      if (token !== null) {
        try {
          const invite = await api.get<InviteResult>(`/api/invites/${token}`);
          setRules(invite.passwordRules);
          setStep({ name: 'invite', token, invite });
        } catch (failure) {
          setError(problemFrom(failure));
          setStep({ name: 'signin' });
        }
        return;
      }

      try {
        const session = await api.get<SessionResult>('/api/session');
        setStep(destinationFor(session, null));
      } catch {
        // Not signed in is the ordinary case, not an error worth showing.
        setStep({ name: 'signin' });
      }
      try {
        const served = await api.get<{ rules: string[] }>('/api/password/rules');
        setRules(served.rules);
      } catch {
        // The checklist labels come from the server; without them the reset screen still works, it just
        // shows no checklist until the request succeeds.
      }
    })();
  }, []);

  const afterSignedIn = useCallback(async (chosen: Membership | null) => {
    const session = await api.get<SessionResult>('/api/session');
    setStep(destinationFor(session, chosen));
  }, []);

  function signIn(input: { identifier: string; password: string; remember: boolean }): void {
    void run(async () => {
      const result = await api.post<SignInResult>('/api/session', input);
      if (result.next === 'two-step') {
        setStep({ name: 'two-step', userId: result.userId, sentTo: result.sentTo });
        return;
      }
      if (result.next === 'choose-store') {
        setStep({ name: 'choose-store', memberships: result.memberships });
        return;
      }
      await afterSignedIn(null);
    });
  }

  function submitTwoStep(code: string): void {
    if (step.name !== 'two-step') return;
    const { userId } = step;
    void run(async () => {
      await api.post('/api/session/two-step', { userId, code });
      await afterSignedIn(null);
    });
  }

  function requestReset(identifier: string): void {
    void run(async () => {
      await api.post('/api/password/reset', { identifier });
      setResent(false);
      setStep({ name: 'reset-code', identifier });
    });
  }

  function submitResetCode(code: string): void {
    if (step.name !== 'reset-code') return;
    const { identifier } = step;
    // The code is checked with the new password in one call, so it is carried forward rather than
    // verified twice — a code good once cannot be spent on a preflight check.
    setStep({ name: 'reset-password', identifier, code });
  }

  function saveNewPassword(input: { password: string }): void {
    if (step.name !== 'reset-password') return;
    const { identifier, code } = step;
    void run(async () => {
      await api.post('/api/password/reset/confirm', { identifier, code, password: input.password });
      await afterSignedIn(null);
    });
  }

  function acceptInvite(input: { password?: string; plateNumber?: string }): void {
    if (step.name !== 'invite') return;
    const { token } = step;
    void run(async () => {
      await api.post(`/api/invites/${token}/accept`, input);
      await afterSignedIn(null);
    });
  }

  if (step.name === 'loading') {
    return (
      <AuthShell>
        <div className="flex flex-col gap-3">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      {step.name === 'signin' ? (
        <SignInStep
          {...(notice === undefined ? {} : { notice })}
          error={error}
          busy={busy}
          onSubmit={signIn}
          onForgot={() => {
            setError(null);
            setNotice(undefined);
            setStep({ name: 'forgot' });
          }}
        />
      ) : null}

      {step.name === 'choose-store' ? (
        <StorePickerStep
          memberships={step.memberships}
          onPick={(membership) => void run(() => afterSignedIn(membership))}
        />
      ) : null}

      {step.name === 'two-step' ? (
        <CodeStep
          title="Confirm it’s you"
          sub={`Vendlyfy team accounts need a second step. We sent a code to ${step.sentTo}.`}
          error={error}
          busy={busy}
          resendLabel={resent ? 'Sent again' : 'Send again'}
          onSubmit={submitTwoStep}
          onResend={() => setResent(true)}
          onBack={() => {
            setError(null);
            setStep({ name: 'signin' });
          }}
        />
      ) : null}

      {step.name === 'forgot' ? (
        <ForgotStep
          error={error}
          busy={busy}
          onSubmit={requestReset}
          onBack={() => {
            setError(null);
            setStep({ name: 'signin' });
          }}
        />
      ) : null}

      {step.name === 'reset-code' ? (
        <CodeStep
          title="Enter the code"
          sub="If that account exists, a code is on its way. It is good for 10 minutes."
          error={error}
          busy={busy}
          resendLabel={resent ? 'Sent again' : 'Send again'}
          onSubmit={submitResetCode}
          onResend={() => {
            setResent(true);
            requestReset(step.identifier);
          }}
          onBack={() => {
            setError(null);
            setStep({ name: 'signin' });
          }}
        />
      ) : null}

      {step.name === 'reset-password' ? (
        <NewPasswordStep
          title="Choose a new password"
          sub="This signs you out on every other device."
          cta="Save password"
          rules={rules}
          context={{}}
          error={error}
          busy={busy}
          onSubmit={saveNewPassword}
        />
      ) : null}

      {step.name === 'invite' ? (
        step.invite.hasAccount ? (
          <div className="flex flex-col gap-4">
            <Alert
              tone="info"
              headline={`${step.invite.invite.email} already has a Vendlyfy account.`}
            >
              Sign in as that account, then open this link again to join {step.invite.invite.store.name}.
            </Alert>
            <Button block onClick={() => void run(() => Promise.resolve(acceptInvite({})))}>
              I’m signed in — join {step.invite.invite.store.name}
            </Button>
            {error === null ? null : <Alert tone="danger" headline={error.message} />}
          </div>
        ) : (
          <NewPasswordStep
            title={`Join ${step.invite.invite.store.name}`}
            sub={
              step.invite.invite.invitedBy === null
                ? `You were invited as a ${step.invite.invite.role}.`
                : `${step.invite.invite.invitedBy} invited ${step.invite.invite.name} as a ${step.invite.invite.role}.`
            }
            cta="Join and sign in"
            rules={rules.length > 0 ? rules : step.invite.passwordRules}
            context={{ email: step.invite.invite.email, storeName: step.invite.invite.store.name }}
            error={error}
            busy={busy}
            needsPlate={step.invite.invite.role === 'rider'}
            onSubmit={acceptInvite}
          />
        )
      ) : null}

      {step.name === 'routed' ? (
        <RoutedStep
          title={step.title}
          sub={step.sub}
          cta={step.cta}
          onContinue={() => {
            window.location.assign(step.href);
          }}
        />
      ) : null}
    </AuthShell>
  );
}
