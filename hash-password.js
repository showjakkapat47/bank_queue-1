// สร้างไฟล์ใหม่: hash-password.js
const bcrypt = require('bcrypt');

async function hashPassword(plainPassword) {
  const hash = await bcrypt.hash(plainPassword, 10);
  console.log(`Password: ${plainPassword}`);
  console.log(`Hash: ${hash}`);
}

// ทดสอบ
hashPassword('test');
