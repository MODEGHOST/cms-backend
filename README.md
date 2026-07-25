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
npm run dev
```

Login เริ่มต้นหลัง seed: `admin` / `Admin123!`
