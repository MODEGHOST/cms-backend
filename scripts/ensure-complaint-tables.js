/**
 * Ensure Complaint module tables / columns exist (safe to re-run).
 * - problems.name_en
 * - flutes master
 * - complaint_records
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [config.db.database, table, column],
  );
  return rows.length > 0;
}

async function ensureColumn(conn, table, column, definition) {
  if (await columnExists(conn, table, column)) return;
  await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Added ${table}.${column}`);
}

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    if (!(await columnExists(conn, "problems", "name_en"))) {
      await conn.query(
        `ALTER TABLE problems
           ADD COLUMN name_en VARCHAR(255) NULL AFTER name`,
      );
      console.log("Added problems.name_en");
    } else {
      console.log("problems.name_en already exists");
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS flutes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(20) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_flutes_name (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      INSERT INTO flutes (name, is_active) VALUES
        ('A', 1), ('AB', 1), ('B', 1), ('BC', 1), ('C', 1), ('E', 1)
      ON DUPLICATE KEY UPDATE is_active = 1
    `);

    await conn.query(`
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
        grade VARCHAR(10) NULL,
        sale_cs_staff VARCHAR(120) NULL,

        document_accepted ENUM('P', 'O') NULL,
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await ensureColumn(
      conn,
      "complaint_records",
      "workflow_status",
      `ENUM('cs_draft','pending_qa','qa_review','pending_department','department_action','qa_confirm','completed')
       NOT NULL DEFAULT 'cs_draft' AFTER remark`,
    );

    // Expand enum safely if table already existed without pending_qa / pending_department
    await conn.query(`
      ALTER TABLE complaint_records
      MODIFY COLUMN workflow_status ENUM(
        'cs_draft',
        'pending_qa',
        'qa_review',
        'pending_department',
        'department_action',
        'qa_confirm',
        'completed'
      ) NOT NULL DEFAULT 'cs_draft'
    `);

    // Cases CS already submitted but QA not started yet → allow CS re-edit
    await conn.query(`
      UPDATE complaint_records
         SET workflow_status = 'pending_qa'
       WHERE workflow_status = 'qa_review'
         AND qa_submitted_at IS NULL
    `);

    // Cases QA already sent to department but department not accepted yet
    await conn.query(`
      UPDATE complaint_records
         SET workflow_status = 'pending_department'
       WHERE workflow_status = 'department_action'
         AND department_submitted_at IS NULL
    `);
    await ensureColumn(
      conn,
      "complaint_records",
      "cs_submitted_by",
      "BIGINT UNSIGNED NULL AFTER workflow_status",
    );
    await ensureColumn(
      conn,
      "complaint_records",
      "cs_submitted_at",
      "DATETIME NULL AFTER cs_submitted_by",
    );
    await ensureColumn(
      conn,
      "complaint_records",
      "qa_submitted_by",
      "BIGINT UNSIGNED NULL AFTER cs_submitted_at",
    );
    await ensureColumn(
      conn,
      "complaint_records",
      "qa_submitted_at",
      "DATETIME NULL AFTER qa_submitted_by",
    );
    await ensureColumn(
      conn,
      "complaint_records",
      "department_submitted_by",
      "BIGINT UNSIGNED NULL AFTER qa_submitted_at",
    );
    await ensureColumn(
      conn,
      "complaint_records",
      "department_submitted_at",
      "DATETIME NULL AFTER department_submitted_by",
    );
    await ensureColumn(
      conn,
      "complaint_records",
      "confirmed_by",
      "BIGINT UNSIGNED NULL AFTER department_submitted_at",
    );
    await ensureColumn(
      conn,
      "complaint_records",
      "confirmed_at",
      "DATETIME NULL AFTER confirmed_by",
    );

    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await ensureColumn(
      conn,
      "complaint_attachments",
      "kind",
      `ENUM('file', 'signature') NOT NULL DEFAULT 'file' AFTER complaint_id`,
    );

    await ensureColumn(
      conn,
      "complaint_records",
      "plan_form_json",
      `JSON NULL AFTER remark`,
    );

    const [[flutes]] = await conn.query("SELECT COUNT(*) AS c FROM flutes");
    const [[complaints]] = await conn.query(
      "SELECT COUNT(*) AS c FROM complaint_records",
    );
    console.log("Complaint tables ready:", {
      flutes: flutes.c,
      complaint_records: complaints.c,
    });
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
