# CMS Backend

API ระบบ Complaint Management  
Phase 1: **Reject** | Future: **Complaint** (ตาราง/API แยก อยู่ใน DB เดียวกัน)

## หลักการสำคัญ
- กรอง / ค้นหา / รวมข้อมูล / pagination ทำที่ **backend**
- Frontend ส่ง query แล้วแสดงผลอย่างเดียว ให้น้ำหนักเบา

## โครงสร้าง

```
cms-backend/
├── database/           # schema / migration / seed
├── scripts/
├── storage/
├── test/
└── src/
    ├── server.js
    ├── app.js
    ├── core/
    ├── middleware/
    ├── routes/
    ├── services/
    ├── repositories/
    └── validators/
```

## เริ่มต้น (XAMPP MySQL)

```bash
cp .env.example .env
npm install
npm run db:init
npm run db:migrate-shared-identity   # align CMS profiles + cms_memberships (if not done)
npm run db:migrate-center-user       # create shared_auth.Center_user_lfb
npm run db:migrate-cms-rbac          # CMS roles / permissions
npm run dev
```

Login ใช้บัญชีกลางจาก `shared_auth.Center_user_lfb` (SSO กับ PRD)
หลัง migrate-shared-identity จะ grant `toni.admin` / `peerapon.it`
ถ้ายังไม่มี membership ใน CMS เลย seed จะสร้าง `admin` / `Admin123!`

### Shared identity (SSO)

- **ตารางกลาง**: `shared_auth.Center_user_lfb` — username / password / email / telegram / department / status
- **RBAC ของ CMS** (แยกจาก PRD): `cms_roles` + `cms_permissions` + `cms_membership_roles`
  - roles: `developer`, `admin`, `cs`, `qa`, `qc`, `department`, `viewer`
  - เมนู **สมาชิกและสิทธิ์** (`/system`) — โครงคล้าย PRD Access Admin
  - ตั้ง developer: `npm run db:grant-developer` (ค่าเริ่มต้น `peerapon.it`)
  - แผนก (`department`) ยังใช้คู่กับ `complaints.department` สำหรับหน่วยงานที่รับผิดชอบ
- **Profile ใน CMS** (`cms.users`): โชว์ชื่อ / JOIN FK — `id` ตรงกับ `Center_user_lfb.id`

คนเดียวกัน login รหัสเดียวได้ แต่สิทธิ์แต่ละระบบคนละชุด
