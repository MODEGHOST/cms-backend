const THAI_CHARACTER = /[\u0E00-\u0E7F]/;
const LOWERCASE_CHARACTER = /[a-z]/;
const UPPERCASE_CHARACTER = /[A-Z]/;
const SPECIAL_CHARACTER = /[^A-Za-z0-9\s\u0E00-\u0E7F]/;

export function passwordPolicyErrors(value) {
  const password = String(value || "");
  const errors = [];

  if (password.length < 8) {
    errors.push("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
  }
  if (!LOWERCASE_CHARACTER.test(password)) {
    errors.push("รหัสผ่านต้องมีตัวพิมพ์เล็กอย่างน้อย 1 ตัว");
  }
  if (!UPPERCASE_CHARACTER.test(password)) {
    errors.push("รหัสผ่านต้องมีตัวพิมพ์ใหญ่อย่างน้อย 1 ตัว");
  }
  if (!SPECIAL_CHARACTER.test(password)) {
    errors.push("รหัสผ่านต้องมีอักขระพิเศษอย่างน้อย 1 ตัว");
  }
  if (THAI_CHARACTER.test(password)) {
    errors.push("รหัสผ่านต้องไม่มีอักษรภาษาไทย");
  }

  return errors;
}
