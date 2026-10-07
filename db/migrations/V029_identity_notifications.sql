-- V029_identity_notifications.sql
--
-- Milestone 27. V010 drew eight notification kinds and one of them, `identity_verified`, is the only word a merchant ever got
-- about their identity check. AdminKYC's decision panel says "The merchant gets an SMS with the outcome" — and there is no SMS
-- until milestone 28 — so the outcomes that need the merchant to ACT (a retake; a rejection) have to reach them somewhere that
-- exists. The in-app bell is that place, and it already carries the third outcome.
--
-- Two new kinds, for the two decisions that were silent: asking for one part again, and declining.
--   * `identity_retake`    amber ("attention"): something is needed from you.
--   * `identity_rejected`  red ("bad"): this was not approved.
-- Both are for the owner and admins (the people who can do anything about it) and both lead to the screen that explains.

INSERT INTO notification_types
    (code, audience, visible_to_roles, tone, subject, route, required_payload_keys, is_alert, description) VALUES
    ('identity_retake', 'store_staff', '{owner,admin}', 'attention', 'store', '/app/verify',
     '{}', false,
     'Our team needs one of the identity photos or the video taken again. The rest was accepted.'),
    ('identity_rejected', 'store_staff', '{owner,admin}', 'bad', 'store', '/app/verify',
     '{}', false,
     'The identity check was not approved. The store stays open; payouts stay on hold until the owner is verified.');
