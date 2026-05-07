const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

async function ensureDefaultAdmin() {
  const prisma = new PrismaClient();

  try {
    const hashedPassword = await bcrypt.hash('admin123', 10);

    const teacher = await prisma.user.upsert({
      where: { username: 'admin' },
      update: {
        password: hashedPassword,
        fullName: 'Giáo viên',
        role: 'TEACHER',
        classId: null,
      },
      create: {
        username: 'admin',
        password: hashedPassword,
        fullName: 'Giáo viên',
        role: 'TEACHER',
        classId: null,
      },
    });

    console.log('Default admin ready:', teacher.username, '/ admin123');
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { ensureDefaultAdmin };
