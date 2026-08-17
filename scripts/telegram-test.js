/**
 * Dev helper: inspect Telegram updates / send a test message to the group.
 *
 * Usage:
 *   node scripts/telegram-test.js updates
 *   node scripts/telegram-test.js send
 *   node scripts/telegram-test.js send -1001234567890
 */
import "dotenv/config";
import "../src/core/node16-compat.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID;
const base = `https://api.telegram.org/bot${token}`;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);

async function api(method, body) {
  const res = await fetch(`${base}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

if (cmd === "updates") {
  const data = await api("getUpdates");
  if (!data.ok) {
    console.error("getUpdates failed:", data);
    process.exit(1);
  }
  const chats = new Map();
  for (const u of data.result || []) {
    const chat = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat;
    if (!chat) continue;
    chats.set(chat.id, {
      id: chat.id,
      type: chat.type,
      title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username,
    });
  }
  if (!chats.size) {
    console.log("ยังไม่เจอ chat — ลอง: สร้างกลุ่ม → Add bot → พิมพ์อะไรในกลุ่มสักข้อความ แล้วรันคำสั่งนี้อีกครั้ง");
    process.exit(0);
  }
  console.log("พบ chat ดังนี้ (เอา id ไปใส่ TELEGRAM_GROUP_CHAT_ID):\n");
  for (const c of chats.values()) {
    console.log(`  id: ${c.id}`);
    console.log(`  type: ${c.type}`);
    console.log(`  name: ${c.title}`);
    console.log("");
  }
} else if (cmd === "send") {
  const chatId = arg || groupChatId;
  if (!chatId) {
    console.error("ใส่ chat id: node scripts/telegram-test.js send <CHAT_ID>");
    console.error("หรือตั้ง TELEGRAM_GROUP_CHAT_ID ใน .env ก่อน");
    process.exit(1);
  }
  const data = await api("sendMessage", {
    chat_id: chatId,
    text: "✅ CMS Telegram test — ถ้าเห็นข้อความนี้ แสดงว่า bot ส่งเข้ากลุ่มได้แล้ว",
    parse_mode: "HTML",
  });
  if (!data.ok) {
    console.error("ส่งไม่สำเร็จ:", data);
    process.exit(1);
  }
  console.log("ส่งสำเร็จไปที่ chat_id =", chatId);
} else {
  console.log(`Usage:
  node scripts/telegram-test.js updates   # ดู chat id จากข้อความล่าสุด
  node scripts/telegram-test.js send      # ส่งข้อความทดสอบ (ใช้ TELEGRAM_GROUP_CHAT_ID)
  node scripts/telegram-test.js send <id> # ส่งไป chat id ที่ระบุ`);
  process.exit(cmd ? 1 : 0);
}
