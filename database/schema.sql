-- CMS — Phase 1 schema (Reject module)
-- Future: Complaint module tables will live in this same database (separate tables).
-- Charset: utf8mb4

CREATE DATABASE IF NOT EXISTS cms
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE cms;

-- ---------- Auth ----------
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  role ENUM('admin', 'staff') NOT NULL DEFAULT 'staff',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB;

-- ---------- Masters ----------
CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_companies_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customer_aliases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_aliases_company_name (company_id, name),
  KEY idx_customer_aliases_company (company_id),
  CONSTRAINT fk_customer_aliases_company
    FOREIGN KEY (company_id) REFERENCES companies (id)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS departments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_departments_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS machines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_machines_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS problems (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_problems_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS shifts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(20) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shifts_name (name)
) ENGINE=InnoDB;

-- ---------- Reject transactions (1 row = 1 Excel row) ----------
CREATE TABLE IF NOT EXISTS reject_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Master FKs
  company_id BIGINT UNSIGNED NULL,
  customer_alias_id BIGINT UNSIGNED NULL,
  department_id BIGINT UNSIGNED NULL,
  machine_id BIGINT UNSIGNED NULL,
  problem_id BIGINT UNSIGNED NULL,

  -- Dates (Excel order)
  doc_notify_date DATE NULL,
  reject_received_date DATE NULL,
  customer_ship_date DATE NULL,
  production_date DATE NULL,
  repair_date DATE NULL,

  -- Documents / job
  invoice_no VARCHAR(80) NULL,
  pdr_no VARCHAR(80) NULL,
  sale_order_no VARCHAR(80) NULL,
  order_qty DECIMAL(14, 2) NULL,
  size VARCHAR(255) NULL,
  shift VARCHAR(20) NULL,
  job_type VARCHAR(40) NULL,
  vehicle_plate VARCHAR(80) NULL,
  cause VARCHAR(500) NULL,
  remark TEXT NULL,

  -- Claim amounts
  actual_ship_qty DECIMAL(14, 2) NULL,
  claim_sheet_qty DECIMAL(14, 2) NULL,
  weight_per_sheet DECIMAL(14, 4) NULL,
  claim_weight_kg DECIMAL(14, 4) NULL,
  price_per_sheet DECIMAL(14, 4) NULL,
  claim_amount DECIMAL(14, 2) NULL,

  -- After claim
  sort_claim_sup_qty DECIMAL(14, 2) NULL,
  sort_weight_kg DECIMAL(14, 4) NULL,
  return_to_customer_qty DECIMAL(14, 2) NULL,
  return_amount DECIMAL(14, 2) NULL,
  return_kg DECIMAL(14, 4) NULL,
  destroy_bl_qty DECIMAL(14, 2) NULL,
  destroy_bl_weight DECIMAL(14, 4) NULL,
  destroy_bl_amount DECIMAL(14, 2) NULL,

  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_reject_received_date (reject_received_date),
  KEY idx_reject_company (company_id),
  KEY idx_reject_problem (problem_id),
  KEY idx_reject_machine (machine_id),
  KEY idx_reject_department (department_id),
  KEY idx_reject_invoice (invoice_no),

  CONSTRAINT fk_reject_company
    FOREIGN KEY (company_id) REFERENCES companies (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_reject_customer_alias
    FOREIGN KEY (customer_alias_id) REFERENCES customer_aliases (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_reject_department
    FOREIGN KEY (department_id) REFERENCES departments (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_reject_machine
    FOREIGN KEY (machine_id) REFERENCES machines (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_reject_problem
    FOREIGN KEY (problem_id) REFERENCES problems (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_reject_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_reject_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;
