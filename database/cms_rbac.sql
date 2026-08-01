-- CMS-only RBAC (separate from PRD / Center_user_lfb)
USE cms;

CREATE TABLE IF NOT EXISTS cms_roles (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  label VARCHAR(120) NOT NULL,
  description VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cms_roles_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cms_permissions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(100) NOT NULL,
  description VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cms_permissions_code (code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cms_role_permissions (
  role_id INT UNSIGNED NOT NULL,
  permission_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_cms_rp_role
    FOREIGN KEY (role_id) REFERENCES cms_roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_cms_rp_permission
    FOREIGN KEY (permission_id) REFERENCES cms_permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Access gate to CMS (identity is Center_user_lfb; roles hang off this row)
CREATE TABLE IF NOT EXISTS cms_memberships (
  user_id BIGINT UNSIGNED NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_cms_memberships_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cms_membership_roles (
  user_id BIGINT UNSIGNED NOT NULL,
  role_id INT UNSIGNED NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_cms_mr_user
    FOREIGN KEY (user_id) REFERENCES cms_memberships (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_cms_mr_role
    FOREIGN KEY (role_id) REFERENCES cms_roles (id) ON DELETE CASCADE
) ENGINE=InnoDB;
