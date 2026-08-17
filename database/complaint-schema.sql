-- Complaint module (additive) — apply on existing Phase-1 DB, or use scripts/ensure-complaint-tables.js
-- Source Excel: ทะเบียนข้อร้องเรียน.xlsx
USE cms;

-- English label for Complaint "Problem" column
-- Skip this ALTER if column already exists (prefer: node scripts/ensure-complaint-tables.js)
-- ALTER TABLE problems ADD COLUMN name_en VARCHAR(255) NULL AFTER name;

CREATE TABLE IF NOT EXISTS flutes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(20) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flutes_name (name)
) ENGINE=InnoDB;

INSERT INTO flutes (name, is_active) VALUES
  ('A', 1), ('AB', 1), ('B', 1), ('BC', 1), ('C', 1), ('E', 1)
ON DUPLICATE KEY UPDATE is_active = 1;

CREATE TABLE IF NOT EXISTS complaint_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  excel_seq INT NULL,

  company_id BIGINT UNSIGNED NULL,
  customer_alias_id BIGINT UNSIGNED NULL,
  flute_id BIGINT UNSIGNED NULL,
  machine_id BIGINT UNSIGNED NULL,
  problem_id BIGINT UNSIGNED NULL,
  reported_by_department_id BIGINT UNSIGNED NULL,
  responsible_department_id BIGINT UNSIGNED NULL,

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

  delivery_date DATE NULL,
  production_date DATE NULL,
  received_date DATE NULL,
  completed_date DATE NULL,

  demand_qty DECIMAL(14, 2) NULL,
  ng_qty DECIMAL(14, 2) NULL,
  cs_remark TEXT NULL,
  grade VARCHAR(10) NULL,
  sale_cs_staff VARCHAR(120) NULL,

  document_accepted ENUM('P', 'O') NULL,
  document_accepted_at DATETIME NULL,
  document_deadline_warned_on DATE NULL,
  document_scope ENUM('ภายใน', 'ภายนอก') NULL,
  document_no VARCHAR(80) NULL,
  doc_forward_date DATE NULL,
  doc_receiver VARCHAR(120) NULL,
  doc_reply_date DATE NULL,
  doc_cs_sale_date DATE NULL,
  lead_time_days INT NULL,

  cause TEXT NULL,
  correction TEXT NULL,
  prevention TEXT NULL,
  remark TEXT NULL,
  plan_form_json JSON NULL,

  workflow_status ENUM(
    'cs_draft', 'pending_qa', 'qa_review', 'pending_department', 'department_action', 'qa_confirm', 'completed'
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
  KEY idx_complaint_workflow (workflow_status),
  KEY idx_complaint_received_workflow (received_date, workflow_status),

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
  kind ENUM('file', 'signature') NOT NULL DEFAULT 'file',
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NULL,
  file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  uploaded_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_complaint_attachments_complaint (complaint_id),
  KEY idx_complaint_attachments_kind (complaint_id, kind),
  CONSTRAINT fk_complaint_attachments_complaint
    FOREIGN KEY (complaint_id) REFERENCES complaint_records (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_complaint_attachments_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES users (id)
    ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS complaint_record_problems (
  complaint_id BIGINT UNSIGNED NOT NULL,
  problem_id BIGINT UNSIGNED NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (complaint_id, problem_id),
  KEY idx_crp_problem (problem_id),
  CONSTRAINT fk_crp_complaint
    FOREIGN KEY (complaint_id) REFERENCES complaint_records (id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_crp_problem
    FOREIGN KEY (problem_id) REFERENCES problems (id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;
