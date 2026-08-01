-- Central identity for all LFB apps (SSO).
-- No app roles here — roles stay in each system (PRD RBAC / CMS cms_memberships).

CREATE DATABASE IF NOT EXISTS shared_auth
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE shared_auth;

CREATE TABLE IF NOT EXISTS Center_user_lfb (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  username VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  email VARCHAR(190) NOT NULL,
  telegram_id VARCHAR(64) NULL,
  department VARCHAR(120) NULL,
  status ENUM('active', 'suspended', 'pending') NOT NULL DEFAULT 'active',
  token_version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_center_user_username (username),
  UNIQUE KEY uq_center_user_email (email),
  UNIQUE KEY uq_center_user_telegram (telegram_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
