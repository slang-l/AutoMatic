CREATE TABLE collaboration_documents (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collaboration_documents_title_not_empty
    CHECK (char_length(btrim(title)) > 0),
  CONSTRAINT collaboration_documents_title_length
    CHECK (char_length(title) <= 200)
);

CREATE TABLE collaboration_members (
  document_id uuid NOT NULL REFERENCES collaboration_documents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id),
  CONSTRAINT collaboration_members_role_valid
    CHECK (role IN ('owner', 'editor', 'viewer'))
);

CREATE UNIQUE INDEX collaboration_members_one_owner_idx
  ON collaboration_members (document_id)
  WHERE role = 'owner';

CREATE INDEX collaboration_members_user_idx
  ON collaboration_members (user_id, updated_at DESC);

CREATE TABLE collaboration_updates (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES collaboration_documents(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  update_data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collaboration_updates_operation_unique
    UNIQUE (document_id, operation_id),
  CONSTRAINT collaboration_updates_data_not_empty
    CHECK (octet_length(update_data) > 0),
  CONSTRAINT collaboration_updates_data_size
    CHECK (octet_length(update_data) <= 1048576)
);

CREATE INDEX collaboration_updates_document_sequence_idx
  ON collaboration_updates (document_id, sequence);

CREATE TABLE collaboration_presence (
  document_id uuid NOT NULL REFERENCES collaboration_documents(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, session_id),
  CONSTRAINT collaboration_presence_state_object
    CHECK (jsonb_typeof(state) = 'object'),
  CONSTRAINT collaboration_presence_state_size
    CHECK (octet_length(state::text) <= 8192)
);

CREATE INDEX collaboration_presence_document_updated_idx
  ON collaboration_presence (document_id, updated_at DESC);

