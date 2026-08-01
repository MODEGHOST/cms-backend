import mysql from "mysql2/promise";

const c = await mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "cms",
});

const [refs] = await c.query(`
  SELECT DISTINCT cs_submitted_by, qa_submitted_by, department_submitted_by,
         confirmed_by, updated_by
  FROM complaint_records
  WHERE cs_submitted_by IS NOT NULL
     OR qa_submitted_by IS NOT NULL
     OR department_submitted_by IS NOT NULL
     OR confirmed_by IS NOT NULL
     OR updated_by IS NOT NULL
  LIMIT 20
`);
const [orphans] = await c.query(`
  SELECT COUNT(*) AS n FROM complaint_records cr
  WHERE (cr.cs_submitted_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cr.cs_submitted_by))
     OR (cr.qa_submitted_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cr.qa_submitted_by))
     OR (cr.updated_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cr.updated_by))
`);
const [rejectOrphans] = await c.query(`
  SELECT COUNT(*) AS n FROM reject_records rr
  WHERE (rr.updated_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = rr.updated_by))
`);

console.log({ refs, complaint_orphans: orphans[0].n, reject_orphans: rejectOrphans[0].n });
await c.end();
