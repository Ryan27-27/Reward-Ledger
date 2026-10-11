-- Payment addresses (VPAs): every member gets a unique handle, shown as  <handle>@<VPA_DOMAIN>.
-- Only the handle is stored; the domain comes from config so it can change without a data migration.
CREATE TABLE vpas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  handle     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpa_handle_format CHECK (handle ~ '^[a-z0-9][a-z0-9._-]{2,29}$')
);
CREATE UNIQUE INDEX vpas_handle_uq ON vpas (handle);

-- Anti-farming guard in the database itself: reward points can only ever be minted by a *payment*.
-- Member-to-member transfers can never create an EARN journal, whatever the application code does.
ALTER TABLE journals ADD CONSTRAINT earn_needs_payment CHECK (kind <> 'EARN' OR COALESCE(reference_type, '') = 'payment'); -- COALESCE: a NULL would otherwise pass a CHECK
