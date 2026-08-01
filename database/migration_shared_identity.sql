-- Shared identity: credentials live in lfbsmart_project.users
-- CMS keeps a local users profile for JOINs/FKs (id aligned to shared user id)
-- CMS role/permission stays here in cms_memberships (NOT on shared users)

USE cms;

CREATE TABLE IF NOT EXISTS cms_memberships (
  user_id BIGINT UNSIGNED NOT NULL,
  role ENUM('admin', 'staff') NOT NULL DEFAULT 'staff',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_cms_memberships_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- Local profile columns used by CMS JOINs stay on users.
-- password_hash / role on cms.users become unused after migration (auth reads shared DB).
