const SYSTEM_NAME = "ระบบจัดการ Complaint & Reject";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character],
  );
}

function emailShell({
  preheader,
  eyebrow,
  title,
  description,
  actionLabel,
  actionUrl,
  notice,
  footer,
}) {
  const safeUrl = escapeHtml(actionUrl);

  return `<!doctype html>
<html lang="th" translate="no">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f5f7;color:#172033;font-family:Arial,'Noto Sans Thai','Tahoma',sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(preheader)}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#f4f5f7;">
      <tr>
        <td align="center" style="padding:36px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding:20px 24px;border-radius:18px 18px 0 0;background-color:#0f172a;">
                <div style="color:#fca5a5;font-size:10px;font-weight:700;letter-spacing:1px;">ระบบสำหรับบุคลากรภายในบริษัท</div>
                <div style="margin-top:5px;color:#ffffff;font-size:18px;font-weight:700;line-height:1.4;">
                  ${escapeHtml(SYSTEM_NAME)}
                </div>
                <div style="margin-top:3px;color:#cbd5e1;font-size:11px;font-weight:400;">บริษัท ลี้ไฟเบอร์บอร์ด จำกัด</div>
              </td>
            </tr>
            <tr>
              <td style="overflow:hidden;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 18px 18px;background-color:#ffffff;box-shadow:0 10px 30px rgba(15,23,42,0.10);">
                <div style="height:5px;background-color:#b91c1c;font-size:0;line-height:0;">&nbsp;</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:42px 44px 18px;">
                      <div style="margin-bottom:13px;color:#b91c1c;font-size:12px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;">
                        ${escapeHtml(eyebrow)}
                      </div>
                      <h1 style="margin:0;color:#111827;font-size:30px;line-height:1.35;font-weight:700;letter-spacing:-0.5px;">
                        ${escapeHtml(title)}
                      </h1>
                      <p style="margin:16px 0 0;color:#536176;font-size:16px;line-height:1.8;">
                        ${escapeHtml(description)}
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:14px 44px 28px;">
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                        <tr>
                          <td align="center" style="border-radius:10px;background-color:#b91c1c;box-shadow:0 5px 14px rgba(185,28,28,0.22);">
                            <a href="${safeUrl}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:16px;font-weight:700;line-height:1.2;text-decoration:none;">
                              ${escapeHtml(actionLabel)}
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 44px 28px;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-left:4px solid #dc2626;border-radius:10px;background-color:#fef2f2;">
                        <tr>
                          <td style="padding:15px 17px;color:#536176;font-size:13px;line-height:1.65;">
                            <strong style="color:#29364a;">ข้อมูลสำคัญ:</strong>
                            ${escapeHtml(notice)}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 44px 40px;">
                      <p style="margin:0 0 8px;color:#718096;font-size:12px;line-height:1.6;">
                        หากปุ่มด้านบนใช้งานไม่ได้ ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์
                      </p>
                      <p style="margin:0;word-break:break-all;color:#b91c1c;font-size:12px;line-height:1.6;">
                        <a href="${safeUrl}" target="_blank" style="color:#b91c1c;text-decoration:underline;">${safeUrl}</a>
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 24px 0;color:#8a96a8;font-size:12px;line-height:1.7;">
                ${escapeHtml(footer)}
                <br>อีเมลนี้ส่งโดยอัตโนมัติจาก ${escapeHtml(SYSTEM_NAME)} กรุณาอย่าตอบกลับ
                <br><span style="color:#a5afbd;">© ${new Date().getFullYear()} บริษัท ลี้ไฟเบอร์บอร์ด จำกัด</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function passwordResetEmail({ url }) {
  return {
    subject: `ตั้งรหัสผ่าน ${SYSTEM_NAME} ใหม่`,
    html: emailShell({
      preheader: `คำขอตั้งรหัสผ่าน ${SYSTEM_NAME} ใหม่ ลิงก์มีอายุ 3 นาที`,
      eyebrow: "ความปลอดภัยของบัญชี",
      title: "ตั้งรหัสผ่านใหม่",
      description: `เราได้รับคำขอตั้งรหัสผ่านสำหรับบัญชี ${SYSTEM_NAME} ของคุณ กดปุ่มด้านล่างเพื่อกำหนดรหัสผ่านใหม่`,
      actionLabel: "ตั้งรหัสผ่านใหม่",
      actionUrl: url,
      notice:
        "ลิงก์นี้มีอายุ 3 นาทีและใช้ได้เพียงครั้งเดียว เพื่อความปลอดภัย ระบบจะยกเลิกการเข้าสู่ระบบเดิมหลังเปลี่ยนรหัสผ่าน",
      footer:
        "หากคุณไม่ได้เป็นผู้ส่งคำขอนี้ ไม่ต้องดำเนินการใด ๆ และบัญชีของคุณจะยังปลอดภัย",
    }),
    text: [
      `ตั้งรหัสผ่าน ${SYSTEM_NAME} ใหม่`,
      "",
      "เราได้รับคำขอตั้งรหัสผ่านสำหรับบัญชีของคุณ เปิดลิงก์ด้านล่างเพื่อดำเนินการ:",
      url,
      "",
      "ลิงก์นี้มีอายุ 3 นาทีและใช้ได้เพียงครั้งเดียว",
      "หากคุณไม่ได้ส่งคำขอนี้ ไม่ต้องดำเนินการใด ๆ",
    ].join("\n"),
  };
}
