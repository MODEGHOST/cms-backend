-- CMS schema
-- Phase 1: Reject module | Phase 2: Complaint module (separate transaction tables, shared masters)
-- Charset: utf8mb4

CREATE DATABASE IF NOT EXISTS cms
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE cms;

-- ---------- Auth (local profile + CMS role) ----------
-- Credentials (password) live in shared identity DB: lfbsmart_project.users
-- cms.users.id must match the shared user id after migration.
-- Legacy columns password_hash/role remain for compatibility; auth reads shared DB + cms_memberships.
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NOT NULL DEFAULT '',
  display_name VARCHAR(120) NOT NULL,
  role ENUM('admin', 'staff') NOT NULL DEFAULT 'staff',
  -- Department is separate from role (e.g. QC, Production). NULL = no dept.
  department VARCHAR(80) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  KEY idx_users_department (department)
) ENGINE=InnoDB;

-- CMS-only role/access (RBAC). Credentials live in shared_auth.Center_user_lfb.
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

-- ---------- Masters ----------
CREATE TABLE IF NOT EXISTS companies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255) NULL,
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
  -- English label from Complaint Excel "Problem" column (optional)
  name_en VARCHAR(255) NULL,
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

-- Flute / ลอน (Complaint Excel) — A, B, C, E, BC, AB, ...
CREATE TABLE IF NOT EXISTS flutes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(20) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flutes_name (name)
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

-- ---------- Complaint transactions (1 row = 1 Excel row in ทะเบียนข้อร้องเรียน) ----------
-- Source: ทะเบียนข้อร้องเรียน.xlsx (sheets by year). Separate from reject_records.
CREATE TABLE IF NOT EXISTS complaint_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Optional Excel order within a year sheet
  excel_seq INT NULL,

  -- Master FKs (shared with Reject where applicable)
  company_id BIGINT UNSIGNED NULL,
  customer_alias_id BIGINT UNSIGNED NULL,
  flute_id BIGINT UNSIGNED NULL,
  machine_id BIGINT UNSIGNED NULL,
  problem_id BIGINT UNSIGNED NULL,
  reported_by_department_id BIGINT UNSIGNED NULL,
  responsible_department_id BIGINT UNSIGNED NULL,

  -- Job / product (Excel: Prod Order No, Order, ชื่อสินค้า, M5..M1, แผน, กะ)
  pdr_no VARCHAR(80) NULL,
  order_no VARCHAR(80) NULL,
  product_name VARCHAR(255) NULL,
  paper_m5 VARCHAR(40) NULL,
  paper_m4 VARCHAR(40) NULL,
  paper_m3 VARCHAR(40) NULL,
  paper_m2 VARCHAR(40) NULL,
  paper_m1 VARCHAR(40) NULL,
  plan_no VARCHAR(20) NULL,
  shift VARCHAR(20) NULL,

  -- Dates (Excel order; เดือน is derived from received_date — not stored)
  delivery_date DATE NULL,
  production_date DATE NULL,
  received_date DATE NULL,
  completed_date DATE NULL,

  -- Qty / classification
  demand_qty DECIMAL(14, 2) NULL,
  ng_qty DECIMAL(14, 2) NULL,
  -- GRADE: A / B / C / D / NEW / X
  grade VARCHAR(10) NULL,
  sale_cs_staff VARCHAR(120) NULL,

  -- Document workflow (เอกสาร รับ/ไม่รับ = P/O, ภายใน/ภายนอก)
  document_accepted ENUM('P', 'O') NULL,
  document_scope ENUM('ภายใน', 'ภายนอก') NULL,
  document_no VARCHAR(80) NULL,
  doc_forward_date DATE NULL,
  doc_receiver VARCHAR(120) NULL,
  doc_reply_date DATE NULL,
  doc_cs_sale_date DATE NULL,
  lead_time_days INT NULL,

  -- CAPA text
  cause TEXT NULL,
  correction TEXT NULL,
  prevention TEXT NULL,
  remark TEXT NULL,

  -- Workflow: CS -> QA -> responsible department -> QA confirm
  workflow_status ENUM(
    'cs_draft',
    'pending_qa',
    'qa_review',
    'pending_department',
    'department_action',
    'qa_confirm',
    'completed'
  ) NOT NULL DEFAULT 'cs_draft',
  cs_submitted_by BIGINT UNSIGNED NULL,
  cs_submitted_at DATETIME NULL,
  qa_submitted_by BIGINT UNSIGNED NULL,
  qa_submitted_at DATETIME NULL,
  department_submitted_by BIGINT UNSIGNED NULL,
  department_submitted_at DATETIME NULL,
  confirmed_by BIGINT UNSIGNED NULL,
  confirmed_at DATETIME NULL,

  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_complaint_received_date (received_date),
  KEY idx_complaint_company (company_id),
  KEY idx_complaint_problem (problem_id),
  KEY idx_complaint_machine (machine_id),
  KEY idx_complaint_flute (flute_id),
  KEY idx_complaint_reported_by (reported_by_department_id),
  KEY idx_complaint_responsible (responsible_department_id),
  KEY idx_complaint_pdr (pdr_no),
  KEY idx_complaint_document_no (document_no),
  KEY idx_complaint_grade (grade),

  CONSTRAINT fk_complaint_company
    FOREIGN KEY (company_id) REFERENCES companies (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_customer_alias
    FOREIGN KEY (customer_alias_id) REFERENCES customer_aliases (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_flute
    FOREIGN KEY (flute_id) REFERENCES flutes (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_machine
    FOREIGN KEY (machine_id) REFERENCES machines (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_problem
    FOREIGN KEY (problem_id) REFERENCES problems (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_reported_by
    FOREIGN KEY (reported_by_department_id) REFERENCES departments (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_responsible
    FOREIGN KEY (responsible_department_id) REFERENCES departments (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_cs_submitted_by
    FOREIGN KEY (cs_submitted_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_qa_submitted_by
    FOREIGN KEY (qa_submitted_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_department_submitted_by
    FOREIGN KEY (department_submitted_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_confirmed_by
    FOREIGN KEY (confirmed_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_created_by
    FOREIGN KEY (created_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_complaint_updated_by
    FOREIGN KEY (updated_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS complaint_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  complaint_id BIGINT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NULL,
  file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  uploaded_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_complaint_attachments_complaint (complaint_id),
  CONSTRAINT fk_complaint_attachments_complaint
    FOREIGN KEY (complaint_id) REFERENCES complaint_records (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_complaint_attachments_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------- Activity logs (who filled / updated what) ----------
CREATE TABLE IF NOT EXISTS activity_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NULL,
  username VARCHAR(80) NULL,
  display_name VARCHAR(120) NULL,
  department VARCHAR(80) NULL,
  action VARCHAR(40) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  summary VARCHAR(500) NOT NULL,
  changes_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_activity_created (created_at),
  KEY idx_activity_entity (entity_type, entity_id),
  KEY idx_activity_user (user_id),
  CONSTRAINT fk_activity_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;
