-- V031_admin_money_permissions.sql
--
-- Milestone 27, part B. V001 listed the platform team's permissions explicitly ("rather than as a wildcard, so that 'what can the
-- platform team do' is a query") and wrote the ones the first admin screens needed: kyc.review, stores.suspend, payouts.process,
-- refunds.approve, disputes.resolve, audit.read. Two screens in this part change CONFIGURATION that every store reads — what
-- customers can pay with, and how money is shown and rounded — and neither fits an existing permission: payouts.process is about a
-- merchant's money moving, not about a provider being switched off for everyone.
--
--   payment_methods.manage   edit a method's countries, limits, wording and status; pause one everywhere
--   currencies.manage        edit how a currency is displayed, rounded and converted; enable or disable one
--
-- super_admin gets both, as it holds every platform permission. A narrower finance or support role (AdminTeam, part C) will hold
-- some and not others — which is the reason these are two strings and not one "config.write".

INSERT INTO role_permissions (scope, role, permission) VALUES
    ('platform', 'super_admin', 'payment_methods.manage'),
    ('platform', 'super_admin', 'currencies.manage');
