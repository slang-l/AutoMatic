CREATE TABLE article_workspaces (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  current_doc_id text NOT NULL DEFAULT '',
  publish_records jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(publish_records) = 'array'),
  last_write_id uuid,
  last_write_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Client IDs include historical slug IDs as well as UUIDs. The composite key
-- scopes both documents and parent references to their authenticated owner.
CREATE TABLE articles (
  user_id uuid NOT NULL REFERENCES article_workspaces(user_id) ON DELETE CASCADE,
  id text NOT NULL CHECK (char_length(id) BETWEEN 1 AND 128),
  parent_id text,
  position integer NOT NULL CHECK (position >= 0),
  title text NOT NULL,
  blocks jsonb NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  status text CHECK (status IN ('active', 'review')),
  author text NOT NULL,
  location text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (user_id, id),
  CONSTRAINT articles_parent_fk FOREIGN KEY (user_id, parent_id)
    REFERENCES articles(user_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT articles_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX articles_user_position_idx ON articles(user_id, position);
CREATE INDEX articles_user_parent_idx ON articles(user_id, parent_id);
