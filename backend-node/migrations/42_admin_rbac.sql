ALTER TABLE platform_users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE platform_users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
UPDATE platform_users
SET platform_role = 'admin'
WHERE role = 'admin' AND platform_role = 'user' AND token_version = 0;
